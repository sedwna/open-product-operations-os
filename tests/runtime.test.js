import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { queueProviderItem, syncProvider } from "../src/adapters/provider-sync.js";
import { loadConfig } from "../src/config.js";
import { CONFIG_FILE, TASKBOARD_FILE } from "../src/constants.js";
import { parseCsv, stringifyCsv } from "../src/csv.js";
import { run } from "../src/cli.js";
import { decideApproval, loadApprovals } from "../src/runtime/approvals.js";
import { configureProject } from "../src/runtime/configure.js";
import { runControlTower } from "../src/runtime/control-tower.js";
import { buildDashboard, exportMetrics } from "../src/runtime/dashboard.js";
import { startDashboardServer } from "../src/runtime/dashboard-server.js";
import { runDevelopmentTask } from "../src/runtime/development-runner.js";
import { ingestRecord } from "../src/runtime/intake.js";
import { migrateProject } from "../src/runtime/migrations.js";
import { buildSetupWizard } from "../src/runtime/setup-wizard.js";
import { captureIo, makeTempDirectory, readJson, writeJson } from "./helpers.js";

async function initializedProject(t, name = "runtime-product") {
  const parent = await makeTempDirectory("product-ops-runtime-");
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const target = path.join(parent, name);
  const output = captureIo();
  assert.equal(await run(["init", target], output.io), 0);
  return { parent, target, output };
}

test("control tower selects ready tasks and routes normalized intake", async (t) => {
  const { target, output } = await initializedProject(t);
  const config = await loadConfig(target);
  await ingestRecord(target, {
    type: "new_idea",
    title: "Synthetic summary preference",
    description: "Allow a synthetic user to select a local summary day.",
    source: "local synthetic fixture",
    priority: "P2"
  }, { dryRun: false, now: new Date("2026-08-01T10:00:00Z") });

  const receipt = await runControlTower(target, config, {
    dryRun: true,
    now: new Date("2026-08-01T10:01:00Z")
  });
  assert.ok(receipt.actions.some((action) => action.type === "dispatch_task" && action.ownerRole === "RB-03"));
  assert.ok(receipt.actions.some((action) => action.type === "route_intake" && action.ownerRole === "RB-02"));
  const applied = await runControlTower(target, config, {
    dryRun: false,
    now: new Date("2026-08-01T10:02:00Z")
  });
  assert.equal(applied.actions.filter((action) => action.type === "create_task").length, 12);
  const taskRows = parseCsv(await fs.readFile(path.join(target, TASKBOARD_FILE), "utf8"));
  assert.equal(taskRows.length, 14);
  const verifierTask = taskRows.find((row) => row[3] === "RB-12");
  assert.equal(verifierTask[14], "RB-08");
  const eventRows = taskRows.filter((row, index) => index > 0 && row[1] === "EVT-20260801-001");
  eventRows[0][5] = "done";
  await fs.writeFile(path.join(target, TASKBOARD_FILE), stringifyCsv(taskRows), "utf8");
  const progressed = await runControlTower(target, config, {
    dryRun: false,
    now: new Date("2026-08-01T10:03:00Z")
  });
  assert.ok(progressed.actions.some((action) => action.type === "promote_task" && action.taskId === eventRows[1][0]));
  assert.equal(await run(["validate", target], output.io), 0);
});

test("control tower creates durable human gates and dispatches only after attributed approval", async (t) => {
  const { target } = await initializedProject(t, "approval-product");
  const config = await loadConfig(target);
  const taskboardPath = path.join(target, TASKBOARD_FILE);
  const rows = parseCsv(await fs.readFile(taskboardPath, "utf8"));
  rows[1][16] = "product_direction_or_priority";
  await fs.writeFile(taskboardPath, stringifyCsv(rows), "utf8");

  const before = await runControlTower(target, config, { dryRun: false, now: new Date("2026-08-01T11:00:00Z") });
  assert.ok(before.actions.some((action) => action.type === "request_human_approval"));
  assert.ok(!before.actions.some((action) => action.type === "dispatch_task"));
  const store = await loadApprovals(target);
  assert.equal(store.requests.length, 1);

  await decideApproval(target, config, {
    requestId: store.requests[0].requestId,
    decision: "approved",
    actorId: config.project.humanAuthorityActorId,
    rationale: "Synthetic approval for local test."
  }, { dryRun: false, now: new Date("2026-08-01T11:01:00Z") });
  const after = await runControlTower(target, config, { dryRun: true, now: new Date("2026-08-01T11:02:00Z") });
  assert.ok(after.actions.some((action) => action.type === "dispatch_task"));
});

test("intake deduplicates normalized records and rejects credential material", async (t) => {
  const { target } = await initializedProject(t, "intake-product");
  const input = {
    type: "feedback",
    title: "Local search feedback",
    description: "Synthetic users need clearer local search results.",
    source: "reserved fixture"
  };
  const first = await ingestRecord(target, input, { dryRun: false, now: new Date("2026-08-01T12:00:00Z") });
  const second = await ingestRecord(target, { ...input, title: "  LOCAL search feedback " }, { dryRun: false, now: new Date("2026-08-01T12:01:00Z") });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.record.duplicateOf, first.record.intakeId);
  await assert.rejects(
    ingestRecord(target, { ...input, description: "api_key=synthetic-credential-material" }),
    /credential material/
  );
});

test("development runner dispatches an eligible RB-13 task through a shell-free command contract", async (t) => {
  const { target } = await initializedProject(t, "development-product");
  const configPath = path.join(target, CONFIG_FILE);
  const config = await readJson(configPath);
  config.adapters.development.enabled = true;
  config.adapters.development.settings.executable = "node";
  config.adapters.development.settings.arguments = ["tools/synthetic-agent.mjs", "{taskFile}"];
  await writeJson(configPath, config);
  await fs.mkdir(path.join(target, "tools"));
  await fs.writeFile(path.join(target, "tools", "synthetic-agent.mjs"), `import fs from "node:fs";\nconst input=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));\nprocess.stdout.write(JSON.stringify({schemaVersion:"1.0.0",taskId:input.taskId,status:"implementation_complete",implementationReference:"synthetic-ref-1",changedComponents:["local-demo"],tests:["synthetic test passed"],environmentRevision:"local-1",knownRisks:[],notes:"Synthetic agent result.",completedAt:"2026-08-01T13:00:00Z"}));\n`, "utf8");
  const taskboardPath = path.join(target, TASKBOARD_FILE);
  const rows = parseCsv(await fs.readFile(taskboardPath, "utf8"));
  rows.push([
    "TASK-RB-13-20260801-001", "EVT-00000000-001", "Implement synthetic local behavior",
    "RB-13", "actor-rb-13", "ready", "P2", "", "", "", "", "", "", "",
    "RB-12", "actor-rb-12", "", "", "2026-08-01T12:55:00Z"
  ]);
  await fs.writeFile(taskboardPath, stringifyCsv(rows), "utf8");

  const result = await runDevelopmentTask(target, config, "TASK-RB-13-20260801-001", { dryRun: false });
  assert.equal(result.result.status, "implementation_complete");
  assert.equal(result.result.implementationReference, "synthetic-ref-1");
  assert.equal((await readJson(path.join(target, result.resultFile))).taskId, "TASK-RB-13-20260801-001");
});

test("provider queue defaults to dry-run and records hash-only receipts on authorized execution", async (t) => {
  const { target } = await initializedProject(t, "provider-product");
  const catalogPath = path.join(target, "adapters", "providers.json");
  const catalog = await readJson(catalogPath);
  catalog.providers.github.enabled = true;
  await writeJson(catalogPath, catalog);
  const item = {
    id: "provider-item-1",
    provider: "github",
    operation: "create_task",
    method: "POST",
    endpoint: "/repos/example/example/issues",
    payload: { title: "Synthetic task" },
    responseFields: ["id", "state"]
  };
  await queueProviderItem(target, item, { dryRun: false });
  const plan = await syncProvider(target, "github", { dryRun: true });
  assert.equal(plan.plannedRequests.length, 1);
  const previous = process.env.PRODUCT_OPS_GITHUB_TOKEN;
  process.env.PRODUCT_OPS_GITHUB_TOKEN = ["synthetic", "credential"].join("-");
  t.after(() => {
    if (previous === undefined) delete process.env.PRODUCT_OPS_GITHUB_TOKEN;
    else process.env.PRODUCT_OPS_GITHUB_TOKEN = previous;
  });
  const result = await syncProvider(target, "github", {
    dryRun: false,
    fetchImplementation: async () => ({ ok: true, status: 201, text: async () => "{\"id\":1,\"state\":\"open\"}" }),
    now: new Date("2026-08-01T14:00:00Z")
  });
  assert.equal(result.receipts.length, 1);
  assert.match(result.receipts[0].responseSha256, /^[a-f0-9]{64}$/);
  assert.equal((await readJson(path.join(target, ".product-ops/runtime/provider-outbox.json"))).items[0].status, "completed");
  assert.deepEqual(
    (await readJson(path.join(target, ".product-ops/runtime/provider-inbox.json"))).records[0].data,
    { id: 1, state: "open" }
  );
});

test("workbook provider writes require controls and verify complete read-back", async (t) => {
  const { target } = await initializedProject(t, "workbook-provider-product");
  const catalogPath = path.join(target, "adapters", "providers.json");
  const catalog = await readJson(catalogPath);
  catalog.providers.google_sheets.enabled = true;
  await writeJson(catalogPath, catalog);
  const readback = "{\"values\":[[\"synthetic\"]]}";
  const item = {
    id: "workbook-item-1",
    provider: "google_sheets",
    operation: "write_range",
    method: "POST",
    endpoint: "/spreadsheets/example/values/Sheet1!A1:append",
    payload: { values: [["synthetic"]] },
    controls: {
      approvedPlanHash: crypto.createHash("sha256").update("plan").digest("hex"),
      humanAuthorizationId: "human-authorization-1",
      preconditionHash: crypto.createHash("sha256").update("before").digest("hex"),
      expectedReadbackSha256: crypto.createHash("sha256").update(readback).digest("hex"),
      rollbackPlan: "Restore the prior bounded range.",
      readbackEndpoint: "/spreadsheets/example/values/Sheet1!A1"
    }
  };
  await queueProviderItem(target, item, { dryRun: false });
  const previous = process.env.PRODUCT_OPS_GOOGLE_TOKEN;
  process.env.PRODUCT_OPS_GOOGLE_TOKEN = ["synthetic", "credential"].join("-");
  t.after(() => {
    if (previous === undefined) delete process.env.PRODUCT_OPS_GOOGLE_TOKEN;
    else process.env.PRODUCT_OPS_GOOGLE_TOKEN = previous;
  });
  let calls = 0;
  const result = await syncProvider(target, "google_sheets", {
    dryRun: false,
    fetchImplementation: async () => {
      calls += 1;
      return calls === 1
        ? { ok: true, status: 200, text: async () => "{\"updated\":true}" }
        : { ok: true, status: 200, text: async () => readback };
    }
  });
  assert.equal(calls, 2);
  assert.equal(result.receipts[0].disposition, "verified");
  assert.equal(result.receipts[0].readbackSha256, item.controls.expectedReadbackSha256);
});

test("dashboard, metrics, and setup wizard generate local RTL artifacts", async (t) => {
  const { target } = await initializedProject(t, "dashboard-product");
  await buildDashboard(target, { dryRun: false });
  await exportMetrics(target, { dryRun: false });
  await buildSetupWizard(target, { dryRun: false });
  const dashboard = await fs.readFile(path.join(target, ".product-ops/runtime/dashboard.html"), "utf8");
  assert.match(dashboard, /dir="rtl"/);
  assert.match(dashboard, /برج کنترل/);
  assert.match(dashboard, /window\.__PRODUCT_OPS__/);
  assert.match(dashboard, /prefers-reduced-motion/);
  assert.equal((await readJson(path.join(target, ".product-ops/runtime/metrics.json"))).totals.tasks, 1);
  assert.match(await fs.readFile(path.join(target, ".product-ops/setup.html"), "utf8"), /product-ops-answers\.json/);
});

test("interactive dashboard server is loopback-only, read-only by default, and CSRF guarded", async (t) => {
  const { target } = await initializedProject(t, "dashboard-server-product");
  const readOnly = await startDashboardServer(target, { port: 0 });
  t.after(() => readOnly.close());
  assert.match(readOnly.url, /^http:\/\/127\.0\.0\.1:/);
  assert.deepEqual(await (await fetch(`${readOnly.url}/health`)).json(), { status: "ok", writable: false });
  const snapshotResponse = await fetch(`${readOnly.url}/api/snapshot`);
  assert.equal(snapshotResponse.status, 200);
  assert.equal((await snapshotResponse.json()).project.name, "Dashboard Server Product");
  const refused = await fetch(`${readOnly.url}/api/intake`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-product-ops-csrf": "wrong" },
    body: JSON.stringify({ type: "new_idea", title: "No write", description: "Read only", source: "test" })
  });
  assert.equal(refused.status, 403);
  await assert.rejects(
    startDashboardServer(target, { port: 0, host: "0.0.0.0" }),
    /loopback/
  );
});

test("writable dashboard records bounded intake with its local authorization token", async (t) => {
  const { target } = await initializedProject(t, "dashboard-write-product");
  const dashboard = await startDashboardServer(target, { port: 0, writable: true });
  t.after(() => dashboard.close());
  const page = await fetch(dashboard.url);
  assert.match(page.headers.get("content-security-policy"), /script-src 'self' 'nonce-[A-Za-z0-9_-]+'/);
  assert.doesNotMatch(page.headers.get("content-security-policy"), /script-src[^;]*unsafe-inline/);
  const html = await page.text();
  const token = html.match(/name="product-ops-csrf" content="([^"]+)"/)[1];
  const response = await fetch(`${dashboard.url}/api/intake`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-product-ops-csrf": token },
    body: JSON.stringify({
      type: "new_idea",
      title: "Synthetic dashboard idea",
      description: "A bounded synthetic dashboard write.",
      source: "local test",
      priority: "P2"
    })
  });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).record.status, "proposed");
  assert.equal((await readJson(path.join(target, ".product-ops/runtime/intake.json"))).records.length, 1);
});

test("configuration answers refresh scaffold while preserving operational rows", async (t) => {
  const { parent, target, output } = await initializedProject(t, "configured-product");
  const answersFile = path.join(parent, "answers.json");
  await writeJson(answersFile, {
    name: "Configured Product",
    vision: "A synthetic configured product vision.",
    targetUsers: ["Synthetic coordinators"],
    environments: ["local", "test"],
    humanAuthorityActorId: "human-configured-owner"
  });
  await configureProject(target, await loadConfig(target), answersFile, { dryRun: false });
  assert.equal((await readJson(path.join(target, CONFIG_FILE))).project.name, "Configured Product");
  assert.equal(await run(["validate", target], output.io), 0);
});

test("migration upgrades a legacy generated project with a recoverable configuration snapshot", async (t) => {
  const { target, output } = await initializedProject(t, "legacy-product");
  const configPath = path.join(target, CONFIG_FILE);
  const legacy = await readJson(configPath);
  delete legacy.operations;
  delete legacy.separation.verificationOfVerifierRole;
  for (const route of legacy.routing) delete route.steps;
  for (const adapter of Object.values(legacy.adapters)) {
    delete adapter.implementation;
    delete adapter.settings;
  }
  legacy.adapters.development.type = "placeholder";
  legacy.adapters.git.type = "placeholder";
  await writeJson(configPath, legacy);
  const result = await migrateProject(target, legacy, { dryRun: false, now: new Date("2026-08-01T15:00:00Z") });
  assert.equal(result.toVersion, 2);
  assert.equal((await readJson(configPath)).operations.modelVersion, 2);
  assert.equal((await readJson(configPath)).separation.verificationOfVerifierRole, "RB-08");
  assert.ok((await readJson(configPath)).routing.every((route) => route.steps.length > 0));
  await fs.access(path.join(target, ".product-ops/migrations", result.runId, CONFIG_FILE));
  assert.equal(await run(["validate", target], output.io), 0);
});
