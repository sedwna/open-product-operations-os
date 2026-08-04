import crypto from "node:crypto";
import { loadConfig, validateConfig, validateConfigRelationships } from "../../config.js";
import { loadApprovals } from "../../runtime/approvals.js";
import { loadDashboardSnapshot } from "../../runtime/dashboard.js";
import { readCsvRecords } from "../../runtime/io.js";
import { dependencyState, loadTaskboard, visibleTaskboardRecords } from "../../runtime/taskboard.js";
import { validateProject } from "../../validation.js";
import { projectStatus, renderStatusText } from "../projection.js";
import { untrusted, untrustedList } from "../untrusted.js";
import { ToolFailure } from "../authority.js";

const MAX_FINDINGS = 50;

export async function status(context, { verbosity = "brief" } = {}) {
  const snapshot = await loadDashboardSnapshot(context.root);
  const projection = projectStatus(snapshot, { verbosity, ceiling: verbosity === "full" ? undefined : context.briefCeiling });
  return { structuredContent: projection, text: renderStatusText(projection) };
}

/**
 * One payload for the interactive panel: cycle state, counts, risks, and the pending gates with
 * the tokens needed to put them to the product owner. The panel is a view over the same records
 * every other surface reads; it is not a second source of truth.
 */
export async function panel(context, args = {}) {
  const [state, gates] = await Promise.all([
    status(context, { verbosity: "full" }),
    pendingDecisions(context, { limit: 10 })
  ]);
  const structuredContent = {
    ...state.structuredContent,
    decisions: { pending: gates.structuredContent.pending, items: gates.structuredContent.items },
    humanAuthorityActorId: gates.structuredContent.humanAuthorityActorId
  };
  return {
    structuredContent,
    text: `${state.text}\n\nThe control tower panel is open. Decisions taken there still go through the product owner's own dialog.`
  };
}

export async function pendingDecisions(context, { limit = 10 } = {}) {
  const [config, approvals] = await Promise.all([loadConfig(context.root), loadApprovals(context.root)]);
  const pending = approvals.requests.filter((request) => request.status === "pending");
  const items = pending.slice(0, limit).map((request) => ({
    requestId: request.requestId,
    taskId: request.taskId,
    gate: request.gate,
    question: untrusted(request.question, { source: "approval", id: request.requestId }),
    context: untrusted(request.context, { source: "approval", id: request.requestId }),
    options: request.options,
    recommendedOption: request.recommendedOption,
    risks: untrustedList(request.risks, { source: "approval", id: request.requestId }),
    evidenceRefs: (request.evidenceRefs ?? []).slice(0, 20),
    requestedAt: request.requestedAt,
    decisionToken: context.decisionToken(request)
  }));
  const structuredContent = {
    pending: pending.length,
    humanAuthorityActorId: config.project.humanAuthorityActorId,
    items,
    truncated: pending.length > items.length
  };
  const text = pending.length === 0
    ? "No human gate is waiting for a decision."
    : `${pending.length} gate(s) awaiting the product owner:\n${items.map((item) => `- ${item.requestId} · ${item.gate} · ${item.taskId}`).join("\n")}`;
  return { structuredContent, text };
}

export async function task(context, { taskId } = {}) {
  const { records, byId } = await loadTaskboard(context.root);
  const record = byId.get(taskId);
  if (!record) throw new ToolFailure("NOT_FOUND", `No task "${taskId}" exists on the canonical board.`);
  const dependencies = dependencyState(record, byId);
  const structuredContent = {
    taskId: record.task_id,
    eventId: record.event_id,
    title: untrusted(record.title, { source: "taskboard", id: record.task_id }),
    ownerRole: record.owner_role,
    ownerActorId: record.owner_actor_id,
    status: record.status,
    priority: record.priority,
    humanGate: record.human_gate || null,
    independentVerifierRole: record.independent_verifier_role || null,
    blockedReason: untrusted(record.blocked_reason, { source: "taskboard", id: record.task_id }),
    unblockCondition: untrusted(record.unblock_condition, { source: "taskboard", id: record.task_id }),
    dependencies: {
      declared: dependencies.dependencies,
      missing: dependencies.missing,
      incomplete: dependencies.incomplete,
      satisfied: dependencies.satisfied
    },
    canonicalOutputRefs: splitRefs(record.canonical_output_refs),
    evidenceRefs: splitRefs(record.evidence_refs),
    updatedAt: record.updated_at,
    // Visible records, so this agrees with the count product_ops_status reports.
    boardSize: visibleTaskboardRecords(records).length
  };
  const text = `${record.task_id} is ${record.status}, owned by ${record.owner_role}.`
    + (dependencies.satisfied ? "" : ` Waiting on ${[...dependencies.missing, ...dependencies.incomplete].join(", ")}.`)
    + (record.human_gate ? ` Human gate: ${record.human_gate}.` : "");
  return { structuredContent, text };
}

export async function cycleReport(context, { cycleId } = {}) {
  const snapshot = await loadDashboardSnapshot(context.root);
  const report = snapshot.autopilot?.latestReport;
  if (!report) throw new ToolFailure("NOT_FOUND", "No autonomous cycle report has been produced yet.");
  if (cycleId && report.cycleId !== cycleId) {
    throw new ToolFailure("NOT_FOUND", `Cycle "${cycleId}" is not the latest report; earlier reports are available under productops://cycle/latest only for the most recent cycle.`);
  }
  const structuredContent = {
    cycleId: report.cycleId,
    eventId: report.eventId,
    status: report.status,
    idea: {
      title: untrusted(report.idea?.title, { source: "cycle-report", id: report.cycleId }),
      priority: report.idea?.priority ?? null
    },
    acceptance: untrusted(report.acceptance, { source: "cycle-report", id: report.cycleId }),
    changedComponents: (report.implementation?.changedComponents ?? []).slice(0, 40),
    evidence: (report.implementation?.evidence ?? []).slice(0, 40),
    knownRisks: untrustedList(report.knownRisks, { source: "cycle-report", id: report.cycleId }),
    completedAt: report.completedAt,
    fullReportResource: "productops://cycle/latest"
  };
  return {
    structuredContent,
    text: `Cycle ${report.cycleId} is ${report.status}. ${structuredContent.changedComponents.length} changed component(s), ${structuredContent.knownRisks.length} open risk(s). Read productops://cycle/latest for the full report.`
  };
}

export async function evidence(context, { taskId, eventId } = {}) {
  if (Boolean(taskId) === Boolean(eventId)) {
    throw new ToolFailure("NOT_FOUND", "Supply exactly one of taskId or eventId.");
  }
  const { byId } = await loadTaskboard(context.root);
  let scopedEventId = eventId;
  let taskRefs = [];
  if (taskId) {
    const record = byId.get(taskId);
    if (!record) throw new ToolFailure("NOT_FOUND", `No task "${taskId}" exists on the canonical board.`);
    scopedEventId = record.event_id;
    taskRefs = splitRefs(record.evidence_refs);
  }
  const rows = await readWorkbook(context.root, "workbook/16-evidence.csv");
  const items = rows
    .filter((row) => row.event_id === scopedEventId && !isPlaceholder(row.evidence_item_id))
    .slice(0, 50)
    .map((row) => ({
      evidenceItemId: row.evidence_item_id,
      manifestId: row.evidence_manifest_id,
      status: row.status,
      artifactType: row.artifact_type,
      canonicalPath: row.canonical_path,
      sha256: row.sha256,
      decisive: row.decisive,
      capturedAt: row.captured_at,
      secretScanPassed: row.secret_scan_passed,
      limitation: untrusted(row.limitation, { source: "workbook/evidence", id: row.evidence_item_id })
    }));
  return {
    structuredContent: { eventId: scopedEventId, taskEvidenceRefs: taskRefs, items, truncated: rows.length > items.length },
    text: `${items.length} evidence item(s) recorded for ${scopedEventId}${taskId ? ` via ${taskId}` : ""}.`
  };
}

export async function readiness(context) {
  const snapshot = await loadDashboardSnapshot(context.root);
  const rows = (await readWorkbook(context.root, "workbook/19-readiness.csv"))
    .filter((row) => !isPlaceholder(row.readiness_id));
  const assessments = rows.slice(-5).map((row) => ({
    readinessId: row.readiness_id,
    eventId: row.event_id,
    status: row.status,
    targetEnvironment: row.target_environment,
    blockingIds: splitRefs(row.blocking_ids),
    humanRiskAcceptanceId: row.human_risk_acceptance_id || null,
    rollbackReference: row.rollback_reference || null,
    releaseId: row.release_id || null,
    residualRisks: untrustedList(splitRefs(row.residual_risks), { source: "workbook/readiness", id: row.readiness_id })
  }));
  const blockers = [];
  for (const assessment of assessments) {
    if (assessment.status === "ready") continue;
    if (!assessment.humanRiskAcceptanceId) blockers.push(`${assessment.readinessId}: no attributed human risk acceptance.`);
    if (!assessment.rollbackReference) blockers.push(`${assessment.readinessId}: no rollback plan recorded.`);
    if (!assessment.releaseId) blockers.push(`${assessment.readinessId}: no linked release record.`);
    for (const id of assessment.blockingIds) blockers.push(`${assessment.readinessId}: blocked by ${id}.`);
  }
  if (snapshot.readiness.pendingApprovals > 0) blockers.push(`${snapshot.readiness.pendingApprovals} human gate(s) still pending.`);
  if (snapshot.readiness.blockedTasks > 0) blockers.push(`${snapshot.readiness.blockedTasks} blocked task(s) on the board.`);
  return {
    structuredContent: { summary: snapshot.readiness, assessments, blockers: blockers.slice(0, 25) },
    text: blockers.length === 0
      ? "No readiness blocker is recorded."
      : `Release is not clear. ${blockers.length} blocker(s):\n${blockers.slice(0, 10).map((item) => `- ${item}`).join("\n")}`
  };
}

export async function validate(context) {
  const config = await loadConfig(context.root);
  const configErrors = [...validateConfig(config)];
  if (configErrors.length === 0) configErrors.push(...validateConfigRelationships(config));
  if (configErrors.length > 0) {
    return {
      structuredContent: { ok: false, stage: "configuration", errors: configErrors.slice(0, MAX_FINDINGS), warnings: [], truncated: configErrors.length > MAX_FINDINGS },
      text: `Project configuration is invalid (${configErrors.length} error(s)).`
    };
  }
  const result = await validateProject(context.root, config);
  const structuredContent = {
    ok: result.errors.length === 0,
    stage: "project",
    checkedFiles: result.checkedFiles,
    errors: result.errors.slice(0, MAX_FINDINGS),
    warnings: result.warnings.slice(0, MAX_FINDINGS),
    truncated: result.errors.length > MAX_FINDINGS || result.warnings.length > MAX_FINDINGS
  };
  return {
    structuredContent,
    text: structuredContent.ok
      ? `Validation passed across ${result.checkedFiles} file(s).`
      : `Validation failed with ${result.errors.length} error(s).`
  };
}

export function createDecisionTokenIssuer() {
  const secret = crypto.randomBytes(32);
  const sign = (request) => crypto
    .createHmac("sha256", secret)
    .update(`${request.requestId}\0${request.requestedAt}`)
    .digest("base64url")
    .slice(0, 32);
  return { issue: sign, verify: (request, token) => typeof token === "string" && token.length === 32 && timingSafeEqual(sign(request), token) };
}

function timingSafeEqual(left, right) {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function readWorkbook(root, relativePath) {
  try {
    return (await readCsvRecords(root, relativePath)).records;
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function splitRefs(value) {
  return String(value ?? "").split("|").map((item) => item.trim()).filter(Boolean);
}

function isPlaceholder(value) {
  return !value || /^<.*>$/.test(String(value).trim());
}
