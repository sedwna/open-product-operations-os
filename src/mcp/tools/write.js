import { loadConfig } from "../../config.js";
import { runControlTower } from "../../runtime/control-tower.js";
import { ingestRecord } from "../../runtime/intake.js";
import {
  patchAutopilotState,
  readAutomationLink,
  readAutopilotCoordinator,
  readAutopilotState
} from "../../autopilot/state.js";
import { ToolFailure } from "../authority.js";
import { untrusted } from "../untrusted.js";

export async function intake(context, args = {}) {
  assertApplyAuthorised(context, args);
  const apply = args.apply === true;
  const authorized = args.autopilotAuthorized === true;
  const result = await ingestRecord(context.root, {
    type: args.type,
    title: args.title,
    description: args.description,
    source: args.source,
    targetUser: args.targetUser ?? "",
    priority: args.priority ?? "P2",
    autopilotAuthorized: authorized
  }, { dryRun: !apply });

  const record = result.record;
  const structuredContent = {
    applied: apply,
    intakeId: record.intakeId,
    eventId: record.eventId,
    status: record.status,
    duplicateOf: record.duplicateOf,
    priority: record.priority,
    autopilotAuthorized: record.autopilotAuthorized,
    title: untrusted(record.title, { source: "intake", id: record.intakeId })
  };
  const lines = [
    apply
      ? `Recorded intake ${record.intakeId} as event ${record.eventId} (${record.status}).`
      : `Planned intake ${record.intakeId} for event ${record.eventId} (${record.status}). Nothing was written; call again with apply true to record it.`
  ];
  if (record.status === "duplicate") {
    lines.push(`This matches existing intake ${record.duplicateOf} and joins its event rather than opening a new one.`);
  }
  lines.push(record.autopilotAuthorized
    ? "This intake authorises one bounded autonomous cycle. Production release, destructive actions, spending, and external publication remain separately gated."
    : "This intake does not authorise an autonomous cycle. It waits for the control plane or an explicit authorisation.");
  return { structuredContent, text: lines.join("\n") };
}

export async function operate(context, args = {}) {
  assertApplyAuthorised(context, args);
  const apply = args.apply === true;
  const config = await loadConfig(context.root);

  if (apply) {
    // The continuous coordinator owns routing for this workspace while it runs. The write lease
    // would serialise the two, but serialising is not the same as being correct: a manual cycle
    // interleaved between the coordinator's own steps confuses the state machine it is driving.
    const coordinator = await coordinatorState(context.root);
    if (coordinator.owning) {
      throw new ToolFailure("WRITE_LEASE_HELD", "The continuous coordinator owns product-cycle routing in this workspace. Pause it before running a manual cycle.", { surface: "autopilot" });
    }
  }

  // executeDevelopment is deliberately fixed. Dispatching engineering work crosses the
  // Product/Development authority boundary and is not something a chat message should trigger.
  const receipt = await runControlTower(context.root, config, { dryRun: !apply, executeDevelopment: false });
  const byType = receipt.actions.reduce((counts, action) => {
    counts[action.type] = (counts[action.type] ?? 0) + 1;
    return counts;
  }, {});
  const structuredContent = {
    applied: apply,
    runId: receipt.runId,
    actionCount: receipt.actions.length,
    actionsByType: byType,
    actions: receipt.actions.slice(0, 25).map((action) => ({
      type: action.type,
      taskId: action.taskId ?? null,
      intakeId: action.intakeId ?? null,
      ownerRole: action.ownerRole ?? null,
      gate: action.gate ?? null
    })),
    truncated: receipt.actions.length > 25
  };
  const summary = Object.entries(byType).map(([type, count]) => `${type} ×${count}`).join(", ") || "no action";
  return {
    structuredContent,
    text: apply
      ? `Ran control-plane cycle ${receipt.runId}: ${summary}.`
      : `Planned control-plane cycle ${receipt.runId}: ${summary}. Nothing was written; call again with apply true to run it.`
  };
}

export async function autopilot(context, args = {}) {
  const action = args.action;
  if (!["start", "pause", "resume", "retry"].includes(action)) {
    throw new ToolFailure("NOT_FOUND", `Unsupported autopilot action "${action}".`);
  }
  assertApplyAuthorised(context, { apply: true });

  const link = await automationLink(context.root);
  if (!link) throw new ToolFailure("AUTOPILOT_NOT_CONFIGURED", "This workspace has no usable automation link, so there is no coordinator to control.");

  const before = await readAutopilotState(context.root);
  const coordinator = await readAutopilotCoordinator(context.root);
  const patch = action === "pause"
    ? { status: "paused" }
    : {
        status: "idle",
        attempt: action === "retry" ? 0 : before.attempt,
        transientAttempt: action === "retry" ? 0 : before.transientAttempt,
        nextRetryAt: null,
        lastErrorKind: null,
        lastError: action === "retry" ? null : before.lastError
      };
  const after = await patchAutopilotState(context.root, patch);

  const structuredContent = {
    action,
    previousStatus: before.status,
    status: after.status,
    coordinatorRunning: coordinator.live,
    attempt: after.attempt,
    transientAttempt: after.transientAttempt,
    lastError: untrusted(after.lastError, { source: "autopilot-state", id: "lastError" })
  };
  const lines = [`Autopilot ${before.status} → ${after.status}.`];
  if (action === "pause") {
    lines.push("Pause is cooperative: it takes effect after the agent that is already running returns, not immediately.");
  }
  lines.push(coordinator.live
    ? "A coordinator process is running and will observe this state on its next tick."
    : "No coordinator process is currently running. This changed the durable state, but nothing will act on it until a writable dashboard session starts the loop.");
  return { structuredContent, text: lines.join("\n") };
}

async function coordinatorState(root) {
  const link = await automationLink(root);
  if (!link?.autoStart) return { owning: false, live: false };
  const coordinator = await readAutopilotCoordinator(root);
  return { owning: coordinator.live, live: coordinator.live };
}

/**
 * An absent link and an unusable one are both "no coordinator to control" from a caller's point of
 * view. Reporting the underlying reason keeps a misconfigured link from reading as an internal
 * fault the product owner cannot act on.
 */
async function automationLink(root) {
  try {
    return await readAutomationLink(root);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new ToolFailure("AUTOPILOT_NOT_CONFIGURED", `The automation link cannot be used: ${error.message}`);
  }
}

/**
 * Defence in depth. A read-only server never registers these tools, so this cannot normally fire;
 * it holds the invariant if registration is ever changed.
 */
function assertApplyAuthorised(context, args) {
  if (args?.apply === true && context.allowWrites !== true) {
    throw new ToolFailure("APPLY_NOT_AUTHORIZED", "This server was started without write authorisation.");
  }
}
