import { untrusted } from "./untrusted.js";

export const DEFAULT_BRIEF_CEILING = 4096;
export const FULL_CEILING = 16384;

const BRIEF_DECISIONS = 5;
const BRIEF_RISKS = 3;
const FULL_EVENTS = 10;

/**
 * Reduce the dashboard snapshot to a bounded product-owner view.
 *
 * The snapshot carries every task, every intake record, and the last hundred autopilot events.
 * Returning it verbatim would spend thousands of tokens per call, so the ceiling is a guarantee and
 * the degradation order is fixed: risks first, then decisions, then recent events.
 */
export function projectStatus(snapshot, { verbosity = "brief", ceiling } = {}) {
  const full = verbosity === "full";
  const limit = ceiling ?? (full ? FULL_CEILING : DEFAULT_BRIEF_CEILING);
  const state = snapshot.autopilot?.state ?? {};
  const counts = countStatuses(snapshot.tasks ?? []);
  const pending = (snapshot.approvals ?? []).filter((request) => request.status === "pending");

  const projection = {
    project: { id: snapshot.project.id, name: snapshot.project.name },
    generatedAt: snapshot.generatedAt,
    cycle: {
      status: state.status ?? "idle",
      phase: state.phase ?? "idle",
      currentTaskId: state.currentTaskId ?? null,
      currentRoleId: state.currentRoleId ?? null,
      activeCycleId: state.activeCycleId ?? null,
      activeEventId: state.activeEventId ?? null,
      attempt: state.attempt ?? 0,
      transientAttempt: state.transientAttempt ?? 0,
      nextRetryAt: state.nextRetryAt ?? null,
      lastError: untrusted(state.lastError, { source: "autopilot-state", id: "lastError" })
    },
    counts,
    decisions: {
      pending: pending.length,
      items: pending.slice(0, BRIEF_DECISIONS).map((request) => ({
        requestId: request.requestId,
        gate: request.gate,
        taskId: request.taskId
      }))
    },
    risks: (snapshot.risks ?? []).slice(0, BRIEF_RISKS).map((risk) => ({
      id: risk.id,
      severity: risk.severity,
      ownerRole: risk.ownerRole,
      title: untrusted(risk.title, { source: "risk", id: risk.id })
    })),
    latestCycle: latestCycle(snapshot),
    automation: {
      provider: snapshot.automation?.provider ?? null,
      status: snapshot.automation?.status ?? "not-configured",
      continuousOrchestrator: snapshot.automation?.continuousOrchestrator === true
    },
    truncated: { decisions: pending.length > BRIEF_DECISIONS, risks: (snapshot.risks ?? []).length > BRIEF_RISKS }
  };

  if (full) {
    projection.roleActivity = snapshot.roleActivity ?? [];
    projection.readiness = snapshot.readiness ?? null;
    projection.engineering = summariseEngineering(snapshot.autopilot?.engineering);
    projection.recentEvents = (snapshot.autopilot?.events ?? []).slice(-FULL_EVENTS).map((event) => ({
      type: event.type,
      taskId: event.taskId ?? null,
      roleId: event.roleId ?? null,
      message: untrusted(event.message, { source: "autopilot-event", id: event.type })
    }));
    projection.truncated.recentEvents = (snapshot.autopilot?.events ?? []).length > FULL_EVENTS;
  }

  return enforceCeiling(projection, limit);
}

export function renderStatusText(projection) {
  const { cycle, counts, decisions } = projection;
  const lines = [
    `${projection.project.name} — cycle ${cycle.status} (phase ${cycle.phase}).`,
    cycle.currentTaskId ? `Active: ${cycle.currentTaskId} owned by ${cycle.currentRoleId}.` : "No task is currently claimed.",
    `Tasks: ${counts.ready} ready, ${counts.inProgress} in progress, ${counts.blocked} blocked, ${counts.done} done of ${counts.total}.`,
    decisions.pending === 0
      ? "Nothing is waiting on human authority."
      : `${decisions.pending} human gate(s) awaiting a decision: ${decisions.items.map((item) => item.requestId).join(", ")}.`
  ];
  if (cycle.lastError) lines.push(`Last error: ${cycle.lastError}`);
  if (projection.truncated.decisions || projection.truncated.risks) {
    lines.push("Some entries were omitted to stay inside the result budget; read productops:// resources for the full set.");
  }
  return lines.join("\n");
}

function countStatuses(tasks) {
  const counts = { ready: 0, inProgress: 0, blocked: 0, inReview: 0, done: 0, cancelled: 0, backlog: 0, total: tasks.length };
  const map = { ready: "ready", in_progress: "inProgress", blocked: "blocked", in_review: "inReview", done: "done", cancelled: "cancelled", backlog: "backlog" };
  for (const task of tasks) {
    const key = map[task.status];
    if (key) counts[key] += 1;
  }
  return counts;
}

function latestCycle(snapshot) {
  const report = snapshot.autopilot?.latestReport;
  if (!report) return null;
  return {
    cycleId: report.cycleId ?? null,
    status: report.status ?? null,
    completedAt: report.completedAt ?? null,
    reportResource: "productops://cycle/latest"
  };
}

function summariseEngineering(engineering) {
  if (!engineering) return null;
  return {
    total: engineering.total,
    completed: engineering.completed,
    ready: engineering.ready,
    active: engineering.active.length,
    blocked: engineering.blocked.length,
    failed: engineering.failed.length
  };
}

function enforceCeiling(projection, limit) {
  const steps = [
    (value) => { value.risks = []; value.truncated.risks = true; },
    (value) => { value.decisions.items = []; value.truncated.decisions = true; },
    (value) => { if (value.recentEvents) { value.recentEvents = []; value.truncated.recentEvents = true; } },
    (value) => { value.roleActivity = undefined; },
    (value) => { value.cycle.lastError = value.cycle.lastError ? "<untrusted-record source=\"autopilot-state\">…</untrusted-record>" : null; }
  ];
  let candidate = projection;
  for (const step of steps) {
    if (byteLength(candidate) <= limit) return candidate;
    step(candidate);
  }
  if (byteLength(candidate) > limit) {
    candidate = {
      project: projection.project,
      generatedAt: projection.generatedAt,
      cycle: { status: projection.cycle.status, phase: projection.cycle.phase },
      counts: projection.counts,
      decisions: { pending: projection.decisions.pending, items: [] },
      risks: [],
      latestCycle: null,
      automation: projection.automation,
      truncated: { decisions: true, risks: true, minimised: true }
    };
  }
  return candidate;
}

export function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
