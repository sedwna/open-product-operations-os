#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const statePath = path.join(root, ".product-ops-pack-mode-state.json");
const targets = [
  "launchers/common/bootstrap-node.sh",
  "launchers/linux/open-product-os.sh",
  "launchers/macos/OpenProductOS.command",
  "scripts/one-click-onboarding.mjs",
  "src/development-cli.js"
];
const operation = process.argv[2];

if (!["prepare", "restore"].includes(operation)) {
  throw new Error("Usage: node scripts/normalize-pack-modes.mjs <prepare|restore>");
}

if (process.platform === "win32") process.exit(0);
if (operation === "prepare") await prepare();
else await restore();

async function prepare() {
  if (await exists(statePath)) {
    throw new Error("A prior pack mode state remains; restore it before packing again.");
  }
  const entries = [];
  for (const relative of targets) {
    const filename = contained(relative);
    const stat = await fs.stat(filename);
    if (!stat.isFile()) throw new Error(`Pack mode target is not a file: ${relative}`);
    entries.push({ path: relative, mode: stat.mode & 0o777 });
  }
  const handle = await fs.open(statePath, "wx");
  try {
    await handle.writeFile(`${JSON.stringify({ version: 1, entries }, null, 2)}\n`);
  } finally {
    await handle.close();
  }
  try {
    for (const entry of entries) await fs.chmod(contained(entry.path), 0o644);
  } catch (error) {
    await restore();
    throw error;
  }
}

async function restore() {
  if (!await exists(statePath)) return;
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  if (state.version !== 1 || !Array.isArray(state.entries)) {
    throw new Error("Pack mode recovery state is invalid; refusing ambiguous restoration.");
  }
  for (const entry of state.entries) {
    if (!targets.includes(entry.path) || !Number.isInteger(entry.mode)) {
      throw new Error("Pack mode recovery state contains an unexpected target.");
    }
    await fs.chmod(contained(entry.path), entry.mode);
  }
  await fs.rm(statePath);
}

function contained(relative) {
  const filename = path.resolve(root, relative);
  const rel = path.relative(root, filename);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Pack mode target escapes the repository: ${relative}`);
  }
  return filename;
}

async function exists(filename) {
  return fs.access(filename).then(() => true, () => false);
}
