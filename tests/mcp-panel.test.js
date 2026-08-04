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
    id, className: "", innerHTML: "", textContent: "", disabled: false, onclick: null,
    parentNode: null, firstElementChild: null, insertBefore() {}, removeChild() {}
  });
  const document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, element(id)); return elements.get(id); },
    createElement() { const node = element("tmp"); Object.defineProperty(node, "firstElementChild", { get: () => node }); return node; }
  };
  const listeners = [];
  const posted = [];
  const sandbox = {
    document, setTimeout, console, JSON, Math, String, Object, Array, Error,
    window: {
      addEventListener: (type, fn) => { if (type === "message") listeners.push(fn); },
      removeEventListener: () => {},
      parent: { postMessage: (message) => posted.push(message) }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(renderPanel().match(/<script>([\s\S]*)<\/script>/)[1], sandbox);

  const deliver = (message) => { for (const fn of [...listeners]) fn({ data: message }); };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

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

test("the decision button hands the gate to the owner without deciding it", async (t) => {
  const { posted, deliver, settle, payload, document } = await mountPanel(t);
  const handshake = posted.shift();
  deliver({ jsonrpc: "2.0", id: handshake.id, result: { protocolVersion: "2026-01-26" } });
  deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: payload } });
  await settle();

  const gate = payload.decisions.items[0];
  const button = document.getElementById(`d-${gate.requestId}`);
  assert.equal(typeof button.onclick, "function", "each pending gate needs a control");
  posted.length = 0;
  button.onclick();

  const call = posted.shift();
  assert.equal(call.params.name, "product_ops_decide");
  assert.deepEqual(Object.keys(call.params.arguments).sort(), ["apply", "decisionToken", "requestId"]);
  assert.equal(call.params.arguments.requestId, gate.requestId);
  assert.equal(call.params.arguments.apply, true);
  for (const forbidden of ["decision", "actorId", "rationale"]) {
    assert.equal(forbidden in call.params.arguments, false,
      `the panel must not supply ${forbidden}; the host dialog collects it from the product owner`);
  }
});

test("a failing host request is reported rather than swallowed", async (t) => {
  const { posted, deliver, settle, payload, document } = await mountPanel(t);
  const handshake = posted.shift();
  deliver({ jsonrpc: "2.0", id: handshake.id, result: { protocolVersion: "2026-01-26" } });
  deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: payload } });
  await settle();

  const gate = payload.decisions.items[0];
  posted.length = 0;
  document.getElementById(`d-${gate.requestId}`).onclick();
  const call = posted.shift();
  deliver({ jsonrpc: "2.0", id: call.id, error: { code: -32602, message: "WRITE_LEASE_HELD: another surface is writing." } });
  await settle();

  // The panel re-renders after a failure, so the gate stays actionable rather than stuck disabled.
  assert.match(document.getElementById("root").innerHTML, /class="gate"/);
  assert.equal(typeof document.getElementById(`d-${gate.requestId}`).onclick, "function");
});
