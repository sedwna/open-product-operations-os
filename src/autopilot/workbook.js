import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { applyLocalWrite, rollbackLocalWrite } from "../local-writer.js";
import { canonicalRecordKeys } from "../workbook-contract.js";
import { APPROVAL_STORE_FILE } from "../constants.js";
import { loadApprovals } from "../runtime/approvals.js";

export async function materializeCycleWorkbook(root, config, { cycleId, intake, tasks, runs, now }) {
  const ids = cycleIds(cycleId);
  const actor = (role) => config.agents.find((candidate) => candidate.id === role)?.actorId ?? "";
  const run = (role) => runs.find((candidate) => candidate.roleId === role);
  const engineering = run("RB-13");
  const evidencePath = engineering?.evidence?.find((candidate) => candidate.startsWith(".product-ops/"))
    ?? `.product-ops/runtime/autopilot/product-runs/${engineering?.taskId}.json`;
  const evidenceFile = path.join(root, evidencePath);
  const evidenceBytes = await fs.readFile(evidenceFile);
  const risk = intake.priority === "P0" ? "critical" : intake.priority === "P1" ? "high" : "medium";
  const timestamp = now.toISOString();
  const approvals = await loadApprovals(root);
  const directionTask = tasks.find((task) => task.human_gate === "product_direction_or_priority");
  const directionApproval = approvals.requests.find((item) =>
    item.taskId === directionTask?.task_id && item.gate === "product_direction_or_priority" && item.status === "approved"
  );
  if (!directionApproval?.decidedByActorId || !directionApproval.decidedAt) {
    throw new Error("Cycle workbook cannot advance to issue and delivery records without an attributed product-direction decision.");
  }
  const approvalBytes = await fs.readFile(path.join(root, APPROVAL_STORE_FILE));
  const humanAuthorityEvidence = [{
    kind: "human_approval",
    reference: APPROVAL_STORE_FILE,
    recordId: directionApproval.requestId,
    sha256: sha256(approvalBytes)
  }];
  const acceptance = unique(runs.flatMap((candidate) => candidate.acceptanceCriteria ?? []).map((item) => item.statement)).join(" | ");
  const risks = unique(runs.flatMap((candidate) => candidate.knownRisks ?? [])).join(" | ") || "none recorded";
  const records = [
    record("events", { event_id: intake.eventId }, {
      event_type: intake.type, title: intake.title, status: "closed", priority: intake.priority, risk,
      source_id: intake.intakeId, coordinator_role: "RB-01", coordinator_actor_id: actor("RB-01"),
      semantic_owner_roles: "RB-02|RB-06|RB-09|RB-11", writer_role: "RB-10", verifier_role: "RB-12",
      producer_actor_id: actor("RB-01"), verifier_actor_id: actor("RB-12"), human_gates: "product_direction_or_priority|development-export",
      affected_systems: "product-operations|application", rollback_boundary: "local Git branches and controlled workbook receipts",
      evidence_requirements: "product analysis|engineering gates|independent verification", opened_at: intake.createdAt, closed_at: timestamp
    }),
    record("idea_inbox", { idea_id: ids.idea }, {
      event_id: intake.eventId, submitted_at: intake.createdAt, submitted_by: intake.source,
      problem_or_opportunity: intake.description, target_user: intake.targetUser || "configured target users",
      expected_outcome: run("RB-02")?.recommendations?.[0] ?? intake.title, source_reference: intake.intakeId,
      status: "decided", priority: intake.priority, triage_owner_role: "RB-02", discovery_id: ids.discovery, decision_id: ids.decision,
      notes: "Autonomous cycle authorized by local owner submission."
    }),
    record("discovery", { discovery_id: ids.discovery }, {
      event_id: intake.eventId, idea_id: ids.idea, status: "complete", owner_role: "RB-03", owner_actor_id: actor("RB-03"),
      question: intake.title, method: "bounded agent analysis of owner-supplied input", source_refs: intake.intakeId,
      key_findings: (run("RB-03")?.findings ?? []).join(" | ") || "No separate discovery finding was recorded.",
      limitations: (run("RB-03")?.knownRisks ?? []).join(" | ") || "No external user research was claimed.",
      recommendation: run("RB-03")?.recommendations?.[0] ?? "Proceed through the approved delivery route.", decision_id: ids.decision,
      producer_actor_id: actor("RB-03"), verifier_actor_id: actor("RB-12"), qc_record_id: ids.qc,
      started_at: intake.createdAt, completed_at: timestamp
    }),
    record("decision_log", { decision_id: ids.decision }, {
      event_id: intake.eventId,
      title: directionApproval.question,
      status: "approved",
      selected_option: "approved",
      decision_maker_actor_id: directionApproval.decidedByActorId,
      decided_at: directionApproval.decidedAt,
      brief_reference: APPROVAL_STORE_FILE,
      evidence_refs: directionApproval.requestId,
      risk_acceptance: "none",
      conditions: directionApproval.rationale ?? "Bounded local autonomous delivery only; production remains separately gated.",
      resulting_task_ids: tasks.map((task) => task.task_id).join("|")
    }, { authorityEvidence: humanAuthorityEvidence }),
    record("issues", { issue_id: ids.issue }, {
      event_id: intake.eventId, title: intake.title, status: "validated", priority: intake.priority, risk,
      source_ids: `${intake.intakeId}|${ids.idea}`, affected_user: intake.targetUser || "configured target users",
      current_behavior: intake.description, expected_behavior: run("RB-05")?.recommendations?.[0] ?? intake.title,
      impact: (run("RB-05")?.findings ?? []).join(" | ") || "Approved product outcome",
      evidence_refs: evidencePath, decision_id: ids.decision, ticket_ids: ids.ticket, result_ids: ids.validationResult,
      closure_disposition: "validated by completed autonomous cycle", owner_role: "RB-05", owner_actor_id: actor("RB-05"), updated_at: timestamp
    }),
    record("delivery_tickets", { ticket_id: ids.ticket }, {
      event_id: intake.eventId, issue_id: ids.issue, decision_id: ids.decision, title: intake.title, status: "accepted", priority: intake.priority, risk,
      outcome: run("RB-06")?.recommendations?.[0] ?? intake.title, scope: (run("RB-06")?.impacts ?? []).join("|"),
      non_goals: "production deployment|destructive operations|production data", acceptance_criteria: acceptance,
      dependencies: tasks.find((task) => task.owner_role === "RB-13")?.dependency_ids ?? "",
      write_boundary: "application development-os.config.json policies.allowedPaths", validation_plan_id: ids.validationPlan,
      owner_role: "RB-06", owner_actor_id: actor("RB-06"), development_adapter_role: "RB-13", updated_at: timestamp
    }),
    record("validation_plans", { plan_id: ids.validationPlan }, {
      event_id: intake.eventId, ticket_id: ids.ticket, status: "complete", risk,
      objective: "Verify the approved product and engineering contract.", claims: acceptance,
      entry_criteria: "implementation and engineering evidence returned", exit_criteria: "quality gates and independent verification passed",
      stop_conditions: "unsupported material claim|failed required gate", scenario_ids: ids.validationScenario,
      environment_alias: "local", data_set: "synthetic or repository-local fixtures", evidence_contract: evidencePath,
      human_gate: "none", design_owner_role: "RB-07", design_owner_actor_id: actor("RB-07"), execution_owner_role: "RB-09",
      verifier_role: "RB-12", verifier_actor_id: actor("RB-12"), approved_at: timestamp
    }),
    record("validation_scenarios", { scenario_id: ids.validationScenario }, {
      plan_id: ids.validationPlan, event_id: intake.eventId, ticket_id: ids.ticket, status: "ready",
      claim_or_ac_ids: acceptance, preconditions: "implementation and synchronized evidence available",
      steps: "run repository validation|inspect engineering gates|reproduce independent checks",
      expected_outcomes: acceptance, evidence_required: evidencePath,
      edge_cases: "failure|retry|partial evidence|rollback", pass_rule: "all required claims supported",
      fail_rule: "any material unsupported claim", stop_condition: "unsafe or production-only action required",
      owner_role: "RB-07", owner_actor_id: actor("RB-07")
    }),
    record("validation_runs", { run_id: ids.validationRun }, {
      plan_id: ids.validationPlan, scenario_id: ids.validationScenario, event_id: intake.eventId, ticket_id: ids.ticket,
      status: "completed", executor_role: "RB-09", executor_actor_id: actor("RB-09"), environment_alias: "local",
      data_set: "synthetic or repository-local fixtures", started_at: timestamp, ended_at: timestamp,
      actual_observation: run("RB-09")?.summary ?? "Product QA route completed.", evidence_manifest_id: ids.evidenceManifest,
      cleanup_state: "no production resources created", result_id: ids.validationResult,
      known_limitations: (run("RB-09")?.knownRisks ?? []).join(" | ") || "none recorded"
    }),
    record("validation_results", { result_id: ids.validationResult }, {
      run_id: ids.validationRun, plan_id: ids.validationPlan, scenario_id: ids.validationScenario, event_id: intake.eventId,
      ticket_id: ids.ticket, disposition: "pass", expected: acceptance,
      observed: run("RB-09")?.summary ?? "Required evidence route completed.", difference: "none recorded",
      decisive_evidence_ids: ids.evidence, producer_role: "RB-09", producer_actor_id: actor("RB-09"),
      verifier_role: "RB-12", verifier_actor_id: actor("RB-12"), qc_record_id: ids.qc,
      issue_status_implication: "validated", ticket_status_implication: "accepted", recorded_at: timestamp
    }),
    record("evidence", { evidence_item_id: ids.evidence }, {
      evidence_manifest_id: ids.evidenceManifest, event_id: intake.eventId, run_id: ids.validationRun,
      result_id: ids.validationResult, status: "captured", claim_or_step_ids: engineering?.taskId ?? ids.ticket,
      artifact_type: "application/json", canonical_path: evidencePath, capture_method: "content-addressed development synchronization",
      captured_at: timestamp, environment_alias: "local", media_type: "application/json", byte_length: evidenceBytes.length,
      sha256: sha256(evidenceBytes), decisive: true, limitation: "local evidence; no production deployment claim",
      contains_sensitive_material: false, secret_scan_passed: true
    }),
    record("qc_log", { qc_record_id: ids.qc }, {
      event_id: intake.eventId, task_id: run("RB-12")?.taskId ?? engineering?.taskId, artifact_ids: ids.evidence,
      producer_role: "RB-09", producer_actor_id: actor("RB-09"), verifier_role: "RB-12", verifier_actor_id: actor("RB-12"),
      disposition: "pass", claims_reproduced: run("RB-12")?.summary ?? "Independent product verification completed.",
      canonical_revision: cycleId, development_reference: evidencePath, evidence_refs: evidencePath,
      gap_or_failure: "none recorded", verified_at: timestamp
    }),
    record("releases", { release_id: ids.release }, {
      readiness_id: ids.readiness, event_id: intake.eventId, status: "planned", target_environment: "local",
      ticket_ids: ids.ticket, implementation_refs: evidencePath,
      rollback_reference: "Application Git cycle branch and content-addressed controlled-write backups",
      writer_receipt_ids: "pending audit projection", health_check_refs: evidencePath,
      residual_risks: risks, follow_up_task_ids: run("RB-11")?.taskId ?? "none",
      owner_role: "RB-11", owner_actor_id: actor("RB-11")
    }),
    record("readiness", { readiness_id: ids.readiness }, {
      event_id: intake.eventId, ticket_ids: ids.ticket, status: "conditionally_ready", target_environment: "local",
      required_gate_ids: "product-analysis|engineering-quality|independent-verification",
      satisfied_gate_ids: "product-analysis|engineering-quality|independent-verification", blocking_ids: "human-risk-acceptance|manual-browser-validation|release-authorization",
      residual_risks: risks, rollback_reference: "Git cycle branches and controlled workbook backups",
      release_id: ids.release,
      owner_role: "RB-11", owner_actor_id: actor("RB-11"), producer_actor_id: actor("RB-11"),
      verifier_actor_id: actor("RB-12"), qc_record_id: ids.qc, assessed_at: timestamp
    }),
    record("lineage", { lineage_edge_id: ids.lineage }, {
      event_id: intake.eventId, from_id: ids.idea, from_type: "idea", relationship: "delivered_as",
      to_id: ids.ticket, to_type: "delivery_ticket", canonical_reference: evidencePath,
      created_at: timestamp, created_by_role: "RB-01"
    }),
  ];

  const prepared = [];
  for (const item of records) {
    const manifest = buildInsertManifest(config, item.sheetKey, intake.eventId, item.key, item.changes, timestamp, cycleId, item.options);
    const directory = path.join(root, ".product-ops", "runtime", "autopilot", "manifests");
    await fs.mkdir(directory, { recursive: true });
    const manifestFile = path.join(directory, `${manifest.manifestId}.json`);
    await writeJsonEqual(manifestFile, manifest);
    prepared.push({ manifest, manifestFile });
  }
  const receipts = [];
  for (const item of prepared) {
    await registerManifestAudit(root, config, item.manifest, cycleId, timestamp);
    const preview = await applyLocalWrite(root, item.manifest, config, { dryRun: true });
    const receipt = await applyLocalWrite(root, item.manifest, config, { dryRun: false, approvedPlanHash: preview.planHash });
    try {
      await registerReceiptAudit(root, config, item.manifest, receipt, cycleId, timestamp, ids.qc);
    } catch (error) {
      if (!receipt.replay && receipt.receiptFile) await rollbackLocalWrite(root, receipt.receiptFile).catch(() => {});
      throw new Error(`Controlled write audit registration failed closed for ${item.manifest.manifestId}: ${error.message}`, { cause: error });
    }
    receipts.push(receipt.receiptFile);
  }
  return {
    manifests: prepared.map((item) => path.relative(root, item.manifestFile).replaceAll("\\", "/")),
    receipts
  };
}

async function registerManifestAudit(root, config, manifest, cycleId, timestamp) {
  const actor = (role) => config.agents.find((candidate) => candidate.id === role)?.actorId ?? "";
  const row = record("writer_manifests", { write_manifest_id: manifest.manifestId }, {
    event_id: manifest.eventId, status: "authorized",
    semantic_owner_role: manifest.semanticOwner.role, semantic_owner_actor_id: manifest.semanticOwner.actorId,
    authorized_by_actor_id: manifest.authorization.authorizedByActorId, authorized_at: manifest.authorization.authorizedAt,
    writer_role: manifest.writer.role, writer_actor_id: manifest.writer.actorId,
    target_system_alias: manifest.target.systemAlias, target_environment: manifest.target.environment,
    record_or_tab: manifest.scope.sheet, key_fields: manifest.scope.keyFields.join("|"),
    allowed_fields: manifest.scope.allowedFields.join("|"), prohibited_fields: manifest.scope.prohibitedFields.join("|"),
    bounded_range: manifest.controls.smallestBoundedRange,
    preconditions_hash: sha256(JSON.stringify(manifest.scope.rows.map((item) => item.preconditions))),
    changes_hash: sha256(JSON.stringify(manifest.scope.rows.map((item) => item.changes))),
    second_read_path: manifest.controls.secondReadPath, rollback_plan: manifest.controls.rollbackPlan
  });
  await applyAuditProjection(root, config, row, `${cycleId}-audit-manifest-${manifest.manifestId}`, timestamp);
}

async function registerReceiptAudit(root, config, manifest, receiptResult, cycleId, timestamp, qcRecordId) {
  const receipt = receiptResult.replay
    ? JSON.parse(await fs.readFile(path.join(root, receiptResult.receiptFile), "utf8"))
    : receiptResult;
  const actor = (role) => config.agents.find((candidate) => candidate.id === role)?.actorId ?? "";
  const receiptId = `WRC-${manifest.manifestId.replace(/^WFM-/, "")}`;
  const row = record("writer_receipts", { write_receipt_id: receiptId }, {
    write_manifest_id: manifest.manifestId, event_id: manifest.eventId,
    status: receiptResult.replay ? "replay_verified" : "verified",
    writer_role: manifest.writer.role, writer_actor_id: manifest.writer.actorId,
    target_system_alias: manifest.target.systemAlias, target_environment: manifest.target.environment,
    canonical_revision: receipt.afterSha256, records_attempted: 1, records_changed: receipt.recordsChanged,
    records_unchanged: receiptResult.replay ? 1 : 0, preconditions_match: true,
    full_readback_match: receipt.fullReadbackMatch, second_read_match: receipt.secondReadMatch,
    unexpected_differences: "none", replay_writes: receipt.replayWrites,
    rollback_tested: receipt.rolledBack ? true : "not_applicable", evidence_refs: receiptResult.receiptFile,
    verifier_role: "RB-12", verifier_actor_id: actor("RB-12"), qc_record_id: qcRecordId, completed_at: receipt.createdAt
  });
  await applyAuditProjection(root, config, row, `${cycleId}-audit-receipt-${manifest.manifestId}`, timestamp);
}

async function applyAuditProjection(root, config, item, cycleId, timestamp) {
  const manifest = buildInsertManifest(config, item.sheetKey, item.changes.event_id, item.key, item.changes, timestamp, cycleId);
  const directory = path.join(root, ".product-ops", "runtime", "autopilot", "audit-manifests");
  await fs.mkdir(directory, { recursive: true });
  await writeJsonEqual(path.join(directory, `${manifest.manifestId}.json`), manifest);
  const preview = await applyLocalWrite(root, manifest, config, { dryRun: true });
  await applyLocalWrite(root, manifest, config, { dryRun: false, approvedPlanHash: preview.planHash });
}

export async function materializeWriterCheckpoint(root, config, { cycleId, intake, qaRun, now }) {
  const timestamp = now.toISOString();
  const suffix = safeId(cycleId).replace(/^CYCLE-EVT-/, "");
  const checkpointId = `LIN-WRITER-${suffix}`;
  const evidenceReference = `.product-ops/runtime/autopilot/product-runs/${qaRun.taskId}-result.json`;
  const item = record("lineage", { lineage_edge_id: checkpointId }, {
    event_id: intake.eventId,
    from_id: qaRun.taskId,
    from_type: "product_qa_run",
    relationship: "recorded_by_controlled_writer",
    to_id: cycleId,
    to_type: "operational_checkpoint",
    canonical_reference: evidenceReference,
    created_at: timestamp,
    created_by_role: "RB-10"
  });
  let manifest = buildInsertManifest(config, item.sheetKey, intake.eventId, item.key, item.changes, timestamp, `${cycleId}-writer-checkpoint`);
  const directory = path.join(root, ".product-ops", "runtime", "autopilot", "manifests");
  await fs.mkdir(directory, { recursive: true });
  const manifestFile = path.join(directory, `${manifest.manifestId}.json`);
  const existing = await readJsonOptional(manifestFile);
  if (existing) {
    const row = existing.scope?.rows?.[0];
    const reusable = existing.manifestId === manifest.manifestId
      && existing.eventId === intake.eventId
      && existing.writer?.role === "RB-10"
      && existing.target?.file === manifest.target.file
      && row?.key?.lineage_edge_id === checkpointId
      && row?.changes?.canonical_reference === evidenceReference;
    if (!reusable) throw new Error(`Writer checkpoint manifest already exists for a different cycle boundary: ${manifestFile}`);
    manifest = existing;
  } else {
    await writeJsonEqual(manifestFile, manifest);
  }
  const preview = await applyLocalWrite(root, manifest, config, { dryRun: true });
  const receipt = await applyLocalWrite(root, manifest, config, { dryRun: false, approvedPlanHash: preview.planHash });
  return {
    manifest: path.relative(root, manifestFile).replaceAll("\\", "/"),
    receipt: receipt.receiptFile,
    target: manifest.target.file,
    checkpointId
  };
}

async function readJsonOptional(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function buildInsertManifest(config, sheetKey, eventId, key, changes, timestamp, cycleId, { authorityEvidence = [] } = {}) {
  const sheet = config.workbook.sheets.find((candidate) => candidate.key === sheetKey);
  if (!sheet) throw new Error(`Unknown workbook sheet ${sheetKey}.`);
  const actor = (role) => config.agents.find((candidate) => candidate.id === role)?.actorId ?? "";
  const protectedFields = new Set([...config.fieldAuthority.protectedDevelopmentFields, ...config.fieldAuthority.protectedHumanFields]);
  const keyFields = canonicalRecordKeys(sheetKey);
  const protectedHumanAllowed = authorityEvidence.some((item) => item.kind === "human_approval")
    ? new Set(config.fieldAuthority.protectedHumanFields)
    : new Set();
  const protectedDevelopmentAllowed = authorityEvidence.some((item) => item.kind === "development_result")
    ? new Set(config.fieldAuthority.protectedDevelopmentFields)
    : new Set();
  const authorizedProtected = new Set([...protectedHumanAllowed, ...protectedDevelopmentAllowed]);
  const prohibitedFields = unique([...sheet.columns.filter((field) => protectedFields.has(field) && !authorizedProtected.has(field)), ...keyFields]);
  const allowedFields = Object.keys(changes).filter((field) => !keyFields.includes(field) && (!protectedFields.has(field) || authorizedProtected.has(field)));
  return {
    schemaVersion: "1.0.0",
    manifestId: boundedManifestId(`WFM-${safeId(cycleId)}-${sheetKey.replaceAll("_", "-")}-${safeId(Object.values(key).join("-"))}`),
    eventId,
    status: "authorized",
    semanticOwner: { role: sheet.owner, actorId: actor(sheet.owner) },
    authorization: {
      ownerActorId: actor(sheet.owner),
      authorizedByActorId: authorityEvidence.some((item) => item.kind === "human_approval")
        ? config.project.humanAuthorityActorId
        : actor(sheet.owner),
      authorizedAt: timestamp,
      ownerConfirmed: true, humanProductionAuthorizationId: "not_applicable", authorityEvidence
    },
    writer: { role: config.separation.writerRole, actorId: actor(config.separation.writerRole) },
    target: { systemAlias: "local-product-workbook", environment: "local", file: sheet.file },
    scope: {
      sheet: sheet.name,
      keyFields,
      allowedFields,
      prohibitedFields,
      rows: [{ operation: "insert", key, preconditions: { $record: "absent" }, changes }]
    },
    controls: {
      dryRunRequired: true, smallestBoundedRange: `one new ${sheetKey} record`, fullRecordReadbackRequired: true,
      secondReadPath: "local CSV reopen", replayMustWriteZero: true,
      rollbackPlan: "Restore the content-addressed pre-write CSV backup after verifying its recorded digest.",
      refuseIfEnvironmentAmbiguous: true, refuseIfPreconditionMismatch: true, secretValuesForbidden: true
    },
    createdAt: timestamp
  };
}

function record(sheetKey, key, changes, options = {}) { return { sheetKey, key, changes: clean(changes), options }; }
function clean(value) { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== "" && item !== null && item !== undefined)); }
function unique(values) { return [...new Set(values.filter(Boolean))]; }
function sha256(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function safeId(value) { return String(value).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80); }
function boundedManifestId(value) {
  if (value.length <= 80) return value;
  return `${value.slice(0, 60)}-${sha256(value).slice(0, 19)}`;
}
function cycleIds(cycleId) {
  const suffix = safeId(cycleId).replace(/^CYCLE-EVT-/, "");
  return {
    idea: `IDEA-${suffix}`, discovery: `DSC-${suffix}`, issue: `ISS-${suffix}`, ticket: `TKT-${suffix}`,
    validationPlan: `VPL-${suffix}`, validationScenario: `VSC-${suffix}`, validationRun: `VRN-${suffix}`,
    validationResult: `VRS-${suffix}`, evidenceManifest: `EVM-${suffix}`, evidence: `EVD-${suffix}`,
    qc: `QCV-${suffix}`, readiness: `RDY-${suffix}`, release: `REL-${suffix}`, decision: `DEC-${suffix}`, lineage: `LIN-${suffix}`
  };
}
async function writeJsonEqual(file, value) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  try { await fs.writeFile(file, content, { encoding: "utf8", flag: "wx" }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (await fs.readFile(file, "utf8") !== content) throw new Error(`Workbook manifest already exists with different content: ${file}`);
  }
}
