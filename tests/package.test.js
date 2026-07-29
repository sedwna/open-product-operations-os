import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { normalizeSbomRoot } from "../scripts/sbom-contract.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

test("npm package contains promised public templates, examples, docs, and metadata", async () => {
  const npmCli = process.env.npm_execpath;
  const command = npmCli
    ? process.execPath
    : process.platform === "win32"
      ? "npm.cmd"
      : "npm";
  const args = npmCli
    ? [npmCli, "pack", "--dry-run", "--json"]
    : ["pack", "--dry-run", "--json"];
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    shell: !npmCli && process.platform === "win32"
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const [pack] = JSON.parse(result.stdout);
  const files = new Set(pack.files.map((entry) => entry.path));
  for (const required of [
    "LICENSE",
    "README.md",
    "START-HERE.md",
    ".gitattributes",
    "npm-shrinkwrap.json",
    "scripts/sbom-contract.mjs",
    "src/cli.js",
    "src/local-writer.js",
    "schemas/workbook-write-manifest.schema.json",
    "schemas/workbook-write-receipt.schema.json",
    "templates/config/operating-model.yaml",
    "templates/workbook/tabs/23-lineage.csv",
    "examples/fictional-saas/lineage.csv",
    "docs/security-model.md",
    "docs/migration/clean-room-extraction-ledger.csv",
    "tests/validation.test.js"
  ]) {
    assert.ok(files.has(required), `package missing ${required}`);
  }

  const packageJson = JSON.parse(
    await fs.readFile(path.join(repositoryRoot, "package.json"), "utf8")
  );
  assert.equal(packageJson.license, "Apache-2.0");
  assert.match(packageJson.repository.url, /open-product-operations-os/);
  assert.match(packageJson.homepage, /open-product-operations-os/);
  assert.match(packageJson.bugs.url, /open-product-operations-os/);
  assert.equal(packageJson.publishConfig.provenance, true);
  const shrinkwrap = JSON.parse(
    await fs.readFile(path.join(repositoryRoot, "npm-shrinkwrap.json"), "utf8")
  );
  try {
    const lock = JSON.parse(
      await fs.readFile(path.join(repositoryRoot, "package-lock.json"), "utf8")
    );
    assert.deepEqual(
      shrinkwrap,
      lock,
      "published shrinkwrap must match the repository lockfile"
    );
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
});

test("SBOM root identity is invariant across clone and archive directory names", () => {
  const packageMetadata = {
    name: "open-product-operations-os",
    version: "0.1.0"
  };
  for (const directoryName of [
    "open-product-operations-os",
    "arbitrary-source-archive",
    "package"
  ]) {
    const priorReference = `${directoryName}@0.1.0`;
    const normalized = normalizeSbomRoot(
      {
        bomFormat: "CycloneDX",
        metadata: {
          component: {
            "bom-ref": priorReference,
            name: directoryName,
            version: "0.1.0",
            purl: `pkg:npm/${directoryName}@0.1.0`
          }
        },
        dependencies: [{ ref: priorReference, dependsOn: ["ajv@8.20.0"] }]
      },
      packageMetadata
    );
    assert.equal(normalized.metadata.component.name, packageMetadata.name);
    assert.equal(
      normalized.metadata.component["bom-ref"],
      "open-product-operations-os@0.1.0"
    );
    assert.equal(
      normalized.dependencies[0].ref,
      "open-product-operations-os@0.1.0"
    );
  }
});
