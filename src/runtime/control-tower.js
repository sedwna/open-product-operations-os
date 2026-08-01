import { INTAKE_STORE_FILE, SCHEMA_VERSION } from "../constants.js";
import { loadApprovals, requestApproval } from "./approvals.js";
import { runDevelopmentTask } from "./development-runner.js";
import { readJsonOptional, utcTimestamp, writeJson } from "./io.js";
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
    const route = config.routing.find((candidate) => candidate.event === record.type) ??
      config.routing.find((candidate) => candidate.event === "new_idea");
    if (!route) {
      actions.push({ type: "route_intake", intakeId: record.intakeId, eventId: record.eventId, ownerRole: "RB-01", output: "events", status: "blocked" });
      continue;
    }
    const existing = tasks.filter((task) => task.event_id === record.eventId);
    if (existing.length === 0) {
      let dependencyId = "";
      for (const step of route.steps ?? fallbackSteps(route)) {
        const taskId = nextTaskId(config, tasks);
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
          status: dependencyId ? "backlog" : "ready",
          priority: record.priority,
          dependency_ids: dependencyId,
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
        dependencyId = taskId;
        actions.push({ type: "create_task", taskId, eventId: record.eventId, ownerRole: step.role });
      }
      taskboardChanged = true;
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
        await requestApproval(root, {
          taskId: task.task_id,
          gate: task.human_gate,
          question: `Authorize gate ${task.human_gate} for task ${task.task_id}?`,
          context: task.title,
          evidenceRefs: task.evidence_refs ? task.evidence_refs.split("|").filter(Boolean) : [],
          risks: task.blocked_reason ? [task.blocked_reason] : []
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
  const receipt = {
    schemaVersion: SCHEMA_VERSION,
    runId,
    kind: "control_plane",
    dryRun,
    actions,
    createdAt: utcTimestamp(now)
  };
  if (!dryRun) {
    await writeJson(root, `.product-ops/runtime/control-plane/${runId}.json`, receipt, { dryRun: false });
  }
  return receipt;
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
