import crypto from "node:crypto";
import { loadConfig } from "../../config.js";
import { INTAKE_STORE_FILE } from "../../constants.js";
import { readJsonOptional } from "../../runtime/io.js";
import { loadApprovals } from "../../runtime/approvals.js";
import { loadTaskboard, selectRunnableTasks, visibleTaskboardRecords } from "../../runtime/taskboard.js";
import { adoptionAssignmentForTask, closeAdoption } from "../../adoption/materialize.js";
import { buildProductAgentRequest, runProductAgent, submittedResultExecutor, validateSubmittedProductResult } from "../../autopilot/product-agent.js";
import { applyRunOutcome, cycleProgress, projectRunOutcome } from "../../autopilot/cycle.js";
import { loadProductRuns, persistCycleReport, writeCycleReport } from "../../autopilot/orchestrator.js";
import { materializeCycleWorkbook } from "../../autopilot/workbook.js";
import { withControlPlaneLease } from "../../runtime/control-plane-lease.js";
import { commitRoleRecords, validateRoleRecords } from "../../runtime/coordination-record.js";
import { readAutomationLink } from "../../autopilot/state.js";
import { describeTeam } from "../app/teams.js";
import { ToolFailure } from "../authority.js";
import { untrusted, untrustedList } from "../untrusted.js";

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
  const { records } = await loadTaskboard(context.root);
  const tasks = visibleTaskboardRecords(records);
  const approvals = await loadApprovals(context.root);
  const allRunnable = selectRunnableTasks(tasks, approvals.requests);
  const runnable = allRunnable.filter((task) => task.owner_role !== config.separation.developmentRole);

  if (runnable.length === 0) {
    // Reporting "nothing is ready" when the engineering hand-off is the next card is misleading:
    // the cycle is not stalled, it has simply reached the boundary this surface will not cross.
    const atBoundary = allRunnable.filter((task) => task.owner_role === config.separation.developmentRole);
    if (atBoundary.length > 0) {
      return {
        structuredContent: {
          available: false,
          reason: "at_development_boundary",
          taskId: atBoundary[0].task_id,
          team: describeTeam(config.separation.developmentRole, "product").name,
          waitingOnOwner: pendingGateCount(approvals.requests)
        },
        text: [
          `The next card, ${atBoundary[0].task_id}, is the hand-off to engineering, and this surface does not dispatch it.`,
          "Crossing from product into development is a separate authority, exercised deliberately rather than as the next step in a loop.",
          "Run product_ops_operate. If no application repository is connected, that opens a decision for the owner describing what would be created; it will then appear in product_ops_pending_decisions like any other gate. Do not ask the owner to run commands — put the decision to them and act on their answer."
        ].join("\n")
      };
    }
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
  const adoptionAssignment = await adoptionAssignmentForTask(context.root, task.task_id);
  const brief = buildProductAgentRequest(config, task, role, {
    intake,
    cycleId: task.event_id,
    applicationRoot: link?.applicationRoot ?? null,
    operationalArtifacts: adoptionAssignment
  });

  const team = describeTeam(role.id, "product");
  const decisions = ownerDecisions(approvals.requests, task, tasks);
  const conditions = decisions.flatMap((decision) => decision.conditions);
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
      ownerDecisions: decisions,
      policy: brief.policy,
      adoptionAssignment,
      brief
    },
    text: [
      `Next ready work: ${task.task_id} — ${team.name}.`,
      `That team's job is ${team.focus}.`,
      "",
      // A gate the owner settled with conditions is the owner setting terms for this work. Handing
      // the brief over without them delegates the task and drops the decision that authorised it.
      ...(conditions.length > 0
        ? [`The product owner has already decided on this event, and their decision carries ${conditions.length} condition(s). They are in ownerDecisions. Pass them to the subagent as part of the work, and say in your result how each was met.`, ""]
        : []),
      "Delegate this to a subagent scoped to that boundary. It must stay inside `may`, must not do anything in `mustNot`, and must not write repository files or take production actions.",
      "Return its result through product_ops_submit_work with this claimToken. The result is validated against the same contract a provider CLI would have to satisfy, so an answer that does not match the dispatched task is refused rather than recorded."
    ].join("\n")
  };
}

/**
 * Close a finished event: write its report, then commit its record to the canonical workbook.
 *
 * These are the same two steps the coordinator loop takes when its last card lands, called here
 * because the delegated path finishes cards too and had no way to reach them. `cycleId` follows the
 * loop's own convention so a cycle closed either way is the same cycle, with the same identifiers,
 * in the same places.
 */
async function closeCycle(root, config, task, tasks) {
  const intake = await intakeFor(root, task.event_id);
  if (!intake) throw new Error(`Event ${task.event_id} has no intake record, so there is nothing to write a report about.`);
  const cycleId = `CYCLE-${task.event_id}`;
  const runs = await loadProductRuns(root, tasks, "__after_all__");
  const report = await writeCycleReport(root, cycleId, intake, tasks, new Date());
  const workbook = await materializeCycleWorkbook(root, config, {
    cycleId,
    intake,
    tasks,
    runs,
    now: new Date(runs.at(-1)?.completedAt ?? report.report.completedAt)
  });
  report.report.workbook = workbook;
  await persistCycleReport(root, report);
  return {
    report: report.markdown,
    workbook: { written: workbook.receipts?.length ?? 0, sheets: workbook.manifests?.length ?? 0 }
  };
}

/**
 * What the owner has already settled on this event.
 *
 * A gate is not only a permission to proceed. It is where the owner states which option they chose
 * and on what terms, and those terms govern every task the event goes on to produce — not just the
 * one card that happened to carry the gate.
 */
function ownerDecisions(requests, task, tasks) {
  const sameEvent = new Set(
    tasks.filter((candidate) => candidate.event_id === task.event_id).map((candidate) => candidate.task_id)
  );
  return requests
    .filter((request) => request.status !== "pending" && request.decidedAt && sameEvent.has(request.taskId))
    .map((request) => ({
      requestId: request.requestId,
      taskId: request.taskId,
      gate: request.gate,
      decision: request.status,
      selectedOption: request.selectedOption ?? null,
      conditions: untrustedList(request.conditions ?? [], { source: "human-decision", id: request.requestId }),
      rationale: untrusted(request.rationale, { source: "human-decision", id: request.requestId }),
      decidedAt: request.decidedAt
    }));
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
  const adoptionAssignment = await adoptionAssignmentForTask(context.root, task.task_id);
  if (adoptionAssignment && Array.isArray(args.result?.canonicalRecords) && args.result.canonicalRecords.length > 0) {
    throw new ToolFailure("ADOPTION_CLAIMS_NOT_ALLOWED", "Adoption returns sourced observations for owner review; it cannot write accepted canonical claims.");
  }

  // Plan and apply must enforce the same deterministic contract. Previously plan accepted any
  // schema-shaped result, while apply sealed its run artifacts and only then discovered that a row
  // crossed a role or protected-field boundary. The card stayed ready but the sealed file made a
  // corrected retry impossible. Preflight before either branch keeps rejection side-effect free.
  try {
    validateSubmittedProductResult(args.result, task, role);
  } catch (error) {
    throw new ToolFailure("RESULT_REJECTED", `The submitted result was refused: ${error.message}`);
  }
  if (!adoptionAssignment && args.result.status === "completed") {
    try {
      validateRoleRecords(config, args.result);
    } catch (error) {
      throw new ToolFailure("RECORD_REJECTED", `${error.message} Fix the rows and submit again; the card has not moved.`);
    }
  }

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
        operationalArtifacts: adoptionAssignment,
        execute: submittedResultExecutor(args.result)
      });
    } catch (error) {
      // A rejection here is the contract refusing the submission, not an internal fault. Say which,
      // because the coordinator can fix a malformed result and cannot fix a broken server.
      throw new ToolFailure("RESULT_REJECTED", `The submitted result was refused: ${error.message}`);
    }
    // Committed before the card moves, so a row that will not go in stops the card rather than
    // leaving it done with a record that never arrived.
    let committed = { written: 0, sheets: [] };
    if (recorded.result.status === "completed" && !adoptionAssignment) {
      try {
        committed = await commitRoleRecords(context.root, config, recorded.result);
      } catch (error) {
        throw new ToolFailure("RECORD_REJECTED", `${error.message} Fix the rows and submit again; the card has not moved.`);
      }
    }
    const board = await loadTaskboard(context.root);
    const projected = projectRunOutcome(board.records, task, recorded.result);
    const progress = cycleProgress(projected.tasks, task.event_id);
    const sampleCompletion = task.event_id === "EVT-00000000-001" && task.title === "Complete the first discovery record";
    let closure = null;
    if (progress.complete && !sampleCompletion) {
      try {
        closure = adoptionAssignment
          ? await closeAdoption(context.root, task, progress.tasks)
          : await closeCycle(context.root, config, task, progress.tasks);
      } catch (error) {
        throw new ToolFailure(
          "CLOSURE_FAILED",
          `The result is sealed, but finalization failed before the card moved: ${error.message} Retry the same ready card; its sealed result will be reused.`
        );
      }
    }
    const advanced = await applyRunOutcome(context.root, board.headers, board.records, task, recorded.result);
    return { recorded, advanced, committed, progress, closure, sampleCompletion };
  });

  const { recorded, advanced, committed, progress, closure, sampleCompletion } = outcome;
  // The card that finishes an event closes it. When product work was inverted to host-delegated
  // execution, this step stayed behind in the coordinator loop: the delegated path completed every
  // card and then told the coordinator to run a scheduling pass to "close the cycle", which cannot
  // close anything. So on the only path an owner actually uses, the canonical product record — the
  // issues, the tickets, the validation scenarios, the evidence, the whole workbook the model rests
  // on — was never written. Eight completed cards on the first real product, and every content tab
  // still empty.
  const team = describeTeam(role.id, "product");
  const lines = [
    recorded.result.status === "completed"
      ? `Recorded ${task.task_id} for ${team.name} and moved it to done. A completed result is sealed; submitting again returns the sealed record rather than replacing it.`
      : `Recorded a ${recorded.result.status} result for ${task.task_id} (${team.name}) and stopped the card with the producer's own reason. It is not sealed, so the work can be attempted again.`
  ];
  if (adoptionAssignment && recorded.result.status === "completed") {
    lines.push("The result remains a sourced adoption observation; no canonical product claim was written.");
  } else if (committed.written > 0) {
    lines.push(`${committed.written} row(s) went into the canonical record: ${committed.sheets.join(", ")}.`);
  } else if (recorded.result.status === "completed") {
    lines.push("This card recorded no canonical rows. That is right for a card whose output is analysis, and wrong for one that produced issues, a ticket, scenarios or evidence — those belong in the record, not only in the run file.");
  }
  if (!progress.complete) {
    lines.push(`${progress.remaining} of ${progress.total} card(s) for ${task.event_id} remain. Call product_ops_next_work for the next one.`);
  } else if (adoptionAssignment) {
    lines.push(`Every adoption card for ${task.event_id} is done. Observations are recorded at ${closure.reportFile}; owner review is waiting as ${closure.approvalRequestId}.`);
  } else if (sampleCompletion) {
    lines.push("The setup discovery sample is done. It is an orientation card, not a product event, so no cycle report was created.");
  } else {
    lines.push(`Every card for ${task.event_id} is done. The cycle report is written and the canonical workbook now carries this event's record: ${closure.workbook.written} row(s) across ${closure.workbook.sheets} tab(s).`);
  }

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
