import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parseCsv, stringifyCsv } from "./csv.js";
import {
  assertNoHardLinkedFile,
  assertNoLinkTraversal,
  assertSafeRelativePath,
  resolveInside
} from "./paths.js";
import { validatePublishedSchema } from "./schema-validation.js";
import { validateWriteManifest } from "./validation.js";
import { canonicalRecordKeys } from "./workbook-contract.js";

export async function applyLocalWrite(
  root,
  manifest,
  config,
  {
    dryRun = true,
    approvedPlanHash = "",
    transactionObserver = async () => {}
  } = {}
) {
  const absoluteRoot = path.resolve(root);
  const errors = validateWriteManifest(manifest, config);
  if (errors.length > 0) {
    throw new Error(`Unsafe write manifest:\n- ${errors.join("\n- ")}`);
  }
  if (typeof transactionObserver !== "function") {
    throw new Error("transactionObserver must be a function when provided.");
  }

  const paths = writePaths(absoluteRoot, manifest);
  const manifestSha256 = sha256(canonicalJson(manifest));
  const existingReceipt = await readOptionalReceipt(
    absoluteRoot,
    paths.receiptPath
  );
  if (existingReceipt) {
    await validateReplay(
      absoluteRoot,
      manifest,
      manifestSha256,
      existingReceipt,
      paths
    );
    return {
      dryRun,
      manifestId: manifest.manifestId,
      plannedWrites: 0,
      replay: true,
      planHash: existingReceipt.planHash,
      receiptFile: paths.receiptRelativePath
    };
  }

  const sheet = config.workbook.sheets.find(
    (entry) =>
      entry.file === manifest.target.file && entry.name === manifest.scope.sheet
  );
  const keyFields = canonicalRecordKeys(sheet.key);
  const plan = await buildWritePlan(absoluteRoot, manifest, keyFields);
  if (dryRun) {
    return {
      dryRun: true,
      manifestId: manifest.manifestId,
      plannedWrites: plan.changes.length,
      planHash: plan.planHash
    };
  }
  if (approvedPlanHash !== plan.planHash) {
    throw new Error(
      "Local write requires the exact plan hash returned by a preceding dry run."
    );
  }

  const after = stringifyCsv(plan.rows);
  const receipt = {
    schemaVersion: "1.0.0",
    manifestId: manifest.manifestId,
    manifestSha256,
    targetFile: manifest.target.file,
    environment: manifest.target.environment,
    planHash: plan.planHash,
    beforeSha256: sha256(plan.before),
    afterSha256: sha256(after),
    recordsChanged: new Set(plan.changes.map((change) => change.rowIndex)).size,
    fieldsChanged: plan.changes.length,
    fullReadbackMatch: true,
    secondReadMatch: true,
    replayWrites: 0,
    backupFile: paths.backupRelativePath,
    rollbackPlan: manifest.controls.rollbackPlan,
    rolledBack: false,
    createdAt: new Date().toISOString()
  };
  assertValidReceipt(receipt, "Generated write receipt");

  await prepareWritePaths(absoluteRoot, paths);
  let targetReplaced = false;
  try {
    await fs.writeFile(paths.backupPath, plan.before, {
      encoding: "utf8",
      flag: "wx"
    });
    await stageText(absoluteRoot, paths.targetStagePath, after, "Write target stage");
    await transactionObserver({
      phase: "before-target-replace",
      manifestId: manifest.manifestId
    });
    await assertNoLinkTraversal(
      absoluteRoot,
      paths.targetStagePath,
      "Write target stage"
    );
    await assertNoHardLinkedFile(paths.targetStagePath, "Write target stage");
    if ((await fs.readFile(paths.targetStagePath, "utf8")) !== after) {
      throw new Error("Write target stage changed before atomic replacement.");
    }
    await assertTargetUnchanged(
      absoluteRoot,
      paths.targetPath,
      plan.before,
      "Write target"
    );
    await fs.rename(paths.targetStagePath, paths.targetPath);
    targetReplaced = true;
    await transactionObserver({
      phase: "target-replaced",
      manifestId: manifest.manifestId
    });

    const readBack = await fs.readFile(paths.targetPath, "utf8");
    const secondRead = await fs.readFile(paths.targetPath, "utf8");
    if (readBack !== after || secondRead !== after) {
      throw new Error("Full-record read-back did not match the applied local write.");
    }

    await stageText(
      absoluteRoot,
      paths.receiptStagePath,
      `${JSON.stringify(receipt, null, 2)}\n`,
      "Write receipt stage"
    );
    await fs.rename(paths.receiptStagePath, paths.receiptPath);
  } catch (error) {
    let rollbackError;
    if (targetReplaced) {
      try {
        await atomicReplace(
          absoluteRoot,
          paths.targetPath,
          plan.before,
          paths.rollbackStagePath,
          "Failed-write rollback"
        );
      } catch (caught) {
        rollbackError = caught;
      }
    }
    await cleanupStages(paths);
    if (!targetReplaced) {
      await fs.rm(paths.backupPath, { force: true });
      throw new Error(
        `Controlled write aborted before replacement; target bytes were not modified: ${error.message}`,
        { cause: error }
      );
    }
    if (!rollbackError) {
      await fs.rm(paths.backupPath, { force: true });
      throw new Error(
        `Controlled write failed and the original target was restored: ${error.message}`,
        { cause: error }
      );
    }
    throw new AggregateError(
      [error, rollbackError],
      `Controlled write failed and automatic rollback also failed; recovery backup remains at "${paths.backupRelativePath}".`
    );
  }

  return { ...receipt, receiptFile: paths.receiptRelativePath };
}

export async function rollbackLocalWrite(root, receiptRelativePath) {
  const absoluteRoot = path.resolve(root);
  const safeReceipt = assertSafeRelativePath(receiptRelativePath, "Receipt path");
  const receiptPath = resolveInside(absoluteRoot, safeReceipt, "Receipt path");
  await assertNoLinkTraversal(absoluteRoot, receiptPath, "Receipt path");
  await assertNoHardLinkedFile(receiptPath, "Receipt path");
  const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
  assertValidReceipt(receipt, "Rollback receipt");
  if (receipt.rolledBack) {
    return { ...receipt, rollbackReplay: true };
  }

  const targetPath = resolveInside(absoluteRoot, receipt.targetFile, "Rollback target");
  const backupPath = resolveInside(absoluteRoot, receipt.backupFile, "Rollback backup");
  await assertWritableExistingFile(absoluteRoot, targetPath, "Rollback target");
  await assertWritableExistingFile(absoluteRoot, backupPath, "Rollback backup");
  const current = await fs.readFile(targetPath, "utf8");
  if (sha256(current) !== receipt.afterSha256) {
    throw new Error("Rollback refused because the target changed after the controlled write.");
  }
  const backup = await fs.readFile(backupPath, "utf8");
  if (sha256(backup) !== receipt.beforeSha256) {
    throw new Error("Rollback refused because the backup integrity check failed.");
  }

  const updated = {
    ...receipt,
    rolledBack: true,
    rollbackReadbackMatch: true,
    rolledBackAt: new Date().toISOString()
  };
  assertValidReceipt(updated, "Rollback receipt");
  const suffix = safeManifestId(receipt.manifestId);
  const targetStage = `${targetPath}.${suffix}.rollback.tmp`;
  const receiptStage = `${receiptPath}.${suffix}.rollback.tmp`;
  let targetReplaced = false;
  try {
    await stageText(absoluteRoot, receiptStage, `${JSON.stringify(updated, null, 2)}\n`, "Rollback receipt stage");
    await atomicReplace(
      absoluteRoot,
      targetPath,
      backup,
      targetStage,
      "Rollback target"
    );
    targetReplaced = true;
    if (sha256(await fs.readFile(targetPath)) !== receipt.beforeSha256) {
      throw new Error("Rollback read-back did not match the original content.");
    }
    await fs.rename(receiptStage, receiptPath);
  } catch (error) {
    if (targetReplaced) {
      await atomicReplace(
        absoluteRoot,
        targetPath,
        current,
        targetStage,
        "Rollback transaction recovery"
      );
    }
    await fs.rm(receiptStage, { force: true });
    await fs.rm(targetStage, { force: true });
    throw error;
  }
  return updated;
}

async function buildWritePlan(root, manifest, keyFields) {
  const targetPath = resolveInside(root, manifest.target.file, "Write target");
  await assertWritableExistingFile(root, targetPath, "Write target");
  return buildWritePlanFromText(
    manifest,
    await fs.readFile(targetPath, "utf8"),
    keyFields
  );
}

function buildWritePlanFromText(
  manifest,
  before,
  keyFields = manifest.scope.keyFields
) {
  const rows = parseCsv(before);
  const headers = rows[0] ?? [];
  const indexes = new Map(headers.map((header, index) => [header, index]));
  if (indexes.size !== headers.length) {
    throw new Error("Write target contains duplicate column headers.");
  }
  for (const [index, row] of rows.slice(1).entries()) {
    if (row.length !== headers.length) {
      throw new Error(
        `Write target row ${index + 2} has ${row.length} cells; expected ${headers.length}.`
      );
    }
  }
  const changes = [];
  const referencedFields = new Set([
    ...manifest.scope.keyFields,
    ...manifest.scope.allowedFields,
    ...manifest.scope.rows.flatMap((row) => [
      ...Object.keys(row.key),
      ...Object.keys(row.preconditions),
      ...Object.keys(row.changes)
    ])
  ]);
  for (const field of referencedFields) {
    if (!indexes.has(field)) {
      throw new Error(`Write target is missing configured field "${field}".`);
    }
  }
  const seenCanonicalKeys = new Map();
  for (const [index, row] of rows.slice(1).entries()) {
    const values = keyFields.map((field) => row[indexes.get(field)] ?? "");
    const key = JSON.stringify(values);
    if (seenCanonicalKeys.has(key)) {
      throw new Error(
        `Write target duplicates canonical key ${JSON.stringify(
          Object.fromEntries(
            keyFields.map((field, keyIndex) => [field, values[keyIndex]])
          )
        )} at rows ${seenCanonicalKeys.get(key)} and ${index + 2}.`
      );
    }
    seenCanonicalKeys.set(key, index + 2);
  }

  for (const requested of manifest.scope.rows) {
    const matchingRows = rows
      .map((row, index) => ({ row, index }))
      .filter(
        ({ row, index }) =>
          index > 0 &&
          keyFields.every(
            (field) => row[indexes.get(field)] === scalar(requested.key[field])
          )
      );
    if (matchingRows.length !== 1) {
      throw new Error(
        `Write target must contain exactly one requested key ${JSON.stringify(requested.key)}; found ${matchingRows.length}.`
      );
    }
    const [{ row: matchedRow, index: rowIndex }] = matchingRows;

    for (const [field, newValue] of Object.entries(requested.changes)) {
      const columnIndex = indexes.get(field);
      const currentValue = matchedRow[columnIndex] ?? "";
      const expectedValue = scalar(requested.preconditions[field]);
      const desiredValue = scalar(newValue);
      if (currentValue !== expectedValue) {
        throw new Error(
          `Precondition mismatch for row ${rowIndex + 1} field "${field}".`
        );
      }
      if (currentValue === desiredValue) {
        throw new Error(
          `Write manifest has no effective change for row ${rowIndex + 1} field "${field}".`
        );
      }
      rows[rowIndex][columnIndex] = desiredValue;
      changes.push({ rowIndex, field, from: currentValue, to: desiredValue });
    }
  }

  const planHash = sha256(
    canonicalJson({
      manifest,
      beforeSha256: sha256(before),
      changes
    })
  );
  return { before, rows, changes, planHash };
}

async function validateReplay(root, manifest, manifestSha256, receipt, paths) {
  assertValidReceipt(receipt, "Existing write receipt");
  if (receipt.rolledBack) {
    throw new Error("Manifest ID belongs to a rolled-back write and cannot be replayed.");
  }
  if (
    receipt.manifestId !== manifest.manifestId ||
    receipt.manifestSha256 !== manifestSha256 ||
    receipt.targetFile !== manifest.target.file ||
    receipt.environment !== manifest.target.environment ||
    receipt.backupFile !== paths.backupRelativePath
  ) {
    throw new Error("Existing receipt does not match the validated write manifest.");
  }

  await assertWritableExistingFile(root, paths.targetPath, "Replay target");
  await assertWritableExistingFile(root, paths.backupPath, "Replay backup");
  const current = await fs.readFile(paths.targetPath, "utf8");
  const before = await fs.readFile(paths.backupPath, "utf8");
  if (
    sha256(current) !== receipt.afterSha256 ||
    sha256(before) !== receipt.beforeSha256
  ) {
    throw new Error("Replay refused because target or backup integrity does not match the receipt.");
  }
  const originalPlan = buildWritePlanFromText(
    manifest,
    before,
    manifest.scope.keyFields
  );
  const after = stringifyCsv(originalPlan.rows);
  if (
    originalPlan.planHash !== receipt.planHash ||
    sha256(after) !== receipt.afterSha256 ||
    originalPlan.changes.length !== receipt.fieldsChanged ||
    new Set(originalPlan.changes.map((change) => change.rowIndex)).size !==
      receipt.recordsChanged
  ) {
    throw new Error("Replay refused because the receipt does not prove the original preconditions and result.");
  }
}

function writePaths(root, manifest) {
  const suffix = safeManifestId(manifest.manifestId);
  const receiptDirectory = `.product-ops/writes/${suffix}`;
  const backupRelativePath = `${receiptDirectory}/before.csv`;
  const receiptRelativePath = `${receiptDirectory}/receipt.json`;
  const backupPath = resolveInside(root, backupRelativePath, "Write backup");
  const receiptPath = resolveInside(root, receiptRelativePath, "Write receipt");
  const targetPath = resolveInside(root, manifest.target.file, "Write target");
  return {
    backupRelativePath,
    receiptRelativePath,
    backupPath,
    receiptPath,
    targetPath,
    targetStagePath: `${targetPath}.${suffix}.write.tmp`,
    receiptStagePath: `${receiptPath}.${suffix}.write.tmp`,
    rollbackStagePath: `${targetPath}.${suffix}.recovery.tmp`
  };
}

async function prepareWritePaths(root, paths) {
  for (const [candidate, label] of [
    [paths.backupPath, "Write backup"],
    [paths.receiptPath, "Write receipt"],
    [paths.targetPath, "Write target"],
    [paths.targetStagePath, "Write target stage"],
    [paths.receiptStagePath, "Write receipt stage"]
  ]) {
    await assertNoLinkTraversal(root, candidate, label);
  }
  await assertNoHardLinkedFile(paths.targetPath, "Write target");
  await fs.mkdir(path.dirname(paths.backupPath), { recursive: true });
  await assertNoLinkTraversal(root, paths.backupPath, "Write backup");
  await assertAbsent(paths.backupPath, "Write backup");
  await assertAbsent(paths.receiptPath, "Write receipt");
  await assertAbsent(paths.targetStagePath, "Write target stage");
  await assertAbsent(paths.receiptStagePath, "Write receipt stage");
}

async function readOptionalReceipt(root, receiptPath) {
  await assertNoLinkTraversal(root, receiptPath, "Write receipt");
  try {
    await assertNoHardLinkedFile(receiptPath, "Write receipt");
    return JSON.parse(await fs.readFile(receiptPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function assertWritableExistingFile(root, file, label) {
  await assertNoLinkTraversal(root, file, label);
  await assertNoHardLinkedFile(file, label);
}

async function assertTargetUnchanged(root, file, expected, label) {
  await assertWritableExistingFile(root, file, label);
  const current = await fs.readFile(file, "utf8");
  if (sha256(current) !== sha256(expected) || current !== expected) {
    throw new Error(
      `${label} changed after the approved dry-run plan; concurrent bytes were preserved.`
    );
  }
}

async function assertAbsent(file, label) {
  try {
    await fs.lstat(file);
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error(`${label} already exists without a validated receipt.`);
}

async function stageText(root, stagePath, content, label) {
  await assertNoLinkTraversal(root, stagePath, label);
  await assertAbsent(stagePath, label);
  await fs.writeFile(stagePath, content, { encoding: "utf8", flag: "wx" });
  if ((await fs.readFile(stagePath, "utf8")) !== content) {
    throw new Error(`${label} read-back did not match.`);
  }
}

async function atomicReplace(root, destination, content, stagePath, label) {
  await assertWritableExistingFile(root, destination, label);
  await stageText(root, stagePath, content, `${label} stage`);
  await assertNoHardLinkedFile(destination, label);
  await fs.rename(stagePath, destination);
}

async function cleanupStages(paths) {
  await Promise.all([
    fs.rm(paths.targetStagePath, { force: true }),
    fs.rm(paths.receiptStagePath, { force: true }),
    fs.rm(paths.rollbackStagePath, { force: true })
  ]);
}

function assertValidReceipt(receipt, label) {
  const errors = validatePublishedSchema("workbook-write-receipt.schema.json", receipt);
  if (errors.length > 0) {
    throw new Error(`${label} is invalid:\n- ${errors.join("\n- ")}`);
  }
}

function safeManifestId(value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,79}$/.test(value)) {
    throw new Error("manifestId is not safe for a receipt directory.");
  }
  return value;
}

function scalar(value) {
  return value === null ? "" : String(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
