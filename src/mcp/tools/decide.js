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
        options: request.options ?? ["approved", "rejected"],
        recommendedOption: request.recommendedOption ?? null,
        willAsk: offeredOptions(request).binary
          ? ["decision", "actorId", "rationale", "conditions"]
          : ["decision", "selectedOption", "actorId", "rationale", "conditions"],
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

  const collected = args.source === "panel"
    ? composed(args, config, request)
    : (context.supportsElicitation ? await elicit(context, config, request) : relayed(args, request));

  // The disposition is settled before any lock is taken. Holding a write lease across a dialog that
  // waits on a person would block every other local surface for as long as they take to answer.
  const result = await decideApproval(context.root, config, {
    requestId: request.requestId,
    decision: collected.decision,
    actorId: collected.actorId,
    rationale: collected.rationale,
    selectedOption: collected.selectedOption,
    conditions: collected.conditions
  }, { dryRun: false });

  const structuredContent = {
    applied: true,
    requestId: result.request.requestId,
    taskId: result.request.taskId,
    gate: result.request.gate,
    decision: result.request.status,
    selectedOption: result.request.selectedOption,
    conditions: untrustedList(result.request.conditions ?? [], { source: "human-decision", id: result.request.requestId }),
    decidedByActorId: result.request.decidedByActorId,
    decidedAt: result.request.decidedAt,
    rationale: untrusted(result.request.rationale, { source: "human-decision", id: result.request.requestId }),
    attribution: collected.attribution
  };
  const lines = [`Recorded ${result.request.status} on gate "${result.request.gate}" for ${result.request.taskId}, attributed to ${result.request.decidedByActorId}.`];
  if (result.request.selectedOption) {
    lines.push(`They chose: ${result.request.selectedOption}.`);
  }
  if ((result.request.conditions ?? []).length > 0) {
    lines.push(`It carries ${result.request.conditions.length} condition(s). An approval with conditions is not a bare approval — carry them into the work, and say so when you report it done.`);
  }
  if (collected.attribution === "model_relayed") {
    lines.push("This host cannot open a dialog, so the rationale was relayed by a model rather than typed by the product owner. The record says the owner decided; treat that attribution with the caution it deserves.");
  }
  if (collected.attribution === "panel_entered") {
    lines.push("The product owner composed this in the control tower panel.");
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

/** A gate that offered real options asks which one, not just whether. */
function offeredOptions(request) {
  const options = request.options ?? ["approved", "rejected"];
  const binary = options.length === 2 && options.includes("approved") && options.includes("rejected");
  return { options, binary };
}

async function elicit(context, config, request) {
  const { options, binary } = offeredOptions(request);
  const properties = {
    decision: { type: "string", enum: ["approved", "rejected"], title: "Disposition" },
    actorId: { type: "string", title: "Deciding actor", default: config.project.humanAuthorityActorId },
    rationale: { type: "string", title: "Rationale", minLength: 1, maxLength: 2000 },
    conditions: { type: "string", title: "Conditions, one per line (optional)", maxLength: 2000 }
  };
  if (!binary) {
    properties.selectedOption = { type: "string", enum: options, title: "Which option" };
  }
  const response = await context.elicit({
    message: `Gate "${request.gate}" on task ${request.taskId}. ${String(request.question ?? "Approve or reject?").slice(0, 400)}`,
    requestedSchema: {
      type: "object",
      properties,
      required: binary ? ["decision", "actorId", "rationale"] : ["decision", "selectedOption", "actorId", "rationale"]
    }
  }).catch((error) => {
    // A host that declares elicitation and then fails to deliver it leaves the gate unanswerable
    // through this path. The panel composer is the other way in, and saying so here is the
    // difference between a stuck owner and a decided one.
    throw new ToolFailure("ELICITATION_DECLINED", `No disposition was collected: ${error.message}. Open product_ops_panel and ask the owner to decide in the composer next to this gate instead.`);
  });

  if (response?.action !== "accept") {
    throw new ToolFailure("ELICITATION_DECLINED", `The product owner ${response?.action === "decline" ? "declined" : "cancelled"} the dialog. Nothing was recorded. If they meant to decide and the dialog was in the way, the control tower panel takes the same decision without one.`);
  }
  const content = response.content ?? {};
  if (!["approved", "rejected"].includes(content.decision) || typeof content.rationale !== "string" || content.rationale.trim() === "") {
    throw new ToolFailure("ELICITATION_DECLINED", "The dialog returned an incomplete disposition. Nothing was recorded.");
  }
  if (!binary && !options.includes(content.selectedOption)) {
    throw new ToolFailure("ELICITATION_DECLINED", `The dialog returned no choice among ${options.join(", ")}. Nothing was recorded.`);
  }
  return {
    decision: content.decision,
    selectedOption: binary ? null : content.selectedOption,
    conditions: splitConditions(content.conditions),
    actorId: String(content.actorId ?? config.project.humanAuthorityActorId),
    rationale: content.rationale.trim().slice(0, 2000),
    attribution: "human_entered"
  };
}

/** The dialog takes conditions as free text because a host's schema has no repeatable field. */
function splitConditions(value) {
  return String(value ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 20);
}

/**
 * The product owner composed the disposition in the control tower panel.
 *
 * The panel runs in a sandboxed iframe the host renders; a model cannot type into it. What the
 * server receives, though, is an ordinary tool call, and no field in it proves who authored the
 * text. Two host-side controls carry that weight instead: the decision token, which only the
 * pending-decisions listing issues, and `anthropic/requiresUserInteraction`, which makes a person
 * approve every single call to this tool in every permission mode.
 *
 * The attribution is recorded distinctly so the provenance stays legible in the record rather than
 * being flattened into the dialog path.
 */
function composed(args, config, request) {
  if (!["approved", "rejected"].includes(args.decision)) {
    throw new ToolFailure("ELICITATION_DECLINED", `Gate "${request.gate}" needs an explicit approved or rejected disposition.`);
  }
  const rationale = String(args.rationale ?? "").trim();
  if (rationale === "") {
    throw new ToolFailure("ELICITATION_DECLINED", "A disposition without a rationale is not a durable decision. Write why.");
  }
  const { options, binary } = offeredOptions(request);
  if (!binary && !options.includes(args.selectedOption)) {
    throw new ToolFailure("ELICITATION_DECLINED", `Gate "${request.gate}" offered ${options.join(", ")}. The panel must send back which one the owner picked.`);
  }
  return {
    decision: args.decision,
    selectedOption: binary ? null : args.selectedOption,
    conditions: Array.isArray(args.conditions) ? args.conditions : [],
    actorId: String(args.actorId ?? config.project.humanAuthorityActorId),
    rationale: rationale.slice(0, 2000),
    attribution: "panel_entered"
  };
}

/**
 * Compatibility path for a host that cannot open a dialog. The server-side authority check still
 * applies, but the attribution is weaker and the result says so rather than hiding it.
 */
function relayed(args, request) {
  const { options, binary } = offeredOptions(request);
  if (!binary && !options.includes(args.selectedOption)) {
    throw new ToolFailure(
      "ELICITATION_UNAVAILABLE",
      `Gate "${request.gate}" asked the product owner to choose between ${options.join(", ")}. Ask them, and pass back the option they named as selectedOption.`
    );
  }
  if (!["approved", "rejected"].includes(args.decision) || !args.actorId || !String(args.rationale ?? "").trim()) {
    throw new ToolFailure(
      "ELICITATION_UNAVAILABLE",
      [
        `This host did not declare elicitation support, so no dialog can be opened for gate "${request.gate}".`,
        "Open product_ops_panel and ask the owner to decide there: the composer next to this gate takes their disposition and their own words, and records it attributed to them.",
        "If the panel does not render either, ask them here in the conversation and pass back exactly what they said as decision, actorId and rationale — never your reading of it.",
        "Do not send them to a terminal. There is nothing they need to run."
      ].join(" ")
    );
  }
  return {
    decision: args.decision,
    selectedOption: binary ? null : args.selectedOption,
    conditions: Array.isArray(args.conditions) ? args.conditions : [],
    actorId: String(args.actorId),
    rationale: String(args.rationale).trim().slice(0, 2000),
    attribution: "model_relayed"
  };
}
