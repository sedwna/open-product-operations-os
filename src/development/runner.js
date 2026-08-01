import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { applyWrites, planWrites } from "../file-writer.js";
import { assertNoLinkTraversal, resolveInside } from "../paths.js";
import { assertNoCredentialMaterial } from "../runtime/security.js";
import { assertContract, json, readContract, safeContractId } from "./contracts.js";
import { loadDevelopmentConfig, validateDevelopmentConfig } from "./config.js";

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
  await assertDependenciesComplete(root, planId, workstream.dependencies);
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
    .replaceAll("{planId}", planId)
    .replaceAll("{workstreamId}", workstreamId));
  if (dryRun) return { dryRun, runId, inputFile, resultFile, payload, executable: executor.executable, arguments: argumentsList, workingDirectory };
  await writeExclusiveOrEqual(root, inputFile, json(payload));
  const execution = await execute(executor.executable, argumentsList, {
    cwd: workingDirectory,
    timeoutMs: executor.timeoutMs,
    environmentAllowlist: executor.environmentAllowlist,
    spawnProcess
  });
  let result;
  try { result = JSON.parse(execution.stdout.trim()); }
  catch (error) { throw new Error(`Engineering executor did not return valid JSON: ${error.message}`); }
  assertContract(result, "engineering-workstream-run.schema.json", "Engineering workstream result");
  const actor = config.roles.find((role) => role.id === workstream.ownerRole)?.actorId;
  const mismatches = [];
  if (result.planId !== planId) mismatches.push("planId");
  if (result.workstreamId !== workstreamId) mismatches.push("workstreamId");
  if (result.ownerRole !== workstream.ownerRole) mismatches.push("ownerRole");
  if (result.producerActorId !== actor) mismatches.push("producerActorId");
  if (mismatches.length) throw new Error(`Engineering executor result mismatches dispatched ${mismatches.join(", ")}.`);
  await writeExclusiveOrEqual(root, resultFile, json(result));
  return { dryRun: false, runId, inputFile, resultFile, payload, result, stderr: execution.stderr };
}

async function assertDependenciesComplete(root, planId, dependencies) {
  for (const dependency of dependencies) {
    const file = path.join(root, ".development-os", "runs", `${planId}-${dependency}-result.json`);
    let result;
    try { result = JSON.parse(await fs.readFile(file, "utf8")); }
    catch (error) {
      if (error.code === "ENOENT") throw new Error(`Workstream dependency ${dependency} has no completed run.`);
      throw error;
    }
    if (result.status !== "completed") throw new Error(`Workstream dependency ${dependency} is not completed.`);
  }
}

async function writeExclusiveOrEqual(root, relative, content) {
  const operations = await planWrites(path.resolve(root), new Map([[relative, content]]), {});
  await applyWrites(path.resolve(root), operations);
}

function execute(executable, args, { cwd, timeoutMs, environmentAllowlist, spawnProcess }) {
  return new Promise((resolve, reject) => {
    const environment = {};
    for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "TEMP", "TMP", ...environmentAllowlist]) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    const child = spawnProcess(executable, args, {
      cwd,
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`Engineering executor exited with code ${code ?? "none"} and signal ${signal ?? "none"}.`));
      else resolve({ stdout, stderr });
    });
  });
}
