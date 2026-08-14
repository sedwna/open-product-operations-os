import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { initCommand } from "../src/commands/init.js";
import { loadConfig } from "../src/config.js";
import { loadTaskboard } from "../src/runtime/taskboard.js";
import { createHandlers, createServerContext } from "../src/mcp/server.js";
import { TOOL_DEFINITIONS } from "../src/mcp/registry.js";
import { makeTempDirectory } from "./helpers.js";

async function workspace(t, { allowWrites = true } = {}) {
  const parent = await makeTempDirectory("product-ops-work-");
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "product");
  await initCommand(root, {});
  const context = await createServerContext({ project: root, allowWrites });
  const handlers = createHandlers(context, { version: "test" });
  handlers.initialize({ protocolVersion: "2026-07-28", capabilities: {} });
  return { root, context, handlers };
}

const call = (handlers, name, args = {}) => handlers["tools/call"]({ name, arguments: args });

/** A result shaped the way the run contract requires, for whichever task was handed out. */
function resultFor(claim, overrides = {}) {
  return {
    schemaVersion: "1.0.0",
    taskId: claim.taskId,
    eventId: claim.eventId,
    roleId: claim.roleId,
    producerActorId: claim.producerActorId,
    status: "completed",
    summary: "Recorded by a delegated subagent for the regression suite.",
    findings: [],
    recommendations: [],
    acceptanceCriteria: [],
    impacts: [],
    constraints: [],
    nonFunctionalRequirements: [],
    evidence: [],
    knownRisks: [],
    completedAt: "2026-08-06T00:00:00.000Z",
    ...overrides
  };
}

test("a read-only server exposes no way to take or return work", async (t) => {
  const { handlers } = await workspace(t, { allowWrites: false });
  const { tools } = await handlers["tools/list"]({});
  const names = tools.map((tool) => tool.name);
  assert.ok(!names.includes("product_ops_next_work"), "taking work must not be reachable without write authorisation");
  assert.ok(!names.includes("product_ops_submit_work"), "returning work must not be reachable without write authorisation");
});

test("next_work hands out a team, its boundary, and a claim", async (t) => {
  const { root, handlers } = await workspace(t);
  const config = await loadConfig(root);
  const result = await call(handlers, "product_ops_next_work");
  const claim = result.structuredContent;

  assert.equal(claim.available, true);
  assert.equal(claim.claimToken.length, 32);
  assert.ok(claim.team && claim.team !== claim.roleId, "the brief must name a team, not a contract identifier");
  assert.ok(claim.teamFocus.length > 0, "a team without a stated job is a number with a label");
  assert.ok(Array.isArray(claim.may) && Array.isArray(claim.mustNot));
  assert.notEqual(claim.roleId, config.separation.developmentRole, "the development boundary is not delegated through this surface");
  assert.equal(claim.brief.policy.noDirectRepositoryWrites, true);
  assert.equal(claim.brief.policy.preserveHumanProductAuthority, true);
  assert.equal(claim.brief.resultContract.title, "Product Agent Run");
  assert.equal(claim.brief.resultContract.properties.nonFunctionalRequirements.items.type, "object");
});

test("the decision-brief role returns the exact options that a later human gate will present", async (t) => {
  const { root, handlers } = await workspace(t);
  const config = await loadConfig(root);
  const { ingestRecord } = await import("../src/runtime/intake.js");
  const { replaceTaskboard } = await import("../src/runtime/taskboard.js");
  const { loadApprovals } = await import("../src/runtime/approvals.js");
  await ingestRecord(root, {
    type: "new_idea",
    title: "Choose a launch route",
    description: "The owner must choose how much historical data to import.",
    source: "the owner"
  }, { dryRun: false });
  await call(handlers, "product_ops_operate", { apply: true });

  const loaded = await loadTaskboard(root);
  const eventTasks = loaded.records.filter((task) => task.event_id !== "EVT-00000000-001");
  const briefTask = eventTasks.find((task) => task.owner_role === "RB-02");
  const gateTask = eventTasks.find((task) => task.human_gate === "product_direction_or_priority");
  assert.ok(briefTask && gateTask);
  await replaceTaskboard(root, loaded.headers, loaded.records.map((task) => {
    if (task.event_id !== briefTask.event_id) return task;
    if (task.task_id === briefTask.task_id) return { ...task, status: "done" };
    if (task.task_id === gateTask.task_id) return { ...task, status: "ready" };
    return { ...task, status: "backlog" };
  }), { dryRun: false });

  const runDirectory = path.join(root, ".product-ops/runtime/autopilot/product-runs");
  await fs.mkdir(runDirectory, { recursive: true });
  await fs.writeFile(path.join(runDirectory, `${briefTask.task_id}-result.json`), `${JSON.stringify({
    schemaVersion: "1.0.0",
    taskId: briefTask.task_id,
    eventId: briefTask.event_id,
    roleId: "RB-02",
    producerActorId: config.agents.find((agent) => agent.id === "RB-02").actorId,
    status: "completed",
    summary: "Prepared three bounded launch routes for the owner.",
    findings: [], recommendations: [], acceptanceCriteria: [], impacts: [], constraints: [],
    nonFunctionalRequirements: [], evidence: [], knownRisks: [],
    decisionProposal: {
      question: "Which historical import route should ProductYab take?",
      context: "Choose the bounded launch scope.",
      options: ["A: manual seed", "B: one-year automated backfill", "C: forward-only"],
      recommendedOption: "B: one-year automated backfill"
    },
    completedAt: "2026-08-14T00:00:00.000Z"
  }, null, 2)}\n`, "utf8");

  await call(handlers, "product_ops_operate", { apply: true });
  const approval = (await loadApprovals(root)).requests.find((item) => item.taskId === gateTask.task_id);
  assert.deepEqual(approval.options, ["A: manual seed", "B: one-year automated backfill", "C: forward-only"]);
  assert.equal(approval.recommendedOption, "B: one-year automated backfill");
  assert.equal(approval.question, "Which historical import route should ProductYab take?");
});

test("only RB-02 may prepare a decision proposal and its recommendation must be offered", async (t) => {
  const { root, handlers } = await workspace(t);
  const { ingestRecord } = await import("../src/runtime/intake.js");
  await ingestRecord(root, {
    type: "new_idea",
    title: "Choose a bounded product direction",
    description: "The product owner needs explicit alternatives before delivery.",
    source: "the owner"
  }, { dryRun: false });
  await call(handlers, "product_ops_operate", { apply: true });
  const claim = await cardFor(handlers, "RB-02", root);
  assert.match(claim.brief.reporting.decisionProposalRule, /exact question/i);
  const invalid = await call(handlers, "product_ops_submit_work", {
    taskId: claim.taskId,
    claimToken: claim.claimToken,
    result: resultFor(claim, {
      decisionProposal: {
        question: "Which route should the product take?",
        options: ["A", "B"],
        recommendedOption: "C"
      }
    })
  });
  assert.equal(invalid.isError, true);
  assert.match(JSON.stringify(invalid), /recommendedOption/);
});

test("work is returned through the same contract a provider would have to satisfy", async (t) => {
  const { root, handlers } = await workspace(t);
  const claim = (await call(handlers, "product_ops_next_work")).structuredContent;

  const planned = await call(handlers, "product_ops_submit_work", {
    taskId: claim.taskId,
    claimToken: claim.claimToken,
    result: resultFor(claim)
  });
  assert.equal(planned.structuredContent.applied, false, "submitting must plan by default");

  const runsBefore = await fs.readdir(path.join(root, ".product-ops/runtime/autopilot/product-runs")).catch(() => []);
  assert.equal(runsBefore.length, 0, "a planned submission must write nothing");

  const applied = await call(handlers, "product_ops_submit_work", {
    taskId: claim.taskId,
    claimToken: claim.claimToken,
    result: resultFor(claim),
    apply: true
  });
  assert.equal(applied.structuredContent.applied, true);
  assert.equal(applied.structuredContent.sealed, true);
  assert.equal(applied.structuredContent.team, claim.team);

  const stored = JSON.parse(await fs.readFile(path.join(root, applied.structuredContent.outputFile), "utf8"));
  assert.equal(stored.taskId, claim.taskId);
  assert.equal(stored.producerActorId, claim.producerActorId);
});

test("a result that does not match the dispatched task is refused, not recorded", async (t) => {
  const { handlers } = await workspace(t);
  const claim = (await call(handlers, "product_ops_next_work")).structuredContent;

  // Claiming another role's authorship is the failure that matters: it is how a producer could
  // come to stand behind work it never did.
  const impersonated = await call(handlers, "product_ops_submit_work", {
    taskId: claim.taskId,
    claimToken: claim.claimToken,
    result: resultFor(claim, { producerActorId: "someone-else" }),
    apply: true
  });
  assert.equal(impersonated.isError, true);
  assert.match(JSON.stringify(impersonated), /producerActorId|refused/i);

  const malformed = await call(handlers, "product_ops_submit_work", {
    taskId: claim.taskId,
    claimToken: claim.claimToken,
    result: { schemaVersion: "1.0.0", taskId: claim.taskId },
    apply: true
  });
  assert.equal(malformed.isError, true);
});

test("work cannot be returned without having been taken", async (t) => {
  const { handlers } = await workspace(t);
  const claim = (await call(handlers, "product_ops_next_work")).structuredContent;

  const forged = await call(handlers, "product_ops_submit_work", {
    taskId: claim.taskId,
    claimToken: "0".repeat(32),
    result: resultFor(claim),
    apply: true
  });
  assert.equal(forged.isError, true);
  assert.match(JSON.stringify(forged), /claim/i);
});

test("a claim does not survive the task moving on", async (t) => {
  const { root, context, handlers } = await workspace(t);
  const claim = (await call(handlers, "product_ops_next_work")).structuredContent;

  // The token is keyed to where the task stood when it was handed out. Once it moves, the token
  // describes work that no longer exists, and replaying it must not reach the run store.
  const { headers, records } = await loadTaskboard(root);
  const moved = records.map((task) => task.task_id === claim.taskId ? { ...task, status: "blocked" } : task);
  assert.equal(context.verifyClaimToken(moved.find((task) => task.task_id === claim.taskId), claim.claimToken), false);
  assert.ok(headers.length > 0);
});

test("with nothing ready, the surface says why rather than inventing work", async (t) => {
  const { root, handlers } = await workspace(t);
  const { headers, records } = await loadTaskboard(root);
  const { replaceTaskboard } = await import("../src/runtime/taskboard.js");
  await replaceTaskboard(root, headers, records.map((task) => ({ ...task, status: "done" })), { dryRun: false });

  const result = await call(handlers, "product_ops_next_work");
  assert.equal(result.structuredContent.available, false);
  assert.equal(result.structuredContent.reason, "all_done");
  assert.doesNotMatch(result.content?.[0]?.text ?? "", /undefined|null/);
});

test("both work tools are registered as plan-tier and declared", () => {
  const definitions = TOOL_DEFINITIONS.filter((tool) => tool.name.startsWith("product_ops_next_work") || tool.name.startsWith("product_ops_submit_work"));
  assert.equal(definitions.length, 2);
  for (const definition of definitions) {
    assert.equal(definition.tier, "plan");
    assert.equal(definition.inputSchema.additionalProperties, false);
    assert.ok(definition.description.length <= 160, `${definition.name} description must stay short enough for a tool list`);
  }
});

test("the loop advances rather than handing out the same card forever", async (t) => {
  // The defect this pins was invisible to every per-tool test: submit_work sealed the run correctly
  // and never moved the board, so next_work returned the same card each time. A coordinator
  // following the brief would have looped forever while appearing to work.
  const { root, handlers } = await workspace(t);
  await call(handlers, "product_ops_intake", {
    type: "new_idea",
    title: "Let coordinators choose the weekly summary day",
    description: "Monday summaries arrive after the week is already planned.",
    source: "support conversation",
    apply: true
  });
  await call(handlers, "product_ops_operate", { apply: true });

  const handled = [];
  for (let pass = 0; pass < 40; pass += 1) {
    const next = (await call(handlers, "product_ops_next_work")).structuredContent;
    if (!next.available) break;
    assert.ok(
      !handled.includes(next.taskId),
      `${next.taskId} was handed out twice; the board did not advance after it was returned`
    );
    handled.push(next.taskId);
    const submitted = await call(handlers, "product_ops_submit_work", {
      taskId: next.taskId,
      claimToken: next.claimToken,
      result: resultFor(next),
      apply: true
    });
    assert.equal(submitted.structuredContent.boardStatus, "done", "a completed run must move its card to done");
    assert.ok(submitted.structuredContent.cycle.total > 0, "the reply must say where the cycle now stands");
  }

  assert.ok(handled.length > 0, "the loop must have had work to do");
  const { records } = await loadTaskboard(root);
  for (const taskId of handled) {
    assert.equal(records.find((task) => task.task_id === taskId).status, "done");
  }
});

test("a blocked result stops its card and says why, in the producer's words", async (t) => {
  const { root, handlers } = await workspace(t);
  const next = (await call(handlers, "product_ops_next_work")).structuredContent;

  const submitted = await call(handlers, "product_ops_submit_work", {
    taskId: next.taskId,
    claimToken: next.claimToken,
    result: resultFor(next, { status: "blocked", summary: "The analytics export is unavailable." }),
    apply: true
  });
  assert.equal(submitted.structuredContent.boardStatus, "blocked");
  assert.equal(submitted.structuredContent.sealed, false, "only a completed result is sealed");

  const { records } = await loadTaskboard(root);
  const card = records.find((task) => task.task_id === next.taskId);
  assert.equal(card.status, "blocked");
  assert.match(card.blocked_reason, /analytics export/, "the card must carry the producer's own reason");
});

test("reaching the engineering hand-off is reported as a boundary, not as an empty queue", async (t) => {
  // "Nothing is ready" would be false: the cycle is not stalled, it has arrived at the line this
  // surface deliberately will not cross, and the owner needs to know which of the two it is.
  const { root, handlers } = await workspace(t);
  const config = await loadConfig(root);
  const { headers, records } = await loadTaskboard(root);
  const { replaceTaskboard } = await import("../src/runtime/taskboard.js");
  await replaceTaskboard(root, headers, records.map((task) => ({
    ...task,
    owner_role: config.separation.developmentRole,
    status: "ready",
    human_gate: ""
  })), { dryRun: false });

  const result = await call(handlers, "product_ops_next_work");
  assert.equal(result.structuredContent.available, false);
  assert.equal(result.structuredContent.reason, "at_development_boundary");
  assert.match(result.content[0].text, /hand-off to engineering/);
  assert.doesNotMatch(result.content[0].text, /Nothing is ready/);
});

test("reaching engineering with nowhere to send it opens a decision, not a dead end", async (t) => {
  // The board used to stop and report a boundary, leaving the owner to already know that an
  // application repository must exist, that development-os init writes the engineering model into
  // it, and that link connects the two — and then to ask for all three themselves.
  const { root, handlers } = await workspace(t);
  const config = await loadConfig(root);
  const { headers, records } = await loadTaskboard(root);
  const { replaceTaskboard } = await import("../src/runtime/taskboard.js");
  await replaceTaskboard(root, headers, records.map((task) => ({
    ...task,
    owner_role: config.separation.developmentRole,
    status: "ready",
    human_gate: ""
  })), { dryRun: false });

  await call(handlers, "product_ops_operate", { apply: true });

  const gates = (await call(handlers, "product_ops_pending_decisions")).structuredContent;
  const crossing = gates.items.find((item) => item.gate === "development_boundary_crossing");
  assert.ok(crossing, "the owner must be asked, not left to work it out");
  assert.match(String(crossing.question), /application repository/i);
  // Creating a repository is not authorising agents to write code in it.
  assert.match(String(crossing.context), /separate decision/i);
});

test("the crossing decision is asked once, not on every cycle", async (t) => {
  const { root, handlers } = await workspace(t);
  const config = await loadConfig(root);
  const { headers, records } = await loadTaskboard(root);
  const { replaceTaskboard } = await import("../src/runtime/taskboard.js");
  await replaceTaskboard(root, headers, records.map((task) => ({
    ...task,
    owner_role: config.separation.developmentRole,
    status: "ready",
    human_gate: ""
  })), { dryRun: false });

  await call(handlers, "product_ops_operate", { apply: true });
  await call(handlers, "product_ops_operate", { apply: true });

  const gates = (await call(handlers, "product_ops_pending_decisions")).structuredContent;
  const crossings = gates.items.filter((item) => item.gate === "development_boundary_crossing");
  assert.equal(crossings.length, 1, "a pending decision must not be reopened underneath the owner");
});

/**
 * A gate settled with conditions is the owner setting terms for the work, not merely letting it
 * through. Recording the terms and then delegating the task without them drops the decision that
 * authorised it.
 */
test("conditions the owner attached to a gate travel with the delegated brief", async (t) => {
  const { root, handlers } = await workspace(t);
  const config = await loadConfig(root);
  const { records } = await loadTaskboard(root);
  const task = records[0];

  const { requestApproval, decideApproval } = await import("../src/runtime/approvals.js");
  const { request } = await requestApproval(root, {
    taskId: task.task_id,
    gate: "product_direction_or_priority",
    question: "Ship it?"
  }, { dryRun: false });
  await decideApproval(root, config, {
    requestId: request.requestId,
    decision: "approved",
    actorId: config.project.humanAuthorityActorId,
    rationale: "Worth doing, but not at any cost.",
    conditions: ["Keep the existing default working", "No data migration in this cycle"]
  }, { dryRun: false });

  const claim = (await call(handlers, "product_ops_next_work")).structuredContent;
  assert.equal(claim.available, true);
  const decision = claim.ownerDecisions.find((entry) => entry.gate === "product_direction_or_priority");
  assert.ok(decision, "the owner's decision on this event reaches the team that works it");
  assert.equal(decision.decision, "approved");
  assert.equal(decision.conditions.length, 2);
});

test("a brief with nothing decided carries no decisions rather than an empty claim", async (t) => {
  const { handlers } = await workspace(t);
  const claim = (await call(handlers, "product_ops_next_work")).structuredContent;
  assert.deepEqual(claim.ownerDecisions, []);
});

/**
 * A brief is read by a subagent, pasted into a shell, and interpolated into tool calls. A backslash
 * survives none of that reliably — it is an escape character almost everywhere it lands, and
 * `D:\Projects\app` arrives as `D:Projectsapp`.
 */
test("a path handed to whoever performs the work uses separators that survive being read", async (t) => {
  const { root, handlers } = await workspace(t);
  const application = path.join(path.dirname(root), "application");
  await fs.mkdir(application, { recursive: true });
  const { initializeDevelopmentOs } = await import("../src/development/init.js");
  const { linkCommand } = await import("../src/commands/link.js");
  await initializeDevelopmentOs(application, { dryRun: false });
  await linkCommand(root, { application, apply: true });

  const claim = (await call(handlers, "product_ops_next_work")).structuredContent;
  const linked = claim.brief.linkedApplication.root;
  assert.ok(linked, "the brief names the application it may reach");
  assert.ok(!linked.includes("\\"), `a brief path must not carry backslashes: ${linked}`);
  assert.equal(path.resolve(linked), path.resolve(application), "and it still resolves to the same place");
});

/**
 * The first real product run recorded "no performance budget is documented" because one retrieval
 * returned a transient error and was never retried. Every document downstream then reasoned from a
 * gap that was never there.
 */
test("a brief tells the performer that a failed retrieval is not an absence", async (t) => {
  const { handlers } = await workspace(t);
  const claim = (await call(handlers, "product_ops_next_work")).structuredContent;
  assert.equal(claim.brief.policy.retryBeforeRecordingAbsence, true);
  assert.match(claim.brief.reporting.absenceRule, /retry/i);
  assert.match(claim.brief.reporting.absenceRule, /record the failure/i);
});

/**
 * The card that finishes an event closes it.
 *
 * When product work was inverted to host-delegated execution this step stayed behind in the
 * coordinator loop: the delegated path completed every card and then told the coordinator to run a
 * scheduling pass to "close the cycle", which cannot close anything. So on the only path an owner
 * uses, the canonical product record was never written. The first real product finished eight cards
 * with every content tab still empty.
 */
test("the last card of an event writes the canonical record", async (t) => {
  const { root, handlers } = await workspace(t);
  const { ingestRecord } = await import("../src/runtime/intake.js");
  const { loadConfig } = await import("../src/config.js");
  const { replaceTaskboard } = await import("../src/runtime/taskboard.js");
  const { parseCsv } = await import("../src/csv.js");

  const config = await loadConfig(root);
  await ingestRecord(root, {
    type: "new_idea",
    title: "Players cannot see how far they got",
    description: "A run ends with no record of the distance.",
    source: "the owner"
  }, { dryRun: false });
  await call(handlers, "product_ops_operate", { apply: true });

  // Every card but the last is already answered, which is the state an event reaches just before it
  // closes. Each done card carries its sealed run, because that is what done means here.
  const { headers, records } = await loadTaskboard(root);
  const event = records.filter((task) => task.event_id !== "EVT-00000000-001");
  const last = event.at(-1);
  const directory = path.join(root, ".product-ops", "runtime", "autopilot", "product-runs");
  await fs.mkdir(directory, { recursive: true });
  for (const task of event.slice(0, -1)) {
    await fs.writeFile(path.join(directory, `${task.task_id}-result.json`), `${JSON.stringify({
      schemaVersion: "1.0.0",
      taskId: task.task_id,
      eventId: task.event_id,
      roleId: task.owner_role,
      producerActorId: config.agents.find((agent) => agent.id === task.owner_role).actorId,
      status: "completed",
      summary: `${task.title} completed.`,
      findings: [],
      recommendations: ["Show the distance when the run ends."],
      acceptanceCriteria: [{ statement: "A finished run shows the distance.", verification: "Play one run." }],
      impacts: ["frontend"],
      constraints: [],
      nonFunctionalRequirements: [],
      evidence: [],
      knownRisks: [],
      completedAt: "2026-08-09T11:00:00.000Z"
    }, null, 2)}\n`, "utf8");
  }
  await replaceTaskboard(root, headers, records.map((task) => ({
    ...task,
    status: task.task_id === last.task_id ? "ready" : "done"
  })), { dryRun: false });

  // The canonical record refuses to advance without the owner's attributed direction decision, so
  // the event carries one — as it would have in any run that got this far.
  const { requestApproval, decideApproval } = await import("../src/runtime/approvals.js");
  const gated = event.find((task) => task.human_gate === "product_direction_or_priority");
  const { request } = await requestApproval(root, {
    taskId: gated.task_id,
    gate: "product_direction_or_priority",
    question: "Which bounded route should proceed?",
    options: ["manual_seed", "one_year_backfill"],
    recommendedOption: "one_year_backfill"
  }, { dryRun: false });
  await decideApproval(root, config, {
    requestId: request.requestId,
    decision: "approved",
    selectedOption: "one_year_backfill",
    conditions: ["Keep source provenance", "Provide a kill switch"],
    actorId: config.project.humanAuthorityActorId,
    rationale: "Backfill one year, then monitor daily."
  }, { dryRun: false });

  const claim = (await call(handlers, "product_ops_next_work")).structuredContent;
  assert.equal(claim.taskId, last.task_id, "the last open card is the one handed out");
  const submitted = await call(handlers, "product_ops_submit_work", {
    taskId: claim.taskId, claimToken: claim.claimToken, apply: true, result: resultFor(claim)
  });
  assert.equal(submitted.isError, false, submitted.content[0].text);
  assert.equal(submitted.structuredContent.cycle.complete, true);
  assert.match(submitted.content[0].text, /canonical workbook now carries this event's record/,
    `closing the cycle must be reported as done, not as something still to run: ${submitted.content[0].text}`);

  // The record itself, not the claim about it.
  const rowsIn = async (file) =>
    parseCsv(await fs.readFile(path.join(root, "workbook", file), "utf8")).filter((row) => row.some((cell) => cell !== "")).length - 1;
  for (const file of ["05-events.csv", "10-issues.csv", "11-delivery-tickets.csv", "16-evidence.csv"]) {
    assert.ok(await rowsIn(file) > 0, `${file} must carry this event's record and does not`);
  }
  const decisionRows = parseCsv(await fs.readFile(path.join(root, "workbook", "09-decision-log.csv"), "utf8"));
  const decisionHeader = decisionRows[0];
  const decision = decisionRows.slice(1).find((row) => row[decisionHeader.indexOf("event_id")] === gated.event_id);
  assert.equal(decision[decisionHeader.indexOf("selected_option")], "one_year_backfill");
  assert.match(decision[decisionHeader.indexOf("conditions")], /Keep source provenance/);
  assert.match(decision[decisionHeader.indexOf("conditions")], /Provide a kill switch/);
  await fs.access(path.join(root, ".product-ops", "runtime", "autopilot", "reports"));
});

/**
 * The canonical record used to be written once, by one role, at the very end of a cycle. A product
 * that had raised twenty-nine issues and written a contract with thirty acceptance criteria still
 * showed an empty workbook, and looked — correctly — like a system that was not recording anything.
 * A role can now commit its own rows as its card completes, under three rules.
 */
async function cardFor(handlers, roleId, root) {
  const { loadTaskboard: load, replaceTaskboard } = await import("../src/runtime/taskboard.js");
  const { headers, records } = await load(root);
  const target = records.find((task) => task.owner_role === roleId);
  // Everything before it is done, so the card is genuinely runnable rather than merely marked
  // ready — an unsatisfied dependency would leave nothing to hand out.
  const index = records.indexOf(target);
  await replaceTaskboard(root, headers, records.map((task, position) => ({
    ...task,
    status: position < index ? "done" : (task.task_id === target.task_id ? "ready" : "backlog"),
    human_gate: ""
  })), { dryRun: false });
  const claim = (await call(handlers, "product_ops_next_work")).structuredContent;
  assert.equal(claim.roleId, roleId, `expected the ${roleId} card: ${JSON.stringify(claim)}`);
  return claim;
}

test("a role commits its own rows to the tab it owns as its card completes", async (t) => {
  const { root, handlers } = await workspace(t);
  const { ingestRecord } = await import("../src/runtime/intake.js");
  const { parseCsv } = await import("../src/csv.js");
  await ingestRecord(root, {
    type: "new_idea", title: "Players cannot see how far they got",
    description: "A run ends with no record of the distance.", source: "the owner"
  }, { dryRun: false });
  await call(handlers, "product_ops_operate", { apply: true });

  // The issues team owns the issues register, and this is the card that produces issues.
  const claim = await cardFor(handlers, "RB-05", root);
  assert.ok(claim.brief.reporting.canonicalRecordRule, "the brief tells the role which record is its to write");
  assert.deepEqual(claim.brief.reporting.ownedRecords.map((item) => item.sheet), ["issues"]);

  const submitted = await call(handlers, "product_ops_submit_work", {
    taskId: claim.taskId, claimToken: claim.claimToken, apply: true,
    result: resultFor(claim, {
      canonicalRecords: [{
        sheet: "issues",
        key: { issue_id: "ISS-0001" },
        fields: { title: "No distance is shown when a run ends", status: "open", priority: "P1", owner_role: "RB-05" }
      }]
    })
  });
  assert.equal(submitted.isError, false, submitted.content[0].text);
  assert.match(submitted.content[0].text, /1 row\(s\) went into the canonical record: issues/);

  const rows = parseCsv(await fs.readFile(path.join(root, "workbook", "10-issues.csv"), "utf8"))
    .filter((row) => row.some((cell) => cell !== ""));
  const header = rows[0];
  const written = rows.slice(1).find((row) => row[header.indexOf("issue_id")] === "ISS-0001");
  assert.ok(written, "the row is in the record, not only in the run file");
  assert.equal(written[header.indexOf("event_id")], claim.eventId, "and it is tied to the event that produced it");
});

test("a role cannot write a record that belongs to another role", async (t) => {
  for (const [label, role, rows, expected] of [
    ["another role's tab", "RB-05", [{ sheet: "releases", key: { release_id: "REL-1" }, fields: { status: "released" } }], /belongs to RB-11/],
    ["a column that does not exist", "RB-05", [{ sheet: "issues", key: { issue_id: "ISS-1" }, fields: { not_a_column: "x" } }], /no such column/],
    // The contract role owns delivery tickets, and those carry fields the development side owns.
    // Writing one here would route around the boundary that exists to keep them apart.
    ["a field the development side owns", "RB-06", [{ sheet: "delivery_tickets", key: { ticket_id: "TKT-1" }, fields: { development_status: "done" } }], /protected field/],
    ["a tab that does not exist", "RB-05", [{ sheet: "not_a_tab", key: { id: "x" }, fields: {} }], /not a workbook tab/]
  ]) {
    await t.test(label, async (inner) => {
      // A fresh workspace per case: a submitted attempt is retained, so reusing one card would test
      // the retention rather than the rule.
      const { root, handlers } = await workspace(inner);
      const { ingestRecord } = await import("../src/runtime/intake.js");
      await ingestRecord(root, {
        type: "new_idea", title: "Players cannot see how far they got",
        description: "A run ends with no record of the distance.", source: "the owner"
      }, { dryRun: false });
      await call(handlers, "product_ops_operate", { apply: true });
      const claim = await cardFor(handlers, role, root);

      const refused = await call(handlers, "product_ops_submit_work", {
        taskId: claim.taskId, claimToken: claim.claimToken, apply: true,
        result: resultFor(claim, { canonicalRecords: rows })
      });
      assert.equal(refused.isError, true, `must refuse ${label}`);
      assert.equal(refused.structuredContent.code, "RECORD_REJECTED", "and say so in a code a caller can act on");
      assert.match(JSON.stringify(refused), expected);

      // A row that will not go in stops the card rather than leaving it done with a record that
      // never arrived.
      const { records: board } = await loadTaskboard(root);
      assert.equal(board.find((task) => task.task_id === claim.taskId).status, "ready");
    });
  }
});

test("plan and apply reject protected canonical fields without sealing artifacts, then allow a corrected retry", async (t) => {
  const { root, handlers } = await workspace(t);
  const { ingestRecord } = await import("../src/runtime/intake.js");
  await ingestRecord(root, {
    type: "new_idea",
    title: "Choose the first product direction",
    description: "The owner needs a decision brief before delivery begins.",
    source: "the owner"
  }, { dryRun: false });
  await call(handlers, "product_ops_operate", { apply: true });
  const claim = await cardFor(handlers, "RB-02", root);
  const invalid = resultFor(claim, {
    canonicalRecords: [{
      sheet: "decision_log",
      key: { decision_id: "DEC-PENDING-1" },
      fields: {
        status: "pending_human",
        decision_maker_actor_id: "human-product-owner"
      }
    }]
  });

  for (const apply of [false, true]) {
    const refused = await call(handlers, "product_ops_submit_work", {
      taskId: claim.taskId,
      claimToken: claim.claimToken,
      result: invalid,
      ...(apply ? { apply: true } : {})
    });
    assert.equal(refused.isError, true, `${apply ? "apply" : "plan"} must reject the same protected field`);
    assert.equal(refused.structuredContent.code, "RECORD_REJECTED");
    assert.match(JSON.stringify(refused), /decision_maker_actor_id/);
    const runs = await fs.readdir(path.join(root, ".product-ops/runtime/autopilot/product-runs")).catch(() => []);
    assert.deepEqual(runs, [], "a rejected submission must not leave attempt or sealed artifacts");
  }

  const corrected = await call(handlers, "product_ops_submit_work", {
    taskId: claim.taskId,
    claimToken: claim.claimToken,
    apply: true,
    result: resultFor(claim, {
      canonicalRecords: [{
        sheet: "decision_log",
        key: { decision_id: "DEC-PENDING-1" },
        fields: { status: "pending_human", selected_option: "" }
      }]
    })
  });
  assert.equal(corrected.isError, false, corrected.content[0].text);
  assert.equal(corrected.structuredContent.applied, true);
});
