import { loadApprovals } from "./approvals.js";
import { loadTaskboard } from "./taskboard.js";

export async function calculateMetrics(root, { now = new Date() } = {}) {
  const [{ records: tasks }, approvals] = await Promise.all([
    loadTaskboard(root),
    loadApprovals(root)
  ]);
  const byStatus = countBy(tasks, "status");
  const byOwner = countBy(tasks, "owner_role");
  const byPriority = countBy(tasks, "priority");
  const completed = byStatus.done ?? 0;
  const withEvidence = tasks.filter((task) => String(task.evidence_refs ?? "").trim() !== "").length;
  const overdue = tasks.filter((task) => {
    if (!task.due_at || ["done", "cancelled"].includes(task.status)) return false;
    const due = Date.parse(task.due_at);
    return Number.isFinite(due) && due < now.getTime();
  }).length;
  return {
    generatedAt: now.toISOString(),
    totals: {
      tasks: tasks.length,
      completed,
      blocked: byStatus.blocked ?? 0,
      ready: byStatus.ready ?? 0,
      overdue,
      pendingHumanApprovals: approvals.requests.filter((request) => request.status === "pending").length
    },
    ratios: {
      completion: ratio(completed, tasks.length),
      evidenceCoverage: ratio(withEvidence, tasks.length)
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
