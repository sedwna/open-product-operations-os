import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { initCommand } from "../src/commands/init.js";
import { requestApproval } from "../src/runtime/approvals.js";
import { loadTaskboard, replaceTaskboard } from "../src/runtime/taskboard.js";
import { createHandlers, createServerContext } from "../src/mcp/server.js";
import { renderPanel } from "../src/mcp/app/panel.js";
import { makeTempDirectory } from "./helpers.js";

/**
 * Runs the panel's own inline script against a minimal DOM and the real postMessage dialect.
 *
 * Asserting on the HTML source only proves what was written; running it proves what a person sees.
 * The escape-then-unwrap defect this harness caught was invisible to every source-level check.
 */
async function mountPanel(t) {
  const parent = await makeTempDirectory("product-ops-panel-");
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "product");
  await initCommand(root, {});

  // A freshly generated project carries a single bootstrap task, so the blocked task and the gated
  // task are the same record here. That is enough: the panel renders both a risk and a gate.
  const loaded = await loadTaskboard(root);
  const [first] = loaded.records;
  await replaceTaskboard(root, loaded.headers, loaded.records.map((record) => record.task_id === first.task_id
    ? { ...record, status: "blocked", blocked_reason: "Waiting on the analytics export." }
    : record), { dryRun: false });
  await requestApproval(root, {
    taskId: first.task_id,
    gate: "product_direction_or_priority",
    question: "Ship per-workspace summary days, or keep one global default?",
    risks: ["Scheduled sends must migrate without dropping one."]
  }, { dryRun: false });

  const context = await createServerContext({ project: root, allowWrites: true });
  const handlers = createHandlers(context, { version: "test" });
  handlers.initialize({ protocolVersion: "2026-07-28", capabilities: { elicitation: {} } });
  const payload = (await handlers["tools/call"]({ name: "product_ops_panel", arguments: {} })).structuredContent;

  const elements = new Map();
  const element = (id) => ({
    id, className: "", innerHTML: "", textContent: "", value: "", disabled: false, onclick: null,
    parentNode: null, firstElementChild: null,
    focus() {}, insertBefore() {}, removeChild() {}
  });
  const document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, element(id)); return elements.get(id); },
    createElement() { const node = element("tmp"); Object.defineProperty(node, "firstElementChild", { get: () => node }); return node; }
  };
  const listeners = [];
  const posted = [];
  const sandbox = {
    document, setTimeout, clearTimeout, console, JSON, Math, String, Object, Array, Error,
    window: {
      addEventListener: (type, fn) => { if (type === "message") listeners.push(fn); },
      removeEventListener: () => {},
      parent: { postMessage: (message) => posted.push(message) }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(renderPanel().match(/<script>([\s\S]*)<\/script>/)[1], sandbox);

  const deliver = (message) => { for (const fn of [...listeners]) fn({ data: message }); };
  const settle = () => new Promise((resolve) => { setTimeout(resolve, 20); });

  return { root, payload, posted, deliver, settle, document, handlers };
}

test("the panel completes the app handshake and asks for its own data", async (t) => {
  const { posted, deliver, settle, payload } = await mountPanel(t);

  const handshake = posted.shift();
  assert.equal(handshake.method, "ui/initialize");
  assert.equal(handshake.params.protocolVersion, "2026-01-26");
  assert.ok(handshake.params.clientInfo.name, "the app must identify itself");

  deliver({ jsonrpc: "2.0", id: handshake.id, result: { protocolVersion: "2026-01-26", hostContext: { theme: "dark" } } });
  await settle();

  const call = posted.shift();
  assert.equal(call.method, "tools/call");
  assert.equal(call.params.name, "product_ops_panel");
  deliver({ jsonrpc: "2.0", id: call.id, result: { structuredContent: payload } });
  await settle();
});

test("a host that pushes the tool result needs no follow-up call", async (t) => {
  const { posted, deliver, settle, payload, document } = await mountPanel(t);
  const handshake = posted.shift();
  deliver({ jsonrpc: "2.0", id: handshake.id, result: { protocolVersion: "2026-01-26" } });
  // The host normally pushes the result rather than waiting to be asked.
  deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: payload } });
  await settle();

  assert.match(document.getElementById("root").innerHTML, /class="counts"/);
  assert.equal(posted.filter((message) => message.method === "tools/call").length, 0,
    "a pushed result must not trigger a redundant fetch");
});

test("what a person reads carries no envelope markers", async (t) => {
  const { posted, deliver, settle, payload, document } = await mountPanel(t);
  const handshake = posted.shift();
  deliver({ jsonrpc: "2.0", id: handshake.id, result: { protocolVersion: "2026-01-26" } });
  deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: payload } });
  await settle();

  const rendered = document.getElementById("root").innerHTML;
  assert.equal(/untrusted-record/.test(rendered), false, "the envelope is for the model, not for the reader");
  assert.match(rendered, /Ship per-workspace summary days/, "the question itself must survive unwrapping");
  assert.match(rendered, /Scheduled sends must migrate/, "so must the recorded risks");
});

test("record text is escaped, so a hostile record cannot inject markup into the panel", async (t) => {
  const { posted, deliver, settle, payload, document } = await mountPanel(t);
  const handshake = posted.shift();
  deliver({ jsonrpc: "2.0", id: handshake.id, result: { protocolVersion: "2026-01-26" } });

  const hostile = { ...payload };
  hostile.decisions = {
    pending: 1,
    items: [{
      requestId: "APR-000000000001",
      taskId: "TASK-1",
      gate: "risk_acceptance",
      question: '<untrusted-record source="approval" id="x"><img src=x onerror="alert(1)"><script>bad()</script></untrusted-record>',
      risks: [],
      decisionToken: "0".repeat(32)
    }]
  };
  deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: hostile } });
  await settle();

  const rendered = document.getElementById("root").innerHTML;
  assert.equal(/<img/.test(rendered), false, "unwrapped record text must still be escaped");
  assert.equal(/<script>bad/.test(rendered), false);
  assert.match(rendered, /&lt;img/, "the hostile markup should appear as visible text");
});

test("both sides appear as named teams, never as role codes", async (t) => {
  const { posted, deliver, settle, payload, document } = await mountPanel(t);
  const handshake = posted.shift();
  deliver({ jsonrpc: "2.0", id: handshake.id, result: { protocolVersion: "2026-01-26" } });
  deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: payload } });
  await settle();

  assert.equal(payload.teams.product.length, 13, "every product boundary is a team");
  for (const team of payload.teams.product) {
    assert.notEqual(team.name, team.id, `${team.id} still shows as a code`);
    assert.ok(team.focus.length > 0, `${team.id} needs a line explaining what it does`);
  }

  const rendered = document.getElementById("root").innerHTML;
  assert.match(rendered, /کشف و تحقیق/, "product teams render by name");
  assert.match(rendered, /تیم مهندسی هنوز/, "an unlinked engineering side says so rather than showing nothing");
  assert.equal(/>RB-\d\d</.test(rendered), false, "a role code must never be the visible label");
});

test("the hand-off chain shows where the work actually sits", async (t) => {
  const { posted, deliver, settle, payload, document } = await mountPanel(t);
  const handshake = posted.shift();
  deliver({ jsonrpc: "2.0", id: handshake.id, result: { protocolVersion: "2026-01-26" } });
  deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: payload } });
  await settle();

  assert.ok(payload.flow.steps.length > 0, "an active event must produce a chain");
  for (const step of payload.flow.steps) {
    assert.notEqual(step.team, step.roleId, "each step is labelled by team");
  }
  const rendered = document.getElementById("root").innerHTML;
  assert.match(rendered, /class="flow"/);
  assert.match(rendered, /class="node stuck"/, "a blocked step must be visually distinct");
  assert.equal(/>(ready|backlog|in_progress|blocked)</.test(rendered), false,
    "raw status vocabulary must not reach the reader");
});

test("the composer records the owner's own words and refuses an empty rationale", async (t) => {
  const { posted, deliver, settle, payload, document } = await mountPanel(t);
  const handshake = posted.shift();
  deliver({ jsonrpc: "2.0", id: handshake.id, result: { protocolVersion: "2026-01-26" } });
  deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: payload } });
  await settle();

  const gate = payload.decisions.items[0];
  const approve = document.getElementById(`y-${gate.requestId}`);
  const reject = document.getElementById(`n-${gate.requestId}`);
  const box = document.getElementById(`t-${gate.requestId}`);
  assert.equal(typeof approve.onclick, "function", "each gate needs an approve control");
  assert.equal(typeof reject.onclick, "function", "and a reject control");

  // A disposition without reasoning is not a durable decision.
  posted.length = 0;
  box.value = "   ";
  approve.onclick();
  assert.equal(posted.length, 0, "an empty rationale must not reach the server");
  assert.match(document.getElementById(`m-${gate.requestId}`).textContent, /دلیلش را بنویسید/);

  box.value = "پیش از نوشتن داستان مهاجرت، نه.";
  reject.onclick();
  const call = posted.shift();
  assert.equal(call.params.name, "product_ops_decide");
  const args = call.params.arguments;
  assert.equal(args.requestId, gate.requestId);
  assert.equal(args.decisionToken, gate.decisionToken);
  assert.equal(args.apply, true);
  assert.equal(args.source, "panel", "the server must know a person composed this");
  assert.equal(args.decision, "rejected");
  assert.equal(args.rationale, "پیش از نوشتن داستان مهاجرت، نه.", "the owner's text is sent verbatim");
});

test("a refresh never eats a rationale the owner is halfway through writing", async (t) => {
  // The panel refreshes itself while the owner reads it. A rebuild that discarded an unsent draft
  // would lose their reasoning at the exact moment they were composing it.
  const { posted, deliver, settle, payload, document } = await mountPanel(t);
  const handshake = posted.shift();
  deliver({ jsonrpc: "2.0", id: handshake.id, result: { protocolVersion: "2026-01-26" } });
  deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: payload } });
  await settle();

  const gate = payload.decisions.items[0];
  const halfWritten = "هنوز مطمئن نیستم، ولی احتمالاً به‌خاطر";
  document.getElementById(`t-${gate.requestId}`).value = halfWritten;

  // Fresh data arrives, exactly as an autonomous cycle moving would deliver it.
  deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: payload } });
  await settle();

  assert.equal(document.getElementById(`t-${gate.requestId}`).value, halfWritten,
    "the draft must survive a refresh");

  // And it must still be what gets sent.
  posted.length = 0;
  document.getElementById(`y-${gate.requestId}`).onclick();
  assert.equal(posted.shift().params.arguments.rationale, halfWritten);
});

test("a quiet background refresh does not disturb the interface", async (t) => {
  const { posted, deliver, settle, payload, document } = await mountPanel(t);
  const handshake = posted.shift();
  deliver({ jsonrpc: "2.0", id: handshake.id, result: { protocolVersion: "2026-01-26" } });
  deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: payload } });
  await settle();

  const before = document.getElementById("root").innerHTML;
  deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: payload } });
  await settle();
  assert.equal(document.getElementById("root").innerHTML, before,
    "unchanged data must render identically rather than flickering into a new shape");
  assert.equal(document.getElementById("refresh").textContent, "",
    "a background refresh must not leave the manual control in a loading state");
});

test("a failing host request is reported rather than swallowed", async (t) => {
  const { posted, deliver, settle, payload, document } = await mountPanel(t);
  const handshake = posted.shift();
  deliver({ jsonrpc: "2.0", id: handshake.id, result: { protocolVersion: "2026-01-26" } });
  deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: payload } });
  await settle();

  const gate = payload.decisions.items[0];
  posted.length = 0;
  document.getElementById(`t-${gate.requestId}`).value = "دلیل کافی.";
  document.getElementById(`y-${gate.requestId}`).onclick();
  const call = posted.shift();
  deliver({ jsonrpc: "2.0", id: call.id, error: { code: -32602, message: "WRITE_LEASE_HELD: another surface is writing." } });
  await settle();

  // The panel re-renders after a failure, so the gate stays actionable rather than stuck disabled.
  assert.match(document.getElementById("root").innerHTML, /class="gate"/);
  assert.equal(typeof document.getElementById(`y-${gate.requestId}`).onclick, "function");
});

test("a blockage says why, and whose it is to clear", async (t) => {
  const { posted, deliver, settle, payload, document } = await mountPanel(t);
  const handshake = posted.shift();
  deliver({ jsonrpc: "2.0", id: handshake.id, result: { protocolVersion: "2026-01-26" } });
  deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: payload } });
  await settle();

  assert.ok(payload.blockages.length > 0, "a blocked card must reach the panel");
  for (const blockage of payload.blockages) {
    assert.notEqual(blockage.team, blockage.roleId, "a blockage names the team holding it");
    // The count alone tells the owner something is wrong without telling them whether it is theirs.
    assert.ok(["awaiting_decision", "awaiting_dependency", "stopped"].includes(blockage.kind));
  }

  const rendered = document.getElementById("root").innerHTML;
  assert.match(rendered, /کجا گیر کرده‌ایم/, "the panel must say where the cycle is stuck");
  assert.match(rendered, /Waiting on the analytics export/, "the reason recorded on the card is what the owner reads");
  assert.doesNotMatch(rendered, /RB-0\d/, "a blockage must never be reported by contract identifier");
});

test("a blocked card cannot inject markup through its reason", async (t) => {
  const { root, handlers, posted, deliver, settle, document } = await mountPanel(t);
  const loaded = await loadTaskboard(root);
  const [first] = loaded.records;
  await replaceTaskboard(root, loaded.headers, loaded.records.map((record) => record.task_id === first.task_id
    ? { ...record, status: "blocked", blocked_reason: "<img src=x onerror=alert(1)> pending export" }
    : record), { dryRun: false });

  const fresh = (await handlers["tools/call"]({ name: "product_ops_panel", arguments: {} })).structuredContent;
  const handshake = posted.shift();
  deliver({ jsonrpc: "2.0", id: handshake.id, result: { protocolVersion: "2026-01-26" } });
  deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: fresh } });
  await settle();

  const rendered = document.getElementById("root").innerHTML;
  assert.match(rendered, /pending export/, "the reason itself must still reach the reader");
  assert.doesNotMatch(rendered, /<img src=x/, "record text is data, never markup");
});
