import assert from "node:assert/strict";
import fs from "node:fs/promises";

const lock = JSON.parse(await fs.readFile(new URL("../package-lock.json", import.meta.url)));
const allowed = new Set(["Apache-2.0", "MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "0BSD"]);
const checked = [];

for (const [location, metadata] of Object.entries(lock.packages)) {
  if (!location || metadata.dev || metadata.optional) {
    continue;
  }
  assert.equal(
    typeof metadata.license,
    "string",
    `${location} must declare a license in package-lock.json`
  );
  assert.ok(
    allowed.has(metadata.license),
    `${location} uses unapproved license ${metadata.license}`
  );
  checked.push(`${location}:${metadata.license}`);
}

console.log(`Dependency license allowlist checked for ${checked.length} package(s).`);
