import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { materializeCycleWorkbook, selectCycleApproval } from "../src/autopilot/workbook.js";
import { PRODUCT_RUN_ROOT } from "../src/autopilot/cycle.js";
import { APPROVAL_STORE_FILE } from "../src/constants.js";
import { parseCsv, rowsToObjects } from "../src/csv.js";
import { run } from "../src/cli.js";
import { loadConfig } from "../src/config.js";
import { commitRoleRecords } from "../src/runtime/coordination-record.js";
import { captureIo, makeTempDirectory } from "./helpers.js";

function approval(config, { requestId, taskId, gate, question }) {
  return {
    requestId,
    taskId,
    gate,
    question,
    status: "approved",
    requestedAt: "2026-08-23T10:00:00.000Z",
    decidedAt: "2026-08-23T10:01:00.000Z",
    decidedByActorId: config.project.humanAuthorityActorId,
    rationale: "Authorize the bounded local delivery.",
    conditions: []
  };
}

test("cycle closure prefers its product-direction decision over development export", async (t) => {
  const { config, tasks } = await closureFixture(t, "direction-preferred", "EVT-20260823-101");
  const directionTask = {
    task_id: "WCT-0101",
    event_id: "EVT-20260823-101",
    owner_role: "RB-04",
    human_gate: "product_direction_or_priority"
  };
  const direction = approval(config, {
    requestId: "APR-DIRECTION-101",
    taskId: directionTask.task_id,
    gate: "product_direction_or_priority",
    question: "Which product direction should proceed?"
  });
  const developmentExport = approval(config, {
    requestId: "APR-DEVELOPMENT-101",
    taskId: tasks[0].task_id,
    gate: "development-export",
    question: "Send the bounded contract to engineering?"
  });

  assert.equal(
    selectCycleApproval(config, [directionTask, ...tasks], [developmentExport, direction]),
    direction
  );
});

test("incident closure uses the same event's attributed development-export approval", async (t) => {
  const eventId = "EVT-20260823-102";
  const fixture = await closureFixture(t, "incident-development-export", eventId);
  const developmentExport = approval(fixture.config, {
    requestId: "APR-DEVELOPMENT-102",
    taskId: fixture.tasks[0].task_id,
    gate: "development-export",
    question: "Authorize this incident fix to cross into engineering?"
  });
  await writeApprovalStore(fixture.root, [developmentExport]);

  const result = await materializeCycleWorkbook(fixture.root, fixture.config, {
    cycleId: `CYCLE-${eventId}`,
    intake: fixture.intake,
    tasks: fixture.tasks,
    runs: fixture.runs,
    now: new Date("2026-08-23T10:10:00.000Z")
  });

  assert.equal(result.receipts.length, 15);
  const decisionSheet = fixture.config.workbook.sheets.find((sheet) => sheet.key === "decision_log");
  const decisionRows = rowsToObjects(parseCsv(await fs.readFile(path.join(fixture.root, decisionSheet.file), "utf8"))).records;
  const decision = decisionRows.find((row) => row.event_id === eventId);
  assert.equal(decision.status, "approved");
  assert.equal(decision.evidence_refs, developmentExport.requestId);
  assert.equal(decision.decision_maker_actor_id, fixture.config.project.humanAuthorityActorId);
  const readiness = await workbookRecords(fixture, "readiness");
  const releases = await workbookRecords(fixture, "releases");
  assert.ok(readiness.some((row) => row.readiness_id === "RDY-20260823-102"));
  assert.ok(releases.some((row) => row.release_id === "REL-20260823-102"));
});

test("an explicit not-ready assessment remains the only readiness state and creates no release", async (t) => {
  const eventId = "EVT-20260823-104";
  const fixture = await closureFixture(t, "owned-not-ready", eventId);
  const developmentExport = approval(fixture.config, {
    requestId: "APR-DEVELOPMENT-104",
    taskId: fixture.tasks[0].task_id,
    gate: "development-export",
    question: "Authorize this incident fix to cross into engineering?"
  });
  await writeApprovalStore(fixture.root, [developmentExport]);

  const readinessRun = {
    roleId: "RB-11",
    taskId: "WCT-1041",
    eventId,
    status: "completed",
    canonicalRecords: [{
      sheet: "readiness",
      key: { readiness_id: "RDY-20260823-901" },
      fields: {
        status: "not_ready",
        target_environment: "local",
        blocking_ids: "missing-release-evidence",
        residual_risks: "Release evidence is incomplete.",
        owner_role: "RB-11",
        owner_actor_id: fixture.config.agents.find((agent) => agent.id === "RB-11").actorId,
        producer_actor_id: fixture.config.agents.find((agent) => agent.id === "RB-11").actorId,
        verifier_actor_id: fixture.config.agents.find((agent) => agent.id === "RB-12").actorId,
        assessed_at: "2026-08-23T10:05:00.000Z"
      }
    }]
  };
  assert.deepEqual(await commitRoleRecords(fixture.root, fixture.config, readinessRun), {
    written: 1,
    sheets: ["readiness"]
  });

  const result = await materializeCycleWorkbook(fixture.root, fixture.config, {
    cycleId: `CYCLE-${eventId}`,
    intake: fixture.intake,
    tasks: [...fixture.tasks, { task_id: readinessRun.taskId, event_id: eventId, owner_role: "RB-11", human_gate: "" }],
    runs: [...fixture.runs, readinessRun],
    now: new Date("2026-08-23T10:10:00.000Z")
  });

  assert.equal(result.receipts.length, 13);
  assert.deepEqual((await workbookRecords(fixture, "readiness")).map((row) => row.readiness_id), ["RDY-20260823-901"]);
  assert.deepEqual(await workbookRecords(fixture, "releases"), []);
});

test("cycle closure still fails closed without an attributed same-event approval", async (t) => {
  const eventId = "EVT-20260823-103";
  const fixture = await closureFixture(t, "incident-without-attribution", eventId);
  const unattributed = {
    ...approval(fixture.config, {
      requestId: "APR-DEVELOPMENT-103",
      taskId: fixture.tasks[0].task_id,
      gate: "development-export",
      question: "Authorize this incident fix to cross into engineering?"
    }),
    decidedByActorId: null
  };
  await writeApprovalStore(fixture.root, [unattributed]);

  await assert.rejects(
    materializeCycleWorkbook(fixture.root, fixture.config, {
      cycleId: `CYCLE-${eventId}`,
      intake: fixture.intake,
      tasks: fixture.tasks,
      runs: fixture.runs,
      now: new Date("2026-08-23T10:10:00.000Z")
    }),
    /without an attributed product-direction decision, or an attributed development-export approval/
  );
});

async function closureFixture(t, name, eventId) {
  const root = await makeTempDirectory(`product-ops-${name}-`);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.equal(await run(["init", root], captureIo().io), 0);
  const config = await loadConfig(root);
  const developmentTask = {
    task_id: `WCT-${eventId.slice(-3)}0`,
    event_id: eventId,
    owner_role: config.separation.developmentRole,
    human_gate: ""
  };
  const evidencePath = `${PRODUCT_RUN_ROOT}/${developmentTask.task_id}-result.json`;
  await fs.mkdir(path.dirname(path.join(root, evidencePath)), { recursive: true });
  await fs.writeFile(path.join(root, evidencePath), `${JSON.stringify({ taskId: developmentTask.task_id, status: "implementation_complete" })}\n`, "utf8");
  return {
    root,
    config,
    tasks: [developmentTask],
    intake: {
      intakeId: `INTAKE-${eventId.slice(4)}`,
      eventId,
      type: "incident",
      title: "Synthetic incident closure",
      description: "A bounded incident fix has completed its governed route.",
      source: "synthetic regression",
      priority: "P1",
      createdAt: "2026-08-23T09:00:00.000Z"
    },
    runs: [{
      roleId: config.separation.developmentRole,
      taskId: developmentTask.task_id,
      status: "completed",
      evidence: [evidencePath],
      acceptanceCriteria: [],
      knownRisks: []
    }]
  };
}

async function writeApprovalStore(root, requests) {
  const file = path.join(root, APPROVAL_STORE_FILE);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify({ schemaVersion: "1.0.0", requests }, null, 2)}\n`, "utf8");
}

async function workbookRecords(fixture, sheetKey) {
  const sheet = fixture.config.workbook.sheets.find((candidate) => candidate.key === sheetKey);
  return rowsToObjects(parseCsv(await fs.readFile(path.join(fixture.root, sheet.file), "utf8"))).records
    .filter((row) => !Object.values(row).some((value) => String(value).startsWith("<")));
}
