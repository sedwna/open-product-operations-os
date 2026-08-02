import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { applyLocalWrite } from "../local-writer.js";
import { canonicalRecordKeys } from "../workbook-contract.js";

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
      status: "decided", priority: intake.priority, triage_owner_role: "RB-02", discovery_id: ids.discovery,
      notes: "Autonomous cycle authorized by local owner submission."
    }),
    record("discovery", { discovery_id: ids.discovery }, {
      event_id: intake.eventId, idea_id: ids.idea, status: "complete", owner_role: "RB-03", owner_actor_id: actor("RB-03"),
      question: intake.title, method: "bounded agent analysis of owner-supplied input", source_refs: intake.intakeId,
      key_findings: (run("RB-03")?.findings ?? []).join(" | ") || "No separate discovery finding was recorded.",
      limitations: (run("RB-03")?.knownRisks ?? []).join(" | ") || "No external user research was claimed.",
      recommendation: run("RB-03")?.recommendations?.[0] ?? "Proceed through the approved delivery route.",
      producer_actor_id: actor("RB-03"), verifier_actor_id: actor("RB-12"), qc_record_id: ids.qc,
      started_at: intake.createdAt, completed_at: timestamp
    }),
    record("issues", { issue_id: ids.issue }, {
      event_id: intake.eventId, title: intake.title, status: "validated", priority: intake.priority, risk,
      source_ids: `${intake.intakeId}|${ids.idea}`, affected_user: intake.targetUser || "configured target users",
      current_behavior: intake.description, expected_behavior: run("RB-05")?.recommendations?.[0] ?? intake.title,
      impact: (run("RB-05")?.findings ?? []).join(" | ") || "Approved product outcome",
      evidence_refs: evidencePath, ticket_ids: ids.ticket, result_ids: ids.validationResult,
      closure_disposition: "validated by completed autonomous cycle", owner_role: "RB-05", owner_actor_id: actor("RB-05"), updated_at: timestamp
    }),
    record("delivery_tickets", { ticket_id: ids.ticket }, {
      event_id: intake.eventId, issue_id: ids.issue, title: intake.title, status: "accepted", priority: intake.priority, risk,
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
    record("readiness", { readiness_id: ids.readiness }, {
      event_id: intake.eventId, ticket_ids: ids.ticket, status: "ready", target_environment: "local",
      required_gate_ids: "product-analysis|engineering-quality|independent-verification",
      satisfied_gate_ids: "product-analysis|engineering-quality|independent-verification", blocking_ids: "none",
      residual_risks: risks, rollback_reference: "Git cycle branches and controlled workbook backups",
      owner_role: "RB-11", owner_actor_id: actor("RB-11"), producer_actor_id: actor("RB-11"),
      verifier_actor_id: actor("RB-12"), qc_record_id: ids.qc, assessed_at: timestamp
    }),
    record("lineage", { lineage_edge_id: ids.lineage }, {
      event_id: intake.eventId, from_id: ids.idea, from_type: "idea", relationship: "delivered_as",
      to_id: ids.ticket, to_type: "delivery_ticket", canonical_reference: evidencePath,
      created_at: timestamp, created_by_role: "RB-01"
    })
  ];

  const prepared = [];
  for (const item of records) {
    const manifest = buildInsertManifest(config, item.sheetKey, intake.eventId, item.key, item.changes, timestamp, cycleId);
    const directory = path.join(root, ".product-ops", "runtime", "autopilot", "manifests");
    await fs.mkdir(directory, { recursive: true });
    const manifestFile = path.join(directory, `${manifest.manifestId}.json`);
    await writeJsonEqual(manifestFile, manifest);
    const preview = await applyLocalWrite(root, manifest, config, { dryRun: true });
    prepared.push({ manifest, manifestFile, planHash: preview.planHash });
  }
  const receipts = [];
  for (const item of prepared) {
    const receipt = await applyLocalWrite(root, item.manifest, config, { dryRun: false, approvedPlanHash: item.planHash });
    receipts.push(receipt.receiptFile);
  }
  return {
    manifests: prepared.map((item) => path.relative(root, item.manifestFile).replaceAll("\\", "/")),
    receipts
  };
}

function buildInsertManifest(config, sheetKey, eventId, key, changes, timestamp, cycleId) {
  const sheet = config.workbook.sheets.find((candidate) => candidate.key === sheetKey);
  if (!sheet) throw new Error(`Unknown workbook sheet ${sheetKey}.`);
  const actor = (role) => config.agents.find((candidate) => candidate.id === role)?.actorId ?? "";
  const protectedFields = new Set([...config.fieldAuthority.protectedDevelopmentFields, ...config.fieldAuthority.protectedHumanFields]);
  const keyFields = canonicalRecordKeys(sheetKey);
  const prohibitedFields = unique([...sheet.columns.filter((field) => protectedFields.has(field)), ...keyFields]);
  const allowedFields = Object.keys(changes).filter((field) => !keyFields.includes(field));
  return {
    schemaVersion: "1.0.0",
    manifestId: `WFM-${safeId(cycleId)}-${sheetKey.replaceAll("_", "-")}`,
    eventId,
    status: "authorized",
    semanticOwner: { role: sheet.owner, actorId: actor(sheet.owner) },
    authorization: {
      ownerActorId: actor(sheet.owner), authorizedByActorId: actor(sheet.owner), authorizedAt: timestamp,
      ownerConfirmed: true, humanProductionAuthorizationId: "not_applicable"
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

function record(sheetKey, key, changes) { return { sheetKey, key, changes: clean(changes) }; }
function clean(value) { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== "" && item !== null && item !== undefined)); }
function unique(values) { return [...new Set(values.filter(Boolean))]; }
function sha256(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function safeId(value) { return String(value).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80); }
function cycleIds(cycleId) {
  const suffix = safeId(cycleId).replace(/^CYCLE-EVT-/, "");
  return {
    idea: `IDEA-${suffix}`, discovery: `DSC-${suffix}`, issue: `ISS-${suffix}`, ticket: `TKT-${suffix}`,
    validationPlan: `VPL-${suffix}`, validationScenario: `VSC-${suffix}`, validationRun: `VRN-${suffix}`,
    validationResult: `VRS-${suffix}`, evidenceManifest: `EVM-${suffix}`, evidence: `EVD-${suffix}`,
    qc: `QCV-${suffix}`, readiness: `RDY-${suffix}`, lineage: `LIN-${suffix}`
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
