import { loadTaskboard } from "../../runtime/taskboard.js";
import { ToolFailure } from "../authority.js";
import {
  FEEDBACK_FILE,
  countEntries,
  extractEntries,
  noteStatus,
  readFeedbackLoop,
  recordNote,
  recordOwnerFeedback
} from "../../runtime/feedback-loop.js";
import { describeTeam } from "../app/teams.js";

async function completedCardCount(root) {
  try {
    const board = await loadTaskboard(root);
    return board.records.filter((record) => record.status === "done").length;
  } catch {
    // A workspace without a readable board still keeps its feedback loop; the count is what degrades.
    return 0;
  }
}

/**
 * Read the loop back. The owner asked to be told what the notes say, so reading is a first-class
 * action rather than something only a text editor can do.
 */
export async function readFeedback(context, args = {}) {
  const contents = await readFeedbackLoop(context.root);
  if (contents === null) {
    return {
      structuredContent: { file: FEEDBACK_FILE, exists: false, notes: 0, ownerFeedback: 0 },
      text: `No feedback loop exists in this workspace yet. Recording the first note creates ${FEEDBACK_FILE}.`
    };
  }
  const counted = countEntries(contents);
  const entries = extractEntries(contents, Math.min(Math.max(args.limit ?? 3, 1), 20));
  const status = await noteStatus(context.root, await completedCardCount(context.root));
  return {
    structuredContent: { file: FEEDBACK_FILE, exists: true, ...counted, ...status, returned: entries.length },
    text: [
      `${FEEDBACK_FILE} holds ${counted.notes} note(s) and ${counted.ownerFeedback} piece(s) of owner feedback.`,
      status.owed
        ? `A note is owed: ${status.cardsSinceLastNote} card(s) have finished since the last one.`
        : "No note is owed right now.",
      "",
      ...entries
    ].join("\n")
  };
}

/**
 * Record a note or the owner's feedback.
 *
 * One tool rather than two, because the two halves of a loop belong in one place and an agent that
 * has to find a second tool to write down what the owner just said will not find it.
 */
export async function recordFeedback(context, args = {}) {
  const hasNote = Boolean(args.learned);
  const hasOwner = Boolean(args.ownerFeedback);
  // Checked before the empty case, or an argument that carries only `saw` is reported as carrying
  // nothing at all — which tells the caller to supply something they already supplied.
  if (args.saw && !hasNote) {
    throw new ToolFailure(
      "FEEDBACK_REJECTED",
      "Something seen without something learned is an observation, not a note. Supply learned as well."
    );
  }
  if (!hasNote && !hasOwner) {
    throw new ToolFailure(
      "FEEDBACK_REJECTED",
      "Nothing to record. Supply learned (and optionally saw) for a note, ownerFeedback for what the owner said, or both when you are answering them in the same turn."
    );
  }

  const completed = await completedCardCount(context.root);
  const before = await noteStatus(context.root, completed);

  if (args.apply !== true) {
    return {
      structuredContent: { applied: false, file: FEEDBACK_FILE, wouldRecord: { note: hasNote, ownerFeedback: hasOwner } },
      text: [
        `Planned: would append ${[hasNote ? "one note" : null, hasOwner ? "the owner's feedback" : null]
          .filter(Boolean)
          .join(" and ")} to ${FEEDBACK_FILE}. Nothing was written; call again with apply true.`,
        hasNote
          ? "Report the note to the owner in this conversation as well. A note filed and not said is half a loop."
          : null
      ]
        .filter(Boolean)
        .join("\n")
    };
  }

  const written = [];
  if (hasNote) {
    // The team's own name, so the owner reads "Discovery" rather than a role code they never chose.
    const roleName = args.roleId ? describeTeam(args.roleId, "product").name : null;
    try {
      written.push(
        await recordNote(context.root, {
          taskId: args.taskId,
          roleId: args.roleId,
          roleName,
          learned: args.learned,
          saw: args.saw,
          cardsDone: completed
        })
      );
    } catch (error) {
      throw new ToolFailure("FEEDBACK_REJECTED", error.message);
    }
  }
  if (hasOwner) {
    try {
      written.push(
        await recordOwnerFeedback(context.root, {
          text: args.ownerFeedback,
          about: args.taskId,
          // An agent typing the owner's words into a tool is relaying them. Only a dialog the owner
          // filled in themselves earns the stronger label, and this tool is not one.
          attribution: "model_relayed"
        })
      );
    } catch (error) {
      throw new ToolFailure("FEEDBACK_REJECTED", error.message);
    }
  }

  const after = await noteStatus(context.root, completed);
  return {
    structuredContent: {
      applied: true,
      file: FEEDBACK_FILE,
      recorded: written.length,
      notes: after.notes,
      ownerFeedback: after.ownerFeedback,
      cardsSinceLastNote: after.cardsSinceLastNote,
      owed: after.owed
    },
    text: [
      `Appended ${written.length} entr${written.length === 1 ? "y" : "ies"} to ${FEEDBACK_FILE}, newest first.`,
      hasNote && before.owed && !after.owed ? "The overdue note is now filed." : null,
      hasNote
        ? "Now tell the owner what the note says, in this conversation. The loop is the telling, not the file."
        : "The owner's words are recorded as relayed from the conversation, not as typed by them.",
      hasOwner && args.ownerFeedback.length > 600
        ? "That is a long quotation. Keep the owner's words, but check you recorded feedback rather than a transcript."
        : null
    ]
      .filter(Boolean)
      .join("\n")
  };
}
