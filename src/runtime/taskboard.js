import { TASKBOARD_FILE } from "../constants.js";
import { readCsvRecords, splitReferences } from "./io.js";
import { stringifyCsv } from "../csv.js";
import { applyWrites, planWrites } from "../file-writer.js";

export async function loadTaskboard(root) {
  const parsed = await readCsvRecords(root, TASKBOARD_FILE);
  const byId = new Map(parsed.records.map((task) => [task.task_id, task]));
  return { ...parsed, byId };
}

export function visibleTaskboardRecords(records) {
  const hasRealCycle = records.some((task) => task.event_id !== "EVT-00000000-001");
  if (!hasRealCycle) return records;
  return records.filter((task) => !(
    task.event_id === "EVT-00000000-001"
    && task.title === "Complete the first discovery record"
  ));
}

export function taskDependencies(task) {
  return splitReferences(task.dependency_ids);
}

export function dependencyState(task, byId) {
  const dependencies = taskDependencies(task);
  const missing = dependencies.filter((id) => !byId.has(id));
  const incomplete = dependencies.filter(
    (id) => byId.has(id) && byId.get(id).status !== "done"
  );
  return { dependencies, missing, incomplete, satisfied: missing.length === 0 && incomplete.length === 0 };
}

export function selectRunnableTasks(tasks, approvals = []) {
  const byId = new Map(tasks.map((task) => [task.task_id, task]));
  return tasks.filter((task) => {
    if (task.status !== "ready") {
      return false;
    }
    if (!dependencyState(task, byId).satisfied) {
      return false;
    }
    if (!task.human_gate) {
      return true;
    }
    return approvals.some(
      (request) =>
        request.taskId === task.task_id &&
        request.gate === task.human_gate &&
        request.status === "approved"
    );
  });
}

export async function replaceTaskboard(root, headers, records, { dryRun = true } = {}) {
  const rows = [headers, ...records.map((record) => headers.map((header) => record[header] ?? ""))];
  const operations = await planWrites(
    root,
    new Map([[TASKBOARD_FILE, stringifyCsv(rows)]]),
    { force: true, replaceOperational: true }
  );
  if (!dryRun) await applyWrites(root, operations);
  return operations;
}

export function nextTaskId(config, tasks) {
  const pattern = new RegExp(`^${escapeRegExp(config.taskIds.prefix)}-([0-9]{4})$`);
  const maximum = tasks.reduce((value, task) => {
    const match = task.task_id.match(pattern);
    return match ? Math.max(value, Number(match[1])) : value;
  }, 0);
  if (maximum >= 9999) throw new Error("Task ID sequence is exhausted.");
  return `${config.taskIds.prefix}-${String(maximum + 1).padStart(4, "0")}`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
