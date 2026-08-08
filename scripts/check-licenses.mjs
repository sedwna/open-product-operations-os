import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The licence allowlist governs what this package ships, so it is scoped to what a consumer
 * actually installs.
 *
 * It used to walk every directory under node_modules, which was the same set only for as long as
 * the repository had no development dependencies. The moment one arrived, the check started
 * refusing licences on tooling that is never published — a gate failing for a reason unrelated to
 * the thing it protects. The lockfile already records which entries are development-only, so the
 * scope now comes from there rather than from what happens to be on disk.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const allowed = new Set(["Apache-2.0", "MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "OFL", "OFL-1.1"]);

// A published package ships npm-shrinkwrap.json and no package-lock.json, and this check runs
// inside the packed artifact as well as in the source tree. Naming only one of them passed here and
// failed there — the same mistake in the opposite direction to the one it replaced.
const lockPath = ["package-lock.json", "npm-shrinkwrap.json"]
  .map((name) => path.join(root, name))
  .find((candidate) => existsSync(candidate));
assert.ok(lockPath, "no package-lock.json or npm-shrinkwrap.json to read the dependency tree from");
const lockfile = JSON.parse(await fs.readFile(lockPath, "utf8"));
const production = Object.entries(lockfile.packages ?? {})
  .filter(([location, entry]) => location.startsWith("node_modules/") && entry.dev !== true)
  .map(([location]) => location)
  .sort();

assert.ok(production.length >= 3, "the lockfile records no production dependencies to check");

const checked = [];
const missing = [];
for (const location of production) {
  const directory = path.join(root, location);
  let metadata;
  try {
    metadata = JSON.parse(await fs.readFile(path.join(directory, "package.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      missing.push(location);
      continue;
    }
    throw error;
  }
  const license = typeof metadata.license === "string" ? metadata.license : metadata.license?.type;
  assert.equal(typeof license, "string", `${metadata.name} must declare a license`);
  assert.ok(allowed.has(license), `${metadata.name} uses unapproved license ${license}`);
  checked.push(`${metadata.name}@${metadata.version}:${license}`);
}

// A production dependency in the lockfile but absent from disk means the check silently skipped it.
// Reporting that is the difference between "all approved" and "all of the ones I could find".
assert.deepEqual(missing, [], `run npm ci before checking licences; not installed: ${missing.join(", ")}`);
assert.equal(checked.length, production.length);
console.log(`Production dependency license allowlist checked for ${checked.length} package(s).`);
