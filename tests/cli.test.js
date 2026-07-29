import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { CONFIG_FILE } from "../src/constants.js";
import { run } from "../src/cli.js";
import { captureIo, makeTempDirectory, readJson, writeJson } from "./helpers.js";

test("init creates a complete project and validate accepts it", async (t) => {
  const parent = await makeTempDirectory();
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const target = path.join(parent, "sample-product");
  const output = captureIo();

  assert.equal(await run(["init", target], output.io), 0);
  assert.equal(await run(["validate", target], output.io), 0);

  const expected = [
    CONFIG_FILE,
    "agents/registry.json",
    "governance/governance.json",
    "taskboard/tasks.csv",
    "workbook/product-map.csv",
    "workbook/decision-log.csv",
    "workbook/delivery-contracts.csv",
    "workbook/validation-plan.csv",
    "workbook/evidence-log.csv",
    "workbook/release-readiness.csv",
    "adapters/development.json",
    "adapters/git.json",
    "adapters/spreadsheet.json"
  ];

  for (const relativePath of expected) {
    await fs.access(path.join(target, relativePath));
  }

  const config = await readJson(path.join(target, CONFIG_FILE));
  assert.equal(config.project.id, "sample-product");
  assert.equal(config.taskIds.prefix, "SP");
  assert.match(output.stdout.join("\n"), /Validation passed/);
});

test("init dry-run reports files without creating the target", async (t) => {
  const parent = await makeTempDirectory();
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const target = path.join(parent, "dry-run-product");
  const output = captureIo();

  assert.equal(await run(["init", target, "--dry-run"], output.io), 0);
  await assert.rejects(fs.access(target), { code: "ENOENT" });
  assert.match(output.stdout.join("\n"), /Dry run: would write 13 file\(s\)/);
});

test("init derives valid task prefixes for short and numeric folder names", async (t) => {
  const parent = await makeTempDirectory();
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const output = captureIo();

  for (const folderName of ["x", "123-product"]) {
    const target = path.join(parent, folderName);
    assert.equal(await run(["init", target], output.io), 0);
    assert.equal(await run(["validate", target], output.io), 0);
    const config = await readJson(path.join(target, CONFIG_FILE));
    assert.match(config.taskIds.prefix, /^[A-Z][A-Z0-9]{1,7}$/);
  }
});

test("generate-workbook adds configured sheets and honors dry-run", async (t) => {
  const parent = await makeTempDirectory();
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const target = path.join(parent, "workbook-product");
  const configPath = path.join(target, CONFIG_FILE);
  const output = captureIo();

  assert.equal(await run(["init", target], output.io), 0);
  const config = await readJson(configPath);
  config.workbook.sheets.push({
    name: "Risk Register",
    file: "workbook/risk-register.csv",
    owner: "QUALITY",
    columns: ["Risk ID", "Description", "Owner", "Disposition"]
  });
  await writeJson(configPath, config);

  assert.equal(
    await run(["generate-workbook", target, "--dry-run"], output.io),
    0
  );
  await assert.rejects(fs.access(path.join(target, "workbook/risk-register.csv")), {
    code: "ENOENT"
  });

  assert.equal(await run(["generate-workbook", target], output.io), 0);
  assert.equal(
    await fs.readFile(path.join(target, "workbook/risk-register.csv"), "utf8"),
    "Risk ID,Description,Owner,Disposition\n"
  );
  assert.equal(await run(["validate", target], output.io), 0);
});

test("generate-workbook refuses data loss unless --force is explicit", async (t) => {
  const parent = await makeTempDirectory();
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const target = path.join(parent, "protected-product");
  const workbook = path.join(target, "workbook/product-map.csv");
  const output = captureIo();

  assert.equal(await run(["init", target], output.io), 0);
  await fs.appendFile(workbook, "ITEM-1,Area,Capability,Description,Ready,Evidence\n");

  assert.equal(await run(["generate-workbook", target], output.io), 1);
  assert.match(output.stderr.at(-1), /Refusing to overwrite/);
  assert.match(await fs.readFile(workbook, "utf8"), /ITEM-1/);

  assert.equal(
    await run(["generate-workbook", target, "--force"], output.io),
    0
  );
  assert.doesNotMatch(await fs.readFile(workbook, "utf8"), /ITEM-1/);
});

test("unknown CLI options fail cleanly", async () => {
  const output = captureIo();
  assert.equal(await run(["init", "target", "--mystery"], output.io), 1);
  assert.match(output.stderr[0], /Unknown option/);
});
