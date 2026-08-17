import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { run } from "../src/cli.js";
import {
  FEEDBACK_FILE,
  NOTE_INTERVAL,
  countEntries,
  describeOwedNote,
  ensureFeedbackLoop,
  lastNotedCardCount,
  noteStatus,
  readFeedbackLoop,
  recordNote,
  recordOwnerFeedback
} from "../src/runtime/feedback-loop.js";
import { createHandlers, createServerContext } from "../src/mcp/server.js";
import { captureIo, makeTempDirectory } from "./helpers.js";

async function workspace(t) {
  const parent = await makeTempDirectory("product-ops-feedback-");
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "product");
  const output = captureIo();
  assert.equal(await run(["init", root, "--no-git"], output.io), 0);
  return root;
}

test("init creates the feedback loop so the first card has somewhere to write", async (t) => {
  const root = await workspace(t);
  const contents = await readFeedbackLoop(root);
  assert.ok(contents, `${FEEDBACK_FILE} should exist immediately after init`);
  assert.match(contents, /# Feedback Loop/);
  assert.deepEqual(countEntries(contents), { notes: 0, ownerFeedback: 0 });
});

test("an existing feedback loop is never rewritten", async (t) => {
  const root = await workspace(t);
  await recordNote(root, { taskId: "TASK-1", learned: "The owner's own words matter more than my summary.", cardsDone: 1 });
  const before = await readFeedbackLoop(root);
  assert.deepEqual(await ensureFeedbackLoop(root), { created: false });
  assert.equal(await readFeedbackLoop(root), before);
});

test("notes land newest first, so the owner reads the last thing that happened", async (t) => {
  const root = await workspace(t);
  await recordNote(root, { taskId: "TASK-1", learned: "First thing learned.", cardsDone: 1 });
  await recordNote(root, { taskId: "TASK-2", learned: "Second thing learned.", cardsDone: 2 });
  const contents = await readFeedbackLoop(root);
  assert.ok(
    contents.indexOf("Second thing learned.") < contents.indexOf("First thing learned."),
    "the newer note should appear above the older one"
  );
  assert.deepEqual(countEntries(contents), { notes: 2, ownerFeedback: 0 });
});

test("a note with nothing learned is refused rather than filed empty", async (t) => {
  const root = await workspace(t);
  await assert.rejects(() => recordNote(root, { taskId: "TASK-1", learned: "   " }), /something learned/);
  await assert.rejects(() => recordOwnerFeedback(root, { text: "" }), /owner's words/);
});

test("owner feedback keeps their words and says it was relayed", async (t) => {
  const root = await workspace(t);
  await recordOwnerFeedback(root, { text: "این کافی نیست، دوباره نگاه کن.", about: "TASK-9" });
  const contents = await readFeedbackLoop(root);
  assert.match(contents, /> این کافی نیست، دوباره نگاه کن\./);
  assert.match(contents, /Relayed from the conversation/);
  assert.equal(countEntries(contents).ownerFeedback, 1);
});

test("feedback the owner typed themselves is not labelled as relayed", async (t) => {
  const root = await workspace(t);
  await recordOwnerFeedback(root, { text: "Approved.", attribution: "human_entered" });
  assert.doesNotMatch(await readFeedbackLoop(root), /Relayed from the conversation/);
});

test("a multi-line quotation stays quoted on every line", async (t) => {
  const root = await workspace(t);
  await recordOwnerFeedback(root, { text: "First line.\nSecond line." });
  const contents = await readFeedbackLoop(root);
  assert.match(contents, /> First line\./);
  assert.match(contents, /> Second line\./);
});

test("being owed a note is counted from the record, not from a clock", async (t) => {
  const root = await workspace(t);
  const fresh = await noteStatus(root, 0);
  assert.equal(fresh.cardsSinceLastNote, 0);
  assert.equal(fresh.owed, false);

  const behind = await noteStatus(root, NOTE_INTERVAL);
  assert.equal(behind.owed, true);
  assert.match(describeOwedNote(behind), /product_ops_feedback/);
  assert.match(describeOwedNote(behind), /tell the owner/);

  await recordNote(root, { taskId: "TASK-2", learned: "Caught up.", cardsDone: NOTE_INTERVAL });
  const caught = await noteStatus(root, NOTE_INTERVAL);
  assert.equal(caught.cardsSinceLastNote, 0);
  assert.equal(caught.owed, false);
  assert.equal(describeOwedNote(caught), null);
});

test("the owed count survives a file whose newest entry is owner feedback", async (t) => {
  const root = await workspace(t);
  await recordNote(root, { taskId: "TASK-1", learned: "Something.", cardsDone: 4 });
  await recordOwnerFeedback(root, { text: "Noted." });
  // The hidden counter belongs to the newest note, not the newest entry of any kind.
  assert.equal(lastNotedCardCount(await readFeedbackLoop(root)), 4);
  assert.equal((await noteStatus(root, 4)).owed, false);
});

test("entries survive a file rewritten with Windows line endings", async (t) => {
  const root = await workspace(t);
  await recordNote(root, { taskId: "TASK-1", learned: "Written on one platform.", cardsDone: 1 });
  const file = path.join(root, FEEDBACK_FILE);
  await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace(/\n/g, "\r\n"), "utf8");
  await recordNote(root, { taskId: "TASK-2", learned: "Read on another.", cardsDone: 2 });
  const contents = await readFeedbackLoop(root);
  assert.equal(countEntries(contents).notes, 2);
  assert.ok(contents.indexOf("Read on another.") < contents.indexOf("Written on one platform."));
});

test("a file whose marker was edited away still accepts entries rather than losing them", async (t) => {
  const root = await workspace(t);
  const file = path.join(root, FEEDBACK_FILE);
  await fs.writeFile(file, "# Feedback Loop\n\nSomeone rewrote this by hand.\n", "utf8");
  await recordNote(root, { taskId: "TASK-1", learned: "Still recorded.", cardsDone: 1 });
  const contents = await readFeedbackLoop(root);
  assert.match(contents, /Someone rewrote this by hand\./);
  assert.match(contents, /Still recorded\./);
});

test("the control surface records a note and reads the loop back", async (t) => {
  const root = await workspace(t);
  const context = await createServerContext({ project: root, allowWrites: true });
  const handlers = createHandlers(context, { version: "test" });
  handlers.initialize({ protocolVersion: "2026-07-28", capabilities: {} });
  const call = (name, args = {}) => handlers["tools/call"]({ name, arguments: args });

  const planned = await call("product_ops_feedback", { learned: "Planning writes nothing." });
  assert.equal(planned.structuredContent.applied, false);
  assert.equal(countEntries(await readFeedbackLoop(root)).notes, 0);

  const applied = await call("product_ops_feedback", {
    learned: "The schema refuses a status the vocabulary does not carry, which is how I learned the vocabulary.",
    saw: "A rejected submission naming the six statuses it would have accepted.",
    taskId: "TASK-1",
    roleId: "RB-02",
    apply: true
  });
  assert.equal(applied.structuredContent.applied, true);
  assert.match(applied.content[0].text, /tell the owner/i);

  const read = await call("product_ops_read_feedback", {});
  assert.equal(read.structuredContent.notes, 1);
  assert.match(read.content[0].text, /how I learned the vocabulary/);
});

test("the control surface refuses an empty entry and an observation with no lesson", async (t) => {
  const root = await workspace(t);
  const context = await createServerContext({ project: root, allowWrites: true });
  const handlers = createHandlers(context, { version: "test" });
  handlers.initialize({ protocolVersion: "2026-07-28", capabilities: {} });
  const call = (name, args = {}) => handlers["tools/call"]({ name, arguments: args });

  const empty = await call("product_ops_feedback", { apply: true });
  assert.equal(empty.isError, true);
  assert.match(empty.content[0].text, /Nothing to record/);

  const dangling = await call("product_ops_feedback", { saw: "Something happened.", apply: true });
  assert.equal(dangling.isError, true);
  assert.match(dangling.content[0].text, /not a note/);
});

test("reading the loop before one exists says so instead of failing", async (t) => {
  const parent = await makeTempDirectory("product-ops-feedback-bare-");
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "product");
  const output = captureIo();
  assert.equal(await run(["init", root, "--no-git"], output.io), 0);
  await fs.rm(path.join(root, FEEDBACK_FILE));

  const context = await createServerContext({ project: root, allowWrites: false });
  const handlers = createHandlers(context, { version: "test" });
  handlers.initialize({ protocolVersion: "2026-07-28", capabilities: {} });
  const read = await handlers["tools/call"]({ name: "product_ops_read_feedback", arguments: {} });
  assert.notEqual(read.isError, true);
  assert.equal(read.structuredContent.exists, false);
});
