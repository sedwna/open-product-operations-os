import { loadConfig } from "../../config.js";
import { decideApproval, loadApprovals } from "../../runtime/approvals.js";
import { ToolFailure } from "../authority.js";
import { untrusted, untrustedList } from "../untrusted.js";

/**
 * Record the product owner's disposition on a pending human gate.
 *
 * The disposition, the deciding actor, and the rationale are collected from a person through the
 * host's elicitation dialog. They are deliberately not tool parameters: a rationale relayed by a
 * model is the model's account of what it believes the owner wants, and this operating model exists
 * precisely so that a durable approval means a human said so.
 */
export async function decide(context, args = {}) {
  const apply = args.apply === true;
  const config = await loadConfig(context.root);
  const request = await pendingRequest(context, args);

  if (!apply) {
    return {
      structuredContent: {
        applied: false,
        requestId: request.requestId,
        taskId: request.taskId,
        gate: request.gate,
        willAsk: ["decision", "actorId", "rationale"],
        humanAuthorityActorId: config.project.humanAuthorityActorId,
        question: untrusted(request.question, { source: "approval", id: request.requestId }),
        risks: untrustedList(request.risks, { source: "approval", id: request.requestId })
      },
      text: [
        `Ready to put gate "${request.gate}" on ${request.taskId} to the product owner.`,
        "Nothing has been recorded. Calling again with apply true opens a dialog that asks the owner for the disposition and the rationale in their own words.",
        "You are not being asked to choose; you are asking them to."
      ].join("\n")
    };
  }

  const collected = context.supportsElicitation
    ? await elicit(context, config, request)
    : relayed(args, request);

  // The disposition is settled before any lock is taken. Holding a write lease across a dialog that
  // waits on a person would block every other local surface for as long as they take to answer.
  const result = await decideApproval(context.root, config, {
    requestId: request.requestId,
    decision: collected.decision,
    actorId: collected.actorId,
    rationale: collected.rationale
  }, { dryRun: false });

  const structuredContent = {
    applied: true,
    requestId: result.request.requestId,
    taskId: result.request.taskId,
    gate: result.request.gate,
    decision: result.request.status,
    decidedByActorId: result.request.decidedByActorId,
    decidedAt: result.request.decidedAt,
    rationale: untrusted(result.request.rationale, { source: "human-decision", id: result.request.requestId }),
    attribution: collected.attribution
  };
  const lines = [`Recorded ${result.request.status} on gate "${result.request.gate}" for ${result.request.taskId}, attributed to ${result.request.decidedByActorId}.`];
  if (collected.attribution === "model_relayed") {
    lines.push("This host cannot open a dialog, so the rationale was relayed by a model rather than typed by the product owner. The record says the owner decided; treat that attribution with the caution it deserves.");
  }
  return { structuredContent, text: lines.join("\n") };
}

async function pendingRequest(context, args) {
  const store = await loadApprovals(context.root);
  const request = store.requests.find((candidate) => candidate.requestId === args.requestId);
  if (!request) throw new ToolFailure("NOT_FOUND", `No approval request "${args.requestId}" exists in this project.`);
  // Verify the token before reporting status, so a guessed identifier learns nothing.
  if (!context.verifyDecisionToken(request, args.decisionToken)) {
    throw new ToolFailure("DECISION_TOKEN_INVALID", "The decision token is absent, malformed, or not the one issued for this request. Read product_ops_pending_decisions first.");
  }
  if (request.status !== "pending") {
    throw new ToolFailure("APPROVAL_NOT_PENDING", `Gate "${request.gate}" already carries a ${request.status} disposition recorded at ${request.decidedAt}.`);
  }
  return request;
}

async function elicit(context, config, request) {
  const response = await context.elicit({
    message: `Gate "${request.gate}" on task ${request.taskId}. ${String(request.question ?? "Approve or reject?").slice(0, 400)}`,
    requestedSchema: {
      type: "object",
      properties: {
        decision: { type: "string", enum: ["approved", "rejected"], title: "Disposition" },
        actorId: { type: "string", title: "Deciding actor", default: config.project.humanAuthorityActorId },
        rationale: { type: "string", title: "Rationale", minLength: 1, maxLength: 2000 }
      },
      required: ["decision", "actorId", "rationale"]
    }
  }).catch((error) => { throw new ToolFailure("ELICITATION_DECLINED", `No disposition was collected: ${error.message}`); });

  if (response?.action !== "accept") {
    throw new ToolFailure("ELICITATION_DECLINED", `The product owner ${response?.action === "decline" ? "declined" : "cancelled"} the dialog. Nothing was recorded.`);
  }
  const content = response.content ?? {};
  if (!["approved", "rejected"].includes(content.decision) || typeof content.rationale !== "string" || content.rationale.trim() === "") {
    throw new ToolFailure("ELICITATION_DECLINED", "The dialog returned an incomplete disposition. Nothing was recorded.");
  }
  return {
    decision: content.decision,
    actorId: String(content.actorId ?? config.project.humanAuthorityActorId),
    rationale: content.rationale.trim().slice(0, 2000),
    attribution: "human_entered"
  };
}

/**
 * Compatibility path for a host that cannot open a dialog. The server-side authority check still
 * applies, but the attribution is weaker and the result says so rather than hiding it.
 */
function relayed(args, request) {
  if (!["approved", "rejected"].includes(args.decision) || !args.actorId || !String(args.rationale ?? "").trim()) {
    throw new ToolFailure(
      "ELICITATION_UNAVAILABLE",
      `This host did not declare elicitation support, so gate "${request.gate}" can only be decided by supplying decision, actorId, and rationale explicitly — and only with what the product owner actually said.`
    );
  }
  return {
    decision: args.decision,
    actorId: String(args.actorId),
    rationale: String(args.rationale).trim().slice(0, 2000),
    attribution: "model_relayed"
  };
}
