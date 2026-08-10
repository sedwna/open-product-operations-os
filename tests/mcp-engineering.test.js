import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { initCommand } from "../src/commands/init.js";
import { linkCommand } from "../src/commands/link.js";
import { initializeDevelopmentOs } from "../src/development/init.js";
import { planDevelopmentRequest } from "../src/development/planner.js";
import { loadDevelopmentConfig } from "../src/development/config.js";
import { loadConfig } from "../src/config.js";
import { loadApprovals } from "../src/runtime/approvals.js";
import { loadTaskboard, replaceTaskboard } from "../src/runtime/taskboard.js";
import { parseCsv, stringifyCsv } from "../src/csv.js";
import { ingestRecord } from "../src/runtime/intake.js";
import { runControlTower } from "../src/runtime/control-tower.js";
import { runGit } from "../src/autopilot/shared.js";
import { createHandlers, createServerContext } from "../src/mcp/server.js";
import { makeTempDirectory } from "./helpers.js";

/**
 * The engineering half of host-delegated execution.
 *
 * Product work was inverted first and engineering was left spawning a configured CLI, so a product
 * could reach an approved delivery contract and stop dead because no executable was installed.
 * These prove the mirror path works and refuses the same things the spawned path refuses.
 */

const call = (handlers, name, args = {}) => handlers["tools/call"]({ name, arguments: args });

async function linkedWorkspace(t, { withPlan = true } = {}) {
  const parent = await makeTempDirectory("product-ops-eng-");
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const product = path.join(parent, "ops");
  const application = path.join(parent, "app");
  await initCommand(product, {});
  await fs.mkdir(application, { recursive: true });
  await initializeDevelopmentOs(application, { dryRun: false });
  await linkCommand(product, { application, apply: true });

  if (withPlan) {
    const requestFile = path.join(application, "request.json");
    await fs.writeFile(requestFile, `${JSON.stringify(developmentRequest(), null, 2)}\n`, "utf8");
    await planDevelopmentRequest(application, requestFile, { dryRun: false });
  }

  const context = await createServerContext({ project: product, allowWrites: true });
  const handlers = createHandlers(context, { version: "test" });
  handlers.initialize({ protocolVersion: "2026-07-28", capabilities: {} });
  return { product, application, handlers };
}

test("engineering work is not offered before a plan exists", async (t) => {
  const { handlers } = await linkedWorkspace(t, { withPlan: false });
  const result = (await call(handlers, "product_ops_next_engineering_work")).structuredContent;
  assert.equal(result.available, false);
  assert.equal(result.reason, "no_plan");
});

test("a planned workstream is handed out as a bounded brief", async (t) => {
  const { application, handlers } = await linkedWorkspace(t);
  const claim = (await call(handlers, "product_ops_next_engineering_work")).structuredContent;

  assert.equal(claim.available, true);
  assert.equal(claim.claimToken.length, 32);
  assert.equal(path.resolve(claim.applicationRoot), path.resolve(application));
  assert.notEqual(claim.team, claim.ownerRole, "the brief names a team, not a contract identifier");
  assert.ok(claim.writeBoundary, "engineering may only write where the contract says");
  assert.ok(claim.policy.prohibitedPaths.length > 0, "the paths that are never application code must travel with the brief");
  // ENG-15 reproduces the others' claims; there is nothing to reproduce first.
  assert.notEqual(claim.ownerRole, "ENG-15");
});

test("a submitted result passes the same contract a spawned executor would", async (t) => {
  const { application, handlers } = await linkedWorkspace(t);
  const claim = (await call(handlers, "product_ops_next_engineering_work")).structuredContent;
  const config = await loadDevelopmentConfig(application);
  const actor = config.roles.find((role) => role.id === claim.ownerRole).actorId;

  const result = {
    schemaVersion: "1.0.0",
    planId: claim.planId,
    workstreamId: claim.workstreamId,
    ownerRole: claim.ownerRole,
    producerActorId: actor,
    status: "completed",
    verificationDisposition: "not_applicable",
    implementationRevision: "abcdef1234567890",
    changedComponents: ["src"],
    commands: ["node --test"],
    evidence: ["evidence/run.json"],
    knownRisks: [],
    completedAt: "2026-08-09T12:00:00.000Z"
  };

  const planned = await call(handlers, "product_ops_submit_engineering_work", {
    workstreamId: claim.workstreamId, claimToken: claim.claimToken, result
  });
  assert.equal(planned.structuredContent.applied, false, "submitting must plan by default");

  const applied = await call(handlers, "product_ops_submit_engineering_work", {
    workstreamId: claim.workstreamId, claimToken: claim.claimToken, result, apply: true
  });
  assert.equal(applied.structuredContent.applied, true);
  assert.equal(applied.structuredContent.sealed, true);
  const stored = JSON.parse(await fs.readFile(path.join(application, applied.structuredContent.resultFile), "utf8"));
  assert.equal(stored.workstreamId, claim.workstreamId);
});

test("only ENG-15 may issue a verification disposition", async (t) => {
  const { application, handlers } = await linkedWorkspace(t);
  const claim = (await call(handlers, "product_ops_next_engineering_work")).structuredContent;
  const config = await loadDevelopmentConfig(application);

  // Claiming a passed verification from a role that does not hold it is how a producer would come
  // to certify its own work — the rule the whole model rests on.
  const overreach = await call(handlers, "product_ops_submit_engineering_work", {
    workstreamId: claim.workstreamId,
    claimToken: claim.claimToken,
    apply: true,
    result: {
      schemaVersion: "1.0.0",
      planId: claim.planId,
      workstreamId: claim.workstreamId,
      ownerRole: claim.ownerRole,
      producerActorId: config.roles.find((role) => role.id === claim.ownerRole).actorId,
      status: "completed",
      verificationDisposition: "passed",
      implementationRevision: "abcdef1234567890",
      changedComponents: ["src"],
      commands: ["node --test"],
      evidence: ["evidence/run.json"],
      knownRisks: [],
      completedAt: "2026-08-09T12:00:00.000Z"
    }
  });
  assert.equal(overreach.isError, true);
  assert.match(JSON.stringify(overreach), /verificationDisposition|refused/i);
});

test("engineering work cannot be returned without having been taken", async (t) => {
  const { application, handlers } = await linkedWorkspace(t);
  const claim = (await call(handlers, "product_ops_next_engineering_work")).structuredContent;
  const config = await loadDevelopmentConfig(application);

  const forged = await call(handlers, "product_ops_submit_engineering_work", {
    workstreamId: claim.workstreamId,
    claimToken: "0".repeat(32),
    apply: true,
    result: {
      schemaVersion: "1.0.0",
      planId: claim.planId,
      workstreamId: claim.workstreamId,
      ownerRole: claim.ownerRole,
      producerActorId: config.roles.find((role) => role.id === claim.ownerRole).actorId,
      status: "completed",
      verificationDisposition: "not_applicable",
      implementationRevision: "abcdef1234567890",
      changedComponents: ["src"],
      commands: ["node --test"],
      evidence: ["evidence/run.json"],
      knownRisks: [],
      completedAt: "2026-08-09T12:00:00.000Z"
    }
  });
  assert.equal(forged.isError, true);
  assert.match(JSON.stringify(forged), /claim/i);
});

test("a read-only server offers no engineering execution path", async (t) => {
  const parent = await makeTempDirectory("product-ops-eng-ro-");
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const product = path.join(parent, "ops");
  await initCommand(product, {});
  const context = await createServerContext({ project: product, allowWrites: false });
  const handlers = createHandlers(context, { version: "test" });
  handlers.initialize({ protocolVersion: "2026-07-28", capabilities: {} });

  const names = handlers["tools/list"]().tools.map((tool) => tool.name);
  assert.ok(!names.includes("product_ops_next_engineering_work"));
  assert.ok(!names.includes("product_ops_submit_engineering_work"));
  assert.ok(!names.includes("product_ops_open_delivery"));
  assert.ok(!names.includes("product_ops_close_delivery"));
});

/**
 * The whole crossing, without a terminal.
 *
 * Export and import were command-line only, so an owner could be driven to an approved delivery
 * contract inside a conversation and then had to leave it to get the work across. This walks the
 * path a host actually takes: open the crossing, be told the owner has to settle it, settle it,
 * cross, perform each workstream as a delegated subagent, and close.
 */
test("a delivery crosses into engineering and comes back, entirely through the surface", async (t) => {
  const { product, application, handlers } = await deliveryWorkspace(t);

  const opening = await call(handlers, "product_ops_open_delivery", { apply: true });
  const waiting = opening.structuredContent;
  assert.equal(waiting.applied, false, opening.content[0].text);
  assert.equal(waiting.reason, "waiting_on_owner", "the crossing is the owner's decision, not the loop's");

  // The gate must state its own decision. It used to open by quoting every prior run joined
  // together and cut from the front, so on a real product the owner was asked to authorise a
  // crossing while reading the idea-triage note that led to it.
  const gate = (await call(handlers, "product_ops_pending_decisions")).structuredContent
    .items.find((item) => item.requestId === waiting.requestId);
  assert.ok(gate, "the crossing gate reaches the owner through the ordinary decision list");
  assert.match(gate.context, /acceptance criterion/i, "it says how much travels");
  assert.match(gate.context, /does not authorise a production release/i, "and what approving does not buy");
  assert.match(gate.context, /Rejecting leaves the product side intact/i, "and what rejecting costs");

  await settleGate(handlers, product, waiting.requestId);

  const crossing = await call(handlers, "product_ops_open_delivery", { apply: true });
  const crossed = crossing.structuredContent;
  assert.equal(crossed.applied, true, crossing.content[0].text);

  // What crosses must be the delivery contract, not the history that produced it. The export used
  // to flat-map every card's acceptance criteria in board order and keep the first thirty, so the
  // earliest cards filled every slot and the contract's own criteria were cut off below them — and
  // it declared all thirty impact domains unconditionally, which dispatched a browser game to every
  // engineering team including database and infrastructure.
  const exported = JSON.parse(await fs.readFile(
    path.join(application, ".development-os", "inbox", `${crossed.requestId}.json`), "utf8"));
  assert.ok(
    exported.acceptanceCriteria.every((item) => /catalog|distance|run ends/i.test(item.statement)),
    `the contract's own criteria must be what travels: ${JSON.stringify(exported.acceptanceCriteria.slice(0, 3))}`
  );
  assert.ok(
    exported.impacts.length < 30,
    `impacts must be what the product declared, not the whole enum: ${exported.impacts.length}`
  );
  assert.deepEqual(exported.impacts, ["frontend"], "and exactly what the delivery contract declared");
  assert.match(crossed.planId, /^ENGPLAN-/);
  assert.match(crossed.sourceDigest, /^[a-f0-9]{64}$/, "what crosses is a hashed contract");
  assert.ok(crossed.workstreams > 0);

  // Closing over work nobody did is refused, whoever the performer was.
  const premature = await call(handlers, "product_ops_close_delivery", { apply: true });
  assert.equal(premature.isError, true);
  assert.equal(premature.structuredContent.code, "WORK_INCOMPLETE");

  let performed = 0;
  for (;;) {
    const claim = (await call(handlers, "product_ops_next_engineering_work")).structuredContent;
    if (!claim.available) {
      assert.equal(claim.reason, "all_complete", `stuck: ${claim.reason}`);
      break;
    }
    // What a delegated subagent would do: write inside the contract's boundary, then return.
    await fs.writeFile(
      path.join(application, "src", `${claim.workstreamId.toLowerCase()}.js`),
      `export const ${claim.workstreamId.replace("-", "_").toLowerCase()} = true;\n`,
      "utf8"
    );
    const submitted = await call(handlers, "product_ops_submit_engineering_work", {
      workstreamId: claim.workstreamId,
      claimToken: claim.claimToken,
      apply: true,
      result: workstreamResult(claim)
    });
    assert.equal(submitted.isError, false, JSON.stringify(submitted.structuredContent));
    performed += 1;
    assert.ok(performed <= crossed.workstreams + 1, "the hand-out loop must terminate");
  }
  assert.equal(performed, crossed.workstreams);

  const closed = (await call(handlers, "product_ops_close_delivery", { apply: true })).structuredContent;
  assert.equal(closed.applied, true);
  assert.ok(closed.changedComponents.length > 0, "a delivery that changed nothing is not a delivery");

  const { records } = await loadTaskboard(product);
  const handoff = records.find((task) => task.task_id === closed.taskId);
  assert.equal(handoff.status, "done", "the board moved because the work came back, not because it was asked to");
});

/**
 * A contract already in the outbox used to win over a corrected one. The reuse check compared
 * identity — task, title, problem, approval — and none of those change when acceptance criteria are
 * fixed, which is precisely the case where replacing it matters. The owner's run hit this: the
 * export defect was found before anyone built against it, and the broken contract would have been
 * handed back unchanged.
 */
/**
 * A sealed run is immutable, so a correction the owner makes after the delivery contract was sealed
 * never reaches the contract that crosses. On the owner's first real product this left an
 * acceptance criterion demanding two browsers after they had narrowed it to one — the implementers
 * were told in their briefs, and independent verification, which reads the contract, would have
 * failed the work against a requirement that had been withdrawn.
 */
test("an owner decision recorded after the contract was sealed crosses with it", async (t) => {
  const { product, application, handlers } = await deliveryWorkspace(t);
  const waiting = (await call(handlers, "product_ops_open_delivery", { apply: true })).structuredContent;
  await settleGate(handlers, product, waiting.requestId);

  // The correction lands after the delivery contract card completed, which is the whole difficulty.
  const log = path.join(product, "workbook", "09-decision-log.csv");
  const rows = parseCsv(await fs.readFile(log, "utf8"));
  const header = rows[0];
  const row = header.map(() => "");
  const put = (name, value) => { row[header.indexOf(name)] = value; };
  put("decision_id", "DEC-20260809-001");
  put("event_id", "EVT-20260809-001");
  put("title", "AC-01 applies to Chromium only");
  put("status", "approved");
  put("selected_option", "chromium_only");
  put("decision_maker_actor_id", "human-product-owner");
  put("decided_at", "2026-08-09T23:00:00.000Z");
  put("conditions", "Gecko stays an open issue");
  await fs.writeFile(log, stringifyCsv([...rows, row]), "utf8");

  const crossed = (await call(handlers, "product_ops_open_delivery", { apply: true })).structuredContent;
  const exported = JSON.parse(await fs.readFile(
    path.join(application, ".development-os", "inbox", `${crossed.requestId}.json`), "utf8"));
  const carried = exported.constraints.find((item) => item.includes("DEC-20260809-001"));
  assert.ok(carried, `the correction must travel with the contract: ${JSON.stringify(exported.constraints)}`);
  assert.match(carried, /Chromium only/);
  assert.match(carried, /after this contract was sealed/);
  assert.match(carried, /Gecko stays an open issue/, "its conditions travel too");
});

test("a contract nobody has built against yet can be corrected", async (t) => {
  const { product, handlers } = await deliveryWorkspace(t);
  const waiting = (await call(handlers, "product_ops_open_delivery", { apply: true })).structuredContent;
  await settleGate(handlers, product, waiting.requestId);
  const first = (await call(handlers, "product_ops_open_delivery", { apply: true })).structuredContent;

  // Damage the exported contract the way the export defect did, then cross again.
  const outbox = path.join(product, ".product-ops", "runtime", "development", "contracts", "outbox", `${first.requestId}.json`);
  const broken = JSON.parse(await fs.readFile(outbox, "utf8"));
  broken.acceptanceCriteria = [{ id: "AC-01", statement: "The record does not select, approve, or rank any option.", verification: "Re-read the record." }];
  broken.impacts = ["documentation", "database", "infrastructure"];
  await fs.writeFile(outbox, `${JSON.stringify(broken, null, 2)}\n`, "utf8");

  const corrected = await call(handlers, "product_ops_open_delivery", { apply: true });
  assert.equal(corrected.isError, false, corrected.content[0].text);
  assert.equal(corrected.structuredContent.superseded, true, "the stored contract must not win over the corrected one");
  assert.match(corrected.content[0].text, /replaced/i);
  const stored = JSON.parse(await fs.readFile(outbox, "utf8"));
  assert.deepEqual(stored.impacts, ["frontend"], "and what is on disk is the corrected contract");
});

test("a contract that work has been sealed against is not replaceable underneath it", async (t) => {
  const { product, application, handlers } = await deliveryWorkspace(t);
  const waiting = (await call(handlers, "product_ops_open_delivery", { apply: true })).structuredContent;
  await settleGate(handlers, product, waiting.requestId);
  const first = (await call(handlers, "product_ops_open_delivery", { apply: true })).structuredContent;

  // One workstream answered and sealed. Its evidence certifies this contract's digest.
  const claim = (await call(handlers, "product_ops_next_engineering_work")).structuredContent;
  await fs.writeFile(path.join(application, "src", "answered.js"), "export const answered = true;\n", "utf8");
  await call(handlers, "product_ops_submit_engineering_work", {
    workstreamId: claim.workstreamId, claimToken: claim.claimToken, apply: true, result: workstreamResult(claim)
  });

  const outbox = path.join(product, ".product-ops", "runtime", "development", "contracts", "outbox", `${first.requestId}.json`);
  const changed = JSON.parse(await fs.readFile(outbox, "utf8"));
  changed.acceptanceCriteria = [{ id: "AC-01", statement: "Something else entirely.", verification: "Look at it." }];
  await fs.writeFile(outbox, `${JSON.stringify(changed, null, 2)}\n`, "utf8");

  const refused = await call(handlers, "product_ops_open_delivery", { apply: true });
  assert.equal(refused.isError, true, "sealed work must not be left certifying a document that no longer exists");
  assert.match(JSON.stringify(refused), /sealed against it/i);
  assert.match(JSON.stringify(refused), new RegExp(claim.workstreamId));
});

async function deliveryWorkspace(t) {
  const parent = await makeTempDirectory("product-ops-delivery-");
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const product = path.join(parent, "ops");
  const application = path.join(parent, "app");
  await initCommand(product, {});
  await fs.mkdir(path.join(application, "src"), { recursive: true });
  await initializeDevelopmentOs(application, { dryRun: false });
  await linkCommand(product, { application, apply: true });

  // The engineering side works on a branch, which needs a repository with something in it.
  await runGit(application, ["init", "--quiet"]);
  await fs.writeFile(path.join(application, "README.md"), "Application.\n", "utf8");
  await runGit(application, ["add", "-A"]);
  await runGit(application, ["-c", "user.name=T", "-c", "user.email=t@t.test", "commit", "--quiet", "-m", "first"]);

  // A real idea, routed the way an owner's would be, so the delivery contract is built from a real
  // event rather than from a board row with nothing behind it.
  const config = await loadConfig(product);
  await ingestRecord(product, {
    type: "new_idea",
    title: "Players cannot see how far they got",
    description: "A run ends with no record of the distance, so there is nothing to beat.",
    source: "the owner",
    priority: "P1"
  }, { dryRun: false, now: new Date("2026-08-09T10:00:00Z") });
  await runControlTower(product, config, { dryRun: false, now: new Date("2026-08-09T10:01:00Z") });

  // The product side has worked the event as far as the hand-off. Every card before it is done and
  // carries its sealed run, because that is what a done card means and the delivery contract is
  // built from exactly those.
  const { headers, records } = await loadTaskboard(product);
  const handoff = records.find((task) => task.owner_role === config.separation.developmentRole);
  assert.ok(handoff, "the routed event reaches the development boundary");
  const before = records.slice(0, records.indexOf(handoff));
  for (const task of before) await writeProductRun(product, config, task);
  await replaceTaskboard(product, headers, records.map((task) => ({
    ...task,
    status: task.task_id === handoff.task_id ? "ready" : "done",
    human_gate: ""
  })), { dryRun: false });

  const context = await createServerContext({ project: product, allowWrites: true });
  // The owner answers in their own words; the test speaks for them exactly once, at the gate.
  context.elicit = async () => ({ action: "accept", content: {
    decision: "approved",
    actorId: config.project.humanAuthorityActorId,
    rationale: "Bounded work in a separate repository, and nothing ships without me."
  } });
  const handlers = createHandlers(context, { version: "test" });
  handlers.initialize({ protocolVersion: "2026-07-28", capabilities: { elicitation: {} } });
  return { product, application, handlers };
}

/**
 * The sealed run a completed product card carries.
 *
 * The earlier cards deliberately carry criteria about reviewing documents, and wider impacts, so
 * that a contract assembled from all of them instead of from the delivery card is visibly wrong
 * rather than coincidentally right. This is the shape the owner's own run had.
 */
async function writeProductRun(product, config, task) {
  const directory = path.join(product, ".product-ops", "runtime", "autopilot", "product-runs");
  await fs.mkdir(directory, { recursive: true });
  const isContract = task.owner_role === "RB-06";
  const result = {
    schemaVersion: "1.0.0",
    taskId: task.task_id,
    eventId: task.event_id,
    roleId: task.owner_role,
    producerActorId: config.agents.find((agent) => agent.id === task.owner_role).actorId,
    status: "completed",
    summary: `${task.title} completed for the delivery-crossing regression.`,
    findings: [],
    recommendations: isContract ? ["Show the distance reached when a run ends."] : ["Record the options rather than choosing between them."],
    acceptanceCriteria: isContract
      ? [{ statement: "A finished run shows the distance reached.", verification: "Play one run and read the end screen." }]
      : [{ statement: "The record does not select, approve, or rank any option.", verification: "Re-read the record and confirm no disposition appears in it." }],
    impacts: isContract ? ["frontend"] : ["documentation", "database", "infrastructure"],
    constraints: [],
    nonFunctionalRequirements: [],
    evidence: [],
    knownRisks: [],
    completedAt: "2026-08-09T11:00:00.000Z"
  };
  await fs.writeFile(path.join(directory, `${task.task_id}-result.json`), `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

async function settleGate(handlers, product, requestId) {
  const pending = (await call(handlers, "product_ops_pending_decisions")).structuredContent;
  const gate = pending.items.find((item) => item.requestId === requestId);
  assert.ok(gate, "the crossing gate reaches the owner through the ordinary decision list");
  const decided = await call(handlers, "product_ops_decide", {
    requestId: gate.requestId, decisionToken: gate.decisionToken, apply: true
  });
  assert.equal(decided.isError, false, JSON.stringify(decided.structuredContent));
  assert.equal(decided.structuredContent.decision, "approved");
  assert.equal((await loadApprovals(product)).requests.find((item) => item.requestId === requestId).status, "approved");
}

function workstreamResult(claim) {
  return {
    schemaVersion: "1.0.0",
    planId: claim.planId,
    workstreamId: claim.workstreamId,
    ownerRole: claim.ownerRole,
    producerActorId: claim.producerActorId,
    status: "completed",
    verificationDisposition: claim.ownerRole === "ENG-15" ? "passed" : "not_applicable",
    implementationRevision: "abcdef1234567890",
    changedComponents: ["src"],
    commands: ["node --test"],
    evidence: ["evidence/run.json"],
    knownRisks: [],
    completedAt: "2026-08-09T12:00:00.000Z"
  };
}

/** An approved delivery contract the planner accepts, as the development suite states it. */
function developmentRequest(suffix = "MCP-ENGINEERING-001") {
  return {
    schemaVersion: "1.0.0",
    requestId: `DEVREQ-${suffix}`,
    productTaskId: "TASK-RB-13-0001",
    deliveryTicketReference: "product/delivery-ticket.md",
    title: "Deliver a searchable public catalog",
    problem: "Users cannot discover or efficiently search the public product catalog.",
    desiredOutcome: "Users find indexable catalog entries with predictable response times.",
    acceptanceCriteria: [
      { id: "AC-01", statement: "Catalog entries are searchable and paginated.", verification: "Run API and browser scenarios." },
      { id: "AC-02", statement: "Public pages expose valid canonical metadata.", verification: "Run technical SEO audit." }
    ],
    impacts: ["architecture", "frontend", "accessibility", "backend", "api", "database", "search", "security", "performance", "seo", "documentation"],
    constraints: ["No production data in tests", "Migration must be reversible"],
    nonFunctionalRequirements: [
      { domain: "performance", requirement: "Search p95 remains below the approved budget.", verification: "Execute a reproducible load scenario." },
      { domain: "database", requirement: "Migration supports rollback and restore.", verification: "Run migration and recovery in test." }
    ],
    writeBoundary: {
      repositories: ["application"],
      allowedPaths: ["src", "tests", "database", "migrations", "docs"],
      prohibitedPaths: [".env", "production-data"]
    },
    validation: {
      commands: ["npm test", "npm run audit"],
      evidenceRequired: ["test report", "migration proof", "SEO audit"]
    },
    approval: {
      status: "approved",
      actorId: "human-product-owner",
      decidedAt: "2026-08-01T00:00:00.000Z",
      reference: "APR-DEV-001"
    },
    source: {
      productOperationsRevision: "abcdef1234567890",
      exportedAt: "2026-08-01T00:01:00.000Z"
    }
  };
}
