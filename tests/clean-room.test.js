import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { scanExcludedSourceIdentity } from "../scripts/check-clean-room.mjs";
import { makeTempDirectory } from "./helpers.js";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

test("public tree contains no excluded source-product identity", async () => {
  assert.deepEqual(await scanExcludedSourceIdentity(repositoryRoot), []);
});

test("clean-room scan detects an excluded identity without publishing it in fixtures", async (t) => {
  const root = await makeTempDirectory();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const excludedIdentity = String.fromCharCode(108, 105, 110, 107, 117, 112);
  await fs.writeFile(
    path.join(root, "historical-evidence.txt"),
    `Private source context: ${excludedIdentity}\n`,
    "utf8"
  );

  const findings = await scanExcludedSourceIdentity(root);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, "historical-evidence.txt");
  assert.equal(findings[0].policyLabel, "excluded-source-product-name");
});
