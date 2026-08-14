import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { APPROVAL_STORE_FILE } from "../constants.js";
import { parseCsv } from "../csv.js";
import { applyLocalWrite } from "../local-writer.js";
import { canonicalRecordKeys } from "../workbook-contract.js";
import { loadApprovals } from "./approvals.js";
import { loadTaskboard } from "./taskboard.js";

/**
 * Project attributed human approvals into the decision log through the controlled writer.
 *
 * The approval registry is the authority for routing, while the decision log is the canonical
 * product record other rows reference. Leaving the latter at pending_human after the former is
 * approved makes every correctly linked issue fail validation. This function joins them by event,
 * cites the approval bytes as human-authority evidence, and updates only an unambiguous pending row.
 */
export async function synchronizeDecisionApprovals(root, config) {
  const approvals = await loadApprovals(root);
  const { records: tasks } = await loadTaskboard(root);
  const decisionSheet = config.workbook.sheets.find((sheet) => sheet.key === "decision_log");
  if (!decisionSheet) return { synchronized: 0, skipped: [], receipts: [] };

  const file = path.join(root, decisionSheet.file);
  const parsed = parseCsv(await fs.readFile(file, "utf8")).filter((row) => row.some((cell) => cell !== ""));
  const header = parsed[0] ?? decisionSheet.columns;
  const rows = parsed.slice(1);
  const value = (row, field) => row[header.indexOf(field)] ?? "";
  const approvalBytes = await fs.readFile(path.join(root, APPROVAL_STORE_FILE));
  const approvalSha256 = sha256(approvalBytes);
  const receipts = [];
  const skipped = [];

  for (const approval of approvals.requests.filter((request) =>
    request.gate === "product_direction_or_priority"
      && request.status === "approved"
      && request.decidedByActorId
      && request.decidedAt)) {
    const task = tasks.find((candidate) => candidate.task_id === approval.taskId);
    if (!task) {
      skipped.push({ requestId: approval.requestId, reason: "task_not_found" });
      continue;
    }
    const matches = rows.filter((row) =>
      value(row, "event_id") === task.event_id
        && value(row, "status") === "pending_human");
    if (matches.length === 0) {
      skipped.push({ requestId: approval.requestId, reason: "no_pending_projection" });
      continue;
    }
    if (matches.length > 1) {
      throw new Error(`Approval ${approval.requestId} matches ${matches.length} pending decision rows for ${task.event_id}; projection is ambiguous.`);
    }

    const row = matches[0];
    const keyFields = canonicalRecordKeys(decisionSheet.key);
    const key = Object.fromEntries(keyFields.map((field) => [field, value(row, field)]));
    const conditions = unique([approval.rationale, ...(approval.conditions ?? [])]).join(" | ");
    const changes = clean({
      status: approval.status,
      selected_option: approval.selectedOption ?? approval.status,
      decision_maker_actor_id: approval.decidedByActorId,
      decided_at: approval.decidedAt,
      brief_reference: APPROVAL_STORE_FILE,
      evidence_refs: approval.requestId,
      conditions
    });
    const preconditions = Object.fromEntries(Object.keys(changes).map((field) => [field, value(row, field)]));
    const protectedFields = new Set([
      ...config.fieldAuthority.protectedDevelopmentFields,
      ...config.fieldAuthority.protectedHumanFields
    ]);
    const actor = (role) => config.agents.find((candidate) => candidate.id === role)?.actorId ?? "";
    const manifest = {
      schemaVersion: "1.0.0",
      manifestId: `WFM-${approval.requestId}-decision-projection`,
      eventId: task.event_id,
      status: "authorized",
      semanticOwner: { role: decisionSheet.owner, actorId: actor(decisionSheet.owner) },
      authorization: {
        ownerActorId: actor(decisionSheet.owner),
        authorizedByActorId: config.project.humanAuthorityActorId,
        authorizedAt: approval.decidedAt,
        ownerConfirmed: true,
        humanProductionAuthorizationId: "not_applicable",
        authorityEvidence: [{
          kind: "human_approval",
          reference: APPROVAL_STORE_FILE,
          recordId: approval.requestId,
          sha256: approvalSha256
        }]
      },
      writer: { role: config.separation.writerRole, actorId: actor(config.separation.writerRole) },
      target: { systemAlias: "local-product-workbook", environment: "local", file: decisionSheet.file },
      scope: {
        sheet: decisionSheet.name,
        keyFields,
        allowedFields: Object.keys(changes),
        prohibitedFields: unique([
          ...keyFields,
          ...decisionSheet.columns.filter((field) => protectedFields.has(field) && !(field in changes))
        ]),
        rows: [{ operation: "update", key, preconditions, changes }]
      },
      controls: {
        dryRunRequired: true,
        smallestBoundedRange: "one attributed human decision projection",
        fullRecordReadbackRequired: true,
        secondReadPath: "local CSV reopen",
        replayMustWriteZero: true,
        rollbackPlan: "Restore the content-addressed pre-write CSV backup after verifying its recorded digest.",
        refuseIfEnvironmentAmbiguous: true,
        refuseIfPreconditionMismatch: true,
        secretValuesForbidden: true
      },
      createdAt: approval.decidedAt
    };
    const preview = await applyLocalWrite(root, manifest, config, { dryRun: true });
    const receipt = await applyLocalWrite(root, manifest, config, {
      dryRun: false,
      approvedPlanHash: preview.planHash
    });
    receipts.push({ requestId: approval.requestId, decisionId: key.decision_id, receipt: receipt.receiptFile });
  }
  return { synchronized: receipts.length, skipped, receipts };
}

function clean(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== "" && item !== null && item !== undefined));
}

function unique(values) {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
