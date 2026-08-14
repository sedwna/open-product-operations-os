import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { initCommand } from "../src/commands/init.js";
import { loadConfig } from "../src/config.js";
import { parseCsv, stringifyCsv } from "../src/csv.js";
import { decideApproval, requestApproval } from "../src/runtime/approvals.js";
import { synchronizeDecisionApprovals } from "../src/runtime/decision-projection.js";
import { ingestRecord } from "../src/runtime/intake.js";
import { runControlTower } from "../src/runtime/control-tower.js";
import { loadTaskboard } from "../src/runtime/taskboard.js";
import { makeTempDirectory } from "./helpers.js";

test("an attributed approval updates its pending decision projection through a controlled write", async (t) => {
  const parent = await makeTempDirectory("decision-projection-");
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "product");
  await initCommand(root, {});
  const config = await loadConfig(root);
  await ingestRecord(root, {
    type: "new_idea",
    title: "Choose the catalogue backfill route",
    description: "The owner must choose between a manual seed and one year of automated history.",
    source: "the owner"
  }, { dryRun: false });
  await runControlTower(root, config, { dryRun: false });

  const { records: tasks } = await loadTaskboard(root);
  const eventTasks = tasks.filter((task) => task.event_id !== "EVT-00000000-001");
  const gateTask = eventTasks.find((task) => task.human_gate === "product_direction_or_priority");
  assert.ok(gateTask);
  const { request } = await requestApproval(root, {
    taskId: gateTask.task_id,
    gate: gateTask.human_gate,
    question: "Which backfill route should proceed?",
    options: ["manual_seed", "one_year_backfill"]
  }, { dryRun: false });
  await decideApproval(root, config, {
    requestId: request.requestId,
    decision: "approved",
    selectedOption: "one_year_backfill",
    conditions: ["Keep field provenance", "Provide a kill switch"],
    actorId: config.project.humanAuthorityActorId,
    rationale: "Backfill one year and then monitor daily.",
    attribution: "human_entered"
  }, { dryRun: false });

  const sheet = config.workbook.sheets.find((candidate) => candidate.key === "decision_log");
  const workbookFile = path.join(root, sheet.file);
  const rows = parseCsv(await fs.readFile(workbookFile, "utf8"));
  const header = rows[0];
  const pending = header.map(() => "");
  const set = (field, value) => { pending[header.indexOf(field)] = value; };
  set("decision_id", "DEC-20260814-001");
  set("event_id", gateTask.event_id);
  set("title", "Choose catalogue direction");
  set("status", "pending_human");
  rows.push(pending);
  await fs.writeFile(workbookFile, stringifyCsv(rows), "utf8");

  const result = await synchronizeDecisionApprovals(root, config);
  assert.equal(result.synchronized, 1);
  assert.equal(result.receipts[0].requestId, request.requestId);
  const readback = parseCsv(await fs.readFile(workbookFile, "utf8"));
  const projected = readback.slice(1).find((row) => row[header.indexOf("decision_id")] === "DEC-20260814-001");
  assert.equal(projected[header.indexOf("status")], "approved");
  assert.equal(projected[header.indexOf("selected_option")], "one_year_backfill");
  assert.equal(projected[header.indexOf("decision_maker_actor_id")], config.project.humanAuthorityActorId);
  assert.equal(projected[header.indexOf("evidence_refs")], request.requestId);
  assert.match(projected[header.indexOf("conditions")], /Keep field provenance/);
  assert.match(projected[header.indexOf("conditions")], /Provide a kill switch/);

  const replay = await synchronizeDecisionApprovals(root, config);
  assert.equal(replay.synchronized, 0);
  assert.equal(replay.skipped[0].reason, "no_pending_projection");
});
