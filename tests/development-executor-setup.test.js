import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { main as developmentMain } from "../src/development-cli.js";
import { initializeDevelopmentOs } from "../src/development/init.js";
import {
  configureDevelopmentExecutors,
  doctorDevelopmentExecutors,
  EXECUTOR_ISOLATION_WARNING
} from "../src/development/executor-setup.js";

test("Codex preset is dry-run-first, schema-bound, credential-free, and disabled by default", async (t) => {
  const root = await developmentRoot(t);
  const before = await fs.readFile(path.join(root, "development-os.config.json"), "utf8");
  const result = await configureDevelopmentExecutors(root, {
    provider: "codex",
    role: "ENG-04",
    resolveCommand: async () => path.join(root, "codex")
  });
  const after = await fs.readFile(path.join(root, "development-os.config.json"), "utf8");
  assert.equal(after, before);
  assert.equal(result.dryRun, true);
  assert.equal(result.enabled, false);
  assert.equal(result.doctor.ok, true);
  assert.match(result.warning, /container, VM, or isolated hosted worker/);

  const operation = result.operations.find((candidate) => candidate.relativePath === "development-os.config.json");
  const proposed = JSON.parse(operation.content);
  const executor = proposed.executors.find((candidate) => candidate.roleId === "ENG-04");
  assert.equal(executor.enabled, false);
  assert.equal(executor.executable, "codex");
  assert.deepEqual(executor.environmentAllowlist, []);
  assert.equal(executor.isolation, "external-required");
  assert.deepEqual(executor.arguments.slice(0, 6), [
    "exec", "--ephemeral", "--sandbox", "workspace-write", "--output-schema",
    "{projectRoot}/engineering/schemas/engineering-workstream-run.schema.json"
  ]);
  assert.match(executor.arguments[6], /Read the JSON workstream input at \{inputFile\}/);
  assert.match(executor.arguments[6], /engineering-workstream-run\.schema\.json/);
  assert.doesNotMatch(JSON.stringify(executor), /api[_-]?key|password|secret/i);
});

test("activation requires --enable and a passing read-only doctor", async (t) => {
  const root = await developmentRoot(t);
  await configureDevelopmentExecutors(root, {
    provider: "command",
    role: "ENG-01",
    executable: process.execPath,
    arguments: ["./synthetic-adapter.mjs", "{inputFile}"],
    dryRun: false
  });
  let config = await readConfig(root);
  assert.equal(config.executors.find((candidate) => candidate.roleId === "ENG-01").enabled, false);

  const beforeDoctor = await digest(path.join(root, "development-os.config.json"));
  const doctor = await doctorDevelopmentExecutors(root, { role: "ENG-01" });
  const afterDoctor = await digest(path.join(root, "development-os.config.json"));
  assert.equal(doctor.ok, true);
  assert.equal(doctor.readOnly, true);
  assert.equal(afterDoctor, beforeDoctor);
  assert.deepEqual(doctor.warnings, [EXECUTOR_ISOLATION_WARNING]);

  await configureDevelopmentExecutors(root, {
    provider: "command",
    role: "ENG-01",
    executable: process.execPath,
    arguments: ["./synthetic-adapter.mjs", "{inputFile}"],
    enable: true,
    dryRun: false
  });
  config = await readConfig(root);
  assert.equal(config.executors.find((candidate) => candidate.roleId === "ENG-01").enabled, true);
});

test("failed doctor blocks activation and leaves configuration unchanged", async (t) => {
  const root = await developmentRoot(t);
  const configFile = path.join(root, "development-os.config.json");
  const before = await fs.readFile(configFile, "utf8");
  await assert.rejects(
    configureDevelopmentExecutors(root, {
      provider: "command",
      role: "ENG-06",
      executable: path.join(root, "missing-engineering-adapter"),
      arguments: ["{inputFile}"],
      enable: true,
      dryRun: false
    }),
    /doctor failed; refusing activation/
  );
  assert.equal(await fs.readFile(configFile, "utf8"), before);
});

test("command provider requires an input contract placeholder", async (t) => {
  const root = await developmentRoot(t);
  await assert.rejects(
    configureDevelopmentExecutors(root, {
      provider: "command",
      role: "all",
      executable: process.execPath,
      arguments: ["./adapter.mjs"]
    }),
    /requires at least one --argument containing "\{inputFile\}"/
  );
});

test("command provider rejects shell interpreters even though process spawning is shell-free", async (t) => {
  const root = await developmentRoot(t);
  await assert.rejects(
    configureDevelopmentExecutors(root, {
      provider: "command",
      role: "ENG-09",
      executable: process.platform === "win32" ? "powershell.exe" : "/bin/sh",
      arguments: ["{inputFile}"]
    }),
    /cannot use a shell interpreter/
  );
});

test("development CLI configures, enables, and diagnoses a command executor", async (t) => {
  const root = await developmentRoot(t);
  const output = [];
  const io = { log: (line) => output.push(String(line)) };
  assert.equal(await developmentMain([
    "executor-setup", root,
    "--provider", "command",
    "--role", "ENG-02",
    "--executable", process.execPath,
    "--argument={inputFile}",
    "--enable",
    "--apply"
  ], io), 0);
  assert.equal(await developmentMain(["executor-doctor", root, "--role", "ENG-02"], io), 0);
  const config = await readConfig(root);
  assert.equal(config.executors.find((candidate) => candidate.roleId === "ENG-02").enabled, true);
  assert.ok(output.some((line) => line.includes("no files were changed")));
  await assert.rejects(
    developmentMain(["executor-setup", root, "--provider", "command", "--executable", process.execPath, "--argument={inputFile}"], io),
    /requires --role/
  );
});

async function developmentRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "development-executor-setup-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await initializeDevelopmentOs(root, { dryRun: false });
  return root;
}

async function readConfig(root) {
  return JSON.parse(await fs.readFile(path.join(root, "development-os.config.json"), "utf8"));
}

async function digest(file) {
  return crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
}
