import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { initCommand } from "../src/commands/init.js";
import { loadConfig } from "../src/config.js";
import { decideApproval, loadApprovals, requestApproval } from "../src/runtime/approvals.js";
import { runControlTower } from "../src/runtime/control-tower.js";
import { ingestRecord } from "../src/runtime/intake.js";
import { loadTaskboard, replaceTaskboard } from "../src/runtime/taskboard.js";
import {
  CONTROL_PLANE_LEASE_FILE,
  ControlPlaneLeaseError,
  ControlPlaneLeaseLostError,
  acquireControlPlaneLease,
  controlPlaneSurface,
  readControlPlaneLease,
  releaseControlPlaneLease,
  renewControlPlaneLease,
  setControlPlaneSurface,
  withControlPlaneLease
} from "../src/runtime/control-plane-lease.js";
import { makeTempDirectory } from "./helpers.js";

async function makeProject(t) {
  const parent = await makeTempDirectory("product-ops-lease-");
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "product");
  await initCommand(root, {});
  return root;
}

function leasePath(root) {
  return path.join(root, CONTROL_PLANE_LEASE_FILE);
}

/** A lease written by a process that is not running, so liveness detection treats it as reclaimable. */
async function writeForeignLease(root, overrides = {}) {
  const file = leasePath(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const lease = {
    schemaVersion: "1.0.0",
    holderId: "00000000-0000-4000-8000-00000000dead",
    surface: "dashboard",
    pid: 999_999_999,
    acquiredAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides
  };
  await fs.writeFile(file, `${JSON.stringify(lease)}\n`, "utf8");
  return lease;
}

test("the declared surface is validated and reported", () => {
  assert.equal(controlPlaneSurface(), "cli");
  assert.throws(() => setControlPlaneSurface("something-else"), /Unknown control-plane surface/);
  assert.equal(controlPlaneSurface(), "cli", "a rejected surface must not be adopted");
});

test("a lease is exclusive, attributed, and released", async (t) => {
  const root = await makeProject(t);
  const lease = await acquireControlPlaneLease(root);
  assert.equal(lease.surface, "cli");
  assert.equal(lease.pid, process.pid);

  const stored = await readControlPlaneLease(root);
  assert.equal(stored.holderId, lease.holderId);

  await assert.rejects(
    acquireControlPlaneLease(root, { waitMs: 0 }),
    (error) => error instanceof ControlPlaneLeaseError && error.code === "WRITE_LEASE_HELD"
  );

  await releaseControlPlaneLease(lease);
  assert.equal(await readControlPlaneLease(root), null);

  const second = await acquireControlPlaneLease(root);
  assert.notEqual(second.holderId, lease.holderId);
  await releaseControlPlaneLease(second);
});

test("a refusal names the surface that is holding the lease", async (t) => {
  const root = await makeProject(t);
  await writeForeignLease(root, { pid: process.pid, surface: "dashboard" });
  t.after(() => fs.rm(leasePath(root), { force: true }));

  await assert.rejects(
    acquireControlPlaneLease(root, { waitMs: 0 }),
    (error) => error.holderSurface === "dashboard" && /dashboard/.test(error.message)
  );
});

test("an expired lease and a dead holder are both reclaimed", async (t) => {
  const root = await makeProject(t);

  await writeForeignLease(root, { pid: process.pid, expiresAt: new Date(Date.now() - 1000).toISOString() });
  const afterExpiry = await acquireControlPlaneLease(root, { waitMs: 0 });
  assert.equal(afterExpiry.pid, process.pid);
  await releaseControlPlaneLease(afterExpiry);

  await writeForeignLease(root);
  const afterDeadHolder = await acquireControlPlaneLease(root, { waitMs: 0 });
  assert.equal(afterDeadHolder.pid, process.pid);
  await releaseControlPlaneLease(afterDeadHolder);
});

test("a corrupt lease file does not wedge the control plane", async (t) => {
  const root = await makeProject(t);
  await fs.mkdir(path.dirname(leasePath(root)), { recursive: true });
  await fs.writeFile(leasePath(root), "{ not json", "utf8");
  const lease = await acquireControlPlaneLease(root, { waitMs: 0 });
  assert.equal(lease.pid, process.pid);
  await releaseControlPlaneLease(lease);
});

test("withControlPlaneLease is re-entrant and always releases", async (t) => {
  const root = await makeProject(t);

  const depth = await withControlPlaneLease(root, async (outer) =>
    withControlPlaneLease(root, async (inner) => {
      assert.equal(inner.holderId, outer.holderId, "nesting must re-enter rather than take a second lease");
      return 2;
    }));
  assert.equal(depth, 2);
  assert.equal(await readControlPlaneLease(root), null, "the lease must be released after the outer scope");

  await assert.rejects(
    withControlPlaneLease(root, async () => { throw new Error("handler exploded"); }),
    /handler exploded/
  );
  assert.equal(await readControlPlaneLease(root), null, "a throwing handler must not strand the lease");
});

test("a held lease refuses every canonical write path, then permits them once released", async (t) => {
  const root = await makeProject(t);
  const config = await loadConfig(root);
  const { headers, records } = await loadTaskboard(root);
  await ingestRecord(root, {
    type: "new_idea",
    title: "Lease contention probe",
    description: "Ensures a foreign holder blocks every canonical write path.",
    source: "test"
  }, { dryRun: false });

  await writeForeignLease(root, { pid: process.pid, surface: "dashboard" });
  const blocked = { waitMs: 0 };

  await assert.rejects(
    withControlPlaneLease(root, async () => "unreachable", blocked),
    (error) => error.code === "WRITE_LEASE_HELD"
  );
  await assert.rejects(
    replaceTaskboard(root, headers, records, { dryRun: false }),
    (error) => error.code === "WRITE_LEASE_HELD"
  );
  await assert.rejects(
    requestApproval(root, { taskId: records[0].task_id, gate: "risk_acceptance", question: "?" }, { dryRun: false }),
    (error) => error.code === "WRITE_LEASE_HELD"
  );
  await assert.rejects(
    runControlTower(root, config, { dryRun: false }),
    (error) => error.code === "WRITE_LEASE_HELD"
  );

  // Planning never mutates, so it must stay available while another surface writes.
  const planned = await runControlTower(root, config, { dryRun: true });
  assert.equal(planned.dryRun, true);
  assert.ok(planned.actions.length > 0);

  await fs.rm(leasePath(root), { force: true });
  const applied = await runControlTower(root, config, { dryRun: false });
  assert.equal(applied.dryRun, false);
  assert.equal(await readControlPlaneLease(root), null, "the cycle must release the lease it took");
});

test("concurrent decisions on one gate resolve to a single disposition", async (t) => {
  const root = await makeProject(t);
  const config = await loadConfig(root);
  const { records } = await loadTaskboard(root);
  await requestApproval(root, {
    taskId: records[0].task_id,
    gate: "product_direction_or_priority",
    question: "Approve?"
  }, { dryRun: false });
  const [request] = (await loadApprovals(root)).requests;

  const attempt = () => decideApproval(root, config, {
    requestId: request.requestId,
    decision: "approved",
    actorId: config.project.humanAuthorityActorId,
    rationale: "Concurrent attempt."
  }, { dryRun: false });

  const settled = await Promise.allSettled([attempt(), attempt(), attempt()]);
  const fulfilled = settled.filter((entry) => entry.status === "fulfilled");
  assert.equal(fulfilled.length, 1, "exactly one attempt may record a disposition");
  for (const rejected of settled.filter((entry) => entry.status === "rejected")) {
    assert.match(rejected.reason.message, /already has a disposition/);
  }

  const stored = (await loadApprovals(root)).requests.find((item) => item.requestId === request.requestId);
  assert.equal(stored.status, "approved");
  assert.equal(stored.rationale, "Concurrent attempt.");
});

test("separate processes contending for one gate all reach a definite outcome", async (t) => {
  // The point of the lease is exclusion across processes, which an in-process test cannot show.
  // This also pins the wait behaviour: a contending process must stay alive long enough to acquire
  // the lease and report an outcome. An unref'd poll timer lets it exit mid-wait, writing nothing
  // and reporting nothing, which reads as success to a caller.
  const root = await makeProject(t);
  const { records } = await loadTaskboard(root);
  await requestApproval(root, {
    taskId: records[0].task_id,
    gate: "risk_acceptance",
    question: "Accept the residual risk?"
  }, { dryRun: false });
  const [request] = (await loadApprovals(root)).requests;

  const repositoryRoot = path.dirname(import.meta.dirname);
  const child = (surface) => new Promise((resolve) => {
    const script = `
      const root = ${JSON.stringify(root)};
      const repo = ${JSON.stringify(repositoryRoot)};
      const url = (p) => new URL(p, "file:///" + repo.replaceAll("\\\\", "/") + "/").href;
      const { loadConfig } = await import(url("src/config.js"));
      const { decideApproval } = await import(url("src/runtime/approvals.js"));
      const { setControlPlaneSurface } = await import(url("src/runtime/control-plane-lease.js"));
      setControlPlaneSurface(${JSON.stringify(surface)});
      const config = await loadConfig(root);
      try {
        await decideApproval(root, config, {
          requestId: ${JSON.stringify(request.requestId)},
          decision: "approved",
          actorId: config.project.humanAuthorityActorId,
          rationale: "Recorded by " + ${JSON.stringify(surface)} + "."
        }, { dryRun: false });
        console.log("OK");
      } catch (error) {
        console.log("REFUSED " + error.message);
      }
    `;
    let stdout = "";
    const spawned = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
    spawned.stdout.on("data", (chunk) => { stdout += chunk; });
    spawned.on("close", (code) => resolve({ surface, code, stdout: stdout.trim() }));
  });

  const results = await Promise.all([child("dashboard"), child("mcp"), child("cli")]);
  for (const result of results) {
    assert.equal(result.code, 0, `${result.surface} exited with ${result.code}`);
    assert.notEqual(result.stdout, "", `${result.surface} exited silently instead of reporting an outcome`);
    assert.match(result.stdout, /^(OK|REFUSED )/, `${result.surface} reported "${result.stdout}"`);
  }
  assert.equal(results.filter((result) => result.stdout === "OK").length, 1, "exactly one process may record the disposition");
  for (const refused of results.filter((result) => result.stdout !== "OK")) {
    assert.match(refused.stdout, /already has a disposition/);
  }

  const stored = (await loadApprovals(root)).requests.find((item) => item.requestId === request.requestId);
  assert.equal(stored.status, "approved");
  assert.equal(await readControlPlaneLease(root), null, "every process must release what it took");
});

test("a holder whose work outlives the term keeps the lease", async (t) => {
  // A term that is never extended is a deadline on the work rather than a lock: the holder is still
  // writing when the lease is judged abandoned, and the surface that reclaims it joins it inside the
  // critical section. Under full-suite load that is how two writers once met on the approval store.
  const root = await makeProject(t);
  let contender = null;

  // Sleeping through several terms and hoping the timer keeps up measures the machine, not the
  // lease: expiry is wall-clock while the beat is a timer, so under the full suite the two drift
  // apart and this failed while passing alone. Widening the term twice did not fix it, because
  // nothing bounds the drift.
  //
  // The lease is therefore taken directly rather than through the wrapper, so no heartbeat is
  // running, and renewal is driven here the way a healthy beat drives it: once per term, in
  // sequence. Renewal is serialised by design, so driving it concurrently would race a beat rather
  // than test one. What this holds is that a renewed term is not reclaimable — with no dependence on
  // whether a loaded event loop reached a timer in time.
  const lease = await acquireControlPlaneLease(root, { ttlMs: 300 });
  t.after(() => releaseControlPlaneLease(lease).catch(() => {}));
  for (let beat = 0; beat < 4; beat += 1) {
    assert.equal(await renewControlPlaneLease(lease, { ttlMs: 300 }), "renewed", `beat ${beat + 1} must extend the term`);
  }
  contender = await acquireControlPlaneLease(root, { waitMs: 0 })
    .then((taken) => releaseControlPlaneLease(taken).then(() => "acquired"))
    .catch((error) => error.code);
  await releaseControlPlaneLease(lease);

  assert.equal(contender, "WRITE_LEASE_HELD", "a beating holder must not be displaced mid-write");
  assert.equal(await readControlPlaneLease(root), null, "the holder must still release its own lease");
});

/**
 * The heartbeat used to infer displacement from its own clock: a beat that fired after the term it
 * was meant to extend had lapsed, and hit one transient write failure, condemned a lease nobody had
 * touched. Under load a beat firing late and a replace failing are both ordinary — this makes both
 * happen at once and requires the holder to survive, because only the file says who holds a lease.
 */
test("a late beat that cannot write does not surrender a lease nobody took", async (t) => {
  const root = await makeProject(t);
  const leaseFile = path.join(root, CONTROL_PLANE_LEASE_FILE);
  let held = null;

  await withControlPlaneLease(root, async (lease) => {
    // Renewal stages the new lease under an exclusive name before renaming it into place. Occupying
    // that name makes every replace inside the term fail the way disk contention does, while the
    // lease file itself stays intact and keeps naming this holder.
    const staging = `${leaseFile}.${lease.holderId}.renew.tmp`;
    await fs.writeFile(staging, "occupied", "utf8");
    await new Promise((resolve) => { setTimeout(resolve, 1_200); }); // four terms of failed beats
    await fs.rm(staging, { force: true });
    await new Promise((resolve) => { setTimeout(resolve, 300); });
    held = (await readControlPlaneLease(root))?.holderId === lease.holderId;
  }, { ttlMs: 300 });

  assert.equal(held, true, "the lease file still named this holder throughout");
});

test("a beat that finds another holder in the file does surrender the lease", async (t) => {
  const root = await makeProject(t);
  const leaseFile = path.join(root, CONTROL_PLANE_LEASE_FILE);

  await assert.rejects(
    withControlPlaneLease(root, async () => {
      const stolen = JSON.parse(await fs.readFile(leaseFile, "utf8"));
      stolen.holderId = "00000000-0000-4000-8000-000000000000";
      await fs.writeFile(leaseFile, `${JSON.stringify(stolen, null, 2)}\n`, "utf8");
      await new Promise((resolve) => { setTimeout(resolve, 500); });
    }, { ttlMs: 300 }),
    (error) => error instanceof ControlPlaneLeaseLostError
  );
});

test("a displaced holder fails its write instead of racing the surface that replaced it", async (t) => {
  const root = await makeProject(t);
  const { headers, records } = await loadTaskboard(root);

  await assert.rejects(
    withControlPlaneLease(root, async (lease) => {
      // Whatever the cause — a stalled term, an operator deleting the file — the lease is now
      // someone else's. The write must not proceed on the strength of having once held it.
      await fs.rm(lease.file, { force: true });
      const usurper = await acquireControlPlaneLease(root, { waitMs: 0 });
      t.after(() => releaseControlPlaneLease(usurper));
      await replaceTaskboard(root, headers, records, { dryRun: false });
    }),
    (error) => error instanceof ControlPlaneLeaseLostError && error.code === "WRITE_LEASE_LOST"
  );
});

test("a lease is never observable half-written", async (t) => {
  // An exclusive create is not an atomic one: it makes the file, then fills it. A contender reading
  // in between sees zero bytes, cannot parse them, and treats a live lease as corrupt.
  const root = await makeProject(t);
  const file = leasePath(root);
  let torn = 0;
  let complete = 0;
  let stop = false;

  const reader = (async () => {
    while (!stop) {
      let text;
      try {
        text = await fs.readFile(file, "utf8");
      } catch {
        // Absent, or locked by a concurrent unlink. Neither is a half-written lease.
        continue;
      }
      try {
        JSON.parse(text);
        complete += 1;
      } catch {
        torn += 1;
      }
    }
  })();

  for (let index = 0; index < 200; index += 1) {
    await releaseControlPlaneLease(await acquireControlPlaneLease(root, { waitMs: 2_000 }));
  }
  stop = true;
  await reader;

  assert.ok(complete > 0, "the reader must have observed the lease at least once");
  assert.equal(torn, 0, `a reader observed ${torn} unparseable lease states`);
});

test("one unreadable observation does not destroy a live lease", async (t) => {
  // Belt and braces behind the atomic create. "Unreadable" is evidence of corruption only when it
  // stays unreadable; a single bad read is evidence of a concurrent writer.
  const root = await makeProject(t);
  const holder = await acquireControlPlaneLease(root, { ttlMs: 60_000 });
  t.after(() => releaseControlPlaneLease(holder));

  const real = fs.readFile;
  let tornOnce = false;
  t.mock.method(fs, "readFile", async (...args) => {
    if (!tornOnce && String(args[0]) === leasePath(root)) {
      tornOnce = true;
      return "";
    }
    return real.apply(fs, args);
  });

  await assert.rejects(
    acquireControlPlaneLease(root, { waitMs: 0 }),
    (error) => error.code === "WRITE_LEASE_HELD"
  );
  assert.ok(tornOnce, "the torn read must actually have been served");
  assert.equal(
    (await readControlPlaneLease(root))?.holderId,
    holder.holderId,
    "the live holder must still own the lease"
  );
});

test("the lease file never reaches a validated project tree as canonical state", async (t) => {
  const root = await makeProject(t);
  const lease = await acquireControlPlaneLease(root);
  assert.match(CONTROL_PLANE_LEASE_FILE, /^\.product-ops\/runtime\//, "the lease must live under the runtime directory");
  const { validateProject } = await import("../src/validation.js");
  const result = await validateProject(root, await loadConfig(root));
  assert.deepEqual(result.errors, [], "a held lease must not make the project invalid");
  await releaseControlPlaneLease(lease);
});
