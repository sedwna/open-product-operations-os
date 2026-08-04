import fs from "node:fs/promises";
import path from "node:path";
import { INTAKE_STORE_FILE } from "../constants.js";
import { loadConfig } from "../config.js";
import { validatePublishedSchema } from "../schema-validation.js";
import { loadApprovals, decideApproval, requestApproval } from "../runtime/approvals.js";
import { runControlTower } from "../runtime/control-tower.js";
import { readJsonOptional } from "../runtime/io.js";
import { dependencyState, loadTaskboard, replaceTaskboard, selectRunnableTasks } from "../runtime/taskboard.js";
import { CONTROL_PLANE_LEASE_FILE } from "../runtime/control-plane-lease.js";
import { runEngineeringDelivery } from "./engineering.js";
import { runProductAgent } from "./product-agent.js";
import { materializeCycleWorkbook, materializeWriterCheckpoint } from "./workbook.js";
import { runGit, safeId, writeJson } from "./shared.js";
import {
  acquireAutopilotLease,
  appendAutopilotEvent,
  patchAutopilotState,
  readAutomationLink,
  readAutopilotState,
  releaseAutopilotLease,
  renewAutopilotLease,
  writeAutopilotState
} from "./state.js";

const MAX_ATTEMPTS = 3;
const MAX_TRANSIENT_ATTEMPTS = 8;
const PRODUCT_RUN_ROOT = ".product-ops/runtime/autopilot/product-runs";
const REPORT_ROOT = ".product-ops/runtime/autopilot/reports";

export async function runPendingAutopilotCycle(
  root,
  {
    executeProductAgent = runProductAgent,
    executeEngineering = runEngineeringDelivery,
    materializeWorkbook = materializeCycleWorkbook,
    now = () => new Date()
  } = {}
) {
  const lease = await acquireAutopilotLease(root, { now: now() });
  if (!lease) return { status: "busy" };
  let activeLease = lease;
  try {
    const initialState = await readAutopilotState(root);
    if (initialState.status === "paused") return { status: "paused", state: initialState };
    if (initialState.lastErrorKind === "transient" && initialState.nextRetryAt && Date.parse(initialState.nextRetryAt) > now().getTime()) {
      return { status: "retry_wait", retryAt: initialState.nextRetryAt, state: initialState };
    }
    if (initialState.status === "blocked"
        && (initialState.attempt >= MAX_ATTEMPTS || initialState.transientAttempt >= MAX_TRANSIENT_ATTEMPTS)) {
      return { status: "blocked", state: initialState };
    }
    const config = await loadConfig(root);
    const link = await readAutomationLink(root);
    if (!link.autoStart || !link.productExecutorsEnabled || !link.engineeringExecutorsEnabled) {
      return { status: "idle", reason: "Autopilot link is not enabled." };
    }
    const intakeStore = await readJsonOptional(root, INTAKE_STORE_FILE, { records: [] });
    const intake = await selectPendingIntake(root, intakeStore.records ?? []);
    if (!intake) {
      if (!["completed", "idle"].includes(initialState.status)) {
        await patchAutopilotState(root, { status: "idle", phase: "idle", currentTaskId: null, currentRoleId: null }, now());
      }
      return { status: "idle" };
    }

    await recoverInterruptedTasks(root, intake.eventId, now());
    const cycleId = cycleIdFor(intake.eventId);
    await prepareProductBranch(root, cycleId);
    await writeAutopilotState(root, {
      ...initialState,
      status: "running",
      activeCycleId: cycleId,
      activeEventId: intake.eventId,
      phase: "product_analysis",
      currentTaskId: null,
      currentRoleId: null,
      applicationRoot: link.applicationRoot,
      attempt: initialState.activeEventId === intake.eventId ? initialState.attempt : 0,
      transientAttempt: initialState.activeEventId === intake.eventId ? initialState.transientAttempt : 0,
      nextRetryAt: null,
      lastErrorKind: null,
      startedAt: initialState.activeEventId === intake.eventId && initialState.startedAt ? initialState.startedAt : now().toISOString(),
      updatedAt: now().toISOString(),
      completedAt: null,
      lastError: null,
      latestReport: initialState.activeEventId === intake.eventId ? initialState.latestReport : null
    });
    await appendAutopilotEvent(root, event("cycle_started", cycleId, intake, null, "چرخهٔ خودکار شروع شد."));

    await runControlTower(root, config, { dryRun: false, executeDevelopment: false, now: now() });
    while (true) {
      activeLease = await renewAutopilotLease(activeLease, { now: now() });
      const state = await readAutopilotState(root);
      if (state.status === "paused") return { status: "paused", state };
      const { headers, tasks, approvals } = await refreshCycleRouting(root, now());
      const eventTasks = tasks.filter((task) => task.event_id === intake.eventId);
      if (eventTasks.length === 0) throw new Error(`No product tasks were routed for ${intake.eventId}.`);
      if (eventTasks.every((task) => task.status === "done")) {
        const report = await writeCycleReport(root, cycleId, intake, eventTasks, now());
        const runs = await loadProductRuns(root, eventTasks, "__after_all__");
        report.report.workbook = await materializeWorkbook(root, config, {
          cycleId, intake, tasks: eventTasks, runs, now: new Date(runs.at(-1)?.completedAt ?? report.report.completedAt)
        });
        await persistCycleReport(root, report);
        await patchAutopilotState(root, {
          status: "completed",
          phase: "complete",
          currentTaskId: null,
          currentRoleId: null,
          completedAt: now().toISOString(),
          lastError: null,
          transientAttempt: 0,
          nextRetryAt: null,
          lastErrorKind: null,
          latestReport: report.markdown
        }, now());
        await updateAutomationStatus(root, "چرخهٔ ایده تا پیاده‌سازی کامل شد و گزارش محصول آماده است.");
        await appendAutopilotEvent(root, event("cycle_completed", cycleId, intake, null, "گزارش نهایی محصول آماده شد."));
        const revision = await commitProductCycle(root, cycleId);
        return { status: "completed", cycleId, report, revision };
      }

      let runnable = selectRunnableTasks(tasks, approvals.requests).find((task) => task.event_id === intake.eventId);
      if (!runnable) {
        const gated = eventTasks.find((task) => task.status === "ready" && task.human_gate);
        if (gated) {
          const approval = approvals.requests.find((item) => item.taskId === gated.task_id && item.gate === gated.human_gate);
          if (approval?.status === "pending" && intake.autopilotAuthorized) {
            await decideApproval(root, config, {
              requestId: approval.requestId,
              decision: "approved",
              actorId: config.project.humanAuthorityActorId,
              rationale: "The owner authorized this bounded autonomous cycle by submitting the idea through the local writable dashboard. Production and destructive actions remain separately gated."
            }, { dryRun: false, now: now() });
            await appendAutopilotEvent(root, event("gate_approved", cycleId, intake, gated, `دروازهٔ ${gated.human_gate} با مجوز همان ایده تأیید شد.`));
            continue;
          }
          await patchAutopilotState(root, {
            status: "waiting_for_human", phase: "human_gate", currentTaskId: gated.task_id, currentRoleId: gated.owner_role
          }, now());
          return { status: "waiting_for_human", task: gated, approval };
        }
        throw new Error("The product cycle has incomplete tasks but none is runnable.");
      }

      const phase = phaseFor(runnable.owner_role);
      await patchAutopilotState(root, {
        status: "running", phase, currentTaskId: runnable.task_id, currentRoleId: runnable.owner_role
      }, now());
      await markTask(root, headers, tasks, runnable.task_id, { status: "in_progress", updated_at: now().toISOString() });
      await appendAutopilotEvent(root, event("task_started", cycleId, intake, runnable, `نقش ${runnable.owner_role} کار را برداشت.`));

      const priorRuns = await loadProductRuns(root, eventTasks, runnable.task_id);
      const cycleHistory = await loadRecentCycleReports(root, 3);
      let run;
      if (runnable.owner_role === config.separation.developmentRole) {
        const delivery = await executeEngineering(root, link.applicationRoot, config, runnable, {
          intake,
          productRuns: priorRuns,
          cycleId,
          autoApprove: intake.autopilotAuthorized,
          now: now()
        });
        if (delivery.status === "waiting_for_human") {
          await markTask(root, headers, tasks, runnable.task_id, { status: "ready", updated_at: now().toISOString() });
          await patchAutopilotState(root, { status: "waiting_for_human", phase: "human_gate" }, now());
          return delivery;
        }
        run = await recordEngineeringProductRun(root, config, runnable, delivery, now());
      } else {
        const operationalArtifacts = runnable.owner_role === config.separation.writerRole
          ? await prepareWriterCheckpoint(root, config, { cycleId, intake, priorRuns, now: now() })
          : null;
        const executed = await executeProductAgent(root, config, runnable, {
          intake,
          priorRuns,
          cycleHistory,
          cycleId,
          applicationRoot: link.applicationRoot,
          operationalArtifacts,
          provider: link.provider,
          now: now()
        });
        run = executed.result;
      }

      if (run.status !== "completed") {
        await markTask(root, headers, tasks, runnable.task_id, {
          status: "blocked",
          blocked_reason: run.summary,
          evidence_refs: (run.evidence ?? []).join("|"),
          updated_at: now().toISOString()
        });
        await patchAutopilotState(root, { status: "blocked", lastError: run.summary }, now());
        return { status: "blocked", task: runnable, run };
      }
      const resultRef = `${PRODUCT_RUN_ROOT}/${runnable.task_id}-result.json`;
      await markTask(root, headers, tasks, runnable.task_id, {
        status: "done",
        blocked_reason: "",
        canonical_output_refs: resultRef,
        evidence_refs: unique([resultRef, ...(run.evidence ?? [])]).join("|"),
        updated_at: now().toISOString()
      });
      await appendAutopilotEvent(root, event("task_completed", cycleId, intake, runnable, run.summary));
    }
  } catch (error) {
    const state = await readAutopilotState(root).catch(() => null);
    if (state?.currentTaskId) {
      await resetInProgressTask(root, state.currentTaskId, String(error.message), now()).catch(() => {});
    }
    const transient = classifyAutopilotError(error) === "transient";
    const attempt = transient ? (state?.attempt ?? 0) : Math.min(MAX_ATTEMPTS, (state?.attempt ?? 0) + 1);
    const transientAttempt = transient ? Math.min(MAX_TRANSIENT_ATTEMPTS, (state?.transientAttempt ?? 0) + 1) : 0;
    const exhausted = transient ? transientAttempt >= MAX_TRANSIENT_ATTEMPTS : attempt >= MAX_ATTEMPTS;
    const status = exhausted ? "blocked" : "failed";
    const retryDelayMs = transient && !exhausted ? transientRetryDelay(transientAttempt) : 0;
    await patchAutopilotState(root, {
      status,
      attempt,
      transientAttempt,
      nextRetryAt: retryDelayMs ? new Date(now().getTime() + retryDelayMs).toISOString() : null,
      lastErrorKind: transient ? "transient" : "logical",
      lastError: String(error.message).slice(0, 2000)
    }, now()).catch(() => {});
    await appendAutopilotEvent(root, {
      type: status === "blocked" ? "cycle_blocked" : "cycle_retry_scheduled",
      cycleId: state?.activeCycleId ?? null,
      eventId: state?.activeEventId ?? null,
      taskId: state?.currentTaskId ?? null,
      roleId: state?.currentRoleId ?? null,
      message: String(error.message).slice(0, 2000)
    }).catch(() => {});
    return { status, attempt, transientAttempt, retryDelayMs, errorKind: transient ? "transient" : "logical", error: String(error.message) };
  } finally {
    await releaseAutopilotLease(activeLease).catch(() => {});
  }
}

async function prepareWriterCheckpoint(root, config, { cycleId, intake, priorRuns, now }) {
  const qaRun = priorRuns.find((run) => run.roleId === "RB-09" && run.status === "completed");
  if (!qaRun) throw new Error("Controlled writer checkpoint requires a completed product QA run.");
  return materializeWriterCheckpoint(root, config, { cycleId, intake, qaRun, now });
}

async function recoverInterruptedTasks(root, eventId, now) {
  const loaded = await loadTaskboard(root);
  const interrupted = loaded.records.filter((task) => task.event_id === eventId && task.status === "in_progress");
  if (!interrupted.length) return;
  const interruptedIds = new Set(interrupted.map((task) => task.task_id));
  const recovered = loaded.records.map((task) => interruptedIds.has(task.task_id) ? {
    ...task,
    status: "ready",
    blocked_reason: "Recovered after the prior coordinator process ended before sealing the task result.",
    updated_at: now.toISOString()
  } : task);
  await replaceTaskboard(root, loaded.headers, recovered, { dryRun: false });
}

async function resetInProgressTask(root, taskId, message, now) {
  const { headers, records } = await loadTaskboard(root);
  const task = records.find((candidate) => candidate.task_id === taskId);
  if (!task || task.status !== "in_progress") return;
  await markTask(root, headers, records, taskId, {
    status: "ready",
    blocked_reason: `Retry scheduled after: ${String(message).slice(0, 500)}`,
    updated_at: now.toISOString()
  });
}

export function startAutopilotLoop(root, { intervalMs = 1500, runner = runPendingAutopilotCycle } = {}) {
  let timer = null;
  let closed = false;
  let active = null;
  const schedule = () => {
    if (closed) return;
    timer = setTimeout(tick, intervalMs);
    timer.unref?.();
  };
  const tick = async () => {
    if (closed) return;
    await runOnce();
    schedule();
  };
  const runOnce = () => {
    if (active) return active;
    active = Promise.resolve()
      .then(() => runner(root))
      .catch((error) => ({ status: "failed", error: String(error.message) }))
      .finally(() => { active = null; });
    return active;
  };
  void tick();
  return {
    runNow: runOnce,
    async close() {
      closed = true;
      if (timer) clearTimeout(timer);
      if (active) await active;
    }
  };
}

async function selectPendingIntake(root, records) {
  const tasks = (await loadTaskboard(root)).records;
  const completedEvents = new Set(tasks.filter((task) => task.status === "done").map((task) => task.event_id));
  return [...records].reverse().find((record) =>
    record.status !== "duplicate" &&
    record.autopilotAuthorized === true &&
    (!completedEvents.has(record.eventId) || tasks.some((task) => task.event_id === record.eventId && task.status !== "done"))
  ) ?? null;
}

async function refreshCycleRouting(root, now) {
  const loaded = await loadTaskboard(root);
  let tasks = loaded.records;
  let changed = false;
  let byId = new Map(tasks.map((task) => [task.task_id, task]));
  tasks = tasks.map((task) => {
    if (task.status !== "backlog" || !dependencyState(task, byId).satisfied) return task;
    changed = true;
    return { ...task, status: "ready", updated_at: now.toISOString() };
  });
  if (changed) await replaceTaskboard(root, loaded.headers, tasks, { dryRun: false });
  let approvals = await loadApprovals(root);
  for (const task of tasks.filter((candidate) => candidate.status === "ready" && candidate.human_gate)) {
    const existing = approvals.requests.find((item) => item.taskId === task.task_id && item.gate === task.human_gate);
    if (existing) continue;
    await requestApproval(root, {
      taskId: task.task_id,
      gate: task.human_gate,
      question: `Authorize gate ${task.human_gate} for task ${task.task_id}?`,
      context: task.title,
      evidenceRefs: task.evidence_refs ? task.evidence_refs.split("|").filter(Boolean) : [],
      risks: task.blocked_reason ? [task.blocked_reason] : []
    }, { dryRun: false, now });
    approvals = await loadApprovals(root);
  }
  return { headers: loaded.headers, tasks, approvals };
}

async function loadProductRuns(root, tasks, beforeTaskId) {
  const results = [];
  for (const task of tasks) {
    if (task.task_id === beforeTaskId) break;
    if (task.status !== "done") continue;
    const file = path.join(root, PRODUCT_RUN_ROOT, `${task.task_id}-result.json`);
    const result = JSON.parse(await fs.readFile(file, "utf8"));
    const errors = validatePublishedSchema("product-agent-run.schema.json", result);
    if (errors.length) throw new Error(`Stored product result ${task.task_id} is invalid: ${errors.join("; ")}`);
    results.push(result);
  }
  return results;
}

async function loadRecentCycleReports(root, limit) {
  const directory = path.join(root, REPORT_ROOT);
  let files;
  try { files = (await fs.readdir(directory)).filter((file) => file.endsWith(".json")).sort(); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const reports = [];
  for (const file of files.slice(-limit)) {
    const report = JSON.parse(await fs.readFile(path.join(directory, file), "utf8"));
    reports.push({
      cycleId: report.cycleId,
      eventId: report.eventId,
      idea: report.idea,
      acceptance: report.acceptance,
      implementation: report.implementation,
      knownRisks: report.knownRisks,
      completedAt: report.completedAt
    });
  }
  return reports;
}

async function recordEngineeringProductRun(root, config, task, delivery, now) {
  const role = config.agents.find((candidate) => candidate.id === task.owner_role);
  const result = {
    schemaVersion: "1.0.0",
    taskId: task.task_id,
    eventId: task.event_id,
    roleId: task.owner_role,
    producerActorId: role.actorId,
    status: "completed",
    summary: `Engineering completed ${delivery.changedComponents.length} changed component(s) and returned independently verified evidence.`,
    findings: boundedUnique(delivery.changedComponents.map((item) => `Changed: ${item}`)),
    recommendations: ["Product QA and independent product verification should assess the returned implementation against the acceptance contract."],
    acceptanceCriteria: delivery.request.acceptanceCriteria.slice(0, 30).map(({ statement, verification }) => ({ statement, verification })),
    impacts: boundedUnique(delivery.request.impacts),
    constraints: boundedUnique(delivery.request.constraints),
    nonFunctionalRequirements: delivery.request.nonFunctionalRequirements.slice(0, 30),
    evidence: boundedUnique([
      ...(delivery.productEvidenceRefs ?? []),
      delivery.productReceipt?.storedAt
    ]),
    knownRisks: boundedUnique(delivery.result?.knownRisks ?? []),
    completedAt: now.toISOString()
  };
  const errors = validatePublishedSchema("product-agent-run.schema.json", result);
  if (errors.length) throw new Error(`Engineering return could not be represented in the product contract: ${errors.join("; ")}`);
  await writeJson(path.join(root, PRODUCT_RUN_ROOT, `${task.task_id}-result.json`), result);
  return result;
}

async function markTask(root, headers, tasks, taskId, patch) {
  const updated = tasks.map((task) => task.task_id === taskId ? { ...task, ...patch } : task);
  await replaceTaskboard(root, headers, updated, { dryRun: false });
}

async function writeCycleReport(root, cycleId, intake, tasks, now) {
  const runs = await loadProductRuns(root, tasks, "__after_all__");
  const engineering = runs.find((run) => run.roleId === "RB-13");
  const final = runs.at(-1);
  const report = {
    schemaVersion: "1.0.0",
    cycleId,
    eventId: intake.eventId,
    idea: { title: intake.title, description: intake.description, priority: intake.priority },
    status: "completed",
    productRolesCompleted: runs.map((run) => ({ roleId: run.roleId, taskId: run.taskId, summary: run.summary })),
    implementation: {
      changedComponents: engineering?.findings?.filter((item) => item.startsWith("Changed: ")).map((item) => item.slice(9)) ?? [],
      evidence: engineering?.evidence ?? []
    },
    acceptance: final?.summary ?? "The complete product route finished.",
    knownRisks: unique(runs.flatMap((run) => run.knownRisks ?? [])),
    nextStep: "Review this report in the local dashboard. Submit a new feedback or correction to start the next autonomous cycle.",
    completedAt: now.toISOString()
  };
  const directory = path.join(root, REPORT_ROOT);
  await fs.mkdir(directory, { recursive: true });
  const jsonFile = path.join(directory, `${cycleId}.json`);
  const markdownFile = path.join(directory, `${cycleId}.md`);
  const output = {
    json: path.relative(root, jsonFile).replaceAll("\\", "/"),
    markdown: path.relative(root, markdownFile).replaceAll("\\", "/"),
    report
  };
  await persistCycleReport(root, output);
  return output;
}

async function persistCycleReport(root, output) {
  await writeJson(path.join(root, output.json), output.report);
  await fs.writeFile(path.join(root, output.markdown), renderPersianReport(output.report), "utf8");
}

function renderPersianReport(report) {
  const changes = report.implementation.changedComponents.length
    ? report.implementation.changedComponents.map((item) => `- \`${item}\``).join("\n")
    : "- تغییر ثبت‌شده‌ای گزارش نشد.";
  const risks = report.knownRisks.length ? report.knownRisks.map((item) => `- ${item}`).join("\n") : "- ریسک باز ثبت نشده است.";
  const workbook = report.workbook ? `${report.workbook.receipts.length} ثبت کنترل‌شده در دفترکار محصول انجام شد.` : "دفترکار هنوز ثبت نشده است.";
  return `# گزارش چرخهٔ خودکار\n\n## ایده\n\n${report.idea.title}\n\n${report.idea.description}\n\n## نتیجه\n\n${report.acceptance}\n\n## تغییرات پیاده‌سازی\n\n${changes}\n\n## دفترکار محصول\n\n${workbook}\n\n## ریسک‌های باز\n\n${risks}\n\n## قدم بعدی\n\nبازخورد، اصلاح یا درخواست بعدی را در پنل محلی ثبت کنید تا چرخهٔ بعدی خودکار آغاز شود.\n`;
}

async function prepareProductBranch(root, cycleId) {
  const branch = `codex/${safeId(cycleId).toLowerCase()}-product`;
  const current = (await runGit(root, ["branch", "--show-current"])).stdout.trim();
  const unsafe = (await changedGitPaths(root)).filter((file) => !isManagedProductPath(file));
  if (unsafe.length) throw new Error(`Autopilot found unrelated Product Operations changes and stopped safely: ${unsafe.join(", ")}`);
  if (current === branch) return branch;
  const exists = (await runGit(root, ["branch", "--list", branch])).stdout.trim() !== "";
  await runGit(root, exists ? ["switch", branch] : ["switch", "-c", branch]);
  return branch;
}

async function commitProductCycle(root, cycleId) {
  const unsafe = (await changedGitPaths(root)).filter((file) => !isManagedProductPath(file));
  if (unsafe.length) throw new Error(`Autopilot refused to commit unrelated Product Operations changes: ${unsafe.join(", ")}`);
  await runGit(root, ["add", "--all"]);
  await runGit(root, [
    "reset", "--quiet", "HEAD", "--",
    ".product-ops/runtime/autopilot/orchestrator.lease.json",
    CONTROL_PLANE_LEASE_FILE
  ]).catch(() => {});
  const staged = (await runGit(root, ["diff", "--cached", "--name-only"])).stdout.trim();
  if (!staged) return null;
  await runGit(root, [
    "-c", "user.name=OpenProduct Autopilot",
    "-c", "user.email=autopilot@users.noreply.github.com",
    "commit", "-m", `feat: complete autonomous product cycle ${safeId(cycleId)}`
  ]);
  return (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim();
}

async function changedGitPaths(root) {
  const status = (await runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout;
  const records = status.split("\0").filter(Boolean);
  const files = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const state = record.slice(0, 2);
    files.push(record.slice(3).replaceAll("\\", "/"));
    if (state.includes("R") || state.includes("C")) index += 1;
  }
  return unique(files);
}

async function updateAutomationStatus(root, currentCapability) {
  const file = path.join(root, ".product-ops", "runtime", "automation", "status.json");
  let status;
  try { status = JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    const link = await readAutomationLink(root).catch(() => ({ provider: "codex" }));
    status = {
      schemaVersion: "1.0.0",
      updatedAt: new Date().toISOString(),
      mode: link.provider,
      provider: link.provider,
      status: "executors-ready",
      codex: null,
      claude: null,
      productCycle: "initialized",
      developmentSystem: "ready",
      executorsEnabled: true,
      continuousOrchestrator: true,
      currentCapability,
      nextCapability: "ثبت بازخورد بعدی و آغاز خودکار چرخهٔ اصلاح"
    };
  }
  status.continuousOrchestrator = true;
  status.updatedAt = new Date().toISOString();
  status.currentCapability = currentCapability;
  status.nextCapability = "ثبت بازخورد بعدی در پنل و آغاز خودکار چرخهٔ اصلاح";
  await writeJson(file, status);
}

function phaseFor(roleId) {
  if (roleId === "RB-13") return "engineering";
  if (["RB-09", "RB-10", "RB-11", "RB-12"].includes(roleId)) return "product_validation";
  return "product_analysis";
}

function event(type, cycleId, intake, task, message) {
  return { type, cycleId, eventId: intake.eventId, taskId: task?.task_id ?? null, roleId: task?.owner_role ?? null, message };
}

function cycleIdFor(eventId) { return `CYCLE-${safeId(eventId)}`; }
function unique(values) { return [...new Set(values.filter(Boolean))]; }
export function boundedUnique(values, limit = 30) { return unique(values).slice(0, limit); }
export function classifyAutopilotError(error) {
  const value = `${error?.code ?? ""} ${error?.message ?? error ?? ""}`;
  return /\b(?:ENOENT|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|429|502|503|504)\b|timed out|websocket|temporarily unavailable|network connection/i.test(value)
    ? "transient"
    : "logical";
}
export function transientRetryDelay(attempt) {
  return Math.min(60_000, 1_000 * (2 ** Math.max(0, attempt - 1)));
}
function isManagedProductPath(file) {
  return file.startsWith(".product-ops/") || file === "taskboard/tasks.csv" || file.startsWith("product-intake/") || file.startsWith("workbook/");
}
