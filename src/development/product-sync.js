import path from "node:path";
import { applyWrites, planWrites } from "../file-writer.js";
import { loadApprovals } from "../runtime/approvals.js";
import { dependencyState, loadTaskboard } from "../runtime/taskboard.js";
import { assertContract, contractDigest, json, readContract, safeContractId } from "./contracts.js";

const PRODUCT_CONTRACT_ROOT = ".product-ops/runtime/development/contracts";

export async function exportDevelopmentRequest(root, config, taskId, requestFile, { dryRun = true } = {}) {
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
  if (task.human_gate && !approvals.requests.some((approval) => approval.taskId === taskId && approval.gate === task.human_gate && approval.status === "approved")) {
    throw new Error(`Task "${taskId}" requires an attributed human approval.`);
  }
  if (request.productTaskId !== taskId) throw new Error("Development request productTaskId does not match the exported task.");
  if (request.approval.actorId !== config.project.humanAuthorityActorId) {
    throw new Error("Development request approval is not attributed to the configured human authority.");
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
  ]), {});
  if (!dryRun) await applyWrites(path.resolve(root), operations);
  return { dryRun, task, request, digest, receipt, operations };
}

export async function importEngineeringResult(root, resultFile, { dryRun = true } = {}) {
  const result = await readContract(resultFile, "engineering-result.schema.json", "Engineering result");
  const request = await readContract(
    path.join(root, PRODUCT_CONTRACT_ROOT, "outbox", `${result.requestId}.json`),
    "development-request.schema.json",
    "Previously exported development request"
  );
  const errors = [];
  if (result.productTaskId !== request.productTaskId) errors.push("Engineering result productTaskId does not match the exported request.");
  if (result.sourceDigest !== contractDigest(request)) errors.push("Engineering result source digest does not match the exported request.");
  if (result.producerActorId === result.verification.verifierActorId) errors.push("Engineering result producer and verifier must be distinct.");
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
  const digest = contractDigest(result);
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
  return { dryRun, request, result, digest, receipt, operations };
}
