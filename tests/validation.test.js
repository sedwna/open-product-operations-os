import assert from "node:assert/strict";
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
          key: { ticket_id: "TKT-LOCAL-001" },
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
  record[rows[0].indexOf("ticket_id")] = "TKT-LOCAL-001";
  record[rows[0].indexOf("status")] = "implementation_complete";
  rows.push(record);
  await fs.writeFile(workbookPath, stringifyCsv(rows), "utf8");

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

  const replay = await applyLocalWrite(target, manifest, config);
  assert.equal(replay.plannedWrites, 0);
  const rolledBack = await rollbackLocalWrite(target, receipt.receiptFile);
  assert.equal(rolledBack.rollbackReadbackMatch, true);
  assert.match(
    await fs.readFile(workbookPath, "utf8"),
    /implementation_complete/
  );
  assert.equal(await run(["validate", target], output.io), 0);
});
