import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { initCommand } from "../src/commands/init.js";
import { APPROVAL_STORE_FILE } from "../src/constants.js";
import { linkCommand } from "../src/commands/link.js";
import { initializeDevelopmentOs } from "../src/development/init.js";
import { materializeAdoption } from "../src/adoption/materialize.js";
import { loadApprovals } from "../src/runtime/approvals.js";
import { loadTaskboard } from "../src/runtime/taskboard.js";
import { createHandlers, createServerContext } from "../src/mcp/server.js";
import { makeTempDirectory } from "./helpers.js";

async function linkedWorkspace(t) {
  const parent = await makeTempDirectory("product-ops-adopt-mcp-");
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "product");
  const application = path.join(parent, "application");
  await initCommand(root, {});
  await fs.mkdir(path.join(application, "src"), { recursive: true });
  await fs.mkdir(path.join(application, "tests"), { recursive: true });
  await fs.writeFile(path.join(application, "README.md"), "# Existing product\n", "utf8");
  await fs.writeFile(path.join(application, "src", "index.js"), "export const ready = false;\n", "utf8");
  await fs.writeFile(path.join(application, "tests", "index.test.js"), "// TODO: cover the route\n", "utf8");
  await fs.writeFile(path.join(application, "package.json"), JSON.stringify({ name: "existing-product", dependencies: {} }), "utf8");
  await initializeDevelopmentOs(application, { dryRun: false });
  await linkCommand(root, { application, provider: "codex", apply: true });
  const context = await createServerContext({ project: root, allowWrites: true });
  const handlers = createHandlers(context, { version: "test" });
  handlers.initialize({ protocolVersion: "2026-07-28", capabilities: {} });
  return { root, application, handlers };
}

const call = (handlers, name, args = {}) => handlers["tools/call"]({ name, arguments: args });

function resultFor(claim, overrides = {}) {
  return {
    schemaVersion: "1.0.0",
    taskId: claim.taskId,
    eventId: claim.eventId,
    roleId: claim.roleId,
    producerActorId: claim.producerActorId,
    status: "completed",
    summary: "Recorded sourced observations from the assigned application paths.",
    findings: ["Observation retained with its repository source."],
    recommendations: [],
    acceptanceCriteria: [],
    impacts: [],
    constraints: [],
    nonFunctionalRequirements: [],
    evidence: claim.adoptionAssignment.paths.slice(0, 5),
    knownRisks: [],
    completedAt: "2026-08-14T00:00:00.000Z",
    ...overrides
  };
}

test("adopt plans first, then records one durable card per survey assignment", async (t) => {
  const { root, handlers } = await linkedWorkspace(t);
  const before = await loadTaskboard(root);

  const planned = await call(handlers, "product_ops_adopt");
  assert.equal(planned.structuredContent.applied, false);
  assert.equal((await loadTaskboard(root)).records.length, before.records.length, "planning must write no cards");

  const applied = await call(handlers, "product_ops_adopt", { apply: true });
  assert.equal(applied.isError, false);
  assert.equal(applied.structuredContent.applied, true);
  assert.ok(applied.structuredContent.adoption.assignments.length >= 3);
  const board = await loadTaskboard(root);
  const eventTasks = board.records.filter((task) => task.event_id === applied.structuredContent.adoption.eventId);
  assert.equal(eventTasks.length, applied.structuredContent.adoption.assignments.length);
  assert.ok(eventTasks.every((task) => task.evidence_refs.endsWith("/survey.json")));

  const repeated = await call(handlers, "product_ops_adopt", { apply: true });
  assert.equal(repeated.structuredContent.adoption.created, false, "the same application revision must be idempotent");
  assert.equal((await loadTaskboard(root)).records.length, board.records.length, "repeating adoption must not duplicate cards");

  await fs.rm(path.join(root, ".product-ops/runtime/adoption/index.json"));
  const recovered = await call(handlers, "product_ops_adopt", { apply: true });
  assert.equal(recovered.isError, false, "a retry must repair a run whose final index write was interrupted");
  assert.equal(recovered.structuredContent.adoption.created, false);
  assert.equal((await loadTaskboard(root)).records.length, board.records.length, "crash recovery must not duplicate cards");
});

test("next_work skips the setup sample and carries the exact adoption assignment", async (t) => {
  const { handlers } = await linkedWorkspace(t);
  const adopted = await call(handlers, "product_ops_adopt", { apply: true });
  const expected = new Map(adopted.structuredContent.survey.assignments.map((assignment) => [assignment.roleId, assignment]));

  const claim = (await call(handlers, "product_ops_next_work")).structuredContent;
  assert.notEqual(claim.eventId, "EVT-00000000-001", "a real adoption must hide the setup sample card");
  assert.equal(claim.adoptionAssignment.kind, "adoption_assignment");
  assert.deepEqual(claim.adoptionAssignment.paths, expected.get(claim.roleId).paths);
  assert.deepEqual(claim.brief.operationalArtifacts, claim.adoptionAssignment);
});

test("distinct repositories at the same revision never collapse into one adoption event", async (t) => {
  const { root, handlers } = await linkedWorkspace(t);
  const first = await call(handlers, "product_ops_adopt", { apply: true });
  const secondSurvey = {
    ...first.structuredContent.survey,
    applicationRoot: `${first.structuredContent.survey.applicationRoot}-a-different-repository`
  };
  const second = await materializeAdoption(root, secondSurvey, { dryRun: false, now: new Date("2026-08-14T01:00:00.000Z") });

  assert.notEqual(second.key, first.structuredContent.adoption.key);
  assert.notEqual(second.eventId, first.structuredContent.adoption.eventId);
});

test("adoption results remain observations and end at an owner review gate", async (t) => {
  const { root, handlers } = await linkedWorkspace(t);
  const adopted = await call(handlers, "product_ops_adopt", { apply: true });
  const total = adopted.structuredContent.adoption.assignments.length;

  for (let index = 0; index < total; index += 1) {
    let claim = (await call(handlers, "product_ops_next_work")).structuredContent;
    if (index === 0) {
      const refused = await call(handlers, "product_ops_submit_work", {
        taskId: claim.taskId,
        claimToken: claim.claimToken,
        result: resultFor(claim, { canonicalRecords: [{ sheet: "issues", key: { issue_id: "ISS-1" }, fields: {} }] }),
        apply: true
      });
      assert.equal(refused.isError, true);
      assert.match(JSON.stringify(refused), /observations|canonical claims/i);
    }
    if (index === total - 1) {
      await fs.writeFile(path.join(root, APPROVAL_STORE_FILE), JSON.stringify({ schemaVersion: "1.0.0", requests: "broken" }), "utf8");
      const interrupted = await call(handlers, "product_ops_submit_work", {
        taskId: claim.taskId,
        claimToken: claim.claimToken,
        result: resultFor(claim),
        apply: true
      });
      assert.equal(interrupted.isError, true);
      const stillReady = (await loadTaskboard(root)).byId.get(claim.taskId);
      assert.equal(stillReady.status, "ready", "a failed owner-gate write must leave the final card retryable");
      await fs.writeFile(path.join(root, APPROVAL_STORE_FILE), `${JSON.stringify({ schemaVersion: "1.0.0", requests: [] }, null, 2)}\n`, "utf8");
      claim = (await call(handlers, "product_ops_next_work")).structuredContent;
    }
    const submitted = await call(handlers, "product_ops_submit_work", {
      taskId: claim.taskId,
      claimToken: claim.claimToken,
      result: resultFor(claim),
      apply: true
    });
    assert.equal(submitted.isError, false, JSON.stringify(submitted.structuredContent));
    assert.equal(submitted.structuredContent.cycle.done, index + 1);
  }

  const approvals = await loadApprovals(root);
  const review = approvals.requests.find((request) => request.gate === "adoption_observations_review");
  assert.ok(review, "finishing every adoption card must return the observations to human authority");
  assert.equal(review.status, "pending");
  const report = JSON.parse(await fs.readFile(path.join(root, review.evidenceRefs.at(-1)), "utf8"));
  assert.equal(report.statusAtCompletion, "awaiting_owner_review");
  assert.equal(report.status, undefined, "immutable evidence must not masquerade as live review state");
  assert.equal(report.observations.length, total);
});
