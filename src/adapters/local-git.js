import { spawn } from "node:child_process";
import { resolveInside } from "../paths.js";

export async function prepareGitWorkspace(root, config, taskId, { dryRun = true, spawnProcess = spawn } = {}) {
  const adapter = config.adapters.git;
  if (!adapter?.enabled) return { enabled: false };
  if (adapter.implementation !== "local-git") throw new Error("Git adapter implementation must be local-git.");
  const repository = resolveInside(root, adapter.settings?.repositoryPath ?? ".", "Git repository");
  const status = await runGit(repository, ["status", "--porcelain"], spawnProcess);
  if (adapter.settings?.requireCleanWorktree !== false && status.stdout.trim() !== "") {
    throw new Error("Development Git repository must be clean before branch preparation.");
  }
  const baseRevision = (await runGit(repository, ["rev-parse", "HEAD"], spawnProcess)).stdout.trim();
  const branch = `${adapter.settings?.branchPrefix ?? "product-ops/"}${taskId.toLowerCase()}`;
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes("..") || branch.startsWith("/") || branch.endsWith("/")) {
    throw new Error("Configured development branch name is unsafe.");
  }
  if (!dryRun) await runGit(repository, ["switch", "-c", branch], spawnProcess);
  return { enabled: true, dryRun, repository, branch, baseRevision };
}

function runGit(cwd, args, spawnProcess) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess("git", args, { cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8"); child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`Git command failed with code ${code}: ${stderr.trim()}`)));
  });
}
