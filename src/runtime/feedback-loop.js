import path from "node:path";
import fs from "node:fs/promises";

/**
 * The feedback loop: what the system learned while building a product, and what its owner said back.
 *
 * The name carries a space because the product owner named it. A file nobody can find is a file
 * nobody reads, and the owner asked for this one by name.
 *
 * Two design choices are load-bearing.
 *
 * Newest entries go at the top. This file grows for the life of a product, and an owner opening it
 * wants the last thing that happened, not the first. Appending at the end is easier to write and
 * worse to read, and this file exists to be read by a person.
 *
 * Every note carries the number of completed cards at the time it was written, in an HTML comment
 * the reader never sees. That is what makes "a note is overdue" an exact count rather than a guess
 * from timestamps — no clock comparison, no assumption that task identifiers sort monotonically,
 * and no separate counter file that can disagree with the record it describes.
 */

export const FEEDBACK_FILE = "Feedback Loop.md";

/** How many cards may complete before a note is owed. The owner asked for one every card or two. */
export const NOTE_INTERVAL = 2;

const ENTRY_MARKER = "<!-- entries below, newest first -->";
const DONE_COUNT_PATTERN = /<!--\s*cards-done:\s*(\d+)\s*-->/;

const HEADER = `# Feedback Loop

What this system learned while building this product, and what its owner said back.

Two kinds of entry live here. A **note** is written by the agent running the operating model after it
finishes a card or two — one or two sentences on what it learned and what it actually saw, not a
summary of what it did. **Owner feedback** is what you said in reply, kept in your own words.

The agent tells you each note in the conversation as it writes it, so you can answer. Nothing here
waits for you to come looking.

${ENTRY_MARKER}
`;

export function feedbackFilePath(root) {
  return path.join(root, FEEDBACK_FILE);
}

/** Read the file, or null when it does not exist yet. Never throws for absence. */
export async function readFeedbackLoop(root) {
  try {
    return await fs.readFile(feedbackFilePath(root), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export function buildFeedbackLoopFile() {
  return HEADER;
}

/** Create the file when it is missing. An existing file is never rewritten. */
export async function ensureFeedbackLoop(root) {
  const existing = await readFeedbackLoop(root);
  if (existing !== null) return { created: false };
  await fs.writeFile(feedbackFilePath(root), HEADER, "utf8");
  return { created: true };
}

function today(at) {
  return (at instanceof Date ? at : new Date(at ?? Date.now())).toISOString().slice(0, 10);
}

/**
 * Insert an entry directly below the marker.
 *
 * Lines are split on either line ending and rejoined with one, because a file written on Windows and
 * read by a POSIX-shaped matcher is a defect this repository has produced more than once.
 */
function insertEntry(contents, entry) {
  const lines = contents.split(/\r?\n/);
  const at = lines.findIndex((line) => line.trim() === ENTRY_MARKER);
  if (at === -1) {
    // A file whose marker was edited away still accepts entries rather than losing them.
    return `${lines.join("\n").replace(/\s*$/, "")}\n\n${entry.trim()}\n`;
  }
  const before = lines.slice(0, at + 1);
  const after = lines.slice(at + 1);
  return [...before, "", entry.trim(), ...after].join("\n").replace(/\n{3,}/g, "\n\n");
}

function formatNote({ taskId, roleId, roleName, learned, saw, cardsDone, at }) {
  const who = [taskId, roleName ?? roleId].filter(Boolean).join(" · ");
  const heading = ["## Note", today(at), who].filter(Boolean).join(" · ");
  const body = [`**Learned.** ${learned.trim()}`];
  if (saw && saw.trim()) body.push(`**Saw.** ${saw.trim()}`);
  return [heading, "", ...body.flatMap((line) => [line, ""]), `<!-- cards-done: ${cardsDone ?? 0} -->`, "", "---"].join(
    "\n"
  );
}

function formatOwnerFeedback({ text, about, attribution, at }) {
  const heading = ["## Owner feedback", today(at), about].filter(Boolean).join(" · ");
  const quoted = text
    .trim()
    .split(/\r?\n/)
    .map((line) => `> ${line}`.trimEnd())
    .join("\n");
  const lines = [heading, "", quoted, ""];
  if (attribution === "model_relayed") {
    lines.push("*Relayed from the conversation by the agent, not typed by the owner into a dialog.*", "");
  }
  lines.push("---");
  return lines.join("\n");
}

/**
 * File a note. `learned` is required because a note with nothing learned is not a note.
 */
export async function recordNote(root, { taskId, roleId, roleName, learned, saw, cardsDone, at } = {}) {
  if (!learned || !String(learned).trim()) {
    throw new Error("A feedback-loop note needs something learned; an empty note is worse than none.");
  }
  await ensureFeedbackLoop(root);
  const contents = await readFeedbackLoop(root);
  const entry = formatNote({ taskId, roleId, roleName, learned, saw, cardsDone, at });
  await fs.writeFile(feedbackFilePath(root), insertEntry(contents, entry), "utf8");
  return { file: FEEDBACK_FILE, taskId: taskId ?? null, cardsDone: cardsDone ?? 0 };
}

/**
 * File the owner's own words.
 *
 * `attribution` matters and is not decoration. Feedback the owner typed into a dialog is theirs;
 * feedback an agent relayed from a conversation is weaker evidence of what they meant, and the
 * record says which it was rather than flattening both into "the owner said".
 */
export async function recordOwnerFeedback(root, { text, about, attribution = "model_relayed", at } = {}) {
  if (!text || !String(text).trim()) {
    throw new Error("Owner feedback needs the owner's words; do not record a summary in their place.");
  }
  await ensureFeedbackLoop(root);
  const contents = await readFeedbackLoop(root);
  const entry = formatOwnerFeedback({ text, about, attribution, at });
  await fs.writeFile(feedbackFilePath(root), insertEntry(contents, entry), "utf8");
  return { file: FEEDBACK_FILE, attribution };
}

/** The completed-card count carried by the newest note, or 0 when there is no note yet. */
export function lastNotedCardCount(contents) {
  if (!contents) return 0;
  const match = DONE_COUNT_PATTERN.exec(contents);
  return match ? Number(match[1]) : 0;
}

/**
 * The entries, newest first, without the header.
 *
 * Splitting the whole file on its separators puts the header and the first entry in one block, so
 * everything below the marker is taken first. The marker lives in one place for the same reason.
 */
export function extractEntries(contents, limit = Infinity) {
  if (!contents) return [];
  const at = contents.indexOf(ENTRY_MARKER);
  const body = at === -1 ? contents : contents.slice(at + ENTRY_MARKER.length);
  return body
    .split(/\r?\n---\r?\n/)
    .map((block) => block.trim())
    .filter((block) => block.startsWith("## "))
    .slice(0, limit);
}

export function countEntries(contents) {
  if (!contents) return { notes: 0, ownerFeedback: 0 };
  const lines = contents.split(/\r?\n/);
  return {
    notes: lines.filter((line) => line.startsWith("## Note")).length,
    ownerFeedback: lines.filter((line) => line.startsWith("## Owner feedback")).length
  };
}

/**
 * Whether a note is owed, and how far behind it is.
 *
 * This is the mechanism that keeps the loop from depending on an agent remembering. The count is
 * derived from the record itself, so it survives a restarted process, a different agent, and a
 * conversation that lost its history.
 */
export async function noteStatus(root, completedCards) {
  const contents = await readFeedbackLoop(root);
  const since = Math.max(0, completedCards - lastNotedCardCount(contents));
  return {
    file: FEEDBACK_FILE,
    exists: contents !== null,
    completedCards,
    cardsSinceLastNote: since,
    owed: since >= NOTE_INTERVAL,
    ...countEntries(contents)
  };
}

/** The sentence the control surface adds when a note is owed. */
export function describeOwedNote(status) {
  if (!status.owed) return null;
  return `${status.cardsSinceLastNote} card(s) have finished since the last feedback-loop note. Write one now with product_ops_feedback — one or two sentences on what you learned and what you actually saw — and tell the owner what it says in this conversation, so they can answer it.`;
}
