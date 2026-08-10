import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { assertNoLinkTraversal, resolveInside, toPosixPath } from "../paths.js";
import { validatePublishedSchema } from "../schema-validation.js";
import { assertNoCredentialMaterial } from "../runtime/security.js";

const PRODUCT_RUN_ROOT = ".product-ops/runtime/autopilot/product-runs";

export async function runProductAgent(
  root,
  config,
  task,
  { intake, priorRuns = [], cycleHistory = [], cycleId, applicationRoot = null, operationalArtifacts = null, execute, now = new Date() } = {}
) {
  // The performer is always supplied. There is no built-in one: work is done by whoever the host
  // delegates it to, and this function's job is the contract around that, not the doing.
  if (typeof execute !== "function") {
    throw new Error("A product agent run needs a performer; pass `execute`.");
  }
  const role = config.agents.find((candidate) => candidate.id === task.owner_role);
  if (!role) throw new Error(`Product task ${task.task_id} has no configured role ${task.owner_role}.`);
  if (role.id === config.separation.developmentRole) {
    throw new Error("The development adapter is executed by the cross-system orchestrator, not a product analysis agent.");
  }
  const absoluteRoot = path.resolve(root);
  const runDirectory = resolveInside(absoluteRoot, PRODUCT_RUN_ROOT, "Product agent run root");
  await assertNoLinkTraversal(absoluteRoot, runDirectory, "Product agent run root");
  await fs.mkdir(runDirectory, { recursive: true });
  const canonicalOutputFile = path.join(runDirectory, `${task.task_id}-result.json`);
  const sealedResult = await readCompletedResult(canonicalOutputFile, task, role);
  if (sealedResult) {
    return {
      result: sealedResult,
      inputFile: null,
      outputFile: path.relative(absoluteRoot, canonicalOutputFile).replaceAll("\\", "/")
    };
  }
  const attemptId = crypto.randomUUID();
  const attemptPrefix = `${task.task_id}-attempt-${attemptId}`;
  const inputFile = path.join(runDirectory, `${attemptPrefix}-input.json`);
  const attemptOutputFile = path.join(runDirectory, `${attemptPrefix}-result.json`);
  const payload = buildProductAgentRequest(config, task, role, {
    intake,
    priorRuns,
    cycleHistory,
    cycleId,
    applicationRoot,
    operationalArtifacts
  });
  assertNoCredentialMaterial("Product agent input", payload);
  await writeExclusiveOrEqual(inputFile, payload);
  const result = await execute({
    root: absoluteRoot,
    inputFile,
    outputFile: attemptOutputFile,
    task,
    role,
    applicationRoot,
    operationalArtifacts,
    now
  });
  const errors = validatePublishedSchema("product-agent-run.schema.json", result);
  if (errors.length) throw new Error(`Product agent result is invalid:\n- ${errors.join("\n- ")}`);
  const mismatches = [];
  if (result.taskId !== task.task_id) mismatches.push("taskId");
  if (result.eventId !== task.event_id) mismatches.push("eventId");
  if (result.roleId !== role.id) mismatches.push("roleId");
  if (result.producerActorId !== role.actorId) mismatches.push("producerActorId");
  if (mismatches.length) throw new Error(`Product agent result mismatches dispatched ${mismatches.join(", ")}.`);
  assertNoCredentialMaterial("Product agent result", result);
  const outputFile = result.status === "completed" ? canonicalOutputFile : attemptOutputFile;
  await writeExclusiveOrEqual(outputFile, result);
  return {
    result,
    inputFile: path.relative(absoluteRoot, inputFile).replaceAll("\\", "/"),
    outputFile: path.relative(absoluteRoot, outputFile).replaceAll("\\", "/")
  };
}

/**
 * The brief a performer needs to carry out one product task, whatever performs it.
 *
 * It is written to a file for the record and returned to the coordinator, which hands it to whoever
 * performs the work. One definition means a team's boundary cannot mean one thing here and
 * something else wherever the work is actually done.
 */
export function buildProductAgentRequest(
  config,
  task,
  role,
  { intake, priorRuns = [], cycleHistory = [], cycleId, applicationRoot = null, operationalArtifacts = null } = {}
) {
  return {
    schemaVersion: "1.0.0",
    cycleId,
    // Forward slashes even on Windows. This path is read by whoever performs the work — a subagent,
    // a shell, a tool call — and a backslash survives none of that reliably: it is an escape
    // character almost everywhere it lands, so `D:\Projects\app` arrives as `D:Projectsapp`. Node,
    // Git and PowerShell all accept the forward-slash form, and it cannot be silently eaten.
    linkedApplication: applicationRoot ? { root: toPosixPath(path.resolve(applicationRoot)) } : null,
    operationalArtifacts,
    project: config.project,
    task,
    role: {
      id: role.id,
      actorId: role.actorId,
      name: role.name,
      purpose: role.role,
      responsibilities: role.responsibilities,
      prohibitedActions: role.prohibitedActions
    },
    intake,
    cycleHistory: cycleHistory.slice(-3),
    priorRuns: priorRuns.map(compactPriorRun),
    policy: {
      preserveHumanProductAuthority: true,
      noDirectRepositoryWrites: true,
      noProductionActions: true,
      noCredentialMaterial: true,
      evidenceBeforeClaims: true,
      // A retrieval that failed is a fact about the attempt, not about the world. Recording "no
      // performance budget is documented" because one fetch returned an error puts a false absence
      // into the record, and every document downstream then reasons from a gap that was never
      // there — which is exactly what happened the first time a real product ran through this.
      retryBeforeRecordingAbsence: true
    },
    reporting: {
      absenceRule: "A source you could not reach is not a source that says nothing. Retry a failed retrieval at least once before recording anything as absent, and if it still fails, record the failure — what you tried and what it returned — rather than the absence."
    }
  };
}

/**
 * Perform a task with a result the caller already has.
 *
 * A coordinator whose subagent has done the work submits the result through `runProductAgent` with
 * this performer, so the submission passes the same schema validation, the same dispatch-identity
 * check, the same credential scan, and the same sealing as every other run. Delegating gains a
 * performer, not an exemption.
 */
export function submittedResultExecutor(result) {
  return async () => result;
}


async function writeExclusiveOrEqual(file, value) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  try {
    await fs.writeFile(file, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = await fs.readFile(file, "utf8");
    if (existing !== content) throw new Error(`Autopilot artifact already exists with different content: ${file}`);
  }
}

function compactPriorRun(run) {
  return {
    taskId: run.taskId,
    roleId: run.roleId,
    status: run.status,
    summary: run.summary,
    findings: run.findings.slice(0, 12),
    recommendations: run.recommendations.slice(0, 12),
    acceptanceCriteria: run.acceptanceCriteria.slice(0, 20),
    impacts: run.impacts,
    constraints: run.constraints.slice(0, 12),
    nonFunctionalRequirements: run.nonFunctionalRequirements.slice(0, 20),
    evidence: run.evidence.slice(0, 20),
    knownRisks: run.knownRisks.slice(0, 12)
  };
}

async function readCompletedResult(file, task, role) {
  let result;
  try {
    result = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`Sealed product agent result is unreadable: ${file}: ${error.message}`);
  }
  if (result.status !== "completed") return null;
  const errors = validatePublishedSchema("product-agent-run.schema.json", result);
  if (errors.length) throw new Error(`Sealed product agent result is invalid:\n- ${errors.join("\n- ")}`);
  const matches = result.taskId === task.task_id && result.eventId === task.event_id &&
    result.roleId === role.id && result.producerActorId === role.actorId;
  if (!matches) throw new Error(`Sealed product agent result does not match dispatched task ${task.task_id}.`);
  assertNoCredentialMaterial("Sealed product agent result", result);
  return result;
}
