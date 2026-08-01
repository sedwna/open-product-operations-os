import fs from "node:fs/promises";
import path from "node:path";
import { applyWrites, planWrites } from "../file-writer.js";
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
  if (result.sourceDigest !== expectedDigest || plan.sourceDigest !== expectedDigest) errors.push("Source digest does not match the canonical approved request.");
  const roleActors = new Set(config.roles.map((role) => role.actorId));
  const verifierActor = config.roles.find((role) => role.id === "ENG-15")?.actorId;
  if (!roleActors.has(result.producerActorId)) errors.push("Engineering result producer is not a configured engineering actor.");
  if (result.verification.verifierActorId !== verifierActor) errors.push("Engineering result must be verified by the configured ENG-15 actor.");
  if (result.producerActorId === result.verification.verifierActorId) errors.push("Engineering producer and verifier actors must be distinct.");
  const gateResults = new Map(result.gateResults.map((gate) => [gate.gateId, gate]));
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
  if (errors.length) throw new Error(`Engineering result relationships are invalid:\n- ${errors.join("\n- ")}`);
}

export async function loadStoredResultContext(root, result) {
  const config = await loadDevelopmentConfig(root);
  const [request, plan] = await Promise.all([
    readContract(path.join(root, config.sync.inbox, `${result.requestId}.json`), "development-request.schema.json", "Stored development request"),
    readContract(path.join(root, ".development-os", "plans", `${result.planId}.json`), "engineering-plan.schema.json", "Stored engineering plan")
  ]);
  return { config, request, plan };
}
