import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
    "board-task.schema.json",
    "evidence-receipt.schema.json",
    "handoff.schema.json",
    "project-config.schema.json",
    "workbook-write-manifest.schema.json"
  ]);

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
  }
});
