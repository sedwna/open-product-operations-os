import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { run } from "../src/cli.js";
import { boundedUnique, runPendingAutopilotCycle } from "../src/autopilot/orchestrator.js";
import { runProductAgent } from "../src/autopilot/product-agent.js";
import { dependencyOrderedWorkstreams } from "../src/autopilot/engineering.js";
import { emptyAutopilotState, readAutopilotState, writeAutomationLink, writeAutopilotState } from "../src/autopilot/state.js";
import { loadConfig } from "../src/config.js";
import { initializeDevelopmentOs } from "../src/development/init.js";
import { ingestRecord } from "../src/runtime/intake.js";
import { runControlTower } from "../src/runtime/control-tower.js";
import { loadDashboardSnapshot } from "../src/runtime/dashboard.js";
import { loadTaskboard, replaceTaskboard } from "../src/runtime/taskboard.js";
import { materializeWriterCheckpoint } from "../src/autopilot/workbook.js";
import { captureIo, makeTempDirectory } from "./helpers.js";

test("autopilot completes the product-development-product loop and records a durable report", async (t) => {
  const parent = await makeTempDirectory("product-ops-autopilot-");
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const productRoot = path.join(parent, "sample-product-ops");
  const applicationRoot = path.join(parent, "sample-application");
  assert.equal(await run(["init", productRoot], captureIo().io), 0);
  const productConfigFile = path.join(productRoot, "product-ops.config.json");
  const productConfig = JSON.parse(await fs.readFile(productConfigFile, "utf8"));
  const originalSteps = productConfig.routing.find((route) => route.event === "new_idea").steps;
  productConfig.routing.find((route) => route.event === "new_idea").steps = [
    { role: "RB-02", title: "Analyze synthetic idea", humanGate: "product_direction_or_priority" },
    { role: "RB-13", title: "Implement synthetic idea", humanGate: "" },
    { role: "RB-11", title: "Report synthetic result", humanGate: "" }
  ];
  await fs.writeFile(productConfigFile, `${JSON.stringify(productConfig, null, 2)}\n`, "utf8");
  await fs.mkdir(applicationRoot, { recursive: true });
  await initializeDevelopmentOs(applicationRoot, { dryRun: false });
  await initializeGit(productRoot);
  await initializeGit(applicationRoot);
  await writeAutomationLink(productRoot, {
    schemaVersion: "1.0.0",
    applicationRelativePath: "../sample-application",
    provider: "codex",
    productExecutorsEnabled: true,
    engineeringExecutorsEnabled: true,
    autoStart: true,
    autoApproveInitialIdea: true,
    createdAt: "2026-08-02T00:00:00.000Z"
  });
  const intake = await ingestRecord(productRoot, {
    type: "new_idea",
    title: "Autonomous synthetic feature",
    description: "Build a bounded synthetic feature and return verified product evidence.",
    source: "autopilot integration test",
    priority: "P2",
    autopilotAuthorized: true
  }, { dryRun: false, now: new Date("2026-08-02T01:00:00.000Z") });

  await runControlTower(productRoot, productConfig, { dryRun: false, now: new Date("2026-08-02T01:00:10.000Z") });
  const beforeRecovery = await loadTaskboard(productRoot);
  const interrupted = beforeRecovery.records.find((task) => task.event_id === intake.record.eventId);
  assert.ok(interrupted);
  await replaceTaskboard(productRoot, beforeRecovery.headers, beforeRecovery.records.map((task) =>
    task.task_id === interrupted.task_id
      ? { ...task, status: "in_progress", updated_at: "2026-08-02T01:00:20.000Z" }
      : task
  ), { dryRun: false });
  await writeAutopilotState(productRoot, {
    ...emptyAutopilotState(new Date("2026-08-02T01:00:20.000Z")),
    status: "running",
    activeCycleId: `CYCLE-${intake.record.eventId}`,
    activeEventId: intake.record.eventId,
    phase: "product_analysis",
    currentTaskId: interrupted.task_id,
    currentRoleId: interrupted.owner_role,
    applicationRoot,
    startedAt: "2026-08-02T01:00:20.000Z"
  });

  const result = await runPendingAutopilotCycle(productRoot, {
    now: monotonicClock("2026-08-02T01:01:00.000Z"),
    executeProductAgent: stubProductAgent,
    executeEngineering: stubEngineering
  });

  assert.equal(result.status, "completed", result.error);
  const state = await readAutopilotState(productRoot);
  assert.equal(state.status, "completed");
  assert.ok(state.latestReport.endsWith(".md"));
  const tasks = (await loadTaskboard(productRoot)).records.filter((task) => task.event_id === intake.record.eventId);
  assert.equal(tasks.length, 3);
  assert.ok(tasks.every((task) => task.status === "done"));
  assert.ok(tasks.every((task) => task.canonical_output_refs.includes("product-runs")));
  const report = JSON.parse(await fs.readFile(path.join(productRoot, result.report.json), "utf8"));
  assert.equal(report.status, "completed");
  assert.deepEqual(report.implementation.changedComponents, ["src/feature.js"]);
  assert.equal(report.workbook.receipts.length, 13);
  const dashboard = await loadDashboardSnapshot(productRoot, { now: new Date("2026-08-02T02:00:00.000Z") });
  assert.equal(dashboard.autopilot.latestReport.cycleId, result.cycleId);
  assert.deepEqual(dashboard.autopilot.latestReport.implementation.changedComponents, ["src/feature.js"]);
  assert.match(await fs.readFile(path.join(productRoot, result.report.markdown), "utf8"), /گزارش چرخهٔ خودکار/);
  const approvals = JSON.parse(await fs.readFile(path.join(productRoot, ".product-ops/runtime/approvals.json"), "utf8"));
  assert.ok(approvals.requests.some((approval) => approval.gate === "product_direction_or_priority" && approval.status === "approved"));
  assert.equal((await git(productRoot, ["branch", "--show-current"])).trim(), `codex/cycle-${intake.record.eventId.toLowerCase()}-product`);
  assert.match(await git(productRoot, ["log", "-1", "--pretty=%s"]), /complete autonomous product cycle/);
  productConfig.routing.find((route) => route.event === "new_idea").steps = originalSteps;
  await fs.writeFile(productConfigFile, `${JSON.stringify(productConfig, null, 2)}\n`, "utf8");
  const validationOutput = captureIo();
  assert.equal(await run(["validate", productRoot], validationOutput.io), 0, validationOutput.stderr.join("\n"));
});

test("autopilot lease is exclusive and stale leases are recovered", async (t) => {
  const parent = await makeTempDirectory("product-ops-autopilot-lease-");
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const { acquireAutopilotLease, releaseAutopilotLease } = await import("../src/autopilot/state.js");
  const first = await acquireAutopilotLease(parent, { now: new Date("2026-08-02T00:00:00Z"), ttlMs: 1000 });
  assert.ok(first);
  assert.equal(await acquireAutopilotLease(parent, { now: new Date("2026-08-02T00:00:00.500Z"), ttlMs: 1000 }), null);
  const recovered = await acquireAutopilotLease(parent, { now: new Date("2026-08-02T00:00:02Z"), ttlMs: 1000 });
  assert.ok(recovered);
  assert.notEqual(recovered.token, first.token);
  await releaseAutopilotLease(first);
  await releaseAutopilotLease(recovered);

  const abandonedRoot = path.join(parent, "abandoned");
  const abandonedFile = path.join(abandonedRoot, ".product-ops", "runtime", "autopilot", "orchestrator.lease.json");
  await fs.mkdir(path.dirname(abandonedFile), { recursive: true });
  await fs.writeFile(abandonedFile, `${JSON.stringify({
    token: "abandoned-token",
    pid: 2_147_483_647,
    acquiredAt: "2026-08-02T00:00:00.000Z",
    expiresAt: "2026-08-03T00:00:00.000Z"
  })}\n`, "utf8");
  const processRecovered = await acquireAutopilotLease(abandonedRoot, { now: new Date("2026-08-02T00:00:01.000Z") });
  assert.ok(processRecovered);
  assert.notEqual(processRecovered.token, "abandoned-token");
  await releaseAutopilotLease(processRecovered);
});

test("engineering execution follows dependencies instead of display order", () => {
  const ordered = dependencyOrderedWorkstreams([
    { id: "WS-01", dependencies: [] },
    { id: "WS-02", dependencies: ["WS-01", "WS-03"] },
    { id: "WS-03", dependencies: ["WS-01"] }
  ]);
  assert.deepEqual(ordered.map((workstream) => workstream.id), ["WS-01", "WS-03", "WS-02"]);
  assert.throws(() => dependencyOrderedWorkstreams([
    { id: "WS-01", dependencies: ["WS-02"] },
    { id: "WS-02", dependencies: ["WS-01"] }
  ]), /contains a cycle/);
});

test("cross-boundary product summaries stay within the published contract budget", () => {
  const values = Array.from({ length: 40 }, (_, index) => `item-${index}`);
  assert.equal(boundedUnique([...values, values[0]]).length, 30);
  assert.deepEqual(boundedUnique(["first", "first", "second"]), ["first", "second"]);
});

test("controlled writer checkpoint creates a replay-safe manifest and receipt before product verification", async (t) => {
  const root = await makeTempDirectory("product-ops-writer-checkpoint-");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.equal(await run(["init", root], captureIo().io), 0);
  const config = await loadConfig(root);
  const input = {
    cycleId: "CYCLE-EVT-20260802-900",
    intake: { eventId: "EVT-20260802-900" },
    qaRun: { taskId: "TTO-9010", roleId: "RB-09", status: "completed" },
    now: new Date("2026-08-02T12:00:00.000Z")
  };
  const first = await materializeWriterCheckpoint(root, config, input);
  const replay = await materializeWriterCheckpoint(root, config, { ...input, now: new Date("2026-08-02T12:05:00.000Z") });
  assert.equal(replay.manifest, first.manifest);
  assert.equal(replay.receipt, first.receipt);
  const receipt = JSON.parse(await fs.readFile(path.join(root, first.receipt), "utf8"));
  assert.equal(receipt.recordsChanged, 1);
  assert.equal(receipt.fullReadbackMatch, true);
  assert.equal(receipt.secondReadMatch, true);
  assert.equal(receipt.replayWrites, 0);
  assert.match(await fs.readFile(path.join(root, first.target), "utf8"), /LIN-WRITER-20260802-900/);
});

test("product agent retries use isolated artifacts and a Codex-compatible output schema", async (t) => {
  const parent = await makeTempDirectory("product-ops-agent-retry-");
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const productRoot = path.join(parent, "retry-product");
  assert.equal(await run(["init", productRoot], captureIo().io), 0);
  const config = await loadConfig(productRoot);
  const baseTask = {
    task_id: "RTP-0002",
    event_id: "EVT-20260802-001",
    owner_role: "RB-02",
    owner_actor_id: "actor-rb-02",
    status: "in_progress",
    priority: "P2",
    updated_at: "2026-08-02T01:00:00.000Z"
  };
  const intake = {
    intakeId: "INTAKE-20260802-001",
    eventId: baseTask.event_id,
    type: "new_idea",
    title: "Retry-safe idea",
    description: "Exercise a retry without overwriting the prior attempt.",
    source: "synthetic test",
    priority: "P2",
    status: "proposed",
    autopilotAuthorized: true
  };
  let executions = 0;
  const execute = async ({ schemaFile, task, role, now }) => {
    executions += 1;
    const providerSchema = JSON.parse(await fs.readFile(schemaFile, "utf8"));
    assert.doesNotMatch(JSON.stringify(providerSchema), /uniqueItems/);
    assert.equal(providerSchema.properties.schemaVersion.type, "string");
    assert.equal(providerSchema.properties.status.type, "string");
    assert.equal(providerSchema.properties.impacts.items.type, "string");
    return productAgentResult(task, role, executions === 1 ? "failed" : "completed", now);
  };

  const first = await runProductAgent(productRoot, config, baseTask, {
    intake,
    cycleId: "CYCLE-EVT-20260802-001",
    execute,
    now: new Date("2026-08-02T01:01:00.000Z")
  });
  assert.equal(first.result.status, "failed");
  assert.match(first.outputFile, /RTP-0002-attempt-[a-f0-9-]+-result\.json$/);

  const second = await runProductAgent(productRoot, config, {
    ...baseTask,
    blocked_reason: "Retry scheduled after the first failed result.",
    updated_at: "2026-08-02T01:02:00.000Z"
  }, {
    intake,
    cycleId: "CYCLE-EVT-20260802-001",
    execute,
    now: new Date("2026-08-02T01:03:00.000Z")
  });
  assert.equal(second.result.status, "completed");
  assert.equal(second.outputFile, ".product-ops/runtime/autopilot/product-runs/RTP-0002-result.json");

  const resumed = await runProductAgent(productRoot, config, baseTask, {
    intake,
    cycleId: "CYCLE-EVT-20260802-001",
    execute: async () => { throw new Error("A sealed completed result must not execute again."); }
  });
  assert.equal(resumed.result.status, "completed");
  assert.equal(executions, 2);

  const files = await fs.readdir(path.join(productRoot, ".product-ops", "runtime", "autopilot", "product-runs"));
  assert.equal(files.filter((file) => file.endsWith("-input.json")).length, 2);
  assert.equal(files.filter((file) => file.endsWith("-schema.json")).length, 2);
  assert.equal(files.filter((file) => /-attempt-.*-result\.json$/.test(file)).length, 1);
  assert.ok(files.includes("RTP-0002-result.json"));
});

async function stubProductAgent(root, config, task, { now }) {
  const role = config.agents.find((candidate) => candidate.id === task.owner_role);
  const result = {
    schemaVersion: "1.0.0",
    taskId: task.task_id,
    eventId: task.event_id,
    roleId: task.owner_role,
    producerActorId: role.actorId,
    status: "completed",
    summary: `${role.id} completed its bounded synthetic product responsibility.`,
    findings: ["Synthetic evidence is bounded to the integration fixture."],
    recommendations: ["Continue through the dependency-ordered route."],
    acceptanceCriteria: [{ statement: "The autonomous route completes.", verification: "Inspect the durable cycle report." }],
    impacts: ["frontend", "backend", "database", "security", "seo"],
    constraints: ["No production action"],
    nonFunctionalRequirements: [{ domain: "security", requirement: "Remain bounded and attributable.", verification: "Inspect actors and evidence." }],
    evidence: [`evidence/${task.task_id}.json`],
    knownRisks: [],
    completedAt: now.toISOString()
  };
  const file = path.join(root, ".product-ops", "runtime", "autopilot", "product-runs", `${task.task_id}-result.json`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return { result };
}

function productAgentResult(task, role, status, now) {
  return {
    schemaVersion: "1.0.0",
    taskId: task.task_id,
    eventId: task.event_id,
    roleId: role.id,
    producerActorId: role.actorId,
    status,
    summary: status === "completed" ? "The retry-safe product task completed." : "The synthetic first attempt failed safely.",
    findings: ["The attempt is isolated."],
    recommendations: ["Continue only after a safe retry."],
    acceptanceCriteria: [{ statement: "Retries preserve prior artifacts.", verification: "Inspect attempt-specific files." }],
    impacts: ["architecture"],
    constraints: ["No production action"],
    nonFunctionalRequirements: [{ domain: "resilience", requirement: "A failed attempt must not poison retry.", verification: "Run the regression test." }],
    evidence: ["synthetic/retry-evidence.json"],
    knownRisks: [],
    completedAt: now.toISOString()
  };
}

async function stubEngineering(productRoot, _applicationRoot, _config, task, { now }) {
  const evidencePath = `.product-ops/runtime/development/contracts/evidence/${task.task_id}/engineering-result.json`;
  await fs.mkdir(path.dirname(path.join(productRoot, evidencePath)), { recursive: true });
  await fs.writeFile(path.join(productRoot, evidencePath), `${JSON.stringify({ taskId: task.task_id, status: "implementation_complete" })}\n`, "utf8");
  return {
    status: "implementation_complete",
    request: {
      acceptanceCriteria: [{ id: "AC-01", statement: "The autonomous route completes.", verification: "Inspect the report." }],
      impacts: ["frontend", "backend", "database", "security", "seo"],
      constraints: ["No production action"],
      nonFunctionalRequirements: [{ domain: "security", requirement: "Remain bounded.", verification: "Inspect evidence." }]
    },
    result: { evidence: [], knownRisks: [], completedAt: now.toISOString() },
    productReceipt: { storedAt: evidencePath },
    productEvidenceRefs: [evidencePath],
    changedComponents: ["src/feature.js"]
  };
}

function monotonicClock(start) {
  let value = Date.parse(start);
  return () => { const current = new Date(value); value += 1000; return current; };
}

async function initializeGit(root) {
  await git(root, ["init", "-b", "main"]);
  await git(root, ["add", "--all"]);
  await git(root, ["-c", "user.name=Autopilot Test", "-c", "user.email=autopilot@example.test", "commit", "-m", "test: initialize fixture"]);
}

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-c", `safe.directory=${cwd}`, ...args], { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
  });
}
