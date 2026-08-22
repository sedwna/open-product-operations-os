import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { applyWrites, planWrites } from "../file-writer.js";
import { assertNoLinkTraversal, resolveInside } from "../paths.js";
import { assertNoCredentialMaterial } from "../runtime/security.js";
import { assertContract, json, readContract, safeContractId } from "./contracts.js";
import { loadDevelopmentConfig, validateDevelopmentConfig } from "./config.js";
import { resolveExecutable } from "./executor-setup.js";
import { writeCodexCompatibleSchema } from "../codex/structured-output-schema.js";
import { effectiveCodexSandboxArguments } from "../codex/sandbox-profile.js";
import { resolveDevelopmentCommand } from "./command-resolution.js";
export { effectiveCodexSandboxArguments } from "../codex/sandbox-profile.js";

const MAX_EXECUTOR_OUTPUT_BYTES = 1024 * 1024;

export async function runEngineeringWorkstream(
  root,
  planId,
  workstreamId,
  { dryRun = true, spawnProcess = spawn, execute } = {}
) {
  safeContractId(planId, "Plan ID");
  safeContractId(workstreamId, "Workstream ID");
  const config = await loadDevelopmentConfig(root);
  const configErrors = validateDevelopmentConfig(config);
  if (configErrors.length) throw new Error(`Development configuration is invalid:\n- ${configErrors.join("\n- ")}`);
  const plan = await readContract(
    path.join(root, ".development-os", "plans", `${planId}.json`),
    "engineering-plan.schema.json",
    "Engineering plan"
  );
  const workstream = plan.workstreams.find((candidate) => candidate.id === workstreamId);
  if (!workstream) throw new Error(`Unknown workstream "${workstreamId}" in ${planId}.`);
  if (!['ready', 'in_progress'].includes(workstream.status)) throw new Error(`Workstream "${workstreamId}" is not executable.`);
  await assertDependenciesComplete(root, plan, config, workstream.dependencies);
  const request = await readContract(
    path.join(root, config.sync.inbox, `${plan.requestId}.json`),
    "development-request.schema.json",
    "Stored development request"
  );
  // A performer supplied by the caller is the host-delegated path: the coordinator's subagent did
  // the work and is returning it. There is no CLI to configure, so none of the executor block
  // applies — but everything after it does, which is the point. The same schema, the same
  // dispatch-identity check, the same read-only proof for ENG-15, the same sealing.
  const delegated = typeof execute === "function";
  const executor = delegated ? null : config.executors.find((candidate) => candidate.roleId === workstream.ownerRole);
  if (!delegated) {
    if (!executor?.enabled || executor.implementation !== "command-runner") {
      throw new Error(`Executor for ${workstream.ownerRole} is disabled or not configured as a command runner.`);
    }
    if (executor.isolation !== "external-required") throw new Error("Engineering executors must retain the external-isolation requirement.");
  }
  const workingDirectory = delegated
    ? path.resolve(root)
    : resolveInside(root, executor.workingDirectory, "Engineering executor working directory");
  if (!delegated) await assertNoLinkTraversal(root, workingDirectory, "Engineering executor working directory");
  const runId = `${planId}-${workstreamId}`;
  const inputFile = `.development-os/runs/${runId}-input.json`;
  const resultFile = `.development-os/runs/${runId}-result.json`;
  const attemptId = crypto.randomUUID();
  const rawOutputFile = `.development-os/runs/${runId}-${attemptId}.raw.json`;
  const providerSchemaFile = `.development-os/runs/${runId}-${attemptId}-schema.json`;
  const verificationBinding = workstream.ownerRole === "ENG-15"
    ? {
        workspaceDigest: await verifierWorkspaceDigest(root, config.policies.prohibitedPaths),
        headRevision: await gitHead(root)
      }
    : null;
  const payload = {
    schemaVersion: "1.0.0",
    planId,
    workstream,
    request,
    writeBoundary: request.writeBoundary,
    policy: {
      prohibitedPaths: config.policies.prohibitedPaths,
      productionRequiresHumanApproval: config.policies.requireHumanProductionApproval,
      independentVerificationRequired: config.policies.requireIndependentVerification,
      proportionalEngineering: {
        stopCondition: "The approved acceptance criteria are met with the smallest complete reversible change.",
        reproduceBeforeEdit: true,
        understandAffectedFlowFirst: true,
        solutionLadder: ["no build", "repository reuse", "standard library or native platform", "installed capability", "minimum local implementation"],
        defectRule: "Inspect every caller and fix the shared root cause once.",
        prefer: ["deletion over addition", "boring over clever", "fewest affected files"],
        speculativeComplexityProhibited: true,
        complexityJustification: ["present requirement or observed risk", "simpler alternative and why it is insufficient now", "ongoing maintenance or operational cost", "removal or expansion trigger"],
        deliberateShortcutRecord: ["known ceiling", "observable upgrade trigger"],
        minimumRunnableCheck: "one focused runnable check for non-trivial changed logic; no new framework for a trivial change",
        qualityFloor: ["trust-boundary validation", "data-loss handling", "security", "accessibility", "explicit acceptance criteria"],
        assuranceDepth: "focused for low-risk reversible work; integration and rollback proof for cross-boundary work; full specialist, independent, and human gates for sensitive, production, high-risk, or irreversible work"
      },
      // A spawned executor must be externally isolated because this process starts it. A delegated
      // performer was already started by the host, inside whatever the host confines it to, so the
      // brief states that plainly rather than claiming a guarantee this code did not make.
      isolation: delegated ? "host-delegated" : executor.isolation
    },
    returnContract: { schema: "engineering-workstream-run.schema.json", transport: "stdout-json" },
    ...(verificationBinding ? { verificationBinding } : {})
  };
  assertNoCredentialMaterial("Engineering workstream payload", payload);

  // The delegated path stops here and hands the brief back. Everything between this point and the
  // result validation exists to shape a command line — provider schema files, preset prompts,
  // argument templating, sandbox flags — and none of it means anything when the performer is a
  // subagent the host already started.
  if (delegated) {
    if (dryRun) return { dryRun, runId, inputFile, resultFile, payload, delegated: true, workingDirectory };
    await writeExclusiveOrEqual(root, inputFile, json(payload));
    const verifierBefore = workstream.ownerRole === "ENG-15"
      ? await verifierWorkspaceDigest(root, config.policies.prohibitedPaths)
      : null;
    const delegatedResult = await execute({ root: path.resolve(root), planId, workstreamId, workstream, payload });
    if (verifierBefore && await verifierWorkspaceDigest(root, config.policies.prohibitedPaths) !== verifierBefore) {
      throw new Error("Independent engineering verifier modified repository content; verification must remain read-only.");
    }
    return recordWorkstreamResult(root, {
      result: delegatedResult, config, plan, planId, workstream, workstreamId, runId, attemptId, inputFile, resultFile, payload
    });
  }

  const canonicalSchemaReference = "{projectRoot}/engineering/schemas/engineering-workstream-run.schema.json";
  const usesCodexPreset = looksLikeCodexExecutor(executor);
  const usesClaudePreset = looksLikeClaudeExecutor(executor);
  const usesProviderSchema = executor.arguments.some((argument) =>
    argument === canonicalSchemaReference
    || argument.includes("{providerSchemaFile}")
    || argument.includes("{providerSchemaJson}")
  );
  if (usesProviderSchema && !dryRun) {
    await writeCodexCompatibleSchema(
      path.join(root, "engineering", "schemas", "engineering-workstream-run.schema.json"),
      path.join(root, providerSchemaFile),
      async (file, value) => writeExclusiveOrEqual(root, path.relative(root, file), json(value))
    );
  }
  const providerSchemaJson = usesProviderSchema
    ? JSON.stringify(JSON.parse(await fs.readFile(
        path.join(root, dryRun ? "engineering/schemas/engineering-workstream-run.schema.json" : providerSchemaFile),
        "utf8"
      )))
    : "";
  let argumentsList = executor.arguments.map((argument) => String(argument)
    .replaceAll(canonicalSchemaReference, path.resolve(root, providerSchemaFile))
    .replaceAll("{providerSchemaFile}", path.resolve(root, providerSchemaFile))
    .replaceAll("{providerSchemaJson}", providerSchemaJson)
    .replaceAll("{inputFile}", path.resolve(root, inputFile))
    .replaceAll("{projectRoot}", path.resolve(root))
    .replaceAll("{rawOutputFile}", path.resolve(root, rawOutputFile))
    .replaceAll("{planId}", planId)
    .replaceAll("{workstreamId}", workstreamId));
  if (usesCodexPreset || usesClaudePreset) {
    const promptIndex = usesCodexPreset ? argumentsList.length - 1 : argumentsList.indexOf("-p") + 1;
    argumentsList[promptIndex] = `${argumentsList[promptIndex]} Product-agent execution limits such as "no repository edits for this run" apply to the historical product-analysis role, not to this approved engineering execution. The development request writeBoundary is the authoritative repository-write permission for this workstream; durable product scope, environment, security, and production constraints still apply. Reproduce the claimed gap before editing; an already-satisfied request may correctly produce no code change. Read the affected code and trace the real flow first. For defects, inspect every caller and fix the shared root cause once. Then stop at the earliest viable solution: no build, repository reuse, standard-library or native-platform capability, installed capability, then minimum local implementation. Prefer deletion, boring code, and the fewest affected files; stop when the approved acceptance criteria are met. Do not refactor adjacent code or add speculative abstractions, services, dependencies, stores, queues, extension points, gates, or documents. Any necessary complexity must identify its present need, the simpler alternative and why it is insufficient now, its ongoing cost, and a removal or expansion trigger. Record the known ceiling and observable upgrade trigger for a deliberate shortcut. Leave one focused runnable check for non-trivial changed logic without adding a test framework for a trivial change. Never simplify away trust-boundary validation, data-loss handling, security, accessibility, or explicit acceptance criteria. Keep business rules in one shared domain or service implementation consumed by the UI and other adapters. User-visible behavior needs a real DOM, browser, integration, or equivalent runtime test; source-pattern assertions alone are not behavioral evidence.`;
    if (workstream.ownerRole === "ENG-15") {
      argumentsList[promptIndex] += " On Windows, run Node test files with node --test tests\\*.test.js rather than passing the tests directory. You have tool-execution access only so you can reproduce verification; do not modify any file. The orchestrator compares repository content before and after this run and rejects verification if anything changes. For a working-tree verdict, copy payload.verificationBinding.workspaceDigest exactly into implementationRevision and include git-head:<payload.verificationBinding.headRevision> in evidence; these bind both verified bytes and history position. Set verificationDisposition to passed only when you actually reproduced every material claim; otherwise set it to failed or blocked and return the matching non-completed status.";
    } else {
      argumentsList[promptIndex] += " Set verificationDisposition to not_applicable because only ENG-15 may issue the independent engineering disposition.";
    }
    if (usesCodexPreset) argumentsList = effectiveCodexSandboxArguments(argumentsList);
  }
  if (dryRun) return { dryRun, runId, inputFile, resultFile, payload, executable: executor.executable, arguments: argumentsList, workingDirectory };
  await writeExclusiveOrEqual(root, inputFile, json(payload));
  const usesRawOutput = executor.arguments.some((argument) => argument.includes("{rawOutputFile}"));
  const verifierDigestBefore = workstream.ownerRole === "ENG-15"
    ? await verifierWorkspaceDigest(root, config.policies.prohibitedPaths)
    : null;
  let execution;
  let resultText;
  try {
    const executable = spawnProcess === spawn
      ? await resolveExecutable(executor.executable, { cwd: workingDirectory })
      : executor.executable;
    execution = await runCommand(executable, argumentsList, {
      cwd: workingDirectory,
      timeoutMs: executor.timeoutMs,
      environmentAllowlist: executor.environmentAllowlist,
      spawnProcess
    });
    if (verifierDigestBefore && await verifierWorkspaceDigest(root, config.policies.prohibitedPaths) !== verifierDigestBefore) {
      throw new Error("Independent engineering verifier modified repository content; verification must remain read-only.");
    }
    resultText = usesRawOutput ? await fs.readFile(path.join(root, rawOutputFile), "utf8") : execution.stdout;
  } finally {
    await fs.rm(path.join(root, rawOutputFile), { force: true });
  }
  let result;
  try { result = usesClaudePreset ? extractClaudeStructuredOutput(resultText) : JSON.parse(resultText.trim()); }
  catch (error) { throw new Error(`Engineering executor did not return valid JSON: ${error.message}`); }
  const recorded = await recordWorkstreamResult(root, {
    result, config, plan, planId, workstream, workstreamId, runId, attemptId, inputFile, resultFile, payload
  });
  return { ...recorded, stderr: execution.stderr };
}

/**
 * What a workstream result has to satisfy before it is allowed to exist, whoever produced it.
 *
 * Both performers pass through here: the spawned command runner and the host's subagent. A
 * delegated result gains a performer, not an exemption — the schema, the check that it answers the
 * workstream actually dispatched, the rule that only ENG-15 may issue a verification disposition,
 * and the sealing of a completed run are identical either way.
 */
async function recordWorkstreamResult(root, { result, config, planId, workstream, workstreamId, runId, attemptId, inputFile, resultFile, payload }) {
  assertContract(result, "engineering-workstream-run.schema.json", "Engineering workstream result");
  const actor = config.roles.find((role) => role.id === workstream.ownerRole)?.actorId;
  const mismatches = [];
  if (result.planId !== planId) mismatches.push("planId");
  if (result.workstreamId !== workstreamId) mismatches.push("workstreamId");
  if (result.ownerRole !== workstream.ownerRole) mismatches.push("ownerRole");
  if (result.producerActorId !== actor) mismatches.push("producerActorId");
  if (workstream.ownerRole === "ENG-15") {
    const expectedDisposition = result.status === "completed" ? "passed" : result.status === "failed" ? "failed" : "blocked";
    if (result.verificationDisposition !== expectedDisposition) mismatches.push("verificationDisposition");
  } else if (result.verificationDisposition !== "not_applicable") {
    mismatches.push("verificationDisposition");
  }
  if (mismatches.length) throw new Error(`Engineering executor result mismatches dispatched ${mismatches.join(", ")}.`);
  const storedResultFile = result.status === "completed"
    ? resultFile
    : `.development-os/runs/${runId}-attempt-${attemptId}-result.json`;
  await writeExclusiveOrEqual(root, storedResultFile, json(result));
  return { dryRun: false, runId, inputFile, resultFile: storedResultFile, payload, result };
}

/** Perform a workstream with a result the caller already has. Mirrors the product-side performer. */
export function submittedWorkstreamResult(result) {
  return async () => result;
}

export function extractClaudeStructuredOutput(value) {
  const envelope = JSON.parse(String(value ?? "").trim());
  if (!envelope || typeof envelope !== "object" || !envelope.structured_output || typeof envelope.structured_output !== "object") {
    throw new Error("Claude output envelope is missing structured_output.");
  }
  return envelope.structured_output;
}

export async function verifierWorkspaceDigest(root, prohibitedPaths = [".git", "node_modules"]) {
  const hash = crypto.createHash("sha256");
  const excluded = [".git", ".development-os/runs", ...prohibitedPaths]
    .map((value) => String(value).replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, ""))
    .filter(Boolean);
  const isExcluded = (relative) => excluded.some((candidate) =>
    relative === candidate || relative.startsWith(`${candidate}/`));
  async function visit(directory, relative = "") {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (isExcluded(childRelative)) continue;
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

async function gitHead(root) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error("Independent verification requires a readable Git HEAD.");
  return result.stdout.trim();
}

async function assertDependenciesComplete(root, plan, config, dependencies) {
  for (const dependency of dependencies) {
    const dependencyWorkstream = plan.workstreams.find((candidate) => candidate.id === dependency);
    if (!dependencyWorkstream) {
      throw new Error(`Workstream dependency ${dependency} is not present in engineering plan ${plan.planId}.`);
    }
    const expectedActor = config.roles.find((role) => role.id === dependencyWorkstream.ownerRole)?.actorId;
    if (!expectedActor) {
      throw new Error(`Workstream dependency ${dependency} has no configured producer actor.`);
    }
    const result = await readContract(
      path.join(root, ".development-os", "runs", `${plan.planId}-${dependency}-result.json`),
      "engineering-workstream-run.schema.json",
      `Engineering workstream dependency ${dependency}`
    );
    const mismatches = [];
    if (result.planId !== plan.planId) mismatches.push("planId");
    if (result.workstreamId !== dependency) mismatches.push("workstreamId");
    if (result.ownerRole !== dependencyWorkstream.ownerRole) mismatches.push("ownerRole");
    if (result.producerActorId !== expectedActor) mismatches.push("producerActorId");
    if (result.status !== "completed") mismatches.push("status");
    if (mismatches.length) {
      throw new Error(`Workstream dependency ${dependency} mismatches planned ${mismatches.join(", ")}.`);
    }
  }
}

async function writeExclusiveOrEqual(root, relative, content) {
  const operations = await planWrites(path.resolve(root), new Map([[relative, content]]), {});
  await applyWrites(path.resolve(root), operations);
}

async function runCommand(executable, args, { cwd, timeoutMs, environmentAllowlist, spawnProcess }) {
  const environment = {};
  for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "TEMP", "TMP", ...environmentAllowlist]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  const command = await windowsCommand(executable, args);
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command.executable, command.args, {
      cwd,
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timer;

    const stopChild = () => {
      try { child.kill(); }
      catch { /* The process may already have exited. */ }
    };
    const settleReject = (error, { terminate = false } = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (terminate) stopChild();
      reject(error);
    };
    const settleResolve = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const capture = (channel, chunks, byteCount, chunk) => {
      if (settled) return byteCount;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      const nextByteCount = byteCount + buffer.length;
      if (nextByteCount > MAX_EXECUTOR_OUTPUT_BYTES) {
        settleReject(
          new Error(`Engineering executor ${channel} exceeded the ${MAX_EXECUTOR_OUTPUT_BYTES}-byte limit.`),
          { terminate: true }
        );
        return nextByteCount;
      }
      chunks.push(buffer);
      return nextByteCount;
    };

    child.stdout?.on("data", (chunk) => { stdoutBytes = capture("stdout", stdout, stdoutBytes, chunk); });
    child.stderr?.on("data", (chunk) => { stderrBytes = capture("stderr", stderr, stderrBytes, chunk); });
    timer = setTimeout(() => {
      settleReject(new Error(`Engineering executor timed out after ${timeoutMs}ms.`), { terminate: true });
    }, timeoutMs);
    child.once("error", (error) => { settleReject(error); });
    child.once("close", (code, signal) => {
      if (code !== 0) {
        settleReject(new Error(`Engineering executor exited with code ${code ?? "none"} and signal ${signal ?? "none"}.`));
      } else {
        settleResolve({
          stdout: Buffer.concat(stdout, stdoutBytes).toString("utf8"),
          stderr: Buffer.concat(stderr, stderrBytes).toString("utf8")
        });
      }
    });
  });
}

async function windowsCommand(executable, args) {
  if (process.platform !== "win32" || !/\.(?:cmd|bat)$/i.test(executable)) return { executable, args };
  const name = path.basename(executable).toLowerCase();
  const isCodexShim = name === "codex.cmd" && args[0] === "exec";
  const isClaudeShim = name === "claude.cmd" && args.includes("-p");
  if (!isCodexShim && !isClaudeShim) {
    throw new Error("Windows batch executors are not supported because their arguments cross a command-interpreter boundary.");
  }
  if (isClaudeShim) return resolveDevelopmentCommand(executable, args);
  const javascriptLauncher = isCodexShim
    ? path.join(path.dirname(executable), "node_modules", "@openai", "codex", "bin", "codex.js")
    : null;
  try { await fs.access(javascriptLauncher); }
  catch {
    throw new Error("The Codex command shim was found, but its shell-free JavaScript launcher could not be resolved. Install the official Codex application or reinstall @openai/codex.");
  }
  const bundledNode = path.join(path.dirname(executable), "node.exe");
  let nodeExecutable = process.execPath;
  try { await fs.access(bundledNode); nodeExecutable = bundledNode; }
  catch { /* The current trusted Node runtime executes the official launcher. */ }
  return { executable: nodeExecutable, args: [javascriptLauncher, ...args] };
}

function looksLikeCodexExecutor(executor) {
  return ["codex", "codex.exe", "codex.cmd"].includes(path.basename(executor.executable).toLowerCase())
    && executor.arguments[0] === "exec";
}

function looksLikeClaudeExecutor(executor) {
  return ["claude", "claude.exe", "claude.cmd"].includes(path.basename(executor.executable).toLowerCase())
    && executor.arguments.includes("--json-schema");
}
