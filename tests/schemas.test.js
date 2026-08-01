import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

test("all public JSON schemas parse and declare Draft 2020-12", async () => {
  const schemaDirectory = path.join(repositoryRoot, "schemas");
  const files = (await fs.readdir(schemaDirectory))
    .filter((file) => file.endsWith(".schema.json"))
    .sort();

  assert.deepEqual(files, [
    "agent-registry.schema.json",
    "approval-store.schema.json",
    "board-task.schema.json",
    "development-run.schema.json",
    "evidence-receipt.schema.json",
    "handoff.schema.json",
    "intake-record.schema.json",
    "project-config.schema.json",
    "provider-catalog.schema.json",
    "provider-outbox-item.schema.json",
    "runtime-receipt.schema.json",
    "workbook-write-manifest.schema.json",
    "workbook-write-receipt.schema.json"
  ]);

  const ajv = new Ajv2020({ strict: true, allowUnionTypes: true });
  addFormats(ajv);
  for (const file of files) {
    const schema = JSON.parse(
      await fs.readFile(path.join(schemaDirectory, file), "utf8")
    );
    assert.equal(
      schema.$schema,
      "https://json-schema.org/draft/2020-12/schema",
      file
    );
    assert.equal(typeof schema.title, "string", file);
    assert.equal(schema.type, "object", file);
    assert.equal(typeof ajv.compile(schema), "function", file);
  }
});
