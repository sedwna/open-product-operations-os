import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const parent = await fs.mkdtemp(path.join(os.tmpdir(), "product-ops-smoke-"));
const target = path.join(parent, "smoke-project");
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const cli = path.join(repositoryRoot, "src/cli.js");
const execute = promisify(execFile);

try {
  await execute(process.execPath, [cli, "init", target]);
  await execute(process.execPath, [cli, "validate", target]);
  const before = await treeDigest(target);
  await execute(process.execPath, [cli, "init", target]);
  const after = await treeDigest(target);
  assert.equal(after, before, "idempotent re-init tree digest");
  await execute(process.execPath, [cli, "validate", target]);
  await execute(process.execPath, [cli, "generate-workbook", target]);
  await execute(process.execPath, [cli, "operate", target]);
  await execute(process.execPath, [cli, "setup", target, "--apply"]);
  await execute(process.execPath, [cli, "metrics", target, "--apply"]);
  await execute(process.execPath, [cli, "dashboard", target, "--apply"]);
  await execute(process.execPath, [cli, "validate", target]);
  const config = JSON.parse(
    await fs.readFile(path.join(target, "product-ops.config.json"), "utf8")
  );
  assert.equal(config.agents.length, 13);
  assert.equal(config.workbook.sheets.length, 23);
  console.log("Smoke verified init, validation, stable re-init, runtime planning, local dashboard, metrics, 13 roles, and 23 tabs.");
} finally {
  await fs.rm(parent, { recursive: true, force: true });
}

async function treeDigest(directory) {
  const entries = [];
  async function visit(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const location = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(location);
      } else if (entry.isFile()) {
        entries.push([
          path.relative(directory, location).replaceAll("\\", "/"),
          crypto.createHash("sha256").update(await fs.readFile(location)).digest("hex")
        ]);
      }
    }
  }
  await visit(directory);
  entries.sort(([left], [right]) => left.localeCompare(right));
  return crypto.createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}
