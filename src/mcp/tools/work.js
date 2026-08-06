import crypto from "node:crypto";
import { loadConfig } from "../../config.js";
import { INTAKE_STORE_FILE } from "../../constants.js";
import { readJsonOptional } from "../../runtime/io.js";
import { loadApprovals } from "../../runtime/approvals.js";
import { loadTaskboard, selectRunnableTasks } from "../../runtime/taskboard.js";
import { buildProductAgentRequest, runProductAgent, submittedResultExecutor } from "../../autopilot/product-agent.js";
import { applyRunOutcome, cycleProgress } from "../../autopilot/cycle.js";
import { withControlPlaneLease } from "../../runtime/control-plane-lease.js";
import { readAutomationLink } from "../../autopilot/state.js";
import { describeTeam } from "../app/teams.js";
import { ToolFailure } from "../authority.js";
import { untrusted } from "../untrusted.js";

/**
 * The host-delegated execution path.
 *
 * The spawned-provider path drives itself: the coordinator loop picks work and runs a CLI to do it.
 * A host cannot be driven that way — its subagents are its own to start — so here the host drives
 * and this surface serves the work. `next_work` hands out one bounded brief; `submit_work` takes
 * the result back through the very same validation the spawned path uses.
 *
 * Both paths write the same records. What differs is only who performs the work.
 */

export async function nextWork(context) {
  const config = await loadConfig(context.root);
  const { records: tasks } = await loadTaskboard(context.root);
  const approvals = await loadApprovals(context.root);
  const runnable = selectRunnableTasks(tasks, approvals.requests)
    .filter((task) => task.owner_role !== config.separation.developmentRole);

  if (runnable.length === 0) {
    return {
      structuredContent: { available: false, reason: reasonNothingIsReady(tasks, approvals.requests), waitingOnOwner: pendingGateCount(approvals.requests) },
      text: describeNothingReady(tasks, approvals.requests)
    };
  }

  const task = runnable[0];
  const role = config.agents.find((candidate) => candidate.id === task.owner_role);
  if (!role) {
    throw new ToolFailure("NOT_FOUND", `Task ${task.task_id} names role ${task.owner_role}, which this project does not configure.`);
  }

  const intake = await intakeFor(context.root, task.event_id);
  const link = await automationLink(context.root);
  const brief = buildProductAgentRequest(config, task, role, {
    intake,
    cycleId: task.event_id,
    applicationRoot: link?.applicationRoot ?? null
  });

  const team = describeTeam(role.id, "product");
  return {
    structuredContent: {
      available: true,
      claimToken: context.claimToken(task),
      taskId: task.task_id,
      eventId: task.event_id,
      team: team.name,
      teamFocus: team.focus,
      roleId: role.id,
      producerActorId: role.actorId,
      title: untrusted(task.title, { source: "taskboard", id: task.task_id }),
      may: role.responsibilities ?? [],
      mustNot: role.prohibitedActions ?? [],
      policy: brief.policy,
      brief
    },
    text: [
      `Next ready work: ${task.task_id} — ${team.name}.`,
      `That team's job is ${team.focus}.`,
      "",
      "Delegate this to a subagent scoped to that boundary. It must stay inside `may`, must not do anything in `mustNot`, and must not write repository files or take production actions.",
      "Return its result through product_ops_submit_work with this claimToken. The result is validated against the same contract a provider CLI would have to satisfy, so an answer that does not match the dispatched task is refused rather than recorded."
    ].join("\n")
  };
}

export async function submitWork(context, args = {}) {
  if (args.apply === true && context.allowWrites !== true) {
    throw new ToolFailure("APPLY_NOT_AUTHORIZED", "This server was started without write authorisation.");
  }
  const config = await loadConfig(context.root);
  const { records: tasks } = await loadTaskboard(context.root);
  const task = tasks.find((candidate) => candidate.task_id === args.taskId);
  if (!task) throw new ToolFailure("NOT_FOUND", `No task ${args.taskId} is on this board.`);

  // Read before write, as everywhere else here: the token is only ever issued by next_work, so a
  // task identifier lifted from a record or guessed cannot reach the run store.
  if (!context.verifyClaimToken(task, args.claimToken)) {
    throw new ToolFailure("CLAIM_INVALID", "That claim token does not match this task. Call product_ops_next_work and submit against the work it hands out.");
  }

  const role = config.agents.find((candidate) => candidate.id === task.owner_role);
  if (!role) throw new ToolFailure("NOT_FOUND", `Task ${task.task_id} names role ${task.owner_role}, which this project does not configure.`);

  if (args.apply !== true) {
    return {
      structuredContent: { applied: false, taskId: task.task_id, roleId: role.id, status: args.result?.status ?? null },
      text: `Planned: would record a ${args.result?.status ?? "?"} result for ${task.task_id} as ${describeTeam(role.id, "product").name}. Nothing was written; call again with apply true to record it.`
    };
  }

  const intake = await intakeFor(context.root, task.event_id);
  const link = await automationLink(context.root);

  // Recording the run and advancing the card are one transaction. Doing the first without the
  // second seals the work correctly and leaves the board unchanged, so the next request hands out
  // the same card — a loop that looks like it is running and is not.
  const outcome = await withControlPlaneLease(context.root, async () => {
    let recorded;
    try {
      recorded = await runProductAgent(context.root, config, task, {
        intake,
        cycleId: task.event_id,
        applicationRoot: link?.applicationRoot ?? null,
        execute: submittedResultExecutor(args.result)
      });
    } catch (error) {
      // A rejection here is the contract refusing the submission, not an internal fault. Say which,
      // because the coordinator can fix a malformed result and cannot fix a broken server.
      throw new ToolFailure("RESULT_REJECTED", `The submitted result was refused: ${error.message}`);
    }
    const board = await loadTaskboard(context.root);
    const advanced = await applyRunOutcome(context.root, board.headers, board.records, task, recorded.result);
    return { recorded, advanced, progress: cycleProgress(advanced.tasks, task.event_id) };
  });

  const { recorded, advanced, progress } = outcome;
  const team = describeTeam(role.id, "product");
  const lines = [
    recorded.result.status === "completed"
      ? `Recorded ${task.task_id} for ${team.name} and moved it to done. A completed result is sealed; submitting again returns the sealed record rather than replacing it.`
      : `Recorded a ${recorded.result.status} result for ${task.task_id} (${team.name}) and stopped the card with the producer's own reason. It is not sealed, so the work can be attempted again.`
  ];
  lines.push(progress.complete
    ? `Every card for ${task.event_id} is now done. Run product_ops_operate to close the cycle and produce its report.`
    : `${progress.remaining} of ${progress.total} card(s) for ${task.event_id} remain. Call product_ops_next_work for the next one.`);

  return {
    structuredContent: {
      applied: true,
      taskId: task.task_id,
      eventId: task.event_id,
      team: team.name,
      roleId: role.id,
      status: recorded.result.status,
      boardStatus: advanced.status,
      outputFile: recorded.outputFile,
      sealed: recorded.result.status === "completed",
      cycle: {
        total: progress.total,
        done: progress.done,
        blocked: progress.blocked,
        remaining: progress.remaining,
        complete: progress.complete
      }
    },
    text: lines.join("\n")
  };
}

/**
 * Bound to one server process, like the decision-token issuer, and keyed to the task's current
 * position so a token cannot be held across a state change and replayed against different work.
 */
export function createClaimTokenIssuer() {
  const secret = crypto.randomBytes(32);
  const sign = (task) => crypto
    .createHmac("sha256", secret)
    .update(`${task.task_id}\0${task.event_id}\0${task.owner_role}\0${task.status}`)
    .digest("base64url")
    .slice(0, 32);
  return {
    issue: sign,
    verify: (task, token) => typeof token === "string" && token.length === 32 && timingSafeEqual(sign(task), token)
  };
}

function timingSafeEqual(left, right) {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function intakeFor(root, eventId) {
  const store = await readJsonOptional(root, INTAKE_STORE_FILE, { records: [] });
  return (store.records ?? []).find((record) => record.eventId === eventId) ?? null;
}

async function automationLink(root) {
  try {
    return await readAutomationLink(root);
  } catch {
    // No link is an ordinary state: product operations run perfectly well before an application
    // exists. Only the linked-application field goes missing from the brief.
    return null;
  }
}

function pendingGateCount(approvals) {
  return approvals.filter((request) => request.status === "pending").length;
}

function reasonNothingIsReady(tasks, approvals) {
  if (tasks.length === 0) return "no_tasks";
  if (pendingGateCount(approvals) > 0) return "waiting_on_owner";
  if (tasks.every((task) => task.status === "done")) return "all_done";
  if (tasks.some((task) => task.status === "blocked")) return "blocked";
  return "no_runnable_work";
}

function describeNothingReady(tasks, approvals) {
  const pending = pendingGateCount(approvals);
  if (pending > 0) {
    return `Nothing is ready to delegate. ${pending} gate(s) are waiting on the product owner — call product_ops_pending_decisions and put them to the owner.`;
  }
  if (tasks.length > 0 && tasks.every((task) => task.status === "done")) {
    return "Nothing is ready to delegate: every task on the board is done.";
  }
  if (tasks.some((task) => task.status === "blocked")) {
    return "Nothing is ready to delegate. Work on the board is blocked — call product_ops_task on a blocked card to walk the dependency chain to its cause.";
  }
  return "Nothing is ready to delegate. Run product_ops_operate to route intake and promote ready work, then ask again.";
}
