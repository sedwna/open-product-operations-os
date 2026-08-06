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

test("both work tools are registered as plan-tier and declared", async (t) => {
  const definitions = TOOL_DEFINITIONS.filter((tool) => tool.name.startsWith("product_ops_next_work") || tool.name.startsWith("product_ops_submit_work"));
  assert.equal(definitions.length, 2);
  for (const definition of definitions) {
    assert.equal(definition.tier, "plan");
    assert.equal(definition.inputSchema.additionalProperties, false);
    assert.ok(definition.description.length <= 160, `${definition.name} description must stay short enough for a tool list`);
  }
});
