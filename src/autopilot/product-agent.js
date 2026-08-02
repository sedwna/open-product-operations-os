import fs from "node:fs/promises";
import path from "node:path";
import { captureCodexCommand, inspectCodexReadiness } from "../codex/readiness.js";
import { assertNoLinkTraversal, resolveInside } from "../paths.js";
import { validatePublishedSchema } from "../schema-validation.js";
import { assertNoCredentialMaterial } from "../runtime/security.js";

const PRODUCT_RUN_ROOT = ".product-ops/runtime/autopilot/product-runs";

export async function runProductAgent(
  root,
  config,
  task,
  { intake, priorRuns = [], cycleHistory = [], cycleId, execute = executeCodexProductAgent, now = new Date() } = {}
) {
  const role = config.agents.find((candidate) => candidate.id === task.owner_role);
  if (!role) throw new Error(`Product task ${task.task_id} has no configured role ${task.owner_role}.`);
  if (role.id === config.separation.developmentRole) {
    throw new Error("The development adapter is executed by the cross-system orchestrator, not a product analysis agent.");
  }
  const absoluteRoot = path.resolve(root);
  const runDirectory = resolveInside(absoluteRoot, PRODUCT_RUN_ROOT, "Product agent run root");
  await assertNoLinkTraversal(absoluteRoot, runDirectory, "Product agent run root");
  await fs.mkdir(runDirectory, { recursive: true });
  const inputFile = path.join(runDirectory, `${task.task_id}-input.json`);
  const outputFile = path.join(runDirectory, `${task.task_id}-result.json`);
  const payload = {
    schemaVersion: "1.0.0",
    cycleId,
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
      evidenceBeforeClaims: true
    }
  };
  assertNoCredentialMaterial("Product agent input", payload);
  await writeExclusiveOrEqual(inputFile, payload);
  const result = await execute({
    root: absoluteRoot,
    inputFile,
    outputFile,
    schemaFile: path.join(absoluteRoot, "schemas", "product-agent-run.schema.json"),
    task,
    role,
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
  await writeExclusiveOrEqual(outputFile, result);
  return {
    result,
    inputFile: path.relative(absoluteRoot, inputFile).replaceAll("\\", "/"),
    outputFile: path.relative(absoluteRoot, outputFile).replaceAll("\\", "/")
  };
}

export async function executeCodexProductAgent({ root, inputFile, outputFile, schemaFile, task, role }) {
  const readiness = await inspectCodexReadiness({ cwd: root });
  if (!readiness.canAutomate) throw new Error(`Codex product executor is not ready: ${readiness.message}`);
  const prompt = [
    `Read the product-role input JSON at ${JSON.stringify(inputFile)}.`,
    "Perform only the assigned product role. Do not edit any repository file and do not execute production actions.",
    "Return only one JSON object conforming to product-agent-run.schema.json.",
    `Set taskId to ${JSON.stringify(task.task_id)}, eventId to ${JSON.stringify(task.event_id)}, roleId to ${JSON.stringify(role.id)}, and producerActorId to ${JSON.stringify(role.actorId)}.`,
    "Separate evidence-backed findings from recommendations. Preserve uncertainty and never invent user research, metrics, implementation completion, or approvals.",
    "Keep the result concise and prioritize the highest-value evidence, risks, requirements, and acceptance criteria.",
    "Inspect repository-local evidence referenced by prior runs before making QA, readiness, or verification claims.",
    "Include practical acceptance criteria, impacted engineering domains, non-functional requirements, constraints, evidence references, and known risks when relevant."
  ].join(" ");
  const rawOutputFile = `${outputFile}.${process.pid}.raw`;
  let execution;
  try {
    execution = await captureCodexCommand(readiness.executable, [
      "exec", "--ephemeral", "--ignore-user-config", "--sandbox", "read-only", "--output-schema", schemaFile,
      "--output-last-message", rawOutputFile, prompt
    ], { cwd: root, timeoutMs: 30 * 60 * 1000 });
    if (!execution.ok) {
      throw new Error(`Codex product executor failed: ${execution.error || execution.stderr || execution.stdout}`.slice(0, 2000));
    }
    const value = await fs.readFile(rawOutputFile, "utf8");
    try { return JSON.parse(value.trim()); }
    catch (error) { throw new Error(`Codex product executor did not return valid JSON: ${error.message}`); }
  } finally {
    await fs.rm(rawOutputFile, { force: true });
  }
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
