import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export function safeId(value, { maxLength = 100, label = "autonomous cycle identifier" } = {}) {
  const safe = String(value).replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  if (!safe || safe.includes("..")) throw new Error(`Unsafe ${label}.`);
  return safe.slice(0, maxLength);
}

export async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function readJsonOptional(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export function runGit(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-c", `safe.directory=${path.resolve(cwd)}`, ...args], {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0
      ? resolve({ stdout, stderr })
      : reject(new Error(`Git failed (${code}): ${stderr.trim()}`)));
  });
}
