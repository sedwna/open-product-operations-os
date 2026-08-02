import { INTAKE_STORE_FILE } from "../constants.js";
import { loadConfig } from "../config.js";
import { applyWrites, planWrites } from "../file-writer.js";
import { loadApprovals } from "./approvals.js";
import { renderDashboard } from "./dashboard-view.js";
import { readJsonOptional, writeJson } from "./io.js";
import { calculateMetrics } from "./metrics.js";
import { loadTaskboard } from "./taskboard.js";
import { readAutopilotEvents, readAutopilotState } from "../autopilot/state.js";

export async function loadDashboardSnapshot(root, { now = new Date(), mode = "snapshot", writable = false } = {}) {
  const [config, metrics, taskboard, approvals, intake, automation, autopilotState, autopilotEvents] = await Promise.all([
    loadConfig(root),
    calculateMetrics(root, { now }),
    loadTaskboard(root),
    loadApprovals(root),
    readJsonOptional(root, INTAKE_STORE_FILE, { records: [] }),
    readJsonOptional(root, ".product-ops/runtime/automation/status.json", {
      schemaVersion: "1.0.0",
      mode: "manual",
      provider: null,
      status: "not-configured",
      codex: null,
      productCycle: "unknown",
      developmentSystem: "unknown",
      executorsEnabled: false,
      continuousOrchestrator: false,
      currentCapability: "ساخت خودکار برای این پروژه پیکربندی نشده است.",
      nextCapability: "اتصال یک اجراگر و راه‌اندازی زمان‌بند محلی"
    }),
    readAutopilotState(root),
    readAutopilotEvents(root, 100)
  ]);
  const tasks = taskboard.records;
  const latestAutopilotReport = await loadLatestAutopilotReport(root, autopilotState);
  const pendingApprovals = approvals.requests.filter((request) => request.status === "pending");
  const risks = collectRisks(tasks, pendingApprovals);
  const roleActivity = config.agents.map((agent) => {
    const owned = tasks.filter((task) => task.owner_role === agent.id);
    return {
      roleId: agent.id,
      name: agent.name,
      actorId: agent.actorId,
      total: owned.length,
      active: owned.filter((task) => ["ready", "in_progress", "in_review", "blocked"].includes(task.status)).length,
      completed: owned.filter((task) => task.status === "done").length
    };
  });
  const releaseTasks = tasks.filter((task) => task.owner_role === "RB-11");
  const verificationTasks = tasks.filter((task) => task.owner_role === "RB-12");
  return {
    schemaVersion: "1.0.0",
    generatedAt: now.toISOString(),
    mode,
    writable,
    project: {
      id: config.project.id,
      name: config.project.name,
      vision: config.project.vision,
      targetUsers: config.project.targetUsers,
      environments: config.project.environments,
      humanAuthorityActorId: config.project.humanAuthorityActorId
    },
    metrics,
    tasks,
    approvals: approvals.requests,
    intake: intake.records ?? [],
    automation,
    autopilot: {
      state: autopilotState,
      events: autopilotEvents,
      latestReport: latestAutopilotReport
    },
    risks,
    roleActivity,
    readiness: {
      releaseTasks: releaseTasks.length,
      releaseTasksDone: releaseTasks.filter((task) => task.status === "done").length,
      verificationTasks: verificationTasks.length,
      verificationTasksDone: verificationTasks.filter((task) => task.status === "done").length,
      evidenceCoverage: metrics.ratios.evidenceCoverage,
      pendingApprovals: pendingApprovals.length,
      blockedTasks: metrics.totals.blocked
    }
  };
}

async function loadLatestAutopilotReport(root, state) {
  const markdown = String(state?.latestReport ?? "").replaceAll("\\", "/");
  const reportRoot = ".product-ops/runtime/autopilot/reports/";
  if (!markdown.startsWith(reportRoot) || !markdown.endsWith(".md")) return null;
  const json = `${markdown.slice(0, -3)}.json`;
  return readJsonOptional(root, json, null);
}

export async function buildDashboard(
  root,
  { dryRun = true, output = ".product-ops/runtime/dashboard.html", now = new Date() } = {}
) {
  const snapshot = await loadDashboardSnapshot(root, { now });
  const html = renderDashboard(snapshot);
  const operations = await planWrites(root, new Map([[output, html]]), { force: true });
  if (!dryRun) await applyWrites(root, operations);
  return { dryRun, output, metrics: snapshot.metrics, bytes: Buffer.byteLength(html) };
}

export async function exportMetrics(root, { dryRun = true, output = ".product-ops/runtime/metrics.json" } = {}) {
  const metrics = await calculateMetrics(root);
  await writeJson(root, output, metrics, { dryRun });
  return { dryRun, output, metrics };
}

function collectRisks(tasks, approvals) {
  const taskRisks = tasks
    .filter((task) => task.status === "blocked" || String(task.blocked_reason ?? "").trim() !== "")
    .map((task) => ({
      id: task.task_id,
      source: "task",
      severity: task.priority === "P0" ? "critical" : task.priority === "P1" ? "high" : "medium",
      title: task.title,
      detail: task.blocked_reason || task.unblock_condition || "Blocked work requires an explicit disposition.",
      ownerRole: task.owner_role
    }));
  const approvalRisks = approvals.flatMap((request) =>
    (request.risks ?? []).map((risk, index) => ({
      id: `${request.requestId}-${index + 1}`,
      source: "approval",
      severity: "high",
      title: request.question,
      detail: risk,
      ownerRole: "human"
    }))
  );
  return [...taskRisks, ...approvalRisks];
}
