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
import { exportMetrics, loadEngineeringProgress } from "../src/runtime/snapshot.js";
import { runDevelopmentTask } from "../src/runtime/development-runner.js";
import { ingestRecord } from "../src/runtime/intake.js";
import { migrateProject } from "../src/runtime/migrations.js";
import { captureIo, makeTempDirectory, readJson, writeJson } from "./helpers.js";

async function initializedProject(t, name = "runtime-product") {
  const parent = await makeTempDirectory("product-ops-runtime-");
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const target = path.join(parent, name);
  const output = captureIo();
  assert.equal(await run(["init", target], output.io), 0);
  return { parent, target, output };
}

test("the workspace snapshot summarizes the linked engineering taskboard", async (t) => {
  const root = await makeTempDirectory("product-ops-engineering-progress-");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "engineering", "taskboard");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "workstreams.csv"), stringifyCsv([
    ["workstream_id", "request_id", "owner_role", "domain", "title", "status", "dependency_ids", "evidence_refs", "updated_at"],
    ["WS-01", "DEVREQ-1", "ENG-01", "coordination", "Coordinate", "completed", "", "", "2026-08-02T10:00:00Z"],
    ["WS-02", "DEVREQ-1", "ENG-02", "architecture", "Architect", "in_progress", "WS-01", "", "2026-08-02T10:01:00Z"],
    ["WS-03", "DEVREQ-1", "ENG-03", "frontend", "Build", "ready", "WS-02", "", "2026-08-02T10:02:00Z"]
  ]), "utf8");

  const progress = await loadEngineeringProgress(root);
  assert.equal(progress.total, 3);
  assert.equal(progress.completed, 1);
  assert.equal(progress.active[0].id, "WS-02");
  assert.equal(progress.ready, 1);
});

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
  assert.equal(applied.actions.filter((action) => action.type === "create_task").length, 13);
  const taskRows = parseCsv(await fs.readFile(path.join(target, TASKBOARD_FILE), "utf8"));
  assert.equal(taskRows.length, 15);
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

/**
 * Routing used to be a queue of one: every step waited on whichever step was written before it,
 * so validation design sat behind implementation and the board could only ever offer one card.
 * These hold the shape that replaced it — what waits on what, and what no longer does.
 */
test("work that shares a predecessor is routed to run together", async (t) => {
  const { target } = await initializedProject(t, "parallel-routing");
  const config = await loadConfig(target);
  await ingestRecord(target, {
    type: "new_idea",
    title: "Parallel routing fixture",
    description: "An idea routed through the full product chain.",
    source: "local synthetic fixture",
    priority: "P2"
  }, { dryRun: false, now: new Date("2026-08-01T10:00:00Z") });
  await runControlTower(target, config, { dryRun: false, now: new Date("2026-08-01T10:02:00Z") });

  const rows = parseCsv(await fs.readFile(path.join(target, TASKBOARD_FILE), "utf8"));
  const header = rows[0];
  const tasks = rows.slice(1)
    .filter((row) => row[header.indexOf("event_id")] === "EVT-20260801-001")
    .map((row) => Object.fromEntries(header.map((name, index) => [name, row[index]])));
  const byTitle = (fragment) => tasks.find((task) => task.title.includes(fragment));
  const dependenciesOf = (fragment) => byTitle(fragment).dependency_ids.split("|").filter(Boolean);

  const contract = byTitle("delivery contract");
  // Three teams read the same delivery contract. None of them is a step in the others' way.
  for (const fragment of ["Design validation", "Audit assumptions", "Implement approved delivery"]) {
    assert.deepEqual(dependenciesOf(fragment), [contract.task_id], `${fragment} waits on the contract alone`);
  }
  assert.ok(
    !dependenciesOf("Design validation").includes(byTitle("Implement approved delivery").task_id),
    "designing the validation must not wait for the thing it is meant to validate"
  );
  // QA is where the two rejoin, and it needs both.
  assert.deepEqual(
    dependenciesOf("Execute QA").sort(),
    [byTitle("Design validation").task_id, byTitle("Implement approved delivery").task_id].sort()
  );
  // Exactly one card opens the event; everything else is held until what it named is done.
  assert.equal(tasks.filter((task) => task.status === "ready").length, 1);
  assert.equal(tasks.filter((task) => task.status === "ready")[0].title, "Triage idea");
  assert.ok(tasks.some((task) => task.owner_role === "RB-08"), "risk and logic audit is asked on a normal delivery");
});

test("a step that waits on more than one predecessor opens only when all of them are done", async (t) => {
  const { target } = await initializedProject(t, "join-routing");
  const config = await loadConfig(target);
  const complete = async (fragment) => {
    const rows = parseCsv(await fs.readFile(path.join(target, TASKBOARD_FILE), "utf8"));
    const titleColumn = rows[0].indexOf("title");
    const statusColumn = rows[0].indexOf("status");
    rows.find((row, index) => index > 0 && row[titleColumn].includes(fragment))[statusColumn] = "done";
    await fs.writeFile(path.join(target, TASKBOARD_FILE), stringifyCsv(rows), "utf8");
    return runControlTower(target, config, { dryRun: false, now: new Date("2026-08-01T10:03:00Z") });
  };
  const statusOf = async (fragment) => {
    const rows = parseCsv(await fs.readFile(path.join(target, TASKBOARD_FILE), "utf8"));
    const titleColumn = rows[0].indexOf("title");
    return rows.find((row, index) => index > 0 && row[titleColumn].includes(fragment))[rows[0].indexOf("status")];
  };

  await ingestRecord(target, {
    type: "user_finding",
    title: "Join routing fixture",
    description: "A finding whose delivery fans out and rejoins.",
    source: "local synthetic fixture",
    priority: "P2"
  }, { dryRun: false, now: new Date("2026-08-01T10:00:00Z") });
  await runControlTower(target, config, { dryRun: false, now: new Date("2026-08-01T10:02:00Z") });

  await complete("Triage finding");
  await complete("Author delivery contract");
  assert.equal(await statusOf("Design validation"), "ready");
  assert.equal(await statusOf("Implement approved delivery"), "ready");
  assert.equal(await statusOf("Execute QA"), "backlog");

  await complete("Design validation");
  assert.equal(await statusOf("Execute QA"), "backlog", "half a join is not a join");

  await complete("Implement approved delivery");
  assert.equal(await statusOf("Execute QA"), "ready");
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
  assert.equal(result.toVersion, 3);
  assert.equal((await readJson(configPath)).operations.modelVersion, 3);
  assert.equal((await readJson(configPath)).separation.verificationOfVerifierRole, "RB-08");
  assert.ok((await readJson(configPath)).routing.every((route) => route.steps.length > 0));
  // A route restored from the version-1 gap arrives at the current shape, keys and all.
  const migratedIdea = (await readJson(configPath)).routing.find((route) => route.event === "new_idea");
  assert.ok(migratedIdea.steps.every((step) => step.key), "every step is named so later steps can wait on it");
  assert.deepEqual(migratedIdea.steps.find((step) => step.key === "implement").after, ["contract"]);
  await fs.access(path.join(target, ".product-ops/migrations", result.runId, CONFIG_FILE));
  assert.equal(await run(["validate", target], output.io), 0);
});

test("migration parallelises untouched routes and leaves an edited one exactly as written", async (t) => {
  const { target, output } = await initializedProject(t, "custom-routing-product");
  const configPath = path.join(target, CONFIG_FILE);
  const legacy = await readJson(configPath);
  legacy.operations.modelVersion = 2;
  // The version-2 shape: a serial chain with no keys, and no risk audit on a delivery route.
  for (const route of legacy.routing) {
    route.steps = route.steps
      .filter((step) => step.key !== "risk")
      .map(({ role, title, humanGate }) => ({ role, title, humanGate }));
  }
  // One route its owner has deliberately changed. A routing table says how this product works;
  // an upgrade may improve what the owner did not decide, never overwrite what they did.
  const edited = legacy.routing.find((route) => route.event === "user_finding");
  edited.steps = [{ role: "RB-05", title: "Triage finding our way", humanGate: "" }];
  await writeJson(configPath, legacy);

  const result = await migrateProject(target, legacy, { dryRun: false, now: new Date("2026-08-01T15:00:00Z") });
  const migrated = await readJson(configPath);
  assert.ok(result.changes.some((change) => change.startsWith("routing_steps_parallelised:")));
  assert.ok(result.changes.some((change) => change.startsWith("routing_steps_left_as_customised:")));
  assert.deepEqual(
    migrated.routing.find((route) => route.event === "user_finding").steps,
    [{ role: "RB-05", title: "Triage finding our way", humanGate: "" }]
  );
  assert.deepEqual(
    migrated.routing.find((route) => route.event === "new_idea").steps.find((step) => step.key === "validation-design").after,
    ["contract"]
  );
  assert.equal(await run(["validate", target], output.io), 0);
});

test("metrics still produce their local artifact", async (t) => {
  // Covered only by the dashboard test until the dashboard went; the feature outlived it.
  const { target } = await initializedProject(t, "artifacts-product");
  await exportMetrics(target, { dryRun: false });
  assert.equal((await readJson(path.join(target, ".product-ops/runtime/metrics.json"))).totals.tasks, 1);
});

/**
 * Three of the five things an owner can submit had no route of their own and fell through to
 * `new_idea`. An incident — something already broken in a live product — was sent through idea
 * triage, discovery research and a decision brief before anyone looked at it.
 */
test("an incident is routed as something wrong, not as a new idea", async (t) => {
  const { target } = await initializedProject(t, "incident-routing");
  const config = await loadConfig(target);
  await ingestRecord(target, {
    type: "incident",
    title: "Scores stopped saving an hour ago",
    description: "Every run since the deploy ends with the score lost.",
    source: "two players",
    priority: "P0"
  }, { dryRun: false, now: new Date("2026-08-01T10:00:00Z") });
  await runControlTower(target, config, { dryRun: false, now: new Date("2026-08-01T10:01:00Z") });

  const rows = parseCsv(await fs.readFile(path.join(target, TASKBOARD_FILE), "utf8"));
  const header = rows[0];
  const titles = rows.slice(1)
    .filter((row) => row[header.indexOf("event_id")] === "EVT-20260801-001")
    .map((row) => row[header.indexOf("title")]);

  assert.ok(titles.includes("Triage finding"), `an incident takes the finding route: ${titles.join(", ")}`);
  assert.ok(!titles.includes("Complete discovery"), "and does not go through discovery research first");
  assert.ok(!titles.includes("Prepare decision brief"), "or wait on a decision brief");
});
