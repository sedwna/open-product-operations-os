import fs from "node:fs/promises";
import path from "node:path";
import { INTAKE_STORE_FILE } from "../constants.js";
import { loadConfig } from "../config.js";
import { parseCsv } from "../csv.js";
import { assertNoLinkTraversal, resolveInside } from "../paths.js";
import { loadApprovals } from "./approvals.js";
import { readJsonOptional, writeJson } from "./io.js";
import { calculateMetrics } from "./metrics.js";
import { loadTaskboard, visibleTaskboardRecords } from "./taskboard.js";
import { readAutomationLink, readAutopilotEvents, readAutopilotState } from "../autopilot/state.js";

/**
 * One coherent picture of the workspace: project, board, approvals, risks, automation state, and
 * the linked engineering side. The panel renders it; nothing else is built from it. It is a view
 * over the canonical records, never a second source of truth.
 */
export async function loadWorkspaceSnapshot(root, { now = new Date() } = {}) {
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
      claude: null,
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
  const tasks = visibleTaskboardRecords(taskboard.records);
  const latestAutopilotReport = await loadLatestAutopilotReport(root, autopilotState);
  // The coordinator records the application root once it has run. Before that, the automation link
  // is what says where the application is — and a workspace that has planned engineering work
  // through the CLI has a linked application without ever having run a cycle.
  const engineeringProgress = await loadEngineeringProgress(
    autopilotState.applicationRoot ?? await linkedApplicationRoot(root)
  );
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
      latestReport: latestAutopilotReport,
      engineering: engineeringProgress
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

async function linkedApplicationRoot(root) {
  try {
    return (await readAutomationLink(root)).applicationRoot;
  } catch {
    // No link, or one that no longer resolves. Either way there is no engineering side to show.
    return null;
  }
}

export async function loadEngineeringProgress(applicationRoot) {
  if (typeof applicationRoot !== "string" || applicationRoot.trim() === "") return null;

  const root = path.resolve(applicationRoot);
  const taskboard = resolveInside(root, "engineering/taskboard/workstreams.csv", "Engineering taskboard");
  try {
    await assertNoLinkTraversal(root, taskboard, "Engineering taskboard");
    const stat = await fs.lstat(taskboard);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;

    const rows = parseCsv(await fs.readFile(taskboard, "utf8"));
    const headers = rows[0] ?? [];
    const required = ["workstream_id", "owner_role", "domain", "title", "status", "updated_at"];
    if (!required.every((header) => headers.includes(header))) return null;

    const workstreams = rows.slice(1).map((row) => {
      const value = (header) => row[headers.indexOf(header)] ?? "";
      return {
        id: value("workstream_id"),
        ownerRole: value("owner_role"),
        domain: value("domain"),
        title: value("title"),
        status: value("status"),
        updatedAt: value("updated_at")
      };
    }).filter((workstream) => workstream.id);

    // An empty board is still a board. Returning null here made "the application has no planned
    // work" indistinguishable from "there is no application", and every reader downstream inherited
    // the ambiguity. Absence is null; emptiness is zero.
    const withStatus = (statuses) => workstreams.filter((workstream) => statuses.includes(workstream.status));
    return {
      total: workstreams.length,
      completed: withStatus(["completed"]).length,
      active: withStatus(["claimed", "in_progress", "in_review"]),
      blocked: withStatus(["blocked"]),
      failed: withStatus(["failed"]),
      ready: withStatus(["ready"]).length,
      workstreams
    };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function loadLatestAutopilotReport(root, state) {
  const markdown = String(state?.latestReport ?? "").replaceAll("\\", "/");
  const reportRoot = ".product-ops/runtime/autopilot/reports/";
  if (!markdown.startsWith(reportRoot) || !markdown.endsWith(".md")) return null;
  const json = `${markdown.slice(0, -3)}.json`;
  return readJsonOptional(root, json, null);
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
