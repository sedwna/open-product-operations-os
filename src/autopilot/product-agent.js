import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { captureCodexCommand, inspectCodexReadiness } from "../codex/readiness.js";
import { captureClaudeCommand, inspectClaudeReadiness } from "../claude/readiness.js";
import { writeCodexCompatibleSchema } from "../codex/structured-output-schema.js";
import { effectiveCodexSandboxArguments } from "../codex/sandbox-profile.js";
import { assertNoLinkTraversal, resolveInside } from "../paths.js";
import { validatePublishedSchema } from "../schema-validation.js";
import { assertNoCredentialMaterial } from "../runtime/security.js";

const PRODUCT_RUN_ROOT = ".product-ops/runtime/autopilot/product-runs";

export async function runProductAgent(
  root,
  config,
  task,
  { intake, priorRuns = [], cycleHistory = [], cycleId, applicationRoot = null, operationalArtifacts = null, provider = "codex", execute, now = new Date() } = {}
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
  const providerSchemaFile = path.join(runDirectory, `${attemptPrefix}-schema.json`);
  const payload = {
    schemaVersion: "1.0.0",
    cycleId,
    linkedApplication: applicationRoot ? { root: path.resolve(applicationRoot) } : null,
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
      evidenceBeforeClaims: true
    }
  };
  assertNoCredentialMaterial("Product agent input", payload);
  await writeExclusiveOrEqual(inputFile, payload);
  await writeCodexCompatibleSchema(
    path.join(absoluteRoot, "schemas", "product-agent-run.schema.json"),
    providerSchemaFile,
    writeExclusiveOrEqual
  );
  const selectedExecutor = execute ?? productExecutor(provider);
  const result = await selectedExecutor({
    root: absoluteRoot,
    inputFile,
    outputFile: attemptOutputFile,
    schemaFile: providerSchemaFile,
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

function productExecutor(provider) {
  if (provider === "codex") return executeCodexProductAgent;
  if (provider === "claude") return executeClaudeProductAgent;
  throw new Error(`Unsupported product automation provider: ${provider}`);
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

export async function executeCodexProductAgent({ root, inputFile, outputFile, schemaFile, task, role, applicationRoot, operationalArtifacts }) {
  const verificationRole = ["RB-09", "RB-12"].includes(role.id) && applicationRoot;
  const workingRoot = verificationRole ? path.resolve(applicationRoot) : root;
  const readiness = await inspectCodexReadiness({ cwd: workingRoot });
  if (!readiness.canAutomate) throw new Error(`Codex product executor is not ready: ${readiness.message}`);
  const prompt = [
    `Read the product-role input JSON at ${JSON.stringify(inputFile)}.`,
    "Perform only the assigned product role. Do not edit any repository file and do not execute production actions.",
    "Return only one JSON object conforming to product-agent-run.schema.json.",
    `Set taskId to ${JSON.stringify(task.task_id)}, eventId to ${JSON.stringify(task.event_id)}, roleId to ${JSON.stringify(role.id)}, and producerActorId to ${JSON.stringify(role.actorId)}.`,
    "Separate evidence-backed findings from recommendations. Preserve uncertainty and never invent user research, metrics, implementation completion, or approvals.",
    "In constraints, report only durable product, delivery, environment, compliance, or scope constraints. Do not copy this product role's temporary no-write, no-implementation, or no-self-approval execution limits into product constraints.",
    "Keep the result concise and prioritize the highest-value evidence, risks, requirements, and acceptance criteria.",
    "Inspect repository-local evidence referenced by prior runs before making QA, readiness, or verification claims.",
    operationalArtifacts ? `Inspect the controlled operational manifest at ${JSON.stringify(path.join(root, operationalArtifacts.manifest))} and its canonical receipt at ${JSON.stringify(path.join(root, operationalArtifacts.receipt))}. These content-addressed JSON artifacts are the authoritative manifest and receipt for this local checkpoint; verify their dry-run plan, bounded target, read-back, replay, backup, and hashes directly. receipt.manifestSha256 is defined as SHA-256 of canonical JSON: preserve array order, recursively sort object keys lexicographically, and serialize with no insignificant whitespace. Do not compare manifestSha256 with the bytes of the pretty-printed manifest file. The receipt planHash and replayWrites fields are outputs of the required dry-run-first and validated replay controls.` : "",
    verificationRole ? `The linked application repository is the current working directory ${JSON.stringify(workingRoot)}. Product evidence paths in the input are relative to ${JSON.stringify(root)}. Reproduce the relevant application checks; on Windows run Node tests with node --test tests\\*.test.js rather than passing the tests directory. Do not modify any file.` : "",
    "Include practical acceptance criteria, impacted engineering domains, non-functional requirements, constraints, evidence references, and known risks when relevant."
  ].join(" ");
  const rawOutputFile = `${outputFile}.${process.pid}.raw`;
  const applicationDigestBefore = verificationRole ? await readOnlyWorkspaceDigest(workingRoot) : null;
  let execution;
  try {
    const argumentsList = effectiveCodexSandboxArguments([
      "exec", "--ephemeral", "--ignore-user-config", "--sandbox", "read-only", "--output-schema", schemaFile,
      "--output-last-message", rawOutputFile, prompt
    ]);
    execution = await captureCodexCommand(readiness.executable, argumentsList, { cwd: workingRoot, timeoutMs: 30 * 60 * 1000, maxOutputBytes: 4 * 1024 * 1024 });
    if (!execution.ok) {
      throw new Error(`Codex product executor failed: ${boundedFailureDetails(execution.error || execution.stderr || execution.stdout)}`);
    }
    if (applicationDigestBefore && await readOnlyWorkspaceDigest(workingRoot) !== applicationDigestBefore) {
      throw new Error(`Product verification role ${role.id} modified the linked application; verification must remain read-only.`);
    }
    const value = await fs.readFile(rawOutputFile, "utf8");
    try { return JSON.parse(value.trim()); }
    catch (error) { throw new Error(`Codex product executor did not return valid JSON: ${error.message}`); }
  } finally {
    await fs.rm(rawOutputFile, { force: true });
  }
}

export async function executeClaudeProductAgent(
  { root, inputFile, schemaFile, task, role, applicationRoot, operationalArtifacts },
  { inspectClaude = inspectClaudeReadiness, executeClaude = captureClaudeCommand } = {}
) {
  const verificationRole = ["RB-09", "RB-12"].includes(role.id) && applicationRoot;
  const workingRoot = verificationRole ? path.resolve(applicationRoot) : root;
  const readiness = await inspectClaude({ cwd: workingRoot });
  if (!readiness.canAutomate) throw new Error(`Claude product executor is not ready: ${readiness.message}`);
  const prompt = productPrompt({
    provider: "Claude",
    root,
    inputFile,
    task,
    role,
    workingRoot,
    verificationRole,
    operationalArtifacts
  });
  const schema = JSON.parse(await fs.readFile(schemaFile, "utf8"));
  const argumentsList = [
    "--bare",
    "-p",
    prompt,
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(schema),
    "--no-session-persistence",
    "--permission-mode",
    "dontAsk",
    "--tools",
    verificationRole ? "Read,Glob,Grep,Bash" : "Read,Glob,Grep",
    "--allowedTools",
    verificationRole
      ? "Read,Glob,Grep,Bash(git status *),Bash(git diff *),Bash(node --test *),Bash(npm test *),Bash(npm run *)"
      : "Read,Glob,Grep"
  ];
  if (verificationRole) argumentsList.push("--add-dir", root);
  const applicationDigestBefore = verificationRole ? await readOnlyWorkspaceDigest(workingRoot) : null;
  const execution = await executeClaude(readiness.executable, argumentsList, {
    cwd: workingRoot,
    timeoutMs: 30 * 60 * 1000,
    maxOutputBytes: 4 * 1024 * 1024
  });
  if (!execution.ok) {
    throw new Error(`Claude product executor failed: ${boundedFailureDetails(execution.error || execution.stderr || execution.stdout)}`);
  }
  if (applicationDigestBefore && await readOnlyWorkspaceDigest(workingRoot) !== applicationDigestBefore) {
    throw new Error(`Product verification role ${role.id} modified the linked application; verification must remain read-only.`);
  }
  let envelope;
  try { envelope = JSON.parse(execution.stdout.trim()); }
  catch (error) { throw new Error(`Claude product executor did not return a valid JSON envelope: ${error.message}`); }
  if (!envelope?.structured_output || typeof envelope.structured_output !== "object") {
    throw new Error("Claude product executor response is missing structured_output.");
  }
  return envelope.structured_output;
}

function productPrompt({ root, inputFile, task, role, workingRoot, verificationRole, operationalArtifacts }) {
  return [
    `Read the product-role input JSON at ${JSON.stringify(inputFile)}.`,
    "Perform only the assigned product role. Do not edit any repository file and do not execute production actions.",
    "Return a result conforming to product-agent-run.schema.json.",
    `Set taskId to ${JSON.stringify(task.task_id)}, eventId to ${JSON.stringify(task.event_id)}, roleId to ${JSON.stringify(role.id)}, and producerActorId to ${JSON.stringify(role.actorId)}.`,
    "Separate evidence-backed findings from recommendations. Preserve uncertainty and never invent user research, metrics, implementation completion, or approvals.",
    "In constraints, report only durable product, delivery, environment, compliance, or scope constraints. Do not copy this product role's temporary no-write, no-implementation, or no-self-approval execution limits into product constraints.",
    "Keep the result concise and prioritize the highest-value evidence, risks, requirements, and acceptance criteria.",
    "Inspect repository-local evidence referenced by prior runs before making QA, readiness, or verification claims.",
    operationalArtifacts ? `Inspect the controlled operational manifest at ${JSON.stringify(path.join(root, operationalArtifacts.manifest))} and its canonical receipt at ${JSON.stringify(path.join(root, operationalArtifacts.receipt))}. These content-addressed JSON artifacts are the authoritative manifest and receipt for this local checkpoint; verify their dry-run plan, bounded target, read-back, replay, backup, and hashes directly. receipt.manifestSha256 is defined as SHA-256 of canonical JSON: preserve array order, recursively sort object keys lexicographically, and serialize with no insignificant whitespace. Do not compare manifestSha256 with the bytes of the pretty-printed manifest file. The receipt planHash and replayWrites fields are outputs of the required dry-run-first and validated replay controls.` : "",
    verificationRole ? `The linked application repository is the current working directory ${JSON.stringify(workingRoot)}. Product evidence paths in the input are relative to ${JSON.stringify(root)}. Reproduce the relevant application checks; on Windows run Node tests with node --test tests\\*.test.js rather than passing the tests directory. Do not modify any file.` : "",
    "Include practical acceptance criteria, impacted engineering domains, non-functional requirements, constraints, evidence references, and known risks when relevant."
  ].filter(Boolean).join(" ");
}

async function readOnlyWorkspaceDigest(root) {
  const hash = crypto.createHash("sha256");
  async function visit(directory, relative = "") {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (childRelative === ".git" || childRelative.startsWith(".git/")) continue;
      const absolute = path.join(directory, entry.name);
      hash.update(childRelative).update("\0");
      if (entry.isDirectory()) await visit(absolute, childRelative);
      else if (entry.isFile()) hash.update(await fs.readFile(absolute));
      else hash.update("non-regular-entry");
      hash.update("\0");
    }
  }
  await visit(root);
  return hash.digest("hex");
}

function boundedFailureDetails(value, limit = 1800) {
  const detail = String(value ?? "Unknown Codex execution failure.");
  if (detail.length <= limit) return detail;
  const tailLength = Math.floor(limit * 0.78);
  const headLength = limit - tailLength - 45;
  return `${detail.slice(-tailLength)}\n...[earlier executor output omitted]...\n${detail.slice(0, headLength)}`;
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
