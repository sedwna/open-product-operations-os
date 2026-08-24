import { INTAKE_STORE_FILE, SCHEMA_VERSION } from "../constants.js";
import { loadApprovals, requestApproval } from "./approvals.js";
import { readAutomationLink } from "../autopilot/state.js";
import { runDevelopmentTask } from "./development-runner.js";
import { readJsonOptional, utcTimestamp, writeJson } from "./io.js";
import { withControlPlaneLease } from "./control-plane-lease.js";
import { recordRoutedLineage } from "./coordination-record.js";
import { decisionProposalForGate } from "./gate-proposal.js";

/**
 * Which route an intake type takes when no route is named for it directly.
 *
 * Three of the five things an owner can submit had no route of their own and fell through to
 * `new_idea`, so an incident — something already broken in a live product — was sent through idea
 * triage, discovery research and a decision brief before anyone looked at it. An incident and a
 * user finding are the same shape of work: something is wrong, work out what and fix it. Feedback
 * and a request genuinely are new ideas, and now say so rather than arriving there by default.
 */
const INTAKE_ROUTE_EQUIVALENT = Object.freeze({
  incident: "user_finding",
  feedback: "new_idea",
  request: "new_idea"
});
import {
  dependencyState,
  loadTaskboard,
  nextTaskId,
  replaceTaskboard,
  selectRunnableTasks
} from "./taskboard.js";

export async function runControlTower(
  root,
  config,
  { dryRun = true, executeDevelopment = false, now = new Date() } = {}
) {
  // One scheduling cycle reads the board, the approvals, and the intake store, then writes all
  // three. Holding the lease across the whole sequence is what makes it a transaction; guarding
  // only the individual writes would let a concurrent surface interleave between read and write.
  return dryRun
    ? controlTowerCycle(root, config, { dryRun, executeDevelopment, now })
    : withControlPlaneLease(root, () => controlTowerCycle(root, config, { dryRun, executeDevelopment, now }));
}

async function controlTowerCycle(
  root,
  config,
  { dryRun, executeDevelopment, now }
) {
  const [{ headers, records: loadedTasks }, approvalStore, intakeStore] = await Promise.all([
    loadTaskboard(root),
    loadApprovals(root),
    readJsonOptional(root, ".product-ops/runtime/intake.json", { records: [] })
  ]);
  const tasks = loadedTasks.map((task) => ({ ...task }));
  const actions = [];
  let taskboardChanged = false;
  let intakeChanged = false;
  const timestamp = utcTimestamp(now);

  for (const task of tasks) {
    if (task.status !== "backlog") continue;
    const byId = new Map(tasks.map((candidate) => [candidate.task_id, candidate]));
    if (dependencyState(task, byId).satisfied) {
      task.status = "ready";
      task.updated_at = timestamp;
      taskboardChanged = true;
      actions.push({ type: "promote_task", taskId: task.task_id, status: "ready" });
    }
  }

  for (const record of (intakeStore.records ?? []).filter((entry) => entry.status === "proposed")) {
    const route = config.routing.find((candidate) => candidate.event === record.type)
      ?? config.routing.find((candidate) => candidate.event === INTAKE_ROUTE_EQUIVALENT[record.type])
      ?? config.routing.find((candidate) => candidate.event === "new_idea");
    if (!route) {
      actions.push({ type: "route_intake", intakeId: record.intakeId, eventId: record.eventId, ownerRole: "RB-01", output: "events", status: "blocked" });
      continue;
    }
    const existing = tasks.filter((task) => task.event_id === record.eventId);
    if (existing.length === 0) {
      const steps = route.steps ?? fallbackSteps(route);
      const idByKey = new Map();
      const createdIds = [];
      for (const [index, step] of steps.entries()) {
        const taskId = nextTaskId(config, tasks);
        const dependencies = stepDependencies(step, index, idByKey, createdIds);
        const verifierRole =
          step.role === config.separation.independentVerifierRole
            ? config.separation.verificationOfVerifierRole ?? "RB-08"
            : config.separation.independentVerifierRole;
        const task = {
          task_id: taskId,
          event_id: record.eventId,
          title: step.title,
          owner_role: step.role,
          owner_actor_id: actorFor(config, step.role),
          status: dependencies.length > 0 ? "backlog" : "ready",
          priority: record.priority,
          dependency_ids: dependencies.join("|"),
          blocked_reason: "",
          next_owner_role: "",
          unblock_condition: "",
          canonical_output_refs: "",
          evidence_refs: "",
          handoff_id: "",
          independent_verifier_role: verifierRole,
          verifier_actor_id: actorFor(config, verifierRole),
          human_gate: step.humanGate ?? "",
          due_at: "",
          updated_at: timestamp
        };
        tasks.push(task);
        createdIds.push(taskId);
        if (step.key) idByKey.set(step.key, taskId);
        actions.push({ type: "create_task", taskId, eventId: record.eventId, ownerRole: step.role });
      }
      taskboardChanged = true;
      // The coordination boundary writes its hand-off chain down as it lays it, rather than leaving
      // it to be reconstructed later from cards that may since have been edited. The event row
      // itself is not written here: the controlled writer owns that, and two authorities for one
      // canonical row is how a record stops being trustworthy.
      if (!dryRun) {
        const routed = tasks.filter((task) => task.event_id === record.eventId);
        await recordRoutedLineage(root, config, { record, tasks: routed, now: timestamp });
        actions.push({ type: "record_lineage", eventId: record.eventId, ownerRole: "RB-01" });
      }
    }
    record.status = "accepted";
    intakeChanged = true;
    actions.push({ type: "route_intake", intakeId: record.intakeId, eventId: record.eventId, ownerRole: route.owner, output: route.output });
  }

  if (!dryRun && taskboardChanged) {
    await replaceTaskboard(root, headers, tasks, { dryRun: false });
  }
  if (!dryRun && intakeChanged) {
    await writeJson(root, INTAKE_STORE_FILE, intakeStore, { dryRun: false });
  }

  for (const task of tasks.filter((candidate) => candidate.status === "ready" && candidate.human_gate)) {
    const existing = approvalStore.requests.find(
      (request) => request.taskId === task.task_id && request.gate === task.human_gate
    );
    if (!existing) {
      actions.push({ type: "request_human_approval", taskId: task.task_id, gate: task.human_gate });
      if (!dryRun) {
        const proposal = await decisionProposalForGate(root, tasks, task);
        await requestApproval(root, {
          taskId: task.task_id,
          gate: task.human_gate,
          question: proposal?.question ?? `Authorize gate ${task.human_gate} for task ${task.task_id}?`,
          context: proposal?.context ?? task.title,
          options: proposal?.options ?? ["approved", "rejected"],
          recommendedOption: proposal?.recommendedOption ?? null,
          recommendationRationale: proposal?.recommendationRationale ?? "",
          optionImpacts: proposal?.optionImpacts ?? {},
          evidenceRefs: task.evidence_refs ? task.evidence_refs.split("|").filter(Boolean) : [],
          risks: task.blocked_reason ? [task.blocked_reason] : []
        }, { dryRun: false, now });
      }
    }
  }
  // Reaching engineering with nowhere to send the work is a decision, not a dead end. The board
  // used to stop here and report a boundary, leaving the owner to already know that an application
  // repository must exist, that `development-os init` writes the engineering boundaries into it,
  // and that `link` connects the two — and then to ask for all three. A gate states what would be
  // created and waits, like every other decision that is theirs.
  //
  // Creating the repository is not authorising agents to work inside it. That stays a later,
  // separate decision, and this gate says so rather than quietly bundling them.
  const bridgeTasks = tasks.filter((task) =>
    task.status === "ready" && task.owner_role === config.separation.developmentRole && !task.human_gate);
  if (bridgeTasks.length > 0 && !(await hasLinkedApplication(root))) {
    for (const task of bridgeTasks) {
      const gate = "development_boundary_crossing";
      const already = approvalStore.requests.find(
        (request) => request.taskId === task.task_id && request.gate === gate
      );
      if (already) continue;
      actions.push({ type: "request_human_approval", taskId: task.task_id, gate });
      if (!dryRun) {
        await requestApproval(root, {
          taskId: task.task_id,
          gate,
          question: "The work has reached engineering and no Development root is connected. Create or connect the canonical development/ root?",
          context: [
            `The standard layout keeps this Product root and a sibling development/ root in one GitHub repository.`,
            "The Development root contains fifteen engineering boundaries, its own workstream board, quality gates, application code, and technical evidence.",
            "It does not let any agent write code there. Enabling the engineering executors is a separate decision, asked later.",
            `Rejecting leaves ${task.task_id} waiting; the product side can continue, but nothing crosses into implementation.`
          ].join(" "),
          options: ["approved", "rejected"],
          recommendedOption: "approved",
          recommendationRationale: "This is the bounded route that creates the missing engineering boundary without authorising implementation or production writes.",
          optionImpacts: {
            approved: "Create or connect the independent development/ root; implementation remains separately gated.",
            rejected: `Leave ${task.task_id} waiting before engineering.`
          },
          risks: [
            "Relocating an existing application or adding a namespace to it remains a separate, history-preserving action.",
            "No code is written and no agent is authorised by this decision alone."
          ]
        }, { dryRun: false, now });
      }
    }
  }

  const effectiveApprovals = dryRun ? approvalStore.requests : (await loadApprovals(root)).requests;
  for (const task of selectRunnableTasks(tasks, effectiveApprovals)) {
    const action = {
      type: "dispatch_task",
      taskId: task.task_id,
      ownerRole: task.owner_role,
      ownerActorId: task.owner_actor_id,
      developmentExecution: false
    };
    if (task.owner_role === config.separation.developmentRole) {
      if (executeDevelopment) {
        try {
          const result = await runDevelopmentTask(root, config, task.task_id, { dryRun, now });
          action.developmentExecution = true;
          action.resultFile = result.resultFile;
          if (!dryRun) {
            task.status = result.result?.status === "implementation_complete" ? "in_review" : "blocked";
            task.blocked_reason = result.result?.status === "implementation_complete" ? "" : result.result?.notes ?? "Development did not complete.";
            task.updated_at = timestamp;
            taskboardChanged = true;
          }
        } catch (error) {
          action.developmentExecution = false;
          action.status = "blocked";
          action.error = String(error.message).slice(0, 500);
        }
      } else {
        action.nextAction = "Run the development command with explicit execution authorization.";
      }
    }
    actions.push(action);
  }
  if (!dryRun && taskboardChanged) {
    await replaceTaskboard(root, headers, tasks, { dryRun: false });
  }
  const runId = `CTR-${utcTimestamp(now).replace(/[-:.TZ]/g, "")}`;
  // A cycle routes and promotes; it does not perform. `dispatch_task` means a card is runnable, not
  // that anyone ran it, and without that distinction a surface can report a successful cycle for the
  // hundredth time while the board has not moved since the first. Saying how much the cycle actually
  // changed, and how much is merely waiting for a performer, is what lets a caller tell those apart.
  const advanced = actions.filter((action) => action.type !== "dispatch_task").length;
  const receipt = {
    schemaVersion: SCHEMA_VERSION,
    runId,
    kind: "control_plane",
    dryRun,
    actions,
    advanced,
    awaitingPerformer: actions.filter((action) => action.type === "dispatch_task").length,
    createdAt: utcTimestamp(now)
  };
  if (!dryRun) {
    await writeJson(root, `.product-ops/runtime/control-plane/${runId}.json`, receipt, { dryRun: false });
  }
  return receipt;
}

/**
 * What a routed step waits on.
 *
 * A step that declares `after` waits on exactly the steps it names, so work that shares a
 * predecessor runs together instead of queueing behind whichever one happened to be written first.
 * A step that declares nothing waits on the step before it, which is how every route behaved before
 * keys existed and how a route written without them still behaves.
 *
 * An unresolved key is treated as the conservative case — wait for the previous step — rather than
 * as no dependency at all. A typo must never make work start earlier than intended; configuration
 * validation reports it separately.
 */
function stepDependencies(step, index, idByKey, createdIds) {
  const previous = index === 0 ? [] : [createdIds[index - 1]];
  if (!Array.isArray(step.after)) return previous;
  const resolved = step.after.map((key) => idByKey.get(key));
  if (resolved.some((id) => !id)) return previous;
  return [...new Set(resolved)];
}

function fallbackSteps(route) {
  return [route.owner, ...route.reviewers].map((role) => ({
    role,
    title: `Process ${route.event} as ${role}`,
    humanGate: ""
  }));
}

function actorFor(config, role) {
  return config.agents.find((agent) => agent.id === role)?.actorId ?? "";
}

/**
 * Whether an application repository is connected and still resolvable.
 *
 * `readAutomationLink` throws when the link names a directory that has gone or has no Development
 * OS configuration, which is the same answer as never having linked one for this purpose: there is
 * nowhere to send engineering work.
 */
async function hasLinkedApplication(root) {
  try {
    return Boolean((await readAutomationLink(root)).applicationRoot);
  } catch {
    return false;
  }
}
