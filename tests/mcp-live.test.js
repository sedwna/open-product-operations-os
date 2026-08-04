import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { initCommand } from "../src/commands/init.js";
import { requestApproval } from "../src/runtime/approvals.js";
import { loadTaskboard, replaceTaskboard } from "../src/runtime/taskboard.js";
import { createHandlers, createServerContext } from "../src/mcp/server.js";
import { WATCHED_RESOURCE_URIS, watchCanonicalRecords } from "../src/mcp/watch.js";
import { RESOURCES } from "../src/mcp/resources.js";
import { makeTempDirectory } from "./helpers.js";

async function project(t) {
  const parent = await makeTempDirectory("product-ops-live-");
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "product");
  await initCommand(root, {});
  return root;
}

/** Watch, run an action, and collect whatever the watcher reported within the settle window. */
async function observe(root, act, { debounceMs = 40, settleMs = 700 } = {}) {
  const seen = [];
  const watcher = watchCanonicalRecords(root, (uris) => seen.push(...uris), { debounceMs });
  try {
    await act();
    await new Promise((resolve) => setTimeout(resolve, settleMs));
  } finally {
    watcher.close();
  }
  return [...new Set(seen)];
}

test("every watched URI is a resource the server actually serves", () => {
  for (const uri of WATCHED_RESOURCE_URIS) {
    assert.ok(RESOURCES.some((resource) => resource.uri === uri), `${uri} is watched but not served`);
  }
});

test("a task-board write marks the board resource stale", async (t) => {
  const root = await project(t);
  const loaded = await loadTaskboard(root);
  const seen = await observe(root, () => replaceTaskboard(root, loaded.headers, loaded.records.map((record) => ({
    ...record, blocked_reason: "touched by the watcher test"
  })), { dryRun: false }));
  assert.ok(seen.includes("productops://taskboard"), `expected the board, saw ${JSON.stringify(seen)}`);
});

test("recording a gate marks the approvals resource stale", async (t) => {
  const root = await project(t);
  const { records } = await loadTaskboard(root);
  const seen = await observe(root, () => requestApproval(root, {
    taskId: records[0].task_id, gate: "risk_acceptance", question: "Accept?"
  }, { dryRun: false }));
  assert.ok(seen.includes("productops://approvals/pending"), `expected approvals, saw ${JSON.stringify(seen)}`);
});

test("lease heartbeats and temporary files are not changes anyone subscribed to", async (t) => {
  const root = await project(t);
  const runtime = path.join(root, ".product-ops/runtime");
  await fs.mkdir(path.join(runtime, "autopilot"), { recursive: true });

  const seen = await observe(root, async () => {
    // Exactly what a running coordinator produces: a lease rewritten every few seconds, and the
    // temporary files an atomic replace leaves behind mid-write.
    for (let beat = 0; beat < 4; beat += 1) {
      await fs.writeFile(path.join(runtime, "control-plane.lease.json"), `{"beat":${beat}}`, "utf8");
      await fs.writeFile(path.join(runtime, "autopilot", "orchestrator.lease.json"), `{"beat":${beat}}`, "utf8");
    }
    await fs.writeFile(path.join(runtime, "approvals.json.1234.tmp"), "{}", "utf8");
    await fs.writeFile(path.join(runtime, "approvals.json.abc.bak"), "{}", "utf8");
  });
  assert.deepEqual(seen, [], "a heartbeat must never wake a subscriber");
});

test("one write produces one report, however many events the platform emits", async (t) => {
  // A single controlled write is a plan, a temporary file, a rename, and a mode change. The
  // filesystem reports several events for it; a subscriber should hear about it once.
  const root = await project(t);
  const loaded = await loadTaskboard(root);
  let reports = 0;
  const watcher = watchCanonicalRecords(root, () => { reports += 1; }, { debounceMs: 250 });
  t.after(() => watcher.close());

  await replaceTaskboard(root, loaded.headers, loaded.records.map((record) => ({
    ...record, blocked_reason: "single write"
  })), { dryRun: false });
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(reports, 1, `one write should report once, got ${reports}`);
});

test("a project whose runtime directories do not exist yet is still watched", async (t) => {
  // Approvals and cycle state live in directories created on first write. Watching only what
  // already exists would mean a fresh project reports nothing until the server is restarted.
  const root = await project(t);
  await fs.rm(path.join(root, ".product-ops"), { recursive: true, force: true });

  const watcher = watchCanonicalRecords(root, () => {});
  t.after(() => watcher.close());
  assert.equal(watcher.watching, 3, "board, runtime, and autopilot are all watched");

  const seen = await observe(root, async () => {
    const { records } = await loadTaskboard(root);
    await requestApproval(root, { taskId: records[0].task_id, gate: "risk_acceptance", question: "Accept?" }, { dryRun: false });
  });
  assert.ok(seen.includes("productops://approvals/pending"), `expected approvals, saw ${JSON.stringify(seen)}`);
});

test("the server declares subscription and only announces what was subscribed to", async (t) => {
  const root = await project(t);
  const context = await createServerContext({ project: root });
  const handlers = createHandlers(context, { version: "test" });

  const capabilities = handlers.initialize({ protocolVersion: "2026-07-28", capabilities: {} }).capabilities;
  assert.equal(capabilities.resources.subscribe, true);
  assert.equal(capabilities.resources.listChanged, false, "the resource set is fixed; its content is what changes");

  handlers["resources/subscribe"]({ uri: "productops://taskboard" });
  assert.deepEqual([...context.subscriptions], ["productops://taskboard"]);

  // Only a served resource may be subscribed to, and only a subscribed one is announced.
  assert.throws(() => handlers["resources/subscribe"]({ uri: "productops://nope" }), /not served/);
  assert.throws(() => handlers["resources/subscribe"]({}), /requires a uri/);

  const announced = ["productops://taskboard", "productops://approvals/pending"]
    .filter((uri) => context.subscriptions.has(uri));
  assert.deepEqual(announced, ["productops://taskboard"], "an unsubscribed resource must stay quiet");

  handlers["resources/unsubscribe"]({ uri: "productops://taskboard" });
  assert.equal(context.subscriptions.size, 0);
});
