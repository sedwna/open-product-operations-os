#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const operation = process.argv[2];
if (!["prepare", "restore"].includes(operation)) {
  throw new Error("Usage: node scripts/pack-lifecycle.mjs <prepare|restore>");
}

if (operation === "prepare") {
  run("check-pack-source.mjs", "prepare");
  try {
    run("normalize-pack-modes.mjs", "prepare");
  } catch (error) {
    run("check-pack-source.mjs", "restore", true);
    throw error;
  }
} else {
  let firstError;
  try { run("normalize-pack-modes.mjs", "restore"); } catch (error) { firstError = error; }
  try { run("check-pack-source.mjs", "restore"); } catch (error) { firstError ??= error; }
  if (firstError) throw firstError;
}

function run(script, argument, tolerateFailure = false) {
  const result = spawnSync(process.execPath, [path.join(root, "scripts", script), argument], {
    cwd: root,
    stdio: "inherit",
    shell: false,
    windowsHide: true
  });
  if (result.status !== 0 && !tolerateFailure) {
    throw new Error(`${script} ${argument} failed with status ${result.status ?? result.signal ?? "unknown"}.`);
  }
}
