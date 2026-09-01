import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertControlledWriterAdapter,
  controlledWriterMethodNames,
  validateControlledWriterAdapter
} from "../src/adapters/controlled-writer-contract.js";
import { createDefaultConfig } from "../src/defaults.js";
import { buildProjectFiles } from "../src/generator.js";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

async function descriptor() {
  return JSON.parse(
    await fs.readFile(
      path.join(repositoryRoot, "templates", "writers", "controlled-writer-adapter.json"),
      "utf8"
    )
  );
}

function implementation() {
  return Object.fromEntries(
    controlledWriterMethodNames().map((method) => [method, async () => ({ method })])
  );
}

test("controlled-writer descriptor is portable, fail-closed, and executable-interface complete", async () => {
  const contract = await descriptor();
  assert.deepEqual(validateControlledWriterAdapter(contract, implementation()), []);
  assert.equal(contract.enabled, false);
  assert.equal(contract.implementation, "not-configured");
  assert.equal("endpoint" in contract, false);
  assert.equal("credential" in contract, false);
  assert.deepEqual(controlledWriterMethodNames(), [
    "plan",
    "apply",
    "readBack",
    "replay",
    "rollback"
  ]);
});

test("controlled-writer contract rejects weakened controls and incomplete implementations", async () => {
  const weakened = await descriptor();
  weakened.controls.completeReadBackRequired = false;
  assert.match(
    validateControlledWriterAdapter(weakened, implementation()).join("\n"),
    /completeReadBackRequired/
  );

  const incomplete = implementation();
  delete incomplete.readBack;
  assert.throws(
    () => assertControlledWriterAdapter(awaitableDescriptor, incomplete),
    /readBack must be a function/
  );
});

const awaitableDescriptor = JSON.parse(
  await fs.readFile(
    path.join(repositoryRoot, "templates", "writers", "controlled-writer-adapter.json"),
    "utf8"
  )
);

test("project bootstrap installs the adapter contract and its public schema", async () => {
  const files = buildProjectFiles(createDefaultConfig(path.join("workspace", "sample-product")), {
    includeConfig: true
  });
  assert.deepEqual(
    JSON.parse(files.get("adapters/controlled-writer.json")),
    awaitableDescriptor
  );
  assert.ok(files.has("schemas/controlled-writer-adapter.schema.json"));
});
