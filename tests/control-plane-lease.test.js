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
  acquireControlPlaneLease,
  controlPlaneSurface,
  readControlPlaneLease,
  releaseControlPlaneLease,
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
  const config = await loadConfig(root);
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

test("the lease file never reaches a validated project tree as canonical state", async (t) => {
  const root = await makeProject(t);
  const lease = await acquireControlPlaneLease(root);
  assert.match(CONTROL_PLANE_LEASE_FILE, /^\.product-ops\/runtime\//, "the lease must live under the runtime directory");
  const { validateProject } = await import("../src/validation.js");
  const result = await validateProject(root, await loadConfig(root));
  assert.deepEqual(result.errors, [], "a held lease must not make the project invalid");
  await releaseControlPlaneLease(lease);
});
