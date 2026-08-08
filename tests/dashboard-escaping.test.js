import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { initCommand } from "../src/commands/init.js";
import { loadDashboardSnapshot } from "../src/runtime/dashboard.js";
import { renderDashboard } from "../src/runtime/dashboard-view.js";
import { loadTaskboard, replaceTaskboard } from "../src/runtime/taskboard.js";
import { requestApproval } from "../src/runtime/approvals.js";
import { makeTempDirectory } from "./helpers.js";

/**
 * The dashboard renders text authored outside this system — task titles, blocked reasons, approval
 * questions, intake descriptions. It escapes that text in fourteen places and embeds the whole
 * snapshot as JSON inside a script tag, and none of it was held by a test. These pin the property
 * rather than the implementation, so a refactor that drops the escaping fails here instead of
 * shipping.
 */

// Built rather than typed. These two are invisible in source, and a reader who cannot see them
// cannot tell whether the test still contains what it claims to.
const LINE_SEPARATOR = String.fromCodePoint(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCodePoint(0x2029);

/** Payloads that break out of each context the dashboard puts record text into. */
const BREAKOUTS = {
  scriptClose: "</script><script>globalThis.__breached=1;</script>",
  htmlTag: "<img src=x onerror=alert(1)>",
  attribute: '" onmouseover="alert(1)',
  lineSeparator: `before${LINE_SEPARATOR}after`,
  paragraphSeparator: `before${PARAGRAPH_SEPARATOR}after`,
  entity: "&lt;not-really-escaped&gt;"
};

async function renderWithHostileRecords(t) {
  const parent = await makeTempDirectory("product-ops-escape-");
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "product");
  await initCommand(root, {});

  const { headers, records } = await loadTaskboard(root);
  const [first] = records;
  await replaceTaskboard(root, headers, records.map((record) => record.task_id === first.task_id
    ? {
        ...record,
        status: "blocked",
        title: `Title ${BREAKOUTS.htmlTag}`,
        blocked_reason: `Reason ${BREAKOUTS.scriptClose}`,
        unblock_condition: `Condition ${BREAKOUTS.attribute}`
      }
    : record), { dryRun: false });

  await requestApproval(root, {
    taskId: first.task_id,
    gate: "risk_acceptance",
    question: `Question ${BREAKOUTS.lineSeparator}`,
    context: `Context ${BREAKOUTS.paragraphSeparator}`,
    risks: [`Risk ${BREAKOUTS.entity}`]
  }, { dryRun: false });

  const snapshot = await loadDashboardSnapshot(root);
  return { root, snapshot, html: renderDashboard(snapshot, { csrfToken: "token", live: true }) };
}

test("a record cannot close the script tag that carries the snapshot", async (t) => {
  const { html } = await renderWithHostileRecords(t);

  // The single highest-value property here: the snapshot is embedded as JSON inside <script>, and a
  // record containing a closing tag would end that element early and start executing.
  //
  // The text of the payload survives verbatim — it is data inside a string literal, and asserting
  // its absence would be testing the wrong thing. What must not survive is the angle brackets that
  // would turn it back into markup.
  const scripts = html.split(/<script\b/i).length - 1;
  const closings = html.split(/<\/script>/i).length - 1;
  assert.equal(scripts, closings, "every script element must close exactly once");
  assert.ok(!html.includes(BREAKOUTS.scriptClose), "the raw breakout sequence must never appear");
  assert.ok(!html.includes("<script>globalThis"), "a record must never open a script element");
  assert.match(html, /\\u003c\/script\\u003e/i, "a closing tag inside record text must be escaped, not removed");
});

test("javascript line terminators inside a record cannot break the payload", async (t) => {
  const { html } = await renderWithHostileRecords(t);

  // U+2028 and U+2029 are valid in JSON strings but terminate a line in JavaScript source, so an
  // unescaped one splits the literal the snapshot is assigned from.
  assert.ok(!html.includes(LINE_SEPARATOR), "U+2028 must not survive into the page source");
  assert.ok(!html.includes(PARAGRAPH_SEPARATOR), "U+2029 must not survive into the page source");
  assert.match(html, /\\u2028/);
  assert.match(html, /\\u2029/);
});

test("record markup renders as words rather than as elements", async (t) => {
  const { html } = await renderWithHostileRecords(t);

  // Again the angle brackets are the property, not the text between them.
  assert.ok(!html.includes("<img"), "an image tag from a record must not become an element");
  assert.ok(!html.includes('" onmouseover="'), "a record must not escape its attribute");
  assert.ok(
    html.includes("&lt;img") || html.includes("\\u003cimg"),
    "the attempted tag must still be present, escaped, so the reader sees what the record actually says"
  );
});

test("the client renders record text through its own escape, not raw", async (t) => {
  const { html } = await renderWithHostileRecords(t);

  // Server-side escaping only protects the initial document. The page then re-renders the board
  // from the embedded snapshot with innerHTML, which is a second and independent chance to turn a
  // record back into markup.
  const script = html.match(/<script nonce="[^"]*">([\s\S]*?)<\/script>\s*<\/body>/)?.[1]
    ?? html.slice(html.lastIndexOf("<script"));
  assert.match(script, /const esc=/, "the client must carry its own escape helper");
  for (const field of ["t.title", "a.question", "r.title"]) {
    const raw = new RegExp(`\\+\\s*${field.replace(".", "\\.")}\\s*\\+`);
    assert.ok(!raw.test(script), `${field} must never be concatenated into innerHTML unescaped`);
  }
  assert.match(script, /esc\(t\.title\)/, "task titles must go through the client escape");
});

test("escaping does not swallow the text a person needs to read", async (t) => {
  const { html } = await renderWithHostileRecords(t);

  // Escaping that also deletes content is its own defect: the owner would be reading a redacted
  // board without being told anything was removed.
  assert.match(html, /Title/, "the task title must still reach the page");
  assert.match(html, /Reason/, "the blocked reason must still reach the page");
  assert.match(html, /Question/, "the approval question must still reach the page");
  assert.match(html, /Risk/, "the recorded risk must still reach the page");
});

test("the embedded snapshot is still valid JSON after escaping", async (t) => {
  const { html, snapshot } = await renderWithHostileRecords(t);

  const match = html.match(/window\.__PRODUCT_OPS__=(\{[\s\S]*?\});window\.__PRODUCT_OPS_LIVE__=/);
  const payload = match?.[1];
  assert.ok(payload, "the page must carry the snapshot in a recoverable form");

  // Unescape the four sequences the renderer introduces, then confirm the result still parses and
  // still describes the same board. Escaping that corrupted the data would be silent.
  const restored = payload
    .replaceAll("\\u003c", "<")
    .replaceAll("\\u003e", ">")
    .replaceAll("\\u0026", "&");
  const parsed = JSON.parse(restored);
  assert.equal(parsed.tasks.length, snapshot.tasks.length);
  assert.ok(parsed.tasks.some((task) => String(task.title).includes("<img src=x")),
    "the record must survive escaping intact in the data, however it is rendered");
});
