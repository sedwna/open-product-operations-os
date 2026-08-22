import fs from "node:fs/promises";
import path from "node:path";
import { validatePublishedSchema } from "../schema-validation.js";

const PRODUCT_RUN_ROOT = ".product-ops/runtime/autopilot/product-runs";

/**
 * Recover the exact product-direction question prepared by the preceding product role.
 *
 * The gate sits on the next card, while the options were produced by the completed decision brief.
 * Keeping this lookup at the control-plane boundary prevents a generic approve/reject dialog from
 * flattening a real A/B/C choice into a bare yes.
 */
export async function decisionProposalForGate(root, tasks, gateTask) {
  if (gateTask.human_gate !== "product_direction_or_priority") return null;
  // That role holds more than one card on a route — it triages the idea and later prepares the
  // brief — so taking the first match returned the triage, which carries no proposal, and the gate
  // fell back to "Authorize gate X for task Y?" while a full A/B/C choice sat in the record two
  // cards later. Every one of its completed cards is checked, latest first, and the first that
  // actually carries a proposal is the one that prepared it.
  const briefTasks = tasks.filter((candidate) =>
    candidate.event_id === gateTask.event_id
      && ["RB-02", "RB-05"].includes(candidate.owner_role)
      && candidate.status === "done").reverse();

  for (const briefTask of briefTasks) {
    const file = path.join(root, PRODUCT_RUN_ROOT, `${briefTask.task_id}-result.json`);
    let result;
    try {
      result = JSON.parse(await fs.readFile(file, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const errors = validatePublishedSchema("product-agent-run.schema.json", result);
    if (errors.length > 0) {
      throw new Error(`Stored product decision brief ${briefTask.task_id} is invalid: ${errors.join("; ")}`);
    }
    if (result.decisionProposal) return result.decisionProposal;
  }
  return null;
}
