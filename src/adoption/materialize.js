import crypto from "node:crypto";
import { loadConfig } from "../config.js";
import { INTAKE_STORE_FILE, SCHEMA_VERSION } from "../constants.js";
import { loadProductRuns } from "../autopilot/orchestrator.js";
import { ingestRecord } from "../runtime/intake.js";
import { readJsonOptional, utcTimestamp, writeJson } from "../runtime/io.js";
import { requestApproval } from "../runtime/approvals.js";
import { recordRoutedLineage } from "../runtime/coordination-record.js";
import { withControlPlaneLease } from "../runtime/control-plane-lease.js";
import { loadTaskboard, nextTaskId, replaceTaskboard } from "../runtime/taskboard.js";

const INDEX_FILE = ".product-ops/runtime/adoption/index.json";
const EMPTY_INDEX = { schemaVersion: SCHEMA_VERSION, runs: [] };

/**
 * Turn a mechanical repository survey into durable, role-owned cards.
 *
 * The survey itself must not interpret the application. Materialising it records only who must
 * read which paths and which question they must answer. The resulting work still passes through
 * next_work/submit_work, so observations keep producer identity and cannot become accepted product
 * claims merely because a scanner emitted them.
 */
export async function materializeAdoption(root, survey, { dryRun = true, now = new Date() } = {}) {
  const run = () => materialize(root, survey, { dryRun, now });
  return dryRun ? run() : withControlPlaneLease(root, run);
}

async function materialize(root, survey, { dryRun, now }) {
  const key = adoptionKey(survey);
  const index = await readJsonOptional(root, INDEX_FILE, EMPTY_INDEX);
  const existing = index.runs.find((candidate) => candidate.key === key);
  if (existing) return { ...existing, created: false, dryRun };

  const revisionLabel = survey.revision ?? key.slice(0, 12);
  const intakeInput = {
    type: "request",
    title: `Adopt linked application ${key.slice(0, 12)} at revision ${revisionLabel.slice(0, 12)}`,
    description: "Read the mechanically assigned repository paths and return sourced observations for owner review. Do not turn observations into accepted product claims.",
    source: `Mechanical adoption survey ${key} of ${survey.applicationRoot} at revision ${revisionLabel}`,
    priority: "P1",
    autopilotAuthorized: false
  };
  // The index is the final write. If a process stopped after intake or card creation, retrying must
  // repair that run rather than append a duplicate intake and a second set of cards.
  const intakeBefore = await readJsonOptional(root, INTAKE_STORE_FILE, { schemaVersion: SCHEMA_VERSION, records: [] });
  const recoveredIntake = intakeBefore.records.find((candidate) =>
    candidate.title === intakeInput.title && candidate.source === intakeInput.source && candidate.status !== "rejected");
  const intakeResult = recoveredIntake
    ? { record: recoveredIntake }
    : await ingestRecord(root, intakeInput, { dryRun, now });

  const config = await loadConfig(root);
  const board = await loadTaskboard(root);
  const tasks = board.records.map((task) => ({ ...task }));
  const timestamp = utcTimestamp(now);
  const directory = `.product-ops/runtime/adoption/${key}`;
  const surveyFile = `${directory}/survey.json`;
  const recoveredTasks = tasks.filter((task) => task.evidence_refs === surveyFile);
  if (recoveredTasks.length > 0 && recoveredTasks.length !== survey.assignments.length) {
    throw new Error(`Adoption recovery found ${recoveredTasks.length} of ${survey.assignments.length} cards for ${surveyFile}; refusing to duplicate or guess the missing cards.`);
  }
  const assignments = [];

  for (const [position, assignment] of survey.assignments.entries()) {
    const recoveredTask = recoveredTasks[position] ?? null;
    if (recoveredTask && recoveredTask.owner_role !== assignment.roleId) {
      throw new Error(`Adoption recovery expected ${assignment.roleId} but found ${recoveredTask.owner_role} on ${recoveredTask.task_id}.`);
    }
    const taskId = recoveredTask?.task_id ?? nextTaskId(config, tasks);
    const assignmentFile = recoveredTask?.canonical_output_refs || `${directory}/${taskId}-assignment.json`;
    const role = config.agents.find((candidate) => candidate.id === assignment.roleId);
    if (!role) throw new Error(`Adoption assignment names unconfigured role ${assignment.roleId}.`);
    const verifierRole = assignment.roleId === config.separation.independentVerifierRole
      ? config.separation.verificationOfVerifierRole ?? "RB-08"
      : config.separation.independentVerifierRole;
    const task = recoveredTask ?? {
      task_id: taskId,
      event_id: intakeResult.record.eventId,
      title: `Read the existing application as ${role.name}`,
      owner_role: assignment.roleId,
      owner_actor_id: role.actorId,
      status: "ready",
      priority: "P1",
      dependency_ids: "",
      blocked_reason: "",
      next_owner_role: "RB-01",
      unblock_condition: "",
      canonical_output_refs: assignmentFile,
      evidence_refs: surveyFile,
      handoff_id: "",
      independent_verifier_role: verifierRole,
      verifier_actor_id: actorFor(config, verifierRole),
      human_gate: "",
      due_at: "",
      updated_at: timestamp
    };
    if (!recoveredTask) tasks.push(task);
    assignments.push({ taskId, roleId: assignment.roleId, assignmentFile, question: assignment.question, paths: assignment.paths, pathCount: assignment.pathCount, truncated: assignment.truncated === true });
  }

  const record = {
    schemaVersion: SCHEMA_VERSION,
    key,
    applicationRoot: survey.applicationRoot,
    revision: survey.revision,
    eventId: intakeResult.record.eventId,
    intakeId: intakeResult.record.intakeId,
    surveyFile,
    assignments,
    createdAt: timestamp
  };
  if (!dryRun) {
    await writeJson(root, surveyFile, survey, { dryRun: false });
    for (const assignment of assignments) {
      await writeJson(root, assignment.assignmentFile, {
        schemaVersion: SCHEMA_VERSION,
        kind: "adoption_assignment",
        applicationRoot: survey.applicationRoot,
        revision: survey.revision,
        eventId: record.eventId,
        taskId: assignment.taskId,
        roleId: assignment.roleId,
        question: assignment.question,
        paths: assignment.paths,
        pathCount: assignment.pathCount,
        truncated: assignment.truncated,
        surveyFile
      }, { dryRun: false });
    }
    if (recoveredTasks.length === 0) await replaceTaskboard(root, board.headers, tasks, { dryRun: false });
    await recordRoutedLineage(root, config, { record: intakeResult.record, tasks: tasks.filter((task) => task.event_id === record.eventId), now: timestamp });
    const intakeStore = await readJsonOptional(root, INTAKE_STORE_FILE, { schemaVersion: SCHEMA_VERSION, records: [] });
    const accepted = intakeStore.records.map((candidate) => candidate.intakeId === record.intakeId ? { ...candidate, status: "accepted" } : candidate);
    await writeJson(root, INTAKE_STORE_FILE, { ...intakeStore, records: accepted }, { dryRun: false });
    await writeJson(root, INDEX_FILE, { ...index, runs: [...index.runs, record] }, { dryRun: false });
  }
  return { ...record, created: recoveredTasks.length === 0, dryRun };
}

export async function adoptionAssignmentForTask(root, taskId) {
  const index = await readJsonOptional(root, INDEX_FILE, EMPTY_INDEX);
  for (const run of index.runs) {
    const assignment = run.assignments.find((candidate) => candidate.taskId === taskId);
    if (!assignment) continue;
    return readJsonOptional(root, assignment.assignmentFile, null);
  }
  return null;
}

export async function closeAdoption(root, task, tasks, now = new Date()) {
  const index = await readJsonOptional(root, INDEX_FILE, EMPTY_INDEX);
  const run = index.runs.find((candidate) => candidate.eventId === task.event_id);
  if (!run) return null;
  const eventTasks = tasks.filter((candidate) => candidate.event_id === task.event_id);
  const observations = await loadProductRuns(root, eventTasks, "__after_all__");
  const reportFile = `.product-ops/runtime/adoption/${run.key}/observations.json`;
  await writeJson(root, reportFile, {
    schemaVersion: SCHEMA_VERSION,
    kind: "adoption_observations",
    eventId: run.eventId,
    applicationRoot: run.applicationRoot,
    revision: run.revision,
    // This report is immutable task evidence. Name the state as a completion-time snapshot so an
    // approval recorded later does not make the artifact look like a stale source of live state.
    // The approval store remains the canonical place to read the current review disposition.
    statusAtCompletion: "awaiting_owner_review",
    observations,
    completedAt: utcTimestamp(now)
  }, { dryRun: false });
  const approval = await requestApproval(root, {
    taskId: task.task_id,
    gate: "adoption_observations_review",
    question: "Accept these sourced observations as the starting context for this product workspace?",
    context: "Acceptance records the owner's decision about the observations; it does not authorize implementation or production changes.",
    evidenceRefs: [run.surveyFile, reportFile],
    risks: ["Repository reading can reveal contradictions or missing context; accepted observations may still need later correction."]
  }, { dryRun: false, now });
  return { reportFile, approvalRequestId: approval.request.requestId };
}

function adoptionKey(survey) {
  const stable = JSON.stringify({
    applicationRoot: survey.applicationRoot,
    revision: survey.revision,
    assignments: survey.assignments.map(({ roleId, question, paths, pathCount, truncated }) => ({ roleId, question, paths, pathCount, truncated }))
  });
  return crypto.createHash("sha256").update(stable).digest("hex").slice(0, 24);
}

function actorFor(config, roleId) {
  return config.agents.find((candidate) => candidate.id === roleId)?.actorId ?? "";
}
