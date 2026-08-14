import crypto from "node:crypto";
import { APPROVAL_STORE_FILE, SCHEMA_VERSION } from "../constants.js";
import { validatePublishedSchema } from "../schema-validation.js";
import { readJsonOptional, utcTimestamp, writeJson } from "./io.js";
import { withControlPlaneLease } from "./control-plane-lease.js";

const EMPTY_STORE = { schemaVersion: SCHEMA_VERSION, requests: [] };

export async function loadApprovals(root) {
  const store = await readJsonOptional(root, APPROVAL_STORE_FILE, EMPTY_STORE);
  const errors = validatePublishedSchema("approval-store.schema.json", store);
  if (errors.length > 0) {
    throw new Error(`Invalid approval store:\n- ${errors.join("\n- ")}`);
  }
  return store;
}

export async function requestApproval(
  root,
  {
    taskId,
    gate,
    question,
    context = "",
    options = ["approved", "rejected"],
    recommendedOption = null,
    evidenceRefs = [],
    risks = []
  },
  { dryRun = true, now = new Date() } = {}
) {
  // The read and the write must sit inside one lease, or a concurrent surface can insert the same
  // pending gate between the duplicate check and the store write.
  return guarded(root, dryRun, async () => {
    const store = await loadApprovals(root);
    const existing = store.requests.find(
      (request) => request.taskId === taskId && request.gate === gate && request.status === "pending"
    );
    if (existing) {
      return { request: existing, duplicate: true, dryRun };
    }
    const request = {
      requestId: `APR-${crypto.createHash("sha256").update(`${taskId}\0${gate}`).digest("hex").slice(0, 12).toUpperCase()}`,
      taskId,
      gate,
      question,
      context,
      options,
      recommendedOption,
      evidenceRefs,
      risks,
      status: "pending",
      requestedAt: utcTimestamp(now),
      decidedAt: null,
      decidedByActorId: null,
      rationale: null
    };
    const updated = { ...store, requests: [...store.requests, request] };
    await writeJson(root, APPROVAL_STORE_FILE, updated, { dryRun });
    return { request, duplicate: false, dryRun };
  });
}

/**
 * Record the product owner's disposition on a pending gate.
 *
 * A gate carries two separate things and they were being flattened into one. The board needs a
 * binary: does this task proceed or not. The owner often has more to say than that — which of the
 * offered options they chose, and on what conditions they are letting it through. Recording only
 * the binary threw the answer away and left the record claiming they had simply agreed.
 *
 * `status` stays approved/rejected because that is what the board reads. `selectedOption` and
 * `conditions` carry what they actually decided, and a gate that offered real options refuses a
 * bare yes rather than inventing which one they meant.
 */
export async function decideApproval(
  root,
  config,
  { requestId, decision, actorId, rationale = "", selectedOption = null, conditions = [], attribution = null },
  { dryRun = true, now = new Date() } = {}
) {
  if (!['approved', 'rejected'].includes(decision)) {
    throw new Error('Approval decision must be "approved" or "rejected".');
  }
  if (actorId !== config.project.humanAuthorityActorId) {
    throw new Error("Approval actor does not match the configured human authority actor.");
  }
  if (attribution !== null && !["human_entered", "panel_entered", "model_relayed"].includes(attribution)) {
    throw new Error("Approval attribution is not a recognized decision path.");
  }
  // Read and write under one lease so two surfaces cannot both observe the gate as pending and
  // both record a disposition.
  return guarded(root, dryRun, async () => {
    const store = await loadApprovals(root);
    const index = store.requests.findIndex((request) => request.requestId === requestId);
    if (index === -1) {
      throw new Error(`Unknown approval request "${requestId}".`);
    }
    if (store.requests[index].status !== "pending") {
      throw new Error(`Approval request "${requestId}" already has a disposition.`);
    }
    const pending = store.requests[index];
    const offered = pending.options ?? ["approved", "rejected"];
    const choiceRequired = !isBinaryChoice(offered);
    if (selectedOption !== null && !offered.includes(selectedOption)) {
      throw new Error(`Gate "${pending.gate}" did not offer "${selectedOption}". It offered: ${offered.join(", ")}.`);
    }
    if (choiceRequired && selectedOption === null) {
      throw new Error(`Gate "${pending.gate}" asked the product owner to choose between ${offered.join(", ")}. A bare ${decision} does not say which one they chose.`);
    }
    const request = {
      ...pending,
      status: decision,
      selectedOption,
      conditions: normalizeConditions(conditions),
      decidedAt: utcTimestamp(now),
      decidedByActorId: actorId,
      rationale,
      ...(attribution === null ? {} : { attribution })
    };
    const requests = [...store.requests];
    requests[index] = request;
    await writeJson(root, APPROVAL_STORE_FILE, { ...store, requests }, { dryRun });
    return { request, dryRun };
  });
}

/** Approve-or-reject in any order. Anything else is a question with a real answer in it. */
function isBinaryChoice(options) {
  return options.length === 2 && options.includes("approved") && options.includes("rejected");
}

function normalizeConditions(conditions) {
  if (!Array.isArray(conditions)) return [];
  return [...new Set(conditions.map((entry) => String(entry).trim()).filter(Boolean))].slice(0, 20);
}

function guarded(root, dryRun, run) {
  return dryRun ? run() : withControlPlaneLease(root, run);
}
