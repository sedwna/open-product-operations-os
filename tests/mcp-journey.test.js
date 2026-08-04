import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { initCommand } from "../src/commands/init.js";
import { requestApproval } from "../src/runtime/approvals.js";
import { loadTaskboard } from "../src/runtime/taskboard.js";
import { makeTempDirectory } from "./helpers.js";

const SERVER = path.join(path.dirname(import.meta.dirname), "src", "mcp", "server.js");

/**
 * A client speaking the real wire protocol to a real server process.
 *
 * The unit tests call handlers directly, which cannot catch a transport fault, a capability that is
 * declared but unreachable, or a server that writes to stdout when it should not.
 */
function connect(root, args = [], { onElicit } = {}) {
  const child = spawn(process.execPath, [SERVER, "--project", root, ...args], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  let buffer = "";
  const waiting = new Map();
  const notifications = [];
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.method === "elicitation/create") {
        const answer = onElicit ? onElicit(message.params) : { action: "decline" };
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: answer })}\n`);
        continue;
      }
      if (message.method) { notifications.push(message); continue; }
      const resolve = waiting.get(message.id);
      if (resolve) { waiting.delete(message.id); resolve(message); }
    }
  });
  let id = 0;
  const call = (method, params = {}) => new Promise((resolve) => {
    const current = ++id;
    waiting.set(current, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: current, method, params })}\n`);
  });
  return {
    call,
    notifications,
    tool: async (name, args2 = {}) => (await call("tools/call", { name, arguments: args2 })).result,
    stderr: () => stderr,
    close: () => { child.stdin.end(); child.kill(); }
  };
}

test("a product owner can go from an empty workspace to a decided gate", async (t) => {
  const parent = await makeTempDirectory("product-ops-journey-");
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "weekly-digest");
  await initCommand(root, {});

  // Looking before touching: a read-only connection offers no way to change anything.
  const readOnly = connect(root);
  t.after(() => readOnly.close());
  await readOnly.call("initialize", { protocolVersion: "2026-07-28", capabilities: {} });
  const readTools = (await readOnly.call("tools/list")).result.tools;
  assert.equal(readTools.length, 8);
  assert.equal(readTools.some((tool) => /intake|operate|autopilot|decide/.test(tool.name)), false,
    "a read-only session must not even be offered a write");
  readOnly.close();

  const live = connect(root, ["--allow-writes"], {
    onElicit: () => ({ action: "accept", content: {
      decision: "approved",
      actorId: "human-product-owner",
      rationale: "Coordinators asked for it directly, and the migration is bounded."
    } })
  });
  t.after(() => live.close());
  await live.call("initialize", { protocolVersion: "2026-07-28", capabilities: { elicitation: {} } });

  const idea = {
    type: "feedback",
    title: "Weekly digest arrives after the week is planned",
    description: "Coordinators get the Monday summary once they have already committed the week.",
    source: "three support conversations"
  };
  assert.equal((await live.tool("product_ops_intake", idea)).structuredContent.applied, false);
  const recorded = await live.tool("product_ops_intake", { ...idea, apply: true });
  assert.equal(recorded.structuredContent.applied, true);
  assert.equal(recorded.structuredContent.autopilotAuthorized, false,
    "an idea recorded in conversation must not authorise an autonomous cycle");

  const routed = await live.tool("product_ops_operate", { apply: true });
  assert.ok(routed.structuredContent.actionCount > 0, "the complaint must reach teams");

  const panel = (await live.tool("product_ops_panel")).structuredContent;
  assert.equal(panel.teams.product.length, 13);
  assert.equal(panel.teams.product.every((team) => team.name !== team.id), true, "teams are named, not coded");
  assert.ok(panel.flow.steps.length > 0, "the hand-off chain is populated");
  assert.equal(panel.flow.steps.every((step) => step.team && step.team !== step.roleId), true);

  // A gate reaches the owner and they settle it through their own dialog.
  const gated = (await loadTaskboard(root)).records.find((task) => task.human_gate);
  await requestApproval(root, {
    taskId: gated.task_id,
    gate: gated.human_gate,
    question: "Per-workspace digest day, or one global default?",
    risks: ["Scheduled sends must migrate without dropping one."]
  }, { dryRun: false });

  const waiting = (await live.tool("product_ops_pending_decisions")).structuredContent;
  assert.equal(waiting.pending, 1);
  const gate = waiting.items[0];
  assert.equal((await live.tool("product_ops_decide", { requestId: gate.requestId, decisionToken: gate.decisionToken }))
    .structuredContent.applied, false, "planning a decision records nothing");

  const decided = await live.tool("product_ops_decide", { requestId: gate.requestId, decisionToken: gate.decisionToken, apply: true });
  assert.equal(decided.structuredContent.decision, "approved");
  assert.equal(decided.structuredContent.attribution, "human_entered");
  assert.match(decided.structuredContent.rationale, /Coordinators asked for it directly/);
  assert.equal((await live.tool("product_ops_decide", { requestId: gate.requestId, decisionToken: gate.decisionToken, apply: true }))
    .structuredContent.code, "APPROVAL_NOT_PENDING");

  // The surface stays live while they watch. A second complaint is used rather than another
  // scheduling pass, because a pass over an unchanged board legitimately writes nothing and there
  // would then be no change to announce.
  await live.call("resources/subscribe", { uri: "productops://taskboard" });
  const before = live.notifications.length;
  await live.tool("product_ops_intake", {
    type: "user_finding",
    title: "Digest link opens the wrong workspace",
    description: "Following the digest from a second workspace lands on the first one.",
    source: "reported twice this week",
    apply: true
  });
  await live.tool("product_ops_operate", { apply: true });

  const updates = [];
  // Debounce plus filesystem latency: poll rather than sleeping a fixed guess, so a loaded machine
  // waits longer instead of failing.
  for (let attempt = 0; attempt < 40 && updates.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    updates.push(...live.notifications.slice(before).filter((message) => message.method === "notifications/resources/updated"));
  }
  assert.ok(updates.length >= 1, "a board change must be announced to a subscriber");
  assert.equal(updates.every((message) => message.params.uri === "productops://taskboard"), true,
    "and only what was subscribed to");

  // And nothing was left broken behind.
  assert.equal((await live.tool("product_ops_validate")).structuredContent.ok, true,
    "the project must still validate after a full session of writes");
  assert.equal(await fs.stat(path.join(root, ".product-ops/runtime/control-plane.lease.json")).catch(() => null), null,
    "no write lease may be left behind");
  assert.equal(live.stderr(), "", "a clean session writes nothing to stderr");
});
