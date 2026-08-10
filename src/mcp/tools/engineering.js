import fs from "node:fs/promises";
import path from "node:path";
import { runEngineeringWorkstream, submittedWorkstreamResult } from "../../development/runner.js";
import { loadDevelopmentConfig } from "../../development/config.js";
import { readAutomationLink } from "../../autopilot/state.js";
import { closeEngineeringDelivery, cycleBranch, openEngineeringDelivery } from "../../autopilot/engineering.js";
import { loadProductRuns, recordEngineeringProductRun } from "../../autopilot/orchestrator.js";
import { applyRunOutcome } from "../../autopilot/cycle.js";
import { loadConfig } from "../../config.js";
import { INTAKE_STORE_FILE } from "../../constants.js";
import { readJsonOptional } from "../../runtime/io.js";
import { loadApprovals } from "../../runtime/approvals.js";
import { loadTaskboard } from "../../runtime/taskboard.js";
import { toPosixPath } from "../../paths.js";
import { withControlPlaneLease } from "../../runtime/control-plane-lease.js";
import { describeTeam } from "../app/teams.js";
import { ToolFailure } from "../authority.js";
import { untrusted } from "../untrusted.js";

/**
 * The engineering half of host-delegated execution.
 *
 * The product half was inverted first: the host asks for work, delegates it to a subagent, and
 * returns the result. Engineering was left on the older model, where a configured CLI is spawned to
 * do the work — so a product could be driven all the way to an approved delivery contract and then
 * stop, because no executable was installed. Two halves of one system running on two execution
 * models, and the half that mattered depended on exactly the provider machinery the other half had
 * retired.
 *
 * These are the mirror of `next_work` and `submit_work`, pointed at the linked application. The
 * boundary between the two repositories is unchanged: it was never the executor, it is the hashed
 * contract, and that still governs what crosses.
 */

export async function nextEngineeringWork(context) {
  const application = await linkedApplication(context.root);
  const { plan, planId } = await findActivePlan(application);
  if (!plan) {
    return {
      structuredContent: { available: false, reason: "no_plan" },
      text: "No engineering plan exists yet. A plan appears once an approved delivery contract is exported across the boundary; until then engineering has nothing to carry."
    };
  }

  const completed = await completedWorkstreams(application, planId);
  const ready = plan.workstreams.filter((workstream) =>
    !completed.has(workstream.id)
    && (workstream.dependencies ?? []).every((dependency) => completed.has(dependency)));

  if (ready.length === 0) {
    const remaining = plan.workstreams.filter((workstream) => !completed.has(workstream.id));
    return {
      structuredContent: {
        available: false,
        reason: remaining.length === 0 ? "all_complete" : "awaiting_dependencies",
        planId,
        remaining: remaining.length
      },
      text: remaining.length === 0
        ? `Every workstream in ${planId} is complete. The sealed result returns to the product side for quality, verification and readiness.`
        : `${remaining.length} workstream(s) remain in ${planId}, each waiting on one that has not finished. Nothing is ready to hand out.`
    };
  }

  // Independent verification goes last on purpose: ENG-15 reproduces the others' claims, and there
  // is nothing to reproduce until they have made them.
  const workstream = ready.find((candidate) => candidate.ownerRole !== "ENG-15") ?? ready[0];
  const preview = await runEngineeringWorkstream(application, planId, workstream.id, {
    dryRun: true,
    execute: submittedWorkstreamResult(null)
  });
  const config = await loadDevelopmentConfig(application);
  const team = describeTeam(workstream.ownerRole, "engineering");

  return {
    structuredContent: {
      available: true,
      claimToken: context.claimToken({
        task_id: workstream.id,
        event_id: planId,
        owner_role: workstream.ownerRole,
        status: workstream.status ?? "ready"
      }),
      applicationRoot: reportablePath(application),
      planId,
      workstreamId: workstream.id,
      team: team.name,
      teamFocus: team.focus,
      ownerRole: workstream.ownerRole,
      producerActorId: config.roles.find((role) => role.id === workstream.ownerRole)?.actorId ?? null,
      title: untrusted(workstream.title, { source: "engineering-plan", id: workstream.id }),
      writeBoundary: preview.payload.writeBoundary,
      policy: preview.payload.policy,
      brief: preview.payload
    },
    text: [
      `Next engineering work: ${workstream.id} — ${team.name}, in ${reportablePath(application)}.`,
      `That team's job is ${team.focus}.`,
      "",
      "Delegate this to a subagent working in the application repository. It may write only inside the contract's writeBoundary; the prohibited paths in the policy are refused outright, and the engineering operating model's own files are never application code.",
      workstream.ownerRole === "ENG-15"
        ? "This is independent verification: reproduce the material claims and change nothing. The repository is hashed before and after, and any modification voids the verification."
        : "Only ENG-15 issues a verification disposition; set yours to not_applicable.",
      "Return the result through product_ops_submit_engineering_work with this claimToken."
    ].join("\n")
  };
}

export async function submitEngineeringWork(context, args = {}) {
  if (args.apply === true && context.allowWrites !== true) {
    throw new ToolFailure("APPLY_NOT_AUTHORIZED", "This server was started without write authorisation.");
  }
  const application = await linkedApplication(context.root);
  const { plan, planId } = await findActivePlan(application);
  if (!plan) throw new ToolFailure("NOT_FOUND", "No engineering plan exists to submit against.");

  const workstream = plan.workstreams.find((candidate) => candidate.id === args.workstreamId);
  if (!workstream) throw new ToolFailure("NOT_FOUND", `No workstream ${args.workstreamId} in ${planId}.`);

  if (!context.verifyClaimToken({
    task_id: workstream.id,
    event_id: planId,
    owner_role: workstream.ownerRole,
    status: workstream.status ?? "ready"
  }, args.claimToken)) {
    throw new ToolFailure("CLAIM_INVALID", "That claim token does not match this workstream. Take the work with product_ops_next_engineering_work and submit against what it hands out.");
  }

  const team = describeTeam(workstream.ownerRole, "engineering");
  if (args.apply !== true) {
    return {
      structuredContent: { applied: false, planId, workstreamId: workstream.id, team: team.name, status: args.result?.status ?? null },
      text: `Planned: would record a ${args.result?.status ?? "?"} result for ${workstream.id} as ${team.name}. Nothing was written; call again with apply true to record it.`
    };
  }

  let recorded;
  try {
    recorded = await runEngineeringWorkstream(application, planId, workstream.id, {
      dryRun: false,
      execute: submittedWorkstreamResult(args.result)
    });
  } catch (error) {
    throw new ToolFailure("RESULT_REJECTED", `The submitted engineering result was refused: ${error.message}`);
  }

  return {
    structuredContent: {
      applied: true,
      planId,
      workstreamId: workstream.id,
      team: team.name,
      ownerRole: workstream.ownerRole,
      status: recorded.result.status,
      verificationDisposition: recorded.result.verificationDisposition,
      resultFile: recorded.resultFile,
      sealed: recorded.result.status === "completed"
    },
    text: recorded.result.status === "completed"
      ? `Recorded and sealed ${workstream.id} for ${team.name}. Call product_ops_next_engineering_work for the next one.`
      : `Recorded a ${recorded.result.status} result for ${workstream.id} (${team.name}). It is not sealed, so the work can be attempted again.`
  };
}

async function linkedApplication(root) {
  let link;
  try {
    link = await readAutomationLink(root);
  } catch (error) {
    throw new ToolFailure("NO_LINKED_APPLICATION", `This workspace has no usable application repository: ${error.message}`);
  }
  if (!link?.applicationRoot) {
    throw new ToolFailure("NO_LINKED_APPLICATION", "This workspace has no linked application, so there is no engineering side to carry work.");
  }
  return path.resolve(link.applicationRoot);
}

/**
 * A path as it should be handed to whoever performs the work.
 *
 * Forward slashes even on Windows. This value is read by a subagent, pasted into a shell, or
 * interpolated into a tool call, and a backslash survives none of those reliably — it is an escape
 * character almost everywhere it lands, so `D:\Projects\app` arrives as `D:Projectsapp`. Node, Git
 * and PowerShell all accept the forward-slash form, and nothing eats it silently.
 */
function reportablePath(value) {
  return toPosixPath(value);
}

/** The most recent plan on disk. One request is in flight at a time by design. */
async function findActivePlan(application) {
  const directory = path.join(application, ".development-os", "plans");
  let entries;
  try {
    entries = (await fs.readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if (error.code === "ENOENT") return { plan: null, planId: null };
    throw error;
  }
  if (entries.length === 0) return { plan: null, planId: null };
  const planId = entries.at(-1).replace(/\.json$/, "");
  const plan = JSON.parse(await fs.readFile(path.join(directory, entries.at(-1)), "utf8"));
  return { plan, planId };
}

/** A workstream counts as complete only when its sealed result says so. */
async function completedWorkstreams(application, planId) {
  const directory = path.join(application, ".development-os", "runs");
  const done = new Set();
  let entries;
  try {
    entries = await fs.readdir(directory);
  } catch (error) {
    if (error.code === "ENOENT") return done;
    throw error;
  }
  for (const name of entries) {
    if (!name.startsWith(`${planId}-`) || !name.endsWith("-result.json") || name.includes("-attempt-")) continue;
    try {
      const result = JSON.parse(await fs.readFile(path.join(directory, name), "utf8"));
      if (result.status === "completed" && result.workstreamId) done.add(result.workstreamId);
    } catch {
      // An unreadable or half-written run is not evidence of completion.
    }
  }
  return done;
}

/**
 * The crossing itself.
 *
 * Exporting an approved delivery contract to the engineering repository, and importing the result
 * back, were deliberately kept out of the model-reachable surface: they cross the
 * Product/Development authority line, and that deserved its own review before a model could reach
 * it. The review has happened, and the answer is that the line is not crossed by whoever runs the
 * command. It is crossed by the owner settling the `development-export` gate, and what carries
 * across is the hashed contract with its `sourceDigest`, which the engineering side verifies
 * against. Neither of those changes with the caller.
 *
 * Keeping the commands on the command line did not protect the boundary. It only meant the owner
 * had to open a terminal at the exact moment they had just authorised the crossing — the one thing
 * this surface exists to make unnecessary.
 */
export async function openDelivery(context, args = {}) {
  const apply = args.apply === true;
  if (apply && context.allowWrites !== true) {
    throw new ToolFailure("APPLY_NOT_AUTHORIZED", "This server was started without write authorisation.");
  }
  const application = await linkedApplication(context.root);
  const config = await loadConfig(context.root);
  const { headers, records: tasks } = await loadTaskboard(context.root);
  const task = boundaryTask(tasks, config);
  if (!task) {
    return {
      structuredContent: { available: false, reason: "nothing_at_the_boundary" },
      text: "No card is waiting at the engineering boundary. Either the product side has not reached a delivery hand-off, or the last one has already crossed."
    };
  }

  const approvals = await loadApprovals(context.root);
  const gate = approvals.requests.find((request) =>
    request.taskId === task.task_id && request.gate === "development-export");
  if (!apply) {
    return {
      structuredContent: {
        applied: false,
        taskId: task.task_id,
        eventId: task.event_id,
        applicationRoot: reportablePath(application),
        gate: gate ? { requestId: gate.requestId, status: gate.status } : null
      },
      text: [
        `Planned: would build the delivery contract for ${task.task_id}, export it to ${reportablePath(application)}, and plan it into engineering workstreams.`,
        gate?.status === "approved"
          ? "The owner has settled the development-export gate, so applying will cross."
          : "The development-export gate is not settled. Applying opens it and stops there; whether the work crosses is the owner's call.",
        "Nothing has been written."
      ].join("\n")
    };
  }

  // The delivery contract states the problem in the owner's words, and those live on the intake
  // record. Without one there is nothing to state, and a contract with an invented problem is worse
  // than no contract at all.
  const intake = await intakeFor(context.root, task.event_id);
  if (!intake) {
    throw new ToolFailure(
      "NOT_FOUND",
      `${task.task_id} is at the engineering boundary but its event ${task.event_id} has no intake record, so there is no problem statement to send across. Record the event with product_ops_intake first.`
    );
  }
  const eventTasks = tasks.filter((candidate) => candidate.event_id === task.event_id);
  const productRuns = await loadProductRuns(context.root, eventTasks, task.task_id);
  const opened = await openEngineeringDelivery(context.root, application, config, task, {
    intake,
    productRuns,
    cycleId: task.event_id,
    autoApprove: false
  });

  if (opened.status === "waiting_for_human") {
    return {
      structuredContent: {
        applied: false,
        reason: "waiting_on_owner",
        taskId: task.task_id,
        requestId: opened.approval.requestId,
        gate: "development-export"
      },
      text: [
        `The delivery contract for ${task.task_id} is ready and the crossing is waiting on the product owner.`,
        "Read product_ops_pending_decisions and put the gate to them. Nothing crossed.",
        "Do not settle it yourself, and do not send them to a terminal — the panel composer and this conversation both take the answer."
      ].join("\n")
    };
  }

  if (opened.status === "implementation_complete") {
    return recordDeliveryReturn(context, { config, headers, tasks, task, delivery: opened, resumed: true });
  }

  const remaining = opened.plan.workstreams.filter((workstream) => !opened.runs.has(workstream.id));
  return {
    structuredContent: {
      applied: true,
      taskId: task.task_id,
      eventId: task.event_id,
      applicationRoot: reportablePath(application),
      requestId: opened.request.requestId,
      planId: opened.plan.planId,
      sourceDigest: opened.plan.sourceDigest,
      branch: opened.branch,
      workstreams: opened.plan.workstreams.length,
      alreadyComplete: opened.runs.size,
      remaining: remaining.length,
      superseded: opened.superseded === true
    },
    text: [
      opened.superseded
        ? `A contract for ${opened.request.requestId} was already in the outbox with different contents and nothing had been built against it, so it was replaced. Any plan or brief taken from the previous one is void.`
        : "",
      `The delivery crossed. ${opened.request.requestId} is planned as ${opened.plan.planId} with ${opened.plan.workstreams.length} workstream(s); ${remaining.length} remain.`,
      `Engineering works on branch ${opened.branch} in ${reportablePath(application)}.`,
      "",
      "Now drive the engineering half: product_ops_next_engineering_work hands out one workstream, you delegate it to a subagent working in that repository, and product_ops_submit_engineering_work takes the result back. Repeat until it reports every workstream complete.",
      "Then call product_ops_close_delivery to seal the runs, gather quality-gate evidence, and bring the result back to the product board."
    ].join("\n")
  };
}

/**
 * Bring the finished work back across.
 *
 * Everything the boundary requires happens here, and none of it depends on who performed the work:
 * something must actually have been built, it must sit inside the write boundary the contract set,
 * the runs are sealed against the implementation digest, quality-gate evidence is produced, and the
 * result returns as a product record for the product side to verify independently.
 */
export async function closeDelivery(context, args = {}) {
  const apply = args.apply === true;
  if (apply && context.allowWrites !== true) {
    throw new ToolFailure("APPLY_NOT_AUTHORIZED", "This server was started without write authorisation.");
  }
  const application = await linkedApplication(context.root);
  const config = await loadConfig(context.root);
  const { headers, records: tasks } = await loadTaskboard(context.root);
  const task = boundaryTask(tasks, config);
  if (!task) throw new ToolFailure("NOT_FOUND", "No delivery is open at the engineering boundary.");

  const { plan, planId } = await findActivePlan(application);
  if (!plan) throw new ToolFailure("NOT_FOUND", "No engineering plan exists. Open the delivery first with product_ops_open_delivery.");
  const completed = await completedWorkstreams(application, planId);
  const outstanding = plan.workstreams.filter((workstream) => !completed.has(workstream.id));
  if (outstanding.length > 0) {
    throw new ToolFailure(
      "WORK_INCOMPLETE",
      `${outstanding.length} workstream(s) in ${planId} have no sealed result: ${outstanding.map((workstream) => workstream.id).join(", ")}. A delivery does not close over work that was never done.`
    );
  }

  if (!apply) {
    return {
      structuredContent: { applied: false, taskId: task.task_id, planId, workstreams: plan.workstreams.length },
      text: `Planned: would seal ${plan.workstreams.length} completed workstream(s) in ${planId}, produce quality-gate evidence, and return the result to ${task.task_id}. Nothing has been written.`
    };
  }

  const developmentConfig = await loadDevelopmentConfig(application);
  const request = await storedRequest(application, developmentConfig, plan.requestId);
  const runs = await sealedRunResults(application, planId, plan);
  let delivery;
  try {
    delivery = await closeEngineeringDelivery(context.root, application, {
      request,
      plan,
      requestDigest: plan.sourceDigest,
      developmentConfig,
      runs,
      branch: cycleBranch(task.event_id),
      cycleId: task.event_id
    });
  } catch (error) {
    throw new ToolFailure("DELIVERY_NOT_CLOSEABLE", `The delivery could not be closed: ${error.message}`);
  }
  return recordDeliveryReturn(context, { config, headers, tasks, task, delivery, resumed: false });
}

function boundaryTask(tasks, config) {
  return tasks.find((candidate) =>
    candidate.owner_role === config.separation.developmentRole
    && ["ready", "in_progress"].includes(candidate.status));
}

/** The engineering return, written into the product board as that role's completed run. */
async function recordDeliveryReturn(context, { config, headers, tasks, task, delivery, resumed }) {
  const now = new Date();
  const run = await recordEngineeringProductRun(context.root, config, task, delivery, now);
  await withControlPlaneLease(context.root, () =>
    applyRunOutcome(context.root, headers, tasks, task, run, { now }));
  return {
    structuredContent: {
      applied: true,
      resumed,
      taskId: task.task_id,
      eventId: task.event_id,
      changedComponents: delivery.changedComponents,
      evidence: delivery.productEvidenceRefs ?? [],
      resultId: delivery.result?.resultId ?? null
    },
    text: [
      resumed
        ? "A completed engineering result was already waiting, so it was imported rather than rebuilt."
        : `The delivery closed. ${delivery.changedComponents.length} component(s) changed and the evidence came back with it.`,
      `${task.task_id} is done. The product side takes it from here — QA, independent verification and readiness are product claims, and engineering does not make them.`,
      "Call product_ops_next_work for what comes next."
    ].join("\n")
  };
}

async function intakeFor(root, eventId) {
  const store = await readJsonOptional(root, INTAKE_STORE_FILE, { records: [] });
  return (store.records ?? []).find((record) => record.eventId === eventId) ?? null;
}

async function storedRequest(application, developmentConfig, requestId) {
  const file = path.join(application, developmentConfig.sync.inbox, `${requestId}.json`);
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    throw new ToolFailure("NOT_FOUND", `The exported delivery contract ${requestId} is not in the engineering inbox: ${error.message}`);
  }
}

/** The sealed result for each workstream, keyed the way the closing phase expects. */
async function sealedRunResults(application, planId, plan) {
  const runs = new Map();
  for (const workstream of plan.workstreams) {
    const file = path.join(application, ".development-os", "runs", `${planId}-${workstream.id}-result.json`);
    runs.set(workstream.id, JSON.parse(await fs.readFile(file, "utf8")));
  }
  return runs;
}
