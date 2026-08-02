import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { initCommand } from "../src/commands/init.js";
import { CONFIG_FILE, TASKBOARD_FILE } from "../src/constants.js";
import { parseCsv, stringifyCsv } from "../src/csv.js";
import { initializeDevelopmentOs } from "../src/development/init.js";
import { planDevelopmentRequest } from "../src/development/planner.js";
import { runEngineeringWorkstream } from "../src/development/runner.js";
import { runDevelopmentTask } from "../src/runtime/development-runner.js";
import { makeTempDirectory, readJson, writeJson } from "./helpers.js";

const OUTPUT_LIMIT_BYTES = 1024 * 1024;
const FIXED_NOW = new Date("2026-08-02T04:00:00.000Z");

test("engineering dependencies require a schema-valid result attributed to the planned workstream", async (t) => {
  const fixture = await engineeringFixture(t, "dependency-contract-");
  const workstream = fixture.plan.workstreams.find((candidate) => candidate.dependencies.length > 0);
  assert.ok(workstream, "fixture must include a dependent workstream");
  enableEngineeringExecutor(fixture.config, workstream.ownerRole);
  await writeJson(fixture.configPath, fixture.config);

  const dependencyId = workstream.dependencies[0];
  const dependency = fixture.plan.workstreams.find((candidate) => candidate.id === dependencyId);
  assert.ok(dependency, "dependency must exist in the plan");
  const actor = fixture.config.roles.find((role) => role.id === dependency.ownerRole)?.actorId;
  assert.ok(actor, "dependency owner must have an actor");
  const resultPath = path.join(
    fixture.root,
    ".development-os",
    "runs",
    `${fixture.plan.planId}-${dependencyId}-result.json`
  );
  const spawnProcess = () => assert.fail("an invalid dependency must fail before process dispatch");

  await writeJson(resultPath, { status: "completed" });
  await assert.rejects(
    runEngineeringWorkstream(fixture.root, fixture.plan.planId, workstream.id, { dryRun: false, spawnProcess }),
    /Engineering workstream dependency .* is invalid/
  );

  const validResult = {
    schemaVersion: "1.0.0",
    planId: fixture.plan.planId,
    workstreamId: dependencyId,
    ownerRole: dependency.ownerRole,
    producerActorId: actor,
    status: "completed",
    verificationDisposition: "not_applicable",
    implementationRevision: "abcdef1234567890",
    changedComponents: [],
    commands: [],
    evidence: [],
    knownRisks: [],
    completedAt: "2026-08-02T03:59:00.000Z"
  };
  const mismatches = [
    ["planId", "ENGPLAN-OTHER"],
    ["workstreamId", "WS-99"],
    ["ownerRole", fixture.config.roles.find((role) => role.id !== dependency.ownerRole).id],
    ["producerActorId", "actor-untrusted"],
    ["status", "blocked"]
  ];

  for (const [field, value] of mismatches) {
    await writeJson(resultPath, { ...validResult, [field]: value });
    await assert.rejects(
      runEngineeringWorkstream(fixture.root, fixture.plan.planId, workstream.id, { dryRun: false, spawnProcess }),
      new RegExp(`mismatches planned ${field}`)
    );
  }
});

test("engineering executor bounds both output streams and reports timeout before close/error races", async (t) => {
  const fixture = await engineeringFixture(t, "engineering-executor-hardening-");
  const workstream = fixture.plan.workstreams.find((candidate) => candidate.dependencies.length === 0);
  assert.ok(workstream, "fixture must include an independent workstream");
  enableEngineeringExecutor(fixture.config, workstream.ownerRole);
  await writeJson(fixture.configPath, fixture.config);

  for (const channel of ["stdout", "stderr"]) {
    let child;
    const spawnProcess = () => {
      child = fakeChild((processHandle) => {
        processHandle[channel].write(Buffer.alloc(OUTPUT_LIMIT_BYTES + 1, 0x61));
      });
      return child;
    };
    await assert.rejects(
      runEngineeringWorkstream(fixture.root, fixture.plan.planId, workstream.id, { dryRun: false, spawnProcess }),
      new RegExp(`Engineering executor ${channel} exceeded the ${OUTPUT_LIMIT_BYTES}-byte limit`)
    );
    assert.equal(child.killCalls, 1);
  }

  let timedOutChild;
  const spawnProcess = () => {
    timedOutChild = fakeChild();
    return timedOutChild;
  };
  await assert.rejects(
    runEngineeringWorkstream(fixture.root, fixture.plan.planId, workstream.id, { dryRun: false, spawnProcess }),
    /Engineering executor timed out after 1000ms/
  );
  assert.equal(timedOutChild.killCalls, 1);
});

test("legacy development runner bounds both output streams and reports timeout before close/error races", async (t) => {
  const fixture = await runtimeFixture(t, "runtime-executor-hardening-");

  for (const channel of ["stdout", "stderr"]) {
    let child;
    const spawnProcess = () => {
      child = fakeChild((processHandle) => {
        processHandle[channel].write(Buffer.alloc(OUTPUT_LIMIT_BYTES + 1, 0x62));
      });
      return child;
    };
    await assert.rejects(
      runDevelopmentTask(fixture.root, fixture.config, fixture.taskId, {
        dryRun: false,
        now: FIXED_NOW,
        spawnProcess
      }),
      new RegExp(`Development agent ${channel} exceeded the ${OUTPUT_LIMIT_BYTES}-byte limit`)
    );
    assert.equal(child.killCalls, 1);
  }

  fixture.config.adapters.development.settings.timeoutMs = 10;
  let timedOutChild;
  const spawnProcess = () => {
    timedOutChild = fakeChild();
    return timedOutChild;
  };
  await assert.rejects(
    runDevelopmentTask(fixture.root, fixture.config, fixture.taskId, {
      dryRun: false,
      now: FIXED_NOW,
      spawnProcess
    }),
    /Development agent timed out after 10ms/
  );
  assert.equal(timedOutChild.killCalls, 1);
});

function fakeChild(script) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killCalls = 0;
  child.kill = () => {
    child.killCalls += 1;
    child.emit("close", null, "SIGTERM");
    queueMicrotask(() => child.emit("error", new Error("synthetic post-close error")));
    return true;
  };
  if (script) queueMicrotask(() => script(child));
  return child;
}

async function engineeringFixture(t, prefix) {
  const root = await temporaryRoot(t, prefix);
  await initializeDevelopmentOs(root, { dryRun: false });
  const requestFile = path.join(root, "request.json");
  await writeJson(requestFile, developmentRequest(prefix.replace(/[^A-Za-z0-9]/g, "").toUpperCase()));
  const { plan } = await planDevelopmentRequest(root, requestFile, { dryRun: false });
  const configPath = path.join(root, "development-os.config.json");
  const config = await readJson(configPath);
  return { root, plan, configPath, config };
}

function enableEngineeringExecutor(config, roleId) {
  const executor = config.executors.find((candidate) => candidate.roleId === roleId);
  assert.ok(executor, `missing executor for ${roleId}`);
  executor.enabled = true;
  executor.executable = "synthetic-executor";
  executor.arguments = [];
  executor.timeoutMs = 1000;
}

async function runtimeFixture(t, prefix) {
  const root = await temporaryRoot(t, prefix);
  await initCommand(root, { dryRun: false, force: false });
  const config = await readJson(path.join(root, CONFIG_FILE));
  config.adapters.development.enabled = true;
  config.adapters.development.settings.executable = "synthetic-agent";
  config.adapters.development.settings.arguments = [];
  config.adapters.development.settings.timeoutMs = 1000;
  const taskId = "TASK-RB-13-20260802-001";
  const taskboardPath = path.join(root, TASKBOARD_FILE);
  const rows = parseCsv(await fs.readFile(taskboardPath, "utf8"));
  rows.push([
    taskId, "EVT-00000000-001", "Implement synthetic local behavior",
    "RB-13", "actor-rb-13", "ready", "P2", "", "", "", "", "", "", "",
    "RB-12", "actor-rb-12", "", "", "2026-08-02T03:55:00.000Z"
  ]);
  await fs.writeFile(taskboardPath, stringifyCsv(rows), "utf8");
  return { root, config, taskId };
}

function developmentRequest(suffix) {
  return {
    schemaVersion: "1.0.0",
    requestId: `DEVREQ-${suffix}`,
    productTaskId: "TASK-RB-13-0001",
    deliveryTicketReference: "product/delivery-ticket.md",
    title: "Implement an approved application change",
    problem: "Users need approved behavior that is not implemented yet.",
    desiredOutcome: "The approved behavior is implemented and reproducibly verified.",
    acceptanceCriteria: [{
      id: "AC-01",
      statement: "The approved behavior works as specified.",
      verification: "Run the approved automated scenario."
    }],
    impacts: ["architecture", "frontend", "backend", "database", "security", "performance"],
    constraints: ["No production data in tests"],
    nonFunctionalRequirements: [{
      domain: "security",
      requirement: "Execution remains isolated.",
      verification: "Review the execution evidence."
    }],
    writeBoundary: {
      repositories: ["application"],
      allowedPaths: ["src", "tests", "database", "docs"],
      prohibitedPaths: [".env", "production-data"]
    },
    validation: {
      commands: ["npm test"],
      evidenceRequired: ["test report"]
    },
    approval: {
      status: "approved",
      actorId: "human-product-owner",
      decidedAt: "2026-08-02T03:50:00.000Z",
      reference: "APR-DEV-HARDENING"
    },
    source: {
      productOperationsRevision: "abcdef1234567890",
      exportedAt: "2026-08-02T03:51:00.000Z"
    }
  };
}

async function temporaryRoot(t, prefix) {
  const root = await makeTempDirectory(prefix);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
