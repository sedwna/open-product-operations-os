import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { SCHEMA_VERSION } from "../constants.js";
import { assertNoLinkTraversal, resolveInside } from "../paths.js";
import { validatePublishedSchema } from "../schema-validation.js";
import { loadApprovals } from "./approvals.js";
import { splitReferences, utcTimestamp, writeJson } from "./io.js";
import { dependencyState, loadTaskboard } from "./taskboard.js";
import { assertNoCredentialMaterial } from "./security.js";
import { prepareGitWorkspace } from "../adapters/local-git.js";

const MAX_EXECUTOR_OUTPUT_BYTES = 1024 * 1024;

export async function runDevelopmentTask(
  root,
  config,
  taskId,
  { dryRun = true, now = new Date(), spawnProcess = spawn } = {}
) {
  const [{ records: tasks, byId }, approvals] = await Promise.all([
    loadTaskboard(root),
    loadApprovals(root)
  ]);
  const task = byId.get(taskId);
  if (!task) throw new Error(`Unknown task "${taskId}".`);
  if (task.owner_role !== config.separation.developmentRole) {
    throw new Error(`Task "${taskId}" is not owned by the development adapter role.`);
  }
  if (!["ready", "in_progress"].includes(task.status)) {
    throw new Error(`Task "${taskId}" is not ready for development execution.`);
  }
  const dependencies = dependencyState(task, byId);
  if (!dependencies.satisfied) {
    throw new Error(`Task "${taskId}" has unresolved dependencies.`);
  }
  if (
    task.human_gate &&
    !approvals.requests.some(
      (request) => request.taskId === taskId && request.gate === task.human_gate && request.status === "approved"
    )
  ) {
    throw new Error(`Task "${taskId}" requires an attributed human approval.`);
  }

  const adapter = config.adapters.development;
  if (!adapter.enabled || adapter.implementation !== "command-runner") {
    throw new Error("Development adapter is disabled or not configured as a command runner.");
  }
  const settings = adapter.settings ?? {};
  if (typeof settings.executable !== "string" || settings.executable.trim() === "") {
    throw new Error("Development command runner requires a configured executable.");
  }
  const workingDirectory = resolveInside(root, settings.workingDirectory ?? ".", "Development working directory");
  await assertNoLinkTraversal(root, workingDirectory, "Development working directory");
  const artifacts = await loadArtifacts(root, splitReferences(task.canonical_output_refs));
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    taskId: task.task_id,
    eventId: task.event_id,
    title: task.title,
    priority: task.priority,
    allowedPaths: settings.allowedPaths ?? [],
    prohibitedFields: config.fieldAuthority.protectedHumanFields,
    artifacts,
    returnContract: {
      format: "development-run.schema.json",
      output: "stdout-json"
    },
    dispatchedAt: utcTimestamp(now)
  };
  assertNoCredentialMaterial("Development payload", payload);
  const inputFile = `.product-ops/runtime/development/${safeId(taskId)}-input.json`;
  const resultFile = `.product-ops/runtime/development/${safeId(taskId)}-result.json`;
  const argumentsList = (settings.arguments ?? []).map((argument) =>
    String(argument)
      .replaceAll("{taskFile}", path.resolve(root, inputFile))
      .replaceAll("{projectRoot}", path.resolve(root))
      .replaceAll("{taskId}", taskId)
  );
  if (dryRun) {
    const git = await prepareGitWorkspace(root, config, taskId, { dryRun: true });
    return {
      dryRun: true,
      taskId,
      executable: settings.executable,
      arguments: argumentsList,
      workingDirectory,
      inputFile,
      resultFile,
      git,
      payload
    };
  }

  await writeJson(root, inputFile, payload, { dryRun: false });
  const git = await prepareGitWorkspace(root, config, taskId, { dryRun: false });
  const execution = await execute(settings.executable, argumentsList, {
    cwd: workingDirectory,
    timeoutMs: settings.timeoutMs ?? 1800000,
    environmentAllowlist: settings.environmentAllowlist ?? [],
    spawnProcess
  });
  let result;
  try {
    result = JSON.parse(execution.stdout.trim());
  } catch (error) {
    throw new Error(`Development agent did not return valid JSON: ${error.message}`);
  }
  const errors = validatePublishedSchema("development-run.schema.json", result);
  if (errors.length > 0) {
    throw new Error(`Invalid development return:\n- ${errors.join("\n- ")}`);
  }
  if (result.taskId !== taskId) {
    throw new Error("Development return taskId does not match the dispatched task.");
  }
  assertNoCredentialMaterial("Development return", result);
  await writeJson(root, resultFile, result, { dryRun: false });
  return { dryRun: false, taskId, inputFile, resultFile, result, git, stderr: execution.stderr };
}

async function loadArtifacts(root, references) {
  const artifacts = [];
  for (const relativePath of references) {
    const file = resolveInside(root, relativePath, `Development artifact "${relativePath}"`);
    await assertNoLinkTraversal(root, file, `Development artifact "${relativePath}"`);
    artifacts.push({ path: relativePath, content: await fs.readFile(file, "utf8") });
  }
  return artifacts;
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
          new Error(`Development agent ${channel} exceeded the ${MAX_EXECUTOR_OUTPUT_BYTES}-byte limit.`),
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
      settleReject(new Error(`Development agent timed out after ${timeoutMs}ms.`), { terminate: true });
    }, timeoutMs);
    child.once("error", (error) => { settleReject(error); });
    child.once("close", (code, signal) => {
      if (code !== 0) {
        settleReject(new Error(`Development agent exited with code ${code ?? "none"} and signal ${signal ?? "none"}.`));
      } else {
        settleResolve({
          stdout: Buffer.concat(stdout, stdoutBytes).toString("utf8"),
          stderr: Buffer.concat(stderr, stderrBytes).toString("utf8")
        });
      }
    });
  });
}

function safeId(value) {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error("Task ID is unsafe for a runtime path.");
  return value;
}
