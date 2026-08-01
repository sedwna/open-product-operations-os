import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { applyWrites, planWrites } from "../file-writer.js";
import { assertNoLinkTraversal, resolveInside } from "../paths.js";
import { assertContract, contractDigest, json, readContract, safeContractId } from "./contracts.js";
import { loadDevelopmentConfig, validateDevelopmentConfig } from "./config.js";

export async function completeDevelopmentResult(root, resultFile, { dryRun = true } = {}) {
  const config = await loadDevelopmentConfig(root);
  const configErrors = validateDevelopmentConfig(config);
  if (configErrors.length) throw new Error(`Development configuration is invalid:\n- ${configErrors.join("\n- ")}`);
  const result = await readContract(resultFile, "engineering-result.schema.json", "Engineering result");
  const requestPath = path.join(root, config.sync.inbox, `${result.requestId}.json`);
  const planPath = path.join(root, ".development-os", "plans", `${result.planId}.json`);
  const [request, plan] = await Promise.all([
    readContract(requestPath, "development-request.schema.json", "Stored development request"),
    readContract(planPath, "engineering-plan.schema.json", "Stored engineering plan")
  ]);
  validateResultRelationships(result, request, plan, config);
  await validateCompletionEvidence(root, result, plan, config);
  const digest = contractDigest(result);
  const suffix = safeContractId(result.resultId.replace(/^ENGRESULT-/, ""), "Result ID");
  const storedAt = `${config.sync.outbox}/${result.resultId}.json`;
  const receipt = {
    schemaVersion: "1.0.0",
    receiptId: `SYNC-OUT-${suffix}`,
    direction: "development_to_product",
    contractType: "engineering_result",
    contractId: result.resultId,
    contractDigest: digest,
    sourceRevision: result.implementationRevision,
    storedAt,
    createdAt: result.completedAt
  };
  assertContract(receipt, "development-sync-receipt.schema.json", "Development sync receipt");
  const operations = await planWrites(path.resolve(root), new Map([
    [storedAt, json(result)],
    [`${config.sync.outbox}/${result.resultId}.receipt.json`, json(receipt)],
    [`${config.sync.receipts}/${receipt.receiptId}.json`, json(receipt)]
  ]), {});
  if (!dryRun) await applyWrites(path.resolve(root), operations);
  return { dryRun, result, digest, receipt, operations };
}

export function validateResultRelationships(result, request, plan, config) {
  const errors = [];
  const expectedDigest = contractDigest(request);
  if (result.requestId !== request.requestId || plan.requestId !== request.requestId) errors.push("Request identity does not match across request, plan, and result.");
  if (result.productTaskId !== request.productTaskId) errors.push("Engineering result productTaskId does not match the approved request.");
  if (result.planId !== plan.planId) errors.push("Engineering result planId does not match the stored plan.");
  if (result.planDigest !== contractDigest(plan)) errors.push("Engineering result plan digest does not match the stored plan.");
  if (result.sourceDigest !== expectedDigest || plan.sourceDigest !== expectedDigest) errors.push("Source digest does not match the canonical approved request.");
  const roleActors = new Set(config.roles.map((role) => role.actorId));
  const verifierActor = config.roles.find((role) => role.id === "ENG-15")?.actorId;
  if (!roleActors.has(result.producerActorId)) errors.push("Engineering result producer is not a configured engineering actor.");
  if (result.verification.verifierActorId !== verifierActor) errors.push("Engineering result must be verified by the configured ENG-15 actor.");
  if (result.producerActorId === result.verification.verifierActorId) errors.push("Engineering producer and verifier actors must be distinct.");
  const gateResults = new Map(result.gateResults.map((gate) => [gate.gateId, gate]));
  if (gateResults.size !== result.gateResults.length) errors.push("Engineering result contains duplicate quality-gate results.");
  for (const gateId of plan.qualityGates) {
    const gate = gateResults.get(gateId);
    if (!gate) errors.push(`Engineering result is missing planned quality gate ${gateId}.`);
    if (result.status === "implementation_complete" && gate?.status !== "passed") {
      errors.push(`Completed implementation requires ${gateId} to pass.`);
    }
  }
  for (const gateId of gateResults.keys()) {
    if (!plan.qualityGates.includes(gateId)) errors.push(`Engineering result includes unplanned quality gate ${gateId}.`);
  }
  if (result.status === "implementation_complete" && result.verification.disposition !== "verified") {
    errors.push("Completed implementation requires an independent verified disposition.");
  }
  if (result.status === "implementation_complete" && result.implementationReferences.length === 0) {
    errors.push("Completed implementation requires at least one implementation reference.");
  }
  if (result.status === "implementation_complete" && result.changedComponents.length === 0) {
    errors.push("Completed implementation requires at least one changed component.");
  }
  const runIds = new Set(result.workstreamRuns.map((run) => run.workstreamId));
  if (runIds.size !== result.workstreamRuns.length) errors.push("Engineering result contains duplicate workstream run references.");
  if (result.status === "implementation_complete") {
    for (const workstream of plan.workstreams) {
      if (!runIds.has(workstream.id)) errors.push(`Completed implementation is missing run evidence for ${workstream.id}.`);
    }
    for (const runId of runIds) {
      if (!plan.workstreams.some((workstream) => workstream.id === runId)) errors.push(`Engineering result includes unplanned workstream run ${runId}.`);
    }
    if (result.evidence.length === 0) errors.push("Completed implementation requires content-addressed evidence artifacts.");
  }
  const evidencePaths = new Set(result.evidence.map((artifact) => artifact.path));
  if (evidencePaths.size !== result.evidence.length) errors.push("Engineering result contains duplicate evidence paths.");
  for (const artifact of result.evidence) {
    if (artifact.sourceRevision !== result.implementationRevision) errors.push(`Evidence ${artifact.path} does not target the implementation revision.`);
  }
  for (const gate of result.gateResults) {
    for (const reference of gate.evidenceReferences) {
      if (!evidencePaths.has(reference)) errors.push(`Quality gate ${gate.gateId} references unknown evidence ${reference}.`);
    }
  }
  for (const reference of result.verification.evidenceReferences) {
    if (!evidencePaths.has(reference)) errors.push(`Independent verification references unknown evidence ${reference}.`);
  }
  if (errors.length) throw new Error(`Engineering result relationships are invalid:\n- ${errors.join("\n- ")}`);
}

async function validateCompletionEvidence(root, result, plan, config) {
  if (result.status !== "implementation_complete") return;
  const evidenceRoot = resolveInside(root, ".development-os/evidence", "Engineering evidence root");
  const runReferences = new Map(result.workstreamRuns.map((run) => [run.workstreamId, run]));
  for (const workstream of plan.workstreams) {
    const reference = runReferences.get(workstream.id);
    if (!reference) continue;
    const run = await readContract(
      path.join(root, ".development-os", "runs", `${plan.planId}-${workstream.id}-result.json`),
      "engineering-workstream-run.schema.json",
      `Engineering workstream run ${workstream.id}`
    );
    const expectedActor = config.roles.find((role) => role.id === workstream.ownerRole)?.actorId;
    const mismatches = [];
    if (run.planId !== plan.planId) mismatches.push("planId");
    if (run.workstreamId !== workstream.id) mismatches.push("workstreamId");
    if (run.ownerRole !== workstream.ownerRole) mismatches.push("ownerRole");
    if (run.producerActorId !== expectedActor) mismatches.push("producerActorId");
    if (run.status !== "completed") mismatches.push("status");
    if (run.implementationRevision !== result.implementationRevision) mismatches.push("implementationRevision");
    if (contractDigest(run) !== reference.runDigest) mismatches.push("runDigest");
    if (mismatches.length) throw new Error(`Engineering workstream run ${workstream.id} mismatches ${mismatches.join(", ")}.`);
  }
  for (const artifact of result.evidence) {
    const normalized = artifact.path.replaceAll("\\", "/");
    if (!normalized.startsWith(".development-os/evidence/")) throw new Error(`Evidence path is outside the managed evidence boundary: ${artifact.path}.`);
    const evidenceRelative = normalized.slice(".development-os/evidence/".length);
    const absolute = resolveInside(evidenceRoot, evidenceRelative, "Engineering evidence path");
    await assertNoLinkTraversal(evidenceRoot, absolute, "Engineering evidence path");
    const stat = await fs.lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Engineering evidence is not a regular file: ${artifact.path}.`);
    const digest = crypto.createHash("sha256").update(await fs.readFile(absolute)).digest("hex");
    if (digest !== artifact.sha256) throw new Error(`Engineering evidence digest mismatch: ${artifact.path}.`);
  }
}

export async function loadStoredResultContext(root, result) {
  const config = await loadDevelopmentConfig(root);
  const [request, plan] = await Promise.all([
    readContract(path.join(root, config.sync.inbox, `${result.requestId}.json`), "development-request.schema.json", "Stored development request"),
    readContract(path.join(root, ".development-os", "plans", `${result.planId}.json`), "engineering-plan.schema.json", "Stored engineering plan")
  ]);
  return { config, request, plan };
}
