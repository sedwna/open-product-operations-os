import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { CONFIG_FILE } from "../src/constants.js";
import { run } from "../src/cli.js";
import { captureIo, makeTempDirectory, readJson, writeJson } from "./helpers.js";

async function initializedProject(t, name) {
  const parent = await makeTempDirectory();
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const target = path.join(parent, name);
  const output = captureIo();
  assert.equal(await run(["init", target], output.io), 0);
  return { target, output };
}

test("validate rejects unknown ownership and routing references", async (t) => {
  const { target, output } = await initializedProject(t, "invalid-ownership");
  const configPath = path.join(target, CONFIG_FILE);
  const config = await readJson(configPath);
  config.ownership[0].owner = "MISSING";
  config.routing[0].reviewers.push("UNKNOWN");
  await writeJson(configPath, config);

  assert.equal(await run(["validate", target], output.io), 1);
  const message = output.stderr.at(-1);
  assert.match(message, /unknown agent "MISSING"/);
  assert.match(message, /unknown reviewer "UNKNOWN"/);
});

test("validate rejects duplicate task IDs, undefined statuses, and bad dependencies", async (t) => {
  const { target, output } = await initializedProject(t, "invalid-taskboard");
  const taskboard = path.join(target, "taskboard/tasks.csv");
  const existing = await fs.readFile(taskboard, "utf8");
  const taskId = existing.split(/\r?\n/)[1].split(",")[0];
  const prefix = taskId.slice(0, taskId.lastIndexOf("-"));
  await fs.writeFile(
    taskboard,
    `${existing}${taskId},Duplicate task,CONTROL,Unknown,new-idea,${prefix}-9999,,\n`,
    "utf8"
  );

  assert.equal(await run(["validate", target], output.io), 1);
  const message = output.stderr.at(-1);
  assert.match(message, new RegExp(`duplicates task ID "${taskId}"`));
  assert.match(message, /undefined status "Unknown"/);
  assert.match(message, new RegExp(`depends on missing task "${prefix}-9999"`));
});

test("validate detects missing files, generated drift, and obvious credentials", async (t) => {
  const { target, output } = await initializedProject(t, "integrity-checks");
  await fs.rm(path.join(target, "adapters/git.json"));
  await fs.writeFile(
    path.join(target, "agents/registry.json"),
    '{"schemaVersion":"1.0.0","generatedFrom":"product-ops.config.json","agents":[]}\n'
  );
  await fs.appendFile(
    path.join(target, "workbook/evidence-log.csv"),
    "E-1,Claim,api_key=abcdefghijklmnopqrstuvwxyz123456,2026-01-01T00:00:00Z,QUALITY,pass\n"
  );

  assert.equal(await run(["validate", target], output.io), 1);
  const message = output.stderr.at(-1);
  assert.match(message, /Missing required file "adapters\/git.json"/);
  assert.match(message, /has drifted from the project configuration/);
  assert.match(message, /Possible assigned credential/);
});

test("validate rejects undefined status transitions", async (t) => {
  const { target, output } = await initializedProject(t, "invalid-statuses");
  const configPath = path.join(target, CONFIG_FILE);
  const config = await readJson(configPath);
  config.statuses[0].transitions.push("Waiting Forever");
  await writeJson(configPath, config);

  assert.equal(await run(["validate", target], output.io), 1);
  assert.match(
    output.stderr.at(-1),
    /transitions to undefined status "Waiting Forever"/
  );
});

test("validate rejects generated paths that escape the project", async (t) => {
  const { target, output } = await initializedProject(t, "unsafe-path");
  const configPath = path.join(target, CONFIG_FILE);
  const config = await readJson(configPath);
  config.workbook.sheets[0].file = "../outside.csv";
  await writeJson(configPath, config);

  assert.equal(await run(["validate", target], output.io), 1);
  assert.match(output.stderr.at(-1), /must stay inside the project directory/);
});
