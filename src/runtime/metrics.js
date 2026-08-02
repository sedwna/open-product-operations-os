import { loadApprovals } from "./approvals.js";
import { loadTaskboard, visibleTaskboardRecords } from "./taskboard.js";

export async function calculateMetrics(root, { now = new Date() } = {}) {
  const [{ records: tasks }, approvals] = await Promise.all([
    loadTaskboard(root),
    loadApprovals(root)
  ]);
  const visibleTasks = visibleTaskboardRecords(tasks);
  const byStatus = countBy(visibleTasks, "status");
  const byOwner = countBy(visibleTasks, "owner_role");
  const byPriority = countBy(visibleTasks, "priority");
  const completed = byStatus.done ?? 0;
  const withEvidence = visibleTasks.filter((task) => String(task.evidence_refs ?? "").trim() !== "").length;
  const overdue = visibleTasks.filter((task) => {
    if (!task.due_at || ["done", "cancelled"].includes(task.status)) return false;
    const due = Date.parse(task.due_at);
    return Number.isFinite(due) && due < now.getTime();
  }).length;
  return {
    generatedAt: now.toISOString(),
    totals: {
      tasks: visibleTasks.length,
      completed,
      blocked: byStatus.blocked ?? 0,
      ready: byStatus.ready ?? 0,
      overdue,
      pendingHumanApprovals: approvals.requests.filter((request) => request.status === "pending").length
    },
    ratios: {
      completion: ratio(completed, visibleTasks.length),
      evidenceCoverage: ratio(withEvidence, visibleTasks.length)
    },
    byStatus,
    byOwner,
    byPriority
  };
}

function countBy(records, field) {
  return Object.fromEntries(
    [...records.reduce((counts, record) => {
      const key = String(record[field] || "unspecified");
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return counts;
    }, new Map())].sort(([left], [right]) => left.localeCompare(right))
  );
}

function ratio(numerator, denominator) {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(4));
}
