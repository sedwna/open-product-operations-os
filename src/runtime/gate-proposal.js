import fs from "node:fs/promises";
import path from "node:path";
import { validatePublishedSchema } from "../schema-validation.js";

const PRODUCT_RUN_ROOT = ".product-ops/runtime/autopilot/product-runs";

/**
 * Recover the exact product-direction question prepared by RB-02.
 *
 * The gate sits on the next card, while the options were produced by the completed decision brief.
 * Keeping this lookup at the control-plane boundary prevents a generic approve/reject dialog from
 * flattening a real A/B/C choice into a bare yes.
 */
export async function decisionProposalForGate(root, tasks, gateTask) {
  if (gateTask.human_gate !== "product_direction_or_priority") return null;
  const briefTask = tasks.find((candidate) =>
    candidate.event_id === gateTask.event_id
      && candidate.owner_role === "RB-02"
      && candidate.status === "done");
  if (!briefTask) return null;

  const file = path.join(root, PRODUCT_RUN_ROOT, `${briefTask.task_id}-result.json`);
  let result;
  try {
    result = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const errors = validatePublishedSchema("product-agent-run.schema.json", result);
  if (errors.length > 0) {
    throw new Error(`Stored product decision brief ${briefTask.task_id} is invalid: ${errors.join("; ")}`);
  }
  return result.decisionProposal ?? null;
}
