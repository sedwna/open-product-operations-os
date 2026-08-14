import { replaceTaskboard } from "../runtime/taskboard.js";

/**
 * What happens to a card once its work comes back, and what happens to a cycle once its last card
 * lands. Both performers share this: the coordinator running a provider CLI, and a host returning
 * what its own subagent produced.
 *
 * Recording a run and advancing the board are separate acts, and only the second one is visible.
 * When the host-delegated path did the first without the second, work was sealed correctly and the
 * board never moved, so the next request handed out the same card again — a loop that looks like it
 * is running and is not. One definition of "advance" is the fix for that class of divergence.
 */

export const PRODUCT_RUN_ROOT = ".product-ops/runtime/autopilot/product-runs";

/**
 * Move the card to match its run. A completed run carries its own canonical output forward as
 * evidence; anything else stops the card and says why, in the producer's words rather than ours.
 */
export async function applyRunOutcome(root, headers, tasks, task, run, { now = new Date() } = {}) {
  const projected = projectRunOutcome(tasks, task, run, { now });
  await replaceTaskboard(root, headers, projected.tasks, { dryRun: false });
  return projected;
}

/** Preview the board transition so finalization can succeed before the last card becomes done. */
export function projectRunOutcome(tasks, task, run, { now = new Date() } = {}) {
  const resultRef = `${PRODUCT_RUN_ROOT}/${task.task_id}-result.json`;
  const patch = run.status === "completed"
    ? {
        status: "done",
        blocked_reason: "",
        canonical_output_refs: resultRef,
        evidence_refs: unique([resultRef, ...(run.evidence ?? [])]).join("|"),
        updated_at: now.toISOString()
      }
    : {
        status: "blocked",
        blocked_reason: run.summary,
        evidence_refs: (run.evidence ?? []).join("|"),
        updated_at: now.toISOString()
      };

  const updated = tasks.map((candidate) => candidate.task_id === task.task_id ? { ...candidate, ...patch } : candidate);
  return { status: patch.status, resultRef, tasks: updated };
}

/** Every card for one event, and whether the event has any work left in it. */
export function cycleProgress(tasks, eventId) {
  const owned = tasks.filter((task) => task.event_id === eventId);
  const done = owned.filter((task) => task.status === "done");
  const blocked = owned.filter((task) => task.status === "blocked");
  return {
    tasks: owned,
    total: owned.length,
    done: done.length,
    blocked: blocked.length,
    remaining: owned.length - done.length,
    complete: owned.length > 0 && owned.every((task) => task.status === "done")
  };
}

export function unique(values) {
  return [...new Set(values.filter(Boolean))];
}
