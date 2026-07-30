import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nodeModules = path.join(root, "node_modules");
const allowed = new Set(["Apache-2.0", "MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "0BSD"]);
const checked = [];

await visitNodeModules(nodeModules);
assert.ok(checked.length >= 3, "installed production dependencies were not found");
console.log(`Installed dependency license allowlist checked for ${checked.length} package(s).`);

async function visitNodeModules(directory) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("Run npm install or npm ci before checking dependency licenses.");
    }
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === ".bin") {
      continue;
    }
    if (entry.name.startsWith("@")) {
      await visitScope(path.join(directory, entry.name));
      continue;
    }
    await checkPackage(path.join(directory, entry.name));
  }
}

async function visitScope(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      await checkPackage(path.join(directory, entry.name));
    }
  }
}

async function checkPackage(directory) {
  const metadata = JSON.parse(await fs.readFile(path.join(directory, "package.json"), "utf8"));
  const license =
    typeof metadata.license === "string" ? metadata.license : metadata.license?.type;
  assert.equal(typeof license, "string", `${metadata.name} must declare a license`);
  assert.ok(allowed.has(license), `${metadata.name} uses unapproved license ${license}`);
  checked.push(`${metadata.name}@${metadata.version}:${license}`);
  const nested = path.join(directory, "node_modules");
  try {
    await fs.access(nested);
    await visitNodeModules(nested);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}
