import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { CONFIG_FILE } from "../src/constants.js";
import { run } from "../src/cli.js";
import { captureIo, makeTempDirectory, readJson, writeJson } from "./helpers.js";

test("init creates the canonical 13-role, 23-tab project and validate accepts it", async (t) => {
  const parent = await makeTempDirectory();
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const target = path.join(parent, "sample-product");
  const output = captureIo();

  assert.equal(await run(["init", target], output.io), 0);
  assert.equal(await run(["validate", target], output.io), 0);

  const config = await readJson(path.join(target, CONFIG_FILE));
  assert.equal(config.project.id, "sample-product");
  assert.equal(config.taskIds.prefix, "SP");
  assert.equal(config.agents.length, 13);
  assert.equal(config.workbook.sheets.length, 23);

  for (const agent of config.agents) {
    await fs.access(path.join(target, "agents", "roles", `${agent.id}.md`));
  }
  for (const sheet of config.workbook.sheets) {
    await fs.access(path.join(target, sheet.file));
  }
  await fs.access(
    path.join(target, "events", "EVT-00000000-001-first-discovery.md")
  );
  await fs.access(path.join(target, "config", "operating-model.yaml"));
  const discovery = await fs.readFile(
    path.join(target, "workbook", "08-discovery.csv"),
    "utf8"
  );
  assert.match(discovery, /DSC-00000000-001/);
  assert.match(output.stdout.join("\n"), /Validation passed/);
});

test("init dry-run reports the complete project without creating the target", async (t) => {
  const parent = await makeTempDirectory();
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const target = path.join(parent, "dry-run-product");
  const output = captureIo();

  assert.equal(await run(["init", target, "--dry-run"], output.io), 0);
  await assert.rejects(fs.access(target), { code: "ENOENT" });
  assert.match(output.stdout.join("\n"), /Dry run: would write 56 file\(s\)/);
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

test("generate-workbook adds a bounded extension sheet and honors dry-run", async (t) => {
  const parent = await makeTempDirectory();
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const target = path.join(parent, "workbook-product");
  const configPath = path.join(target, CONFIG_FILE);
  const output = captureIo();

  assert.equal(await run(["init", target], output.io), 0);
  const config = await readJson(configPath);
  config.workbook.sheets.push({
    key: "risk_register",
    name: "Risk Register",
    file: "workbook/risk-register.csv",
    owner: "RB-08",
    columns: ["risk_id", "description", "owner", "disposition"]
  });
  config.ownership.push({ artifact: "risk_register", owner: "RB-08" });
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
    "risk_id,description,owner,disposition\n"
  );
  assert.equal(await run(["init", target, "--force"], output.io), 0);
  assert.equal(await run(["validate", target], output.io), 0);
});

test("generate-workbook --force preserves operational rows", async (t) => {
  const parent = await makeTempDirectory();
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const target = path.join(parent, "protected-product");
  const workbook = path.join(target, "workbook", "10-issues.csv");
  const output = captureIo();

  assert.equal(await run(["init", target], output.io), 0);
  await fs.appendFile(
    workbook,
    "ISS-CANARY,EVT-CANARY,Operational canary,open,P2,low,,,,,,,,,,,,RB-05,actor-rb-05,,\n"
  );

  assert.equal(await run(["generate-workbook", target], output.io), 1);
  assert.match(output.stderr.at(-1), /Refusing to overwrite/);
  assert.match(await fs.readFile(workbook, "utf8"), /ISS-CANARY/);

  assert.equal(await run(["generate-workbook", target, "--force"], output.io), 0);
  assert.match(await fs.readFile(workbook, "utf8"), /ISS-CANARY/);
  assert.equal(await run(["validate", target], output.io), 0);
});

test("init rejects symlink or junction traversal before any escaped write", async (t) => {
  const parent = await makeTempDirectory();
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const target = path.join(parent, "linked-product");
  const outside = path.join(parent, "outside");
  await fs.mkdir(target);
  await fs.mkdir(outside);
  const linkType = process.platform === "win32" ? "junction" : "dir";
  await fs.symlink(outside, path.join(target, "workbook"), linkType);
  const output = captureIo();

  assert.equal(await run(["init", target], output.io), 1);
  assert.match(output.stderr.at(-1), /symbolic link, junction, or reparse point/);
  assert.deepEqual(await fs.readdir(outside), []);
});

test("init rejects a target root that is itself a symlink or junction", async (t) => {
  const parent = await makeTempDirectory();
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const realParent = path.join(parent, "real-parent");
  const linkedParent = path.join(parent, "linked-parent");
  await fs.mkdir(realParent);
  await fs.symlink(
    realParent,
    linkedParent,
    process.platform === "win32" ? "junction" : "dir"
  );
  const output = captureIo();

  assert.equal(
    await run(["init", linkedParent], output.io),
    1
  );
  assert.match(output.stderr.at(-1), /symbolic link, junction, or reparse point/);
  assert.deepEqual(await fs.readdir(realParent), []);
});

test("init canonicalizes a pre-existing alias outside the selected target root", async (t) => {
  const parent = await makeTempDirectory();
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const realParent = path.join(parent, "real-parent");
  const linkedParent = path.join(parent, "linked-parent");
  await fs.mkdir(realParent);
  await fs.symlink(
    realParent,
    linkedParent,
    process.platform === "win32" ? "junction" : "dir"
  );
  const target = path.join(linkedParent, "new-product");
  const output = captureIo();

  assert.equal(await run(["init", target], output.io), 0);
  assert.equal(await run(["validate", target], output.io), 0);
  await fs.access(path.join(realParent, "new-product", CONFIG_FILE));
});

test("unknown CLI options fail cleanly", async () => {
  const output = captureIo();
  assert.equal(await run(["init", "target", "--mystery"], output.io), 1);
  assert.match(output.stderr[0], /Unknown option/);
});
