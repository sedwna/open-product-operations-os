import path from "node:path";
import { applyWrites, planWrites } from "../file-writer.js";
import { loadApprovals } from "../runtime/approvals.js";
import { dependencyState, loadTaskboard } from "../runtime/taskboard.js";
import { assertContract, contractDigest, json, readContract, safeContractId } from "./contracts.js";
import { createDevelopmentConfig } from "./generator.js";
import { buildPlan } from "./planner.js";

const PRODUCT_CONTRACT_ROOT = ".product-ops/runtime/development/contracts";

/**
 * `supersede` replaces a contract already in the outbox with a corrected one. It exists because a
 * contract that turns out to be wrong must be replaceable before anyone builds against it — and
 * must not be replaceable afterwards, which is the caller's judgement to make and state, not this
 * function's to guess.
 */
export async function exportDevelopmentRequest(root, config, taskId, requestFile, { dryRun = true, supersede = false } = {}) {
  const [{ byId }, approvals, request] = await Promise.all([
    loadTaskboard(root),
    loadApprovals(root),
    readContract(requestFile, "development-request.schema.json", "Development request")
  ]);
  const task = byId.get(taskId);
  if (!task) throw new Error(`Unknown task "${taskId}".`);
  if (task.owner_role !== config.separation.developmentRole) throw new Error(`Task "${taskId}" is not owned by the development boundary.`);
  if (!['ready', 'in_progress'].includes(task.status)) throw new Error(`Task "${taskId}" is not ready for development export.`);
  if (!dependencyState(task, byId).satisfied) throw new Error(`Task "${taskId}" has unresolved dependencies.`);
  if (request.productTaskId !== taskId) throw new Error("Development request productTaskId does not match the exported task.");
  if (request.approval.actorId !== config.project.humanAuthorityActorId) {
    throw new Error("Development request approval is not attributed to the configured human authority.");
  }
  const approval = approvals.requests.find((candidate) => candidate.requestId === request.approval.reference);
  const expectedGate = task.human_gate || "development-export";
  if (!approval || approval.taskId !== taskId || approval.gate !== expectedGate || approval.status !== "approved") {
    throw new Error(`Development request approval reference does not resolve to an approved ${expectedGate} record for task "${taskId}".`);
  }
  if (approval.decidedByActorId !== request.approval.actorId || approval.decidedAt !== request.approval.decidedAt) {
    throw new Error("Development request approval attribution does not match the canonical approval store.");
  }
  const digest = contractDigest(request);
  const suffix = safeContractId(request.requestId.replace(/^DEVREQ-/, ""), "Request ID");
  const storedAt = `${PRODUCT_CONTRACT_ROOT}/outbox/${request.requestId}.json`;
  const receipt = {
    schemaVersion: "1.0.0",
    receiptId: `SYNC-PRODUCT-OUT-${suffix}`,
    direction: "product_to_development",
    contractType: "development_request",
    contractId: request.requestId,
    contractDigest: digest,
    sourceRevision: request.source.productOperationsRevision,
    storedAt,
    createdAt: request.source.exportedAt
  };
  assertContract(receipt, "development-sync-receipt.schema.json", "Product development-export receipt");
  const operations = await planWrites(path.resolve(root), new Map([
    [storedAt, json(request)],
    [`${PRODUCT_CONTRACT_ROOT}/receipts/${receipt.receiptId}.json`, json(receipt)]
  ]), { force: supersede });
  if (!dryRun) await applyWrites(path.resolve(root), operations);
  return { dryRun, task, request, digest, receipt, operations };
}

export async function importEngineeringResult(root, resultFile, { dryRun = true } = {}) {
  const result = await readContract(resultFile, "engineering-result.schema.json", "Engineering result");
  const sourceReceiptFile = resultFile.endsWith(".json")
    ? `${resultFile.slice(0, -5)}.receipt.json`
    : `${resultFile}.receipt.json`;
  const sourceReceipt = await readContract(sourceReceiptFile, "development-sync-receipt.schema.json", "Development source receipt");
  const request = await readContract(
    path.join(root, PRODUCT_CONTRACT_ROOT, "outbox", `${result.requestId}.json`),
    "development-request.schema.json",
    "Previously exported development request"
  );
  const errors = [];
  const requestDigest = contractDigest(request);
  const expectedPlan = buildPlan(request, createDevelopmentConfig("application"), requestDigest);
  const expectedPlanDigest = contractDigest(expectedPlan);
  if (result.productTaskId !== request.productTaskId) errors.push("Engineering result productTaskId does not match the exported request.");
  if (result.sourceDigest !== requestDigest) errors.push("Engineering result source digest does not match the exported request.");
  if (result.planId !== expectedPlan.planId || result.planDigest !== expectedPlanDigest) errors.push("Engineering result does not match the deterministic plan for the exported request.");
  if (result.producerActorId === result.verification.verifierActorId) errors.push("Engineering result producer and verifier must be distinct.");
  const gateIds = result.gateResults.map((gate) => gate.gateId);
  if (new Set(gateIds).size !== gateIds.length || !sameSet(gateIds, expectedPlan.qualityGates)) {
    errors.push("Engineering result quality gates do not match the deterministic plan.");
  }
  const runIds = result.workstreamRuns.map((run) => run.workstreamId);
  if (new Set(runIds).size !== runIds.length || !sameSet(runIds, expectedPlan.workstreams.map((workstream) => workstream.id))) {
    errors.push("Engineering result workstream runs do not match the deterministic plan.");
  }
  const resultDigest = contractDigest(result);
  if (sourceReceipt.direction !== "development_to_product"
      || sourceReceipt.contractType !== "engineering_result"
      || sourceReceipt.contractId !== result.resultId
      || sourceReceipt.contractDigest !== resultDigest
      || sourceReceipt.sourceRevision !== result.implementationRevision) {
    errors.push("Engineering result source receipt does not match the transferred result.");
  }
  const verificationGate = result.gateResults.find((gate) => gate.gateId === "GATE-INDEPENDENT-VERIFICATION");
  if (result.status === "implementation_complete" && (result.verification.disposition !== "verified" || verificationGate?.status !== "passed")) {
    errors.push("Completed engineering work requires a passed independent-verification gate and verified disposition.");
  }
  if (result.status === "implementation_complete" && result.gateResults.some((gate) => gate.status !== "passed")) {
    errors.push("Completed engineering work cannot contain a failed, blocked, or not-applicable reported gate.");
  }
  if (result.status === "implementation_complete" && result.evidence.length === 0) {
    errors.push("Completed engineering work requires evidence references.");
  }
  if (errors.length) throw new Error(`Engineering result cannot be synchronized:\n- ${errors.join("\n- ")}`);
  const digest = resultDigest;
  const suffix = safeContractId(result.resultId.replace(/^ENGRESULT-/, ""), "Result ID");
  const storedAt = `${PRODUCT_CONTRACT_ROOT}/inbox/${result.resultId}.json`;
  const receipt = {
    schemaVersion: "1.0.0",
    receiptId: `SYNC-PRODUCT-IN-${suffix}`,
    direction: "development_to_product",
    contractType: "engineering_result",
    contractId: result.resultId,
    contractDigest: digest,
    sourceRevision: result.implementationRevision,
    storedAt,
    createdAt: result.completedAt
  };
  assertContract(receipt, "development-sync-receipt.schema.json", "Product development-import receipt");
  const operations = await planWrites(path.resolve(root), new Map([
    [storedAt, json(result)],
    [`${PRODUCT_CONTRACT_ROOT}/receipts/${receipt.receiptId}.json`, json(receipt)]
  ]), {});
  if (!dryRun) await applyWrites(path.resolve(root), operations);
  return { dryRun, request, result, sourceReceipt, digest, receipt, operations };
}

function sameSet(left, right) {
  return left.length === right.length && new Set(left).size === left.length && left.every((value) => right.includes(value));
}
