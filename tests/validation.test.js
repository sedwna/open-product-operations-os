import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { CONFIG_FILE } from "../src/constants.js";
import { parseCsv, stringifyCsv } from "../src/csv.js";
import { applyLocalWrite, rollbackLocalWrite } from "../src/local-writer.js";
import { run } from "../src/cli.js";
import { validateWriteManifest } from "../src/validation.js";
import { captureIo, makeTempDirectory, readJson, writeJson } from "./helpers.js";

async function initializedProject(t, name) {
  const parent = await makeTempDirectory();
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const target = path.join(parent, name);
  const output = captureIo();
  assert.equal(await run(["init", target], output.io), 0);
  return { target, output };
}

function buildSafeManifest(config, sheet) {
  const actor = (role) => config.agents.find((agent) => agent.id === role).actorId;
  return {
    schemaVersion: "1.0.0",
    manifestId: "WFM-LOCAL-001",
    eventId: "EVT-00000000-001",
    status: "authorized",
    semanticOwner: { role: "RB-06", actorId: actor("RB-06") },
    authorization: {
      ownerActorId: actor("RB-06"),
      authorizedByActorId: actor("RB-06"),
      authorizedAt: "2026-07-29T10:30:00Z",
      ownerConfirmed: true,
      humanProductionAuthorizationId: "not_applicable"
    },
    writer: { role: "RB-10", actorId: actor("RB-10") },
    target: {
      systemAlias: "local-test",
      environment: "local",
      file: sheet.file
    },
    scope: {
      sheet: sheet.name,
      keyFields: ["ticket_id"],
      allowedFields: ["status"],
      prohibitedFields: [
        "implementation_reference",
        "development_status",
        "development_notes"
      ],
      rows: [
        {
          key: { ticket_id: "TKT-20260729-001" },
          preconditions: { status: "implementation_complete" },
          changes: { status: "accepted" }
        }
      ]
    },
    controls: {
      dryRunRequired: true,
      smallestBoundedRange: "one status cell",
      fullRecordReadbackRequired: true,
      secondReadPath: "local CSV reopen",
      replayMustWriteZero: true,
      rollbackPlan: "Restore the backed-up CSV after verifying the post-write hash.",
      refuseIfEnvironmentAmbiguous: true,
      refuseIfPreconditionMismatch: true,
      secretValuesForbidden: true
    },
    createdAt: "2026-07-29T10:30:00Z"
  };
}

async function appendApprovedDecision(target, config, decisionId, eventId) {
  const file = path.join(target, "workbook", "09-decision-log.csv");
  const rows = parseCsv(await fs.readFile(file, "utf8"));
  const headers = rows[0];
  const decision = headers.map(() => "");
  const set = (field, value) => { decision[headers.indexOf(field)] = value; };
  set("decision_id", decisionId);
  set("event_id", eventId);
  set("title", "Authorize bounded test delivery");
  set("status", "approved");
  set("selected_option", "approved");
  set("decision_maker_actor_id", config.project.humanAuthorityActorId);
  set("decided_at", "2026-07-29T10:00:00.000Z");
  set("brief_reference", "test-fixture");
  set("evidence_refs", "test-fixture");
  set("risk_acceptance", "none");
  set("conditions", "Local test only");
  rows.push(decision);
  await fs.writeFile(file, stringifyCsv(rows), "utf8");
}

test("controlled local writer inserts a new canonical row with absent-record precondition and replays safely", async (t) => {
  const { target } = await initializedProject(t, "writer-insert");
  const config = await readJson(path.join(target, CONFIG_FILE));
  const sheet = config.workbook.sheets.find((entry) => entry.key === "events");
  const actor = (role) => config.agents.find((agent) => agent.id === role).actorId;
  const changes = {
    event_type: "new_idea", title: "Synthetic inserted event", status: "closed", priority: "P2", risk: "medium",
    source_id: "INT-SYNTHETIC", coordinator_role: "RB-01", coordinator_actor_id: actor("RB-01"),
    semantic_owner_roles: "RB-02|RB-06", writer_role: "RB-10", verifier_role: "RB-12",
    producer_actor_id: actor("RB-01"), verifier_actor_id: actor("RB-12"), opened_at: "2026-08-02T00:00:00Z",
    closed_at: "2026-08-02T00:01:00Z"
  };
  const manifest = {
    schemaVersion: "1.0.0", manifestId: "WFM-INSERT-001", eventId: "EVT-20260802-001", status: "authorized",
    semanticOwner: { role: "RB-01", actorId: actor("RB-01") },
    authorization: { ownerActorId: actor("RB-01"), authorizedByActorId: actor("RB-01"), authorizedAt: "2026-08-02T00:01:00Z", ownerConfirmed: true, humanProductionAuthorizationId: "not_applicable" },
    writer: { role: "RB-10", actorId: actor("RB-10") },
    target: { systemAlias: "local-test", environment: "local", file: sheet.file },
    scope: { sheet: sheet.name, keyFields: ["event_id"], allowedFields: Object.keys(changes), prohibitedFields: ["event_id"], rows: [{ operation: "insert", key: { event_id: "EVT-20260802-001" }, preconditions: { $record: "absent" }, changes }] },
    controls: { dryRunRequired: true, smallestBoundedRange: "one new event row", fullRecordReadbackRequired: true, secondReadPath: "local CSV reopen", replayMustWriteZero: true, rollbackPlan: "Restore the verified pre-write CSV backup for this bounded insert.", refuseIfEnvironmentAmbiguous: true, refuseIfPreconditionMismatch: true, secretValuesForbidden: true },
    createdAt: "2026-08-02T00:01:00Z"
  };
  assert.deepEqual(validateWriteManifest(manifest, config), []);
  const preview = await applyLocalWrite(target, manifest, config, { dryRun: true });
  const applied = await applyLocalWrite(target, manifest, config, { dryRun: false, approvedPlanHash: preview.planHash });
  assert.equal(applied.recordsChanged, 1);
  const parsed = parseCsv(await fs.readFile(path.join(target, sheet.file), "utf8"));
  assert.ok(parsed.some((row) => row[0] === "EVT-20260802-001"));
  const replay = await applyLocalWrite(target, manifest, config, { dryRun: false, approvedPlanHash: preview.planHash });
  assert.equal(replay.replay, true);
  assert.equal(replay.plannedWrites, 0);
});

test("controlled local writer rekeys an invalid canonical identity with exact preconditions", async (t) => {
  const { target } = await initializedProject(t, "writer-rekey");
  const config = await readJson(path.join(target, CONFIG_FILE));
  const sheet = config.workbook.sheets.find((entry) => entry.key === "validation_runs");
  const actor = (role) => config.agents.find((agent) => agent.id === role).actorId;
  const workbookPath = path.join(target, sheet.file);
  const rows = parseCsv(await fs.readFile(workbookPath, "utf8"));
  const record = rows[0].map(() => "");
  const set = (field, value) => { record[rows[0].indexOf(field)] = value; };
  set("run_id", "RUN-20260815-001");
  set("event_id", "EVT-20260815-001");
  set("status", "completed");
  set("executor_role", "RB-09");
  set("executor_actor_id", actor("RB-09"));
  set("environment_alias", "local-test-synthetic");
  rows.push(record);
  await fs.writeFile(workbookPath, stringifyCsv(rows), "utf8");

  const protectedColumns = sheet.columns.filter((field) =>
    [...config.fieldAuthority.protectedDevelopmentFields, ...config.fieldAuthority.protectedHumanFields].includes(field)
  );
  const manifest = {
    schemaVersion: "1.0.0", manifestId: "WFM-REKEY-001", eventId: "EVT-20260815-001", status: "authorized",
    semanticOwner: { role: "RB-09", actorId: actor("RB-09") },
    authorization: { ownerActorId: actor("RB-09"), authorizedByActorId: actor("RB-09"), authorizedAt: "2026-08-15T00:00:00Z", ownerConfirmed: true, humanProductionAuthorizationId: "not_applicable" },
    writer: { role: "RB-10", actorId: actor("RB-10") },
    target: { systemAlias: "local-test", environment: "test", file: sheet.file },
    scope: {
      sheet: sheet.name,
      keyFields: ["run_id"],
      allowedFields: ["run_id", "environment_alias"],
      prohibitedFields: protectedColumns,
      rows: [{
        operation: "rekey",
        key: { run_id: "RUN-20260815-001" },
        preconditions: { run_id: "RUN-20260815-001", environment_alias: "local-test-synthetic" },
        changes: { run_id: "VRN-20260815-001", environment_alias: "test" }
      }]
    },
    controls: { dryRunRequired: true, smallestBoundedRange: "one invalid validation-run row", fullRecordReadbackRequired: true, secondReadPath: "local CSV reopen", replayMustWriteZero: true, rollbackPlan: "Restore the verified pre-write CSV backup for this bounded rekey.", refuseIfEnvironmentAmbiguous: true, refuseIfPreconditionMismatch: true, secretValuesForbidden: true },
    createdAt: "2026-08-15T00:00:00Z"
  };

  assert.deepEqual(validateWriteManifest(manifest, config), []);
  const preview = await applyLocalWrite(target, manifest, config, { dryRun: true });
  assert.equal(preview.plannedWrites, 2);
  const applied = await applyLocalWrite(target, manifest, config, { dryRun: false, approvedPlanHash: preview.planHash });
  assert.equal(applied.recordsChanged, 1);
  const stored = parseCsv(await fs.readFile(workbookPath, "utf8"));
  assert.ok(stored.some((row) => row[0] === "VRN-20260815-001"));
  assert.ok(!stored.some((row) => row[0] === "RUN-20260815-001"));
});

async function preparedWriter(t, name) {
  const { target } = await initializedProject(t, name);
  const config = await readJson(path.join(target, CONFIG_FILE));
  const sheet = config.workbook.sheets.find(
    (entry) => entry.key === "delivery_tickets"
  );
  const workbookPath = path.join(target, sheet.file);
  const rows = parseCsv(await fs.readFile(workbookPath, "utf8"));
  const record = rows[0].map(() => "");
  record[rows[0].indexOf("ticket_id")] = "TKT-20260729-001";
  record[rows[0].indexOf("decision_id")] = "DEC-20260729-001";
  record[rows[0].indexOf("status")] = "implementation_complete";
  rows.push(record);
  const originalBytes = stringifyCsv(rows);
  await fs.writeFile(workbookPath, originalBytes, "utf8");
  const manifest = buildSafeManifest(config, sheet);
  const preview = await applyLocalWrite(target, manifest, config);
  const transactionDirectory = path.join(
    target,
    ".product-ops",
    "writes",
    manifest.manifestId
  );
  return {
    target,
    config,
    workbookPath,
    originalBytes,
    manifest,
    preview,
    transactionDirectory,
    receiptPath: path.join(transactionDirectory, "receipt.json")
  };
}

test("validate rejects unknown ownership and routing references", async (t) => {
  const { target, output } = await initializedProject(t, "invalid-ownership");
  const configPath = path.join(target, CONFIG_FILE);
  const config = await readJson(configPath);
  config.ownership[0].owner = "RB-99";
  config.routing[0].reviewers.push("RB-98");
  await writeJson(configPath, config);

  assert.equal(await run(["validate", target], output.io), 1);
  const message = output.stderr.at(-1);
  assert.match(message, /unknown agent "RB-99"/);
  assert.match(message, /unknown reviewer "RB-98"/);
});

test("validate rejects duplicate task IDs, undefined statuses, and bad dependencies", async (t) => {
  const { target, output } = await initializedProject(t, "invalid-taskboard");
  const taskboard = path.join(target, "taskboard", "tasks.csv");
  const rows = parseCsv(await fs.readFile(taskboard, "utf8"));
  const duplicate = [...rows[1]];
  duplicate[2] = "Duplicate task";
  duplicate[5] = "unknown";
  duplicate[7] = `${rows[1][0].split("-")[0]}-9999`;
  rows.push(duplicate);
  await fs.writeFile(taskboard, stringifyCsv(rows), "utf8");

  assert.equal(await run(["validate", target], output.io), 1);
  const message = output.stderr.at(-1);
  assert.match(message, new RegExp(`duplicates task ID "${rows[1][0]}"`));
  assert.match(message, /undefined status "unknown"/);
  assert.match(message, /depends on missing task/);
});

test("validate detects missing files, generated drift, and obvious credentials", async (t) => {
  const { target, output } = await initializedProject(t, "integrity-checks");
  await fs.rm(path.join(target, "adapters", "git.json"));
  await fs.writeFile(
    path.join(target, "agents", "registry.json"),
    '{"schemaVersion":"1.0.0","generatedFrom":"product-ops.config.json","agents":[]}\n'
  );
  await fs.appendFile(
    path.join(target, "workbook", "16-evidence.csv"),
    "E-1,Claim,api_key=abcdefghijklmnopqrstuvwxyz123456\n"
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
  config.statuses[0].transitions.push("waiting_forever");
  await writeJson(configPath, config);

  assert.equal(await run(["validate", target], output.io), 1);
  assert.match(
    output.stderr.at(-1),
    /transitions to undefined status "waiting_forever"/
  );
});

test("validate rejects generated paths that escape the project", async (t) => {
  const { target, output } = await initializedProject(t, "unsafe-path");
  const configPath = path.join(target, CONFIG_FILE);
  const config = await readJson(configPath);
  config.workbook.sheets[0].file = "../outside.csv";
  await writeJson(configPath, config);

  assert.equal(await run(["validate", target], output.io), 1);
  assert.match(output.stderr.at(-1), /must stay inside the project directory|must match pattern/);
});

test("validate rejects protected development fields outside their canonical tabs", async (t) => {
  const { target, output } = await initializedProject(t, "protected-fields");
  const configPath = path.join(target, CONFIG_FILE);
  const config = await readJson(configPath);
  config.workbook.sheets.find((sheet) => sheet.key === "issues").columns.push(
    "development_notes"
  );
  config.fieldAuthority.protectedFieldTabs.development_notes.push("issues");
  await writeJson(configPath, config);

  assert.equal(await run(["validate", target], output.io), 1);
  assert.match(output.stderr.at(-1), /Protected-field tab authority for "development_notes"/);
});

test("validate rejects a single actor assigned across producer and verifier roles", async (t) => {
  const { target, output } = await initializedProject(t, "single-actor");
  const configPath = path.join(target, CONFIG_FILE);
  const config = await readJson(configPath);
  for (const agent of config.agents) {
    agent.actorId = "one-actor";
  }
  await writeJson(configPath, config);

  assert.equal(await run(["validate", target], output.io), 1);
  assert.match(output.stderr.at(-1), /Duplicate agent actorId|must be distinct/);
});

test("validate scans the entire target tree, including binary and PII canaries", async (t) => {
  const { target, output } = await initializedProject(t, "whole-tree-scan");
  await fs.mkdir(path.join(target, "extra"));
  await fs.writeFile(
    path.join(target, "extra", "untracked-note.txt"),
    "contact=person@real-company.test\n"
  );
  await fs.writeFile(
    path.join(target, "extra", "binary-canary.bin"),
    Buffer.from([0, ...Buffer.from("api_key=abcdefghijklmnopqrstuvwxyz123456")])
  );

  assert.equal(await run(["validate", target], output.io), 1);
  const message = output.stderr.at(-1);
  assert.match(message, /Possible personal email address/);
  assert.match(message, /Possible assigned credential/);
});

test("unsafe write manifests fail schema and semantic authorization", async (t) => {
  const { target, output } = await initializedProject(t, "unsafe-manifest");
  const manifestDirectory = path.join(target, "manifests");
  await fs.mkdir(manifestDirectory);
  await writeJson(path.join(manifestDirectory, "unsafe-write-manifest.json"), {
    manifestId: "UNSAFE-1",
    createdAt: "not-a-date",
    writes: [{ fields: { development_notes: "invented" } }]
  });

  assert.equal(await run(["validate", target], output.io), 1);
  assert.match(output.stderr.at(-1), /unsafe-write-manifest\.json schema/);
});

test("schema-valid manifests still fail protected-field, actor, and production gates", async (t) => {
  const { target, output } = await initializedProject(t, "semantic-manifest");
  const config = await readJson(path.join(target, CONFIG_FILE));
  const sheet = config.workbook.sheets.find((entry) => entry.key === "delivery_tickets");
  const manifest = buildSafeManifest(config, sheet);
  manifest.manifestId = "WFM-UNSAFE-SEMANTIC";
  manifest.writer.actorId = manifest.semanticOwner.actorId;
  manifest.target.environment = "production";
  manifest.scope.allowedFields = ["development_notes"];
  manifest.scope.prohibitedFields = ["implementation_reference", "development_status"];
  manifest.scope.rows[0].preconditions = { development_notes: "" };
  manifest.scope.rows[0].changes = { development_notes: "invented completion" };
  const manifestErrors = validateWriteManifest(manifest, config);
  assert.match(manifestErrors.join("\n"), /production write requires attributed human authorization/);
  assert.match(manifestErrors.join("\n"), /may not allow protected field "development_notes"/);
  assert.match(manifestErrors.join("\n"), /semantic owner and writer actors must be different/);

  await fs.mkdir(path.join(target, "manifests"));
  await writeJson(
    path.join(target, "manifests", "semantic-write-manifest.json"),
    manifest
  );
  assert.equal(await run(["validate", target], output.io), 1);
  assert.match(output.stderr.at(-1), /semantic-write-manifest\.json/);
});

test("safe local writer enforces dry-run, read-back, replay, and rollback", async (t) => {
  const { target, output } = await initializedProject(t, "local-writer");
  const config = await readJson(path.join(target, CONFIG_FILE));
  const sheet = config.workbook.sheets.find((entry) => entry.key === "delivery_tickets");
  const workbookPath = path.join(target, sheet.file);
  const rows = parseCsv(await fs.readFile(workbookPath, "utf8"));
  const record = rows[0].map(() => "");
  record[rows[0].indexOf("ticket_id")] = "TKT-20260729-001";
  record[rows[0].indexOf("decision_id")] = "DEC-20260729-001";
  record[rows[0].indexOf("status")] = "implementation_complete";
  rows.push(record);
  await fs.writeFile(workbookPath, stringifyCsv(rows), "utf8");
  await appendApprovedDecision(target, config, "DEC-20260729-001", "EVT-20260729-001");

  const manifest = buildSafeManifest(config, sheet);

  assert.deepEqual(validateWriteManifest(manifest, config), []);
  await assert.rejects(
    applyLocalWrite(target, manifest, config, { dryRun: false }),
    /exact plan hash/
  );
  const preview = await applyLocalWrite(target, manifest, config);
  const receipt = await applyLocalWrite(target, manifest, config, {
    dryRun: false,
    approvedPlanHash: preview.planHash
  });
  assert.equal(receipt.fullReadbackMatch, true);
  assert.equal(receipt.replayWrites, 0);
  assert.match(await fs.readFile(workbookPath, "utf8"), /accepted/);
  assert.equal((await fs.lstat(workbookPath)).nlink, 1);
  await assert.rejects(
    fs.access(`${workbookPath}.${manifest.manifestId}.before.tmp`),
    { code: "ENOENT" }
  );

  const replay = await applyLocalWrite(target, manifest, config);
  assert.equal(replay.plannedWrites, 0);
  const rolledBack = await rollbackLocalWrite(target, receipt.receiptFile);
  assert.equal(rolledBack.rollbackReadbackMatch, true);
  assert.match(
    await fs.readFile(workbookPath, "utf8"),
    /implementation_complete/
  );
  assert.equal((await fs.lstat(workbookPath)).nlink, 1);
  await assert.rejects(
    fs.access(`${workbookPath}.${manifest.manifestId}.rollback-current.tmp`),
    { code: "ENOENT" }
  );
  const rollbackReplay = await rollbackLocalWrite(target, receipt.receiptFile);
  assert.equal(rollbackReplay.rollbackReplay, true);
  assert.equal(await run(["validate", target], output.io), 0);
});

test("rollback replay rejects unrelated target bytes and a corrupted backup", async (t) => {
  const { target } = await initializedProject(t, "rollback-replay-integrity");
  const config = await readJson(path.join(target, CONFIG_FILE));
  const sheet = config.workbook.sheets.find((entry) => entry.key === "delivery_tickets");
  const workbookPath = path.join(target, sheet.file);
  const rows = parseCsv(await fs.readFile(workbookPath, "utf8"));
  const record = rows[0].map(() => "");
  record[rows[0].indexOf("ticket_id")] = "TKT-20260729-001";
  record[rows[0].indexOf("status")] = "implementation_complete";
  rows.push(record);
  const original = stringifyCsv(rows);
  await fs.writeFile(workbookPath, original, "utf8");

  const manifest = buildSafeManifest(config, sheet);
  const preview = await applyLocalWrite(target, manifest, config);
  const receipt = await applyLocalWrite(target, manifest, config, {
    dryRun: false,
    approvedPlanHash: preview.planHash
  });
  await rollbackLocalWrite(target, receipt.receiptFile);

  await fs.appendFile(workbookPath, "unrelated bytes\n");
  await assert.rejects(
    rollbackLocalWrite(target, receipt.receiptFile),
    /restored target no longer matches beforeSha256/
  );

  await fs.writeFile(workbookPath, original, "utf8");
  await fs.appendFile(path.join(target, receipt.backupFile), "corrupt backup\n");
  await assert.rejects(
    rollbackLocalWrite(target, receipt.receiptFile),
    /backup integrity check failed/
  );
});

test("validate rejects malformed, duplicate, unauthorized workbook records", async (t) => {
  const { target, output } = await initializedProject(t, "invalid-workbook-records");
  const config = await readJson(path.join(target, CONFIG_FILE));
  const discoveryPath = path.join(target, "workbook", "08-discovery.csv");
  const rows = parseCsv(await fs.readFile(discoveryPath, "utf8"));
  const duplicate = [...rows[1]];
  duplicate[rows[0].indexOf("status")] = "invented_status";
  duplicate[rows[0].indexOf("verifier_actor_id")] =
    duplicate[rows[0].indexOf("producer_actor_id")];
  rows.push(duplicate);
  await fs.writeFile(discoveryPath, stringifyCsv(rows), "utf8");

  const releasePath = path.join(target, "workbook", "20-releases.csv");
  const releaseRows = parseCsv(await fs.readFile(releasePath, "utf8"));
  const release = releaseRows[0].map(() => "");
  release[releaseRows[0].indexOf("release_id")] = "REL-20260729-001";
  release[releaseRows[0].indexOf("status")] = "planned";
  release[releaseRows[0].indexOf("target_environment")] = "production";
  release[releaseRows[0].indexOf("human_authorization_id")] = "HUMAN-UNATTRIBUTED";
  release[releaseRows[0].indexOf("deployment_reference")] = "deploy-claimed";
  release[releaseRows[0].indexOf("owner_role")] = "RB-11";
  release[releaseRows[0].indexOf("owner_actor_id")] =
    config.agents.find((agent) => agent.id === "RB-11").actorId;
  releaseRows.push(release);
  await fs.writeFile(releasePath, stringifyCsv(releaseRows), "utf8");

  assert.equal(await run(["validate", target], output.io), 1);
  const message = output.stderr.at(-1);
  assert.match(message, /duplicates record key "DSC-00000000-001"/);
  assert.match(message, /undefined discovery status "invented_status"/);
  assert.match(message, /producer and verifier actors must be different/);
  assert.match(message, /protected development field "deployment_reference"/);
  assert.match(message, /protected human field "human_authorization_id"/);
});

test("validate enforces workbook row widths", async (t) => {
  const { target, output } = await initializedProject(t, "invalid-row-width");
  await fs.appendFile(
    path.join(target, "workbook", "10-issues.csv"),
    "ISS-TOO-SHORT,EVT-1\n"
  );
  assert.equal(await run(["validate", target], output.io), 1);
  assert.match(output.stderr.at(-1), /has 2 cells; expected 21/);
});

test("ready status requires attributed risk acceptance, rollback, and a real release", async (t) => {
  const { target, output } = await initializedProject(t, "readiness-hard-gate");
  const file = path.join(target, "workbook", "19-readiness.csv");
  const rows = parseCsv(await fs.readFile(file, "utf8"));
  const record = rows[0].map(() => "");
  const set = (field, value) => { record[rows[0].indexOf(field)] = value; };
  set("readiness_id", "RDY-20260802-001");
  set("event_id", "EVT-20260802-001");
  set("status", "ready");
  set("target_environment", "local");
  set("owner_role", "RB-11");
  set("owner_actor_id", "actor-rb-11");
  set("producer_actor_id", "actor-rb-11");
  set("verifier_actor_id", "actor-rb-12");
  rows.push(record);
  await fs.writeFile(file, stringifyCsv(rows), "utf8");
  assert.equal(await run(["validate", target], output.io), 1);
  assert.match(output.stderr.at(-1), /may not be ready without human_risk_acceptance_id, rollback_reference, release_id/);
});

test("validate scans both alignments of UTF-16LE and UTF-16BE secret canaries", async (t) => {
  const { target, output } = await initializedProject(t, "utf16-canaries");
  const extra = path.join(target, "extra");
  await fs.mkdir(extra);
  const assignedCredential = [
    "api",
    "_key=",
    "synthetic",
    "-utf16-",
    "canary-1234567890"
  ].join("");
  const le = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(assignedCredential, "utf16le")
  ]);
  const be = Buffer.from(assignedCredential, "utf16le");
  for (let index = 0; index < be.length; index += 2) {
    const first = be[index];
    be[index] = be[index + 1];
    be[index + 1] = first;
  }
  await fs.writeFile(path.join(extra, "secret-le.bin"), le);
  await fs.writeFile(
    path.join(extra, "secret-be.bin"),
    Buffer.concat([Buffer.from([0xfe, 0xff]), be])
  );
  await fs.writeFile(
    path.join(extra, "secret-le-odd.bin"),
    Buffer.concat([Buffer.from([0x7f]), Buffer.from(assignedCredential, "utf16le")])
  );
  await fs.writeFile(
    path.join(extra, "secret-be-odd.bin"),
    Buffer.concat([Buffer.from([0x7f]), be])
  );

  assert.equal(await run(["validate", target], output.io), 1);
  const message = output.stderr.at(-1);
  assert.match(message, /secret-le\.bin/);
  assert.match(message, /secret-be\.bin/);
  assert.match(message, /secret-le-odd\.bin/);
  assert.match(message, /secret-be-odd\.bin/);
});

test("local writer rejects duplicate keys and hard-linked targets", async (t) => {
  const { target } = await initializedProject(t, "writer-boundaries");
  const config = await readJson(path.join(target, CONFIG_FILE));
  const sheet = config.workbook.sheets.find((entry) => entry.key === "delivery_tickets");
  const workbookPath = path.join(target, sheet.file);
  const rows = parseCsv(await fs.readFile(workbookPath, "utf8"));
  const record = rows[0].map(() => "");
  record[rows[0].indexOf("ticket_id")] = "TKT-20260729-001";
  record[rows[0].indexOf("status")] = "implementation_complete";
  rows.push(record, [...record]);
  await fs.writeFile(workbookPath, stringifyCsv(rows), "utf8");
  const manifest = buildSafeManifest(config, sheet);
  await assert.rejects(
    applyLocalWrite(target, manifest, config),
    /duplicates canonical key/
  );

  rows.pop();
  await fs.writeFile(workbookPath, stringifyCsv(rows), "utf8");
  const outside = path.join(path.dirname(target), "outside-workbook.csv");
  await fs.copyFile(workbookPath, outside);
  await fs.rm(workbookPath);
  try {
    await fs.link(outside, workbookPath);
  } catch (error) {
    if (["EPERM", "ENOTSUP", "EACCES"].includes(error.code)) {
      t.skip(`hard links unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  const before = await fs.readFile(outside, "utf8");
  await assert.rejects(applyLocalWrite(target, manifest, config), /hard-linked/);
  assert.equal(await fs.readFile(outside, "utf8"), before);
});

test("local writer refuses replay without a matching validated receipt", async (t) => {
  const { target } = await initializedProject(t, "writer-receipt-replay");
  const config = await readJson(path.join(target, CONFIG_FILE));
  const sheet = config.workbook.sheets.find((entry) => entry.key === "delivery_tickets");
  const workbookPath = path.join(target, sheet.file);
  const rows = parseCsv(await fs.readFile(workbookPath, "utf8"));
  const record = rows[0].map(() => "");
  record[rows[0].indexOf("ticket_id")] = "TKT-20260729-001";
  record[rows[0].indexOf("status")] = "implementation_complete";
  rows.push(record);
  await fs.writeFile(workbookPath, stringifyCsv(rows), "utf8");
  const manifest = buildSafeManifest(config, sheet);
  const preview = await applyLocalWrite(target, manifest, config);
  const receipt = await applyLocalWrite(target, manifest, config, {
    dryRun: false,
    approvedPlanHash: preview.planHash
  });
  const receiptPath = path.join(target, receipt.receiptFile);
  const tampered = JSON.parse(await fs.readFile(receiptPath, "utf8"));
  tampered.manifestSha256 = "0".repeat(64);
  await fs.writeFile(receiptPath, `${JSON.stringify(tampered, null, 2)}\n`);

  await assert.rejects(
    applyLocalWrite(target, manifest, config),
    /receipt does not match/
  );
  assert.match(await fs.readFile(workbookPath, "utf8"), /accepted/);
});

test("local writer restores original bytes after a post-mutation failure", async (t) => {
  const { target } = await initializedProject(t, "writer-transaction-rollback");
  const config = await readJson(path.join(target, CONFIG_FILE));
  const sheet = config.workbook.sheets.find((entry) => entry.key === "delivery_tickets");
  const workbookPath = path.join(target, sheet.file);
  const rows = parseCsv(await fs.readFile(workbookPath, "utf8"));
  const record = rows[0].map(() => "");
  record[rows[0].indexOf("ticket_id")] = "TKT-20260729-001";
  record[rows[0].indexOf("status")] = "implementation_complete";
  rows.push(record);
  await fs.writeFile(workbookPath, stringifyCsv(rows), "utf8");
  const before = await fs.readFile(workbookPath, "utf8");
  const manifest = buildSafeManifest(config, sheet);
  const preview = await applyLocalWrite(target, manifest, config);

  await assert.rejects(
    applyLocalWrite(target, manifest, config, {
      dryRun: false,
      approvedPlanHash: preview.planHash,
      transactionObserver: async ({ phase }) => {
        if (phase === "target-replaced") {
          throw new Error("injected receipt-path failure");
        }
      }
    }),
    /pre-transaction target was preserved/
  );
  assert.equal(await fs.readFile(workbookPath, "utf8"), before);
  await assert.rejects(
    fs.access(
      path.join(
        target,
        ".product-ops",
        "writes",
        manifest.manifestId,
        "receipt.json"
      )
    ),
    { code: "ENOENT" }
  );
  const retry = await applyLocalWrite(target, manifest, config);
  assert.equal(retry.plannedWrites, 1);
  assert.equal(retry.replay, undefined);
});

test("local writer preserves injected concurrent bytes and emits no receipt", async (t) => {
  const { target } = await initializedProject(t, "writer-concurrent-mutation");
  const config = await readJson(path.join(target, CONFIG_FILE));
  const sheet = config.workbook.sheets.find((entry) => entry.key === "delivery_tickets");
  const workbookPath = path.join(target, sheet.file);
  const rows = parseCsv(await fs.readFile(workbookPath, "utf8"));
  const record = rows[0].map(() => "");
  record[rows[0].indexOf("ticket_id")] = "TKT-20260729-001";
  record[rows[0].indexOf("status")] = "implementation_complete";
  rows.push(record);
  await fs.writeFile(workbookPath, stringifyCsv(rows), "utf8");
  const manifest = buildSafeManifest(config, sheet);
  const preview = await applyLocalWrite(target, manifest, config);
  const concurrentRows = parseCsv(await fs.readFile(workbookPath, "utf8"));
  concurrentRows[2][concurrentRows[0].indexOf("status")] = "blocked";
  const concurrentBytes = stringifyCsv(concurrentRows);

  await assert.rejects(
    applyLocalWrite(target, manifest, config, {
      dryRun: false,
      approvedPlanHash: preview.planHash,
      transactionObserver: async ({ phase }) => {
        if (phase === "before-target-replace") {
          await fs.writeFile(workbookPath, concurrentBytes, "utf8");
        }
      }
    }),
    /changed before atomic quarantine|pre-transaction target was preserved/
  );
  assert.equal(await fs.readFile(workbookPath, "utf8"), concurrentBytes);
  await assert.rejects(
    fs.access(
      path.join(
        target,
        ".product-ops",
        "writes",
        manifest.manifestId,
        "receipt.json"
      )
    ),
    { code: "ENOENT" }
  );
});

test("local writer cannot erase a mutation after quarantine verification and before install", async (t) => {
  const { target } = await initializedProject(t, "writer-late-concurrent-mutation");
  const config = await readJson(path.join(target, CONFIG_FILE));
  const sheet = config.workbook.sheets.find((entry) => entry.key === "delivery_tickets");
  const workbookPath = path.join(target, sheet.file);
  const rows = parseCsv(await fs.readFile(workbookPath, "utf8"));
  const record = rows[0].map(() => "");
  record[rows[0].indexOf("ticket_id")] = "TKT-20260729-001";
  record[rows[0].indexOf("status")] = "implementation_complete";
  rows.push(record);
  const originalBytes = stringifyCsv(rows);
  await fs.writeFile(workbookPath, originalBytes, "utf8");
  const manifest = buildSafeManifest(config, sheet);
  const preview = await applyLocalWrite(target, manifest, config);
  const concurrentRows = parseCsv(originalBytes);
  concurrentRows[2][concurrentRows[0].indexOf("status")] = "blocked";
  const concurrentBytes = stringifyCsv(concurrentRows);

  await assert.rejects(
    applyLocalWrite(target, manifest, config, {
      dryRun: false,
      approvedPlanHash: preview.planHash,
      transactionObserver: async ({ phase }) => {
        if (phase === "after-target-quarantine-verified") {
          await fs.writeFile(workbookPath, concurrentBytes, {
            encoding: "utf8",
            flag: "wx"
          });
        }
      }
    }),
    /recreated concurrently|without overwriting concurrent target bytes/
  );

  assert.equal(await fs.readFile(workbookPath, "utf8"), concurrentBytes);
  const transactionDirectory = path.join(
    target,
    ".product-ops",
    "writes",
    manifest.manifestId
  );
  assert.equal(
    await fs.readFile(path.join(transactionDirectory, "before.csv"), "utf8"),
    originalBytes
  );
  assert.equal(
    await fs.readFile(`${workbookPath}.${manifest.manifestId}.before.tmp`, "utf8"),
    originalBytes
  );
  await assert.rejects(
    fs.access(path.join(transactionDirectory, "receipt.json")),
    { code: "ENOENT" }
  );
  await assert.rejects(
    fs.access(`${workbookPath}.${manifest.manifestId}.write.tmp`),
    { code: "ENOENT" }
  );
});

test("controlled write cannot overwrite a quarantine artifact created after the final absence check", async (t) => {
  const { target } = await initializedProject(t, "writer-quarantine-race");
  const config = await readJson(path.join(target, CONFIG_FILE));
  const sheet = config.workbook.sheets.find((entry) => entry.key === "delivery_tickets");
  const workbookPath = path.join(target, sheet.file);
  const rows = parseCsv(await fs.readFile(workbookPath, "utf8"));
  const record = rows[0].map(() => "");
  record[rows[0].indexOf("ticket_id")] = "TKT-20260729-001";
  record[rows[0].indexOf("status")] = "implementation_complete";
  rows.push(record);
  const originalBytes = stringifyCsv(rows);
  await fs.writeFile(workbookPath, originalBytes, "utf8");
  const manifest = buildSafeManifest(config, sheet);
  const preview = await applyLocalWrite(target, manifest, config);
  const receiptPath = path.join(
    target,
    ".product-ops",
    "writes",
    manifest.manifestId,
    "receipt.json"
  );
  let quarantinePath;

  await assert.rejects(
    applyLocalWrite(target, manifest, config, {
      dryRun: false,
      approvedPlanHash: preview.planHash,
      transactionObserver: async (event) => {
        if (
          event.phase === "before-target-quarantine-move" &&
          event.label === "Write target"
        ) {
          quarantinePath = event.quarantinePath;
          await fs.writeFile(quarantinePath, "concurrent quarantine\n", {
            encoding: "utf8",
            flag: "wx"
          });
        }
      }
    }),
    /quarantine destination already exists.*no-overwrite move refused/
  );

  assert.equal(await fs.readFile(workbookPath, "utf8"), originalBytes);
  assert.equal(
    await fs.readFile(quarantinePath, "utf8"),
    "concurrent quarantine\n"
  );
  await assert.rejects(fs.access(receiptPath), { code: "ENOENT" });
});

for (const [phase, windowName] of [
  ["after-final-pre-unlink-validation", "after final pre-unlink validation"],
  [
    "after-source-unlink-before-commit-validation",
    "after source unlink before commit validation"
  ]
]) {
  test(`controlled write emits no receipt and retains anchored source when destination changes ${windowName}`, async (t) => {
    const { target } = await initializedProject(t, `writer-${phase}`);
    const config = await readJson(path.join(target, CONFIG_FILE));
    const sheet = config.workbook.sheets.find(
      (entry) => entry.key === "delivery_tickets"
    );
    const workbookPath = path.join(target, sheet.file);
    const rows = parseCsv(await fs.readFile(workbookPath, "utf8"));
    const record = rows[0].map(() => "");
    record[rows[0].indexOf("ticket_id")] = "TKT-20260729-001";
    record[rows[0].indexOf("status")] = "implementation_complete";
    rows.push(record);
    const originalBytes = stringifyCsv(rows);
    await fs.writeFile(workbookPath, originalBytes, "utf8");
    const manifest = buildSafeManifest(config, sheet);
    const preview = await applyLocalWrite(target, manifest, config);
    const transactionDirectory = path.join(
      target,
      ".product-ops",
      "writes",
      manifest.manifestId
    );
    const concurrentBytes = `concurrent controlled-write bytes at ${phase}\n`;
    let anchorPath;
    let stagePath;

    await assert.rejects(
      applyLocalWrite(target, manifest, config, {
        dryRun: false,
        approvedPlanHash: preview.planHash,
        transactionObserver: async (event) => {
          if (
            event.phase === phase &&
            event.label === "Write target install"
          ) {
            anchorPath = event.anchorPath;
            stagePath = event.source;
            await fs.unlink(workbookPath);
            await fs.writeFile(workbookPath, concurrentBytes, {
              encoding: "utf8",
              flag: "wx"
            });
          }
        }
      }),
      /Safety anchor retained/
    );

    assert.equal(await fs.readFile(workbookPath, "utf8"), concurrentBytes);
    assert.equal(
      await fs.readFile(
        `${workbookPath}.${manifest.manifestId}.before.tmp`,
        "utf8"
      ),
      originalBytes
    );
    const anchoredReplacement = await fs.readFile(anchorPath, "utf8");
    assert.match(anchoredReplacement, /accepted/);
    await assert.rejects(fs.access(stagePath), { code: "ENOENT" });
    assert.equal(
      await fs.readFile(path.join(transactionDirectory, "before.csv"), "utf8"),
      originalBytes
    );
    await assert.rejects(
      fs.access(path.join(transactionDirectory, "receipt.json")),
      { code: "ENOENT" }
    );
  });
}

test("controlled-write recovery preserves displaced replacement after a later destination race", async (t) => {
  const { target } = await initializedProject(t, "writer-late-recovery-race");
  const config = await readJson(path.join(target, CONFIG_FILE));
  const sheet = config.workbook.sheets.find((entry) => entry.key === "delivery_tickets");
  const workbookPath = path.join(target, sheet.file);
  const rows = parseCsv(await fs.readFile(workbookPath, "utf8"));
  const record = rows[0].map(() => "");
  record[rows[0].indexOf("ticket_id")] = "TKT-20260729-001";
  record[rows[0].indexOf("status")] = "implementation_complete";
  rows.push(record);
  const originalBytes = stringifyCsv(rows);
  await fs.writeFile(workbookPath, originalBytes, "utf8");
  const manifest = buildSafeManifest(config, sheet);
  const preview = await applyLocalWrite(target, manifest, config);
  const quarantinePath = `${workbookPath}.${manifest.manifestId}.before.tmp`;
  const displacedPath = `${workbookPath}.${manifest.manifestId}.displaced.tmp`;
  const transactionDirectory = path.join(
    target,
    ".product-ops",
    "writes",
    manifest.manifestId
  );
  let replacementBytes;

  await assert.rejects(
    applyLocalWrite(target, manifest, config, {
      dryRun: false,
      approvedPlanHash: preview.planHash,
      transactionObserver: async (event) => {
        if (event.phase === "target-replaced") {
          replacementBytes = await fs.readFile(workbookPath, "utf8");
          throw new Error("injected post-install failure");
        }
        if (
          event.phase === "before-original-recovery-restore" &&
          event.label === "Write target"
        ) {
          await fs.writeFile(workbookPath, "concurrent later recovery bytes\n", {
            encoding: "utf8",
            flag: "wx"
          });
        }
      }
    }),
    /aborted without overwriting concurrent target bytes/
  );

  assert.equal(
    await fs.readFile(workbookPath, "utf8"),
    "concurrent later recovery bytes\n"
  );
  assert.equal(await fs.readFile(quarantinePath, "utf8"), originalBytes);
  assert.equal(await fs.readFile(displacedPath, "utf8"), replacementBytes);
  assert.equal(
    await fs.readFile(path.join(transactionDirectory, "before.csv"), "utf8"),
    originalBytes
  );
  await assert.rejects(
    fs.access(path.join(transactionDirectory, "receipt.json")),
    { code: "ENOENT" }
  );
});

test("rollback recovery cannot overwrite a displaced artifact created after the final absence check", async (t) => {
  const { target } = await initializedProject(t, "rollback-displaced-race");
  const config = await readJson(path.join(target, CONFIG_FILE));
  const sheet = config.workbook.sheets.find((entry) => entry.key === "delivery_tickets");
  const workbookPath = path.join(target, sheet.file);
  const rows = parseCsv(await fs.readFile(workbookPath, "utf8"));
  const record = rows[0].map(() => "");
  record[rows[0].indexOf("ticket_id")] = "TKT-20260729-001";
  record[rows[0].indexOf("status")] = "implementation_complete";
  rows.push(record);
  const originalBytes = stringifyCsv(rows);
  await fs.writeFile(workbookPath, originalBytes, "utf8");
  const manifest = buildSafeManifest(config, sheet);
  const preview = await applyLocalWrite(target, manifest, config);
  const receipt = await applyLocalWrite(target, manifest, config, {
    dryRun: false,
    approvedPlanHash: preview.planHash
  });
  const receiptPath = path.join(target, receipt.receiptFile);
  const receiptBytes = await fs.readFile(receiptPath, "utf8");
  const postWriteBytes = await fs.readFile(workbookPath, "utf8");
  let quarantinePath;
  let displacedPath;

  await assert.rejects(
    rollbackLocalWrite(target, receipt.receiptFile, {
      transactionObserver: async (event) => {
        if (
          event.phase === "after-target-installed" &&
          event.label === "Rollback target"
        ) {
          quarantinePath = event.quarantinePath;
          throw new Error("injected rollback receipt failure");
        }
        if (
          event.phase === "before-displaced-recovery-move" &&
          event.label === "Rollback target"
        ) {
          displacedPath = event.displacedPath;
          await fs.writeFile(displacedPath, "concurrent displaced\n", {
            encoding: "utf8",
            flag: "wx"
          });
        }
      }
    }),
    /automatic transaction recovery also failed; recovery artifacts were retained/
  );

  assert.equal(await fs.readFile(workbookPath, "utf8"), originalBytes);
  assert.equal(await fs.readFile(quarantinePath, "utf8"), postWriteBytes);
  assert.equal(
    await fs.readFile(displacedPath, "utf8"),
    "concurrent displaced\n"
  );
  assert.equal(await fs.readFile(receiptPath, "utf8"), receiptBytes);
  assert.equal(JSON.parse(receiptBytes).rolledBack, false);
});

test("rollback recovery preserves displaced bytes and receipt after a later destination race", async (t) => {
  const { target } = await initializedProject(t, "rollback-late-recovery-race");
  const config = await readJson(path.join(target, CONFIG_FILE));
  const sheet = config.workbook.sheets.find((entry) => entry.key === "delivery_tickets");
  const workbookPath = path.join(target, sheet.file);
  const rows = parseCsv(await fs.readFile(workbookPath, "utf8"));
  const record = rows[0].map(() => "");
  record[rows[0].indexOf("ticket_id")] = "TKT-20260729-001";
  record[rows[0].indexOf("status")] = "implementation_complete";
  rows.push(record);
  const originalBytes = stringifyCsv(rows);
  await fs.writeFile(workbookPath, originalBytes, "utf8");
  const manifest = buildSafeManifest(config, sheet);
  const preview = await applyLocalWrite(target, manifest, config);
  const receipt = await applyLocalWrite(target, manifest, config, {
    dryRun: false,
    approvedPlanHash: preview.planHash
  });
  const receiptPath = path.join(target, receipt.receiptFile);
  const receiptBytes = await fs.readFile(receiptPath, "utf8");
  const postWriteBytes = await fs.readFile(workbookPath, "utf8");
  const quarantinePath = `${workbookPath}.${manifest.manifestId}.rollback-current.tmp`;
  const displacedPath = `${workbookPath}.${manifest.manifestId}.rollback-displaced.tmp`;

  await assert.rejects(
    rollbackLocalWrite(target, receipt.receiptFile, {
      transactionObserver: async (event) => {
        if (
          event.phase === "after-target-installed" &&
          event.label === "Rollback target"
        ) {
          throw new Error("injected rollback receipt failure");
        }
        if (
          event.phase === "before-original-recovery-restore" &&
          event.label === "Rollback target"
        ) {
          await fs.writeFile(workbookPath, "concurrent rollback recovery bytes\n", {
            encoding: "utf8",
            flag: "wx"
          });
        }
      }
    }),
    /Rollback aborted without overwriting concurrent target bytes/
  );

  assert.equal(
    await fs.readFile(workbookPath, "utf8"),
    "concurrent rollback recovery bytes\n"
  );
  assert.equal(await fs.readFile(quarantinePath, "utf8"), postWriteBytes);
  assert.equal(await fs.readFile(displacedPath, "utf8"), originalBytes);
  assert.equal(await fs.readFile(receiptPath, "utf8"), receiptBytes);
  assert.equal(JSON.parse(receiptBytes).rolledBack, false);
});

test("controlled write invalidates its receipt when target diverges during receipt commit", async (t) => {
  const {
    target,
    config,
    workbookPath,
    manifest,
    preview,
    receiptPath
  } = await preparedWriter(t, "writer-stale-receipt-race");
  const concurrentBytes = "concurrent bytes after final target read-back\n";
  const invalidReceiptPath = `${receiptPath}.${manifest.manifestId}.invalidated.tmp`;
  let raceInjected = false;
  let failure;

  try {
    await applyLocalWrite(target, manifest, config, {
      dryRun: false,
      approvedPlanHash: preview.planHash,
      transactionObserver: async (event) => {
        if (
          !raceInjected &&
          event.phase === "before-source-unlink-validation" &&
          event.label === "Write receipt install"
        ) {
          raceInjected = true;
          await fs.unlink(workbookPath);
          await fs.writeFile(workbookPath, concurrentBytes, {
            encoding: "utf8",
            flag: "wx"
          });
        }
      }
    });
  } catch (error) {
    failure = error;
  }

  assert.equal(raceInjected, true);
  assert.ok(failure);
  assert.equal(failure.code, "ERECOVERYRETAINED");
  assert.ok(failure.recoveryPaths.includes(invalidReceiptPath));
  assert.equal(await fs.readFile(workbookPath, "utf8"), concurrentBytes);
  await assert.rejects(fs.access(receiptPath), { code: "ENOENT" });
  const invalidReceipt = JSON.parse(
    await fs.readFile(invalidReceiptPath, "utf8")
  );
  assert.equal(invalidReceipt.fullReadbackMatch, true);
  assert.notEqual(
    invalidReceipt.afterSha256,
    crypto
      .createHash("sha256")
      .update(await fs.readFile(workbookPath))
      .digest("hex")
  );
  await assert.rejects(
    applyLocalWrite(target, manifest, config),
    (error) =>
      error.code === "ERECOVERYRETAINED" &&
      error.recoveryPaths.includes(invalidReceiptPath)
  );
});

test("controlled-write recovery retains a displaced-path replacement and reports it", async (t) => {
  const {
    target,
    config,
    workbookPath,
    originalBytes,
    manifest,
    preview
  } = await preparedWriter(t, "writer-displaced-cleanup-race");
  let displacedPath;
  let failure;

  try {
    await applyLocalWrite(target, manifest, config, {
      dryRun: false,
      approvedPlanHash: preview.planHash,
      transactionObserver: async (event) => {
        if (event.phase === "target-replaced") {
          throw new Error("injected post-install failure");
        }
        if (
          event.phase === "before-displaced-recovery-move" &&
          event.label === "Write target"
        ) {
          displacedPath = event.displacedPath;
        }
        if (
          displacedPath &&
          event.phase === "before-safety-anchor-cleanup" &&
          event.label === "Transaction retained recovery"
        ) {
          await fs.unlink(displacedPath);
          await fs.writeFile(displacedPath, "concurrent displaced bytes\n", {
            encoding: "utf8",
            flag: "wx"
          });
        }
      }
    });
  } catch (error) {
    failure = error;
  }

  assert.ok(failure);
  assert.equal(failure.code, "ERECOVERYRETAINED");
  assert.ok(failure.recoveryPaths.includes(displacedPath));
  assert.equal(await fs.readFile(workbookPath, "utf8"), originalBytes);
  assert.equal(
    await fs.readFile(displacedPath, "utf8"),
    "concurrent displaced bytes\n"
  );
});

test("writer committed-cleanup retention is explicit and replay remains fail-closed", async (t) => {
  const {
    target,
    config,
    workbookPath,
    manifest,
    preview,
    receiptPath
  } = await preparedWriter(t, "writer-committed-cleanup-race");
  const quarantinePath = `${workbookPath}.${manifest.manifestId}.before.tmp`;
  let raceInjected = false;
  let failure;

  try {
    await applyLocalWrite(target, manifest, config, {
      dryRun: false,
      approvedPlanHash: preview.planHash,
      transactionObserver: async (event) => {
        if (
          !raceInjected &&
          event.phase === "before-safety-anchor-cleanup" &&
          event.label === "Write receipt install"
        ) {
          raceInjected = true;
          await fs.unlink(quarantinePath);
          await fs.writeFile(
            quarantinePath,
            "concurrent committed quarantine bytes\n",
            { encoding: "utf8", flag: "wx" }
          );
        }
      }
    });
  } catch (error) {
    failure = error;
  }

  assert.equal(raceInjected, true);
  assert.ok(failure);
  assert.equal(failure.code, "ECOMMITTEDCLEANUP");
  assert.equal(failure.committed, true);
  assert.deepEqual(failure.recoveryPaths, [quarantinePath]);
  assert.equal(
    await fs.readFile(quarantinePath, "utf8"),
    "concurrent committed quarantine bytes\n"
  );
  const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
  const current = await fs.readFile(workbookPath);
  assert.equal(
    receipt.afterSha256,
    crypto.createHash("sha256").update(current).digest("hex")
  );
  await assert.rejects(
    applyLocalWrite(target, manifest, config),
    (error) =>
      error.code === "ERECOVERYRETAINED" &&
      error.recoveryPaths.includes(quarantinePath)
  );
});

test("write manifests cannot replace canonical keys with arbitrary selectors", async (t) => {
  const { target } = await initializedProject(t, "writer-canonical-keys");
  const config = await readJson(path.join(target, CONFIG_FILE));
  const sheet = config.workbook.sheets.find((entry) => entry.key === "delivery_tickets");
  const workbookPath = path.join(target, sheet.file);
  const rows = parseCsv(await fs.readFile(workbookPath, "utf8"));
  const first = rows[0].map(() => "");
  first[rows[0].indexOf("ticket_id")] = "TKT-20260729-001";
  first[rows[0].indexOf("event_id")] = "EVT-20260729-001";
  first[rows[0].indexOf("status")] = "implementation_complete";
  const duplicate = [...first];
  duplicate[rows[0].indexOf("event_id")] = "EVT-20260729-002";
  rows.push(first, duplicate);
  await fs.writeFile(workbookPath, stringifyCsv(rows), "utf8");
  const before = await fs.readFile(workbookPath);
  const manifest = buildSafeManifest(config, sheet);
  manifest.scope.keyFields = ["ticket_id", "event_id"];
  manifest.scope.rows[0].key.event_id = "EVT-20260729-001";

  const errors = validateWriteManifest(manifest, config).join("\n");
  assert.match(errors, /keyFields must exactly match the canonical key contract/);
  assert.match(errors, /key selectors must contain exactly ticket_id/);
  await assert.rejects(
    applyLocalWrite(target, manifest, config),
    /Unsafe write manifest/
  );
  assert.deepEqual(await fs.readFile(workbookPath), before);

  const extraSelector = buildSafeManifest(config, sheet);
  extraSelector.scope.rows[0].key.event_id = "EVT-20260729-001";
  assert.match(
    validateWriteManifest(extraSelector, config).join("\n"),
    /key selectors must contain exactly ticket_id/
  );
});

test("placeholder rows reject noncanonical IDs and real controlled values", async (t) => {
  const { target, output } = await initializedProject(t, "placeholder-controls");
  const config = await readJson(path.join(target, CONFIG_FILE));
  const workbookPath = path.join(target, "workbook", "11-delivery-tickets.csv");
  const rows = parseCsv(await fs.readFile(workbookPath, "utf8"));
  const headers = rows[0];
  rows[1][headers.indexOf("ticket_id")] = "<NONCANONICAL_TICKET>";
  rows[1][headers.indexOf("status")] = "accepted";
  rows[1][headers.indexOf("priority")] = "P1";
  rows[1][headers.indexOf("owner_actor_id")] =
    config.agents.find((agent) => agent.id === "RB-06").actorId;
  rows[1][headers.indexOf("implementation_reference")] = "deploy-real-value";
  await fs.writeFile(workbookPath, stringifyCsv(rows), "utf8");

  const releasePath = path.join(target, "workbook", "20-releases.csv");
  const releaseRows = parseCsv(await fs.readFile(releasePath, "utf8"));
  const releaseHeaders = releaseRows[0];
  releaseRows[1][releaseHeaders.indexOf("status")] = "planned";
  releaseRows[1][releaseHeaders.indexOf("target_environment")] = "production";
  releaseRows[1][releaseHeaders.indexOf("human_authorization_id")] = "HUMAN-REAL";
  releaseRows[1][releaseHeaders.indexOf("deployment_reference")] = "deploy-real";
  await fs.writeFile(releasePath, stringifyCsv(releaseRows), "utf8");

  assert.equal(await run(["validate", target], output.io), 1);
  const message = output.stderr.at(-1);
  assert.match(message, /non-canonical placeholder record key/);
  assert.match(message, /placeholder record may not carry real controlled value in "status"/);
  assert.match(message, /placeholder record may not carry real controlled value in "priority"/);
  assert.match(message, /placeholder record may not carry real controlled value in "owner_actor_id"/);
  assert.match(
    message,
    /placeholder record may not carry real controlled value in "implementation_reference"/
  );
  assert.match(
    message,
    /placeholder record may not carry real controlled value in "target_environment"/
  );
  assert.match(
    message,
    /placeholder record may not carry real controlled value in "human_authorization_id"/
  );
  assert.match(
    message,
    /placeholder record may not carry real controlled value in "deployment_reference"/
  );
});

test("controlled verification rows require RB-12 and prevent design-owner self-verification", async (t) => {
  const { target, output } = await initializedProject(t, "verifier-controls");
  const config = await readJson(path.join(target, CONFIG_FILE));
  const workbookPath = path.join(target, "workbook", "12-validation-plans.csv");
  const rows = parseCsv(await fs.readFile(workbookPath, "utf8"));
  const headers = rows[0];
  const actor = (role) => config.agents.find((agent) => agent.id === role).actorId;
  const rb08 = [...rows[1]];
  rb08[headers.indexOf("plan_id")] = "VPL-20260729-001";
  rb08[headers.indexOf("status")] = "draft";
  rb08[headers.indexOf("risk")] = "low";
  rb08[headers.indexOf("environment_alias")] = "local";
  rb08[headers.indexOf("design_owner_actor_id")] = actor("RB-07");
  rb08[headers.indexOf("verifier_role")] = "RB-08";
  rb08[headers.indexOf("verifier_actor_id")] = actor("RB-08");
  const selfVerified = [...rb08];
  selfVerified[headers.indexOf("plan_id")] = "VPL-20260729-002";
  selfVerified[headers.indexOf("verifier_role")] = "RB-07";
  selfVerified[headers.indexOf("verifier_actor_id")] = actor("RB-07");
  rows.splice(1, 1, rb08, selfVerified);
  await fs.writeFile(workbookPath, stringifyCsv(rows), "utf8");

  assert.equal(await run(["validate", target], output.io), 1);
  const message = output.stderr.at(-1);
  assert.match(message, /verifier_role.*active independent verifier "RB-12"/);
  assert.match(message, /verifier actor must be the configured actor for "RB-12"/);
  assert.match(
    message,
    /producer and verifier actors must be different.*design_owner_actor_id/
  );
});

test("config rejects inactive mandatory verifier and extra roles", async (t) => {
  const { target, output } = await initializedProject(t, "invalid-role-contract");
  const configPath = path.join(target, CONFIG_FILE);
  const config = await readJson(configPath);
  config.agents.find((agent) => agent.id === "RB-12").lifecycle = "suspended";
  await writeJson(configPath, config);

  assert.equal(await run(["validate", target], output.io), 1);
  assert.match(
    output.stderr.at(-1),
    /Canonical role "RB-12" authority must match/
  );

  config.agents.push({
    ...config.agents[0],
    id: "RB-99",
    actorId: "actor-rb-99"
  });
  await writeJson(configPath, config);

  assert.equal(await run(["validate", target], output.io), 1);
  assert.match(
    output.stderr.at(-1),
    /must NOT have more than 13 items|exactly the 13 canonical roles/
  );
});
