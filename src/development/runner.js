import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { applyWrites, planWrites } from "../file-writer.js";
import { assertNoLinkTraversal, resolveInside } from "../paths.js";
import { assertNoCredentialMaterial } from "../runtime/security.js";
import { assertContract, json, readContract, safeContractId } from "./contracts.js";
import { loadDevelopmentConfig, validateDevelopmentConfig } from "./config.js";
import { resolveExecutable } from "./executor-setup.js";

const MAX_EXECUTOR_OUTPUT_BYTES = 1024 * 1024;

export async function runEngineeringWorkstream(
  root,
  planId,
  workstreamId,
  { dryRun = true, spawnProcess = spawn } = {}
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
  const executor = config.executors.find((candidate) => candidate.roleId === workstream.ownerRole);
  if (!executor?.enabled || executor.implementation !== "command-runner") {
    throw new Error(`Executor for ${workstream.ownerRole} is disabled or not configured as a command runner.`);
  }
  if (executor.isolation !== "external-required") throw new Error("Engineering executors must retain the external-isolation requirement.");
  const workingDirectory = resolveInside(root, executor.workingDirectory, "Engineering executor working directory");
  await assertNoLinkTraversal(root, workingDirectory, "Engineering executor working directory");
  const runId = `${planId}-${workstreamId}`;
  const inputFile = `.development-os/runs/${runId}-input.json`;
  const resultFile = `.development-os/runs/${runId}-result.json`;
  const attemptId = crypto.randomUUID();
  const rawOutputFile = `.development-os/runs/${runId}-${attemptId}.raw.json`;
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
      isolation: executor.isolation
    },
    returnContract: { schema: "engineering-workstream-run.schema.json", transport: "stdout-json" }
  };
  assertNoCredentialMaterial("Engineering workstream payload", payload);
  const argumentsList = executor.arguments.map((argument) => String(argument)
    .replaceAll("{inputFile}", path.resolve(root, inputFile))
    .replaceAll("{projectRoot}", path.resolve(root))
    .replaceAll("{rawOutputFile}", path.resolve(root, rawOutputFile))
    .replaceAll("{planId}", planId)
    .replaceAll("{workstreamId}", workstreamId));
  if (dryRun) return { dryRun, runId, inputFile, resultFile, payload, executable: executor.executable, arguments: argumentsList, workingDirectory };
  await writeExclusiveOrEqual(root, inputFile, json(payload));
  const usesRawOutput = executor.arguments.some((argument) => argument.includes("{rawOutputFile}"));
  let execution;
  let resultText;
  try {
    const executable = spawnProcess === spawn
      ? await resolveExecutable(executor.executable, { cwd: workingDirectory })
      : executor.executable;
    execution = await execute(executable, argumentsList, {
      cwd: workingDirectory,
      timeoutMs: executor.timeoutMs,
      environmentAllowlist: executor.environmentAllowlist,
      spawnProcess
    });
    resultText = usesRawOutput ? await fs.readFile(path.join(root, rawOutputFile), "utf8") : execution.stdout;
  } finally {
    await fs.rm(path.join(root, rawOutputFile), { force: true });
  }
  let result;
  try { result = JSON.parse(resultText.trim()); }
  catch (error) { throw new Error(`Engineering executor did not return valid JSON: ${error.message}`); }
  assertContract(result, "engineering-workstream-run.schema.json", "Engineering workstream result");
  const actor = config.roles.find((role) => role.id === workstream.ownerRole)?.actorId;
  const mismatches = [];
  if (result.planId !== planId) mismatches.push("planId");
  if (result.workstreamId !== workstreamId) mismatches.push("workstreamId");
  if (result.ownerRole !== workstream.ownerRole) mismatches.push("ownerRole");
  if (result.producerActorId !== actor) mismatches.push("producerActorId");
  if (mismatches.length) throw new Error(`Engineering executor result mismatches dispatched ${mismatches.join(", ")}.`);
  const storedResultFile = result.status === "completed"
    ? resultFile
    : `.development-os/runs/${runId}-attempt-${attemptId}-result.json`;
  await writeExclusiveOrEqual(root, storedResultFile, json(result));
  return { dryRun: false, runId, inputFile, resultFile: storedResultFile, payload, result, stderr: execution.stderr };
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

async function execute(executable, args, { cwd, timeoutMs, environmentAllowlist, spawnProcess }) {
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
  const isCodexShim = path.basename(executable).toLowerCase() === "codex.cmd" && args[0] === "exec";
  if (!isCodexShim) {
    throw new Error("Windows batch executors are not supported because their arguments cross a command-interpreter boundary.");
  }
  const javascriptLauncher = path.join(path.dirname(executable), "node_modules", "@openai", "codex", "bin", "codex.js");
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
