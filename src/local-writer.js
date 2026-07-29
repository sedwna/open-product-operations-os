import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parseCsv, stringifyCsv } from "./csv.js";
import { assertNoLinkTraversal, assertSafeRelativePath, resolveInside } from "./paths.js";
import { validatePublishedSchema } from "./schema-validation.js";
import { validateWriteManifest } from "./validation.js";

export async function applyLocalWrite(
  root,
  manifest,
  config,
  { dryRun = true, approvedPlanHash = "" } = {}
) {
  const absoluteRoot = path.resolve(root);
  const errors = validateWriteManifest(manifest, config);
  if (errors.length > 0) {
    throw new Error(`Unsafe write manifest:\n- ${errors.join("\n- ")}`);
  }

  const plan = await buildWritePlan(absoluteRoot, manifest);
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

  if (plan.changes.length === 0) {
    return {
      dryRun: false,
      manifestId: manifest.manifestId,
      plannedWrites: 0,
      replay: true,
      planHash: plan.planHash
    };
  }

  const receiptDirectory = `.product-ops/writes/${safeManifestId(manifest.manifestId)}`;
  const backupRelativePath = `${receiptDirectory}/before.csv`;
  const receiptRelativePath = `${receiptDirectory}/receipt.json`;
  const backupPath = resolveInside(absoluteRoot, backupRelativePath, "Write backup");
  const receiptPath = resolveInside(absoluteRoot, receiptRelativePath, "Write receipt");
  const targetPath = resolveInside(absoluteRoot, manifest.target.file, "Write target");

  await assertNoLinkTraversal(absoluteRoot, backupPath, "Write backup");
  await assertNoLinkTraversal(absoluteRoot, receiptPath, "Write receipt");
  await assertNoLinkTraversal(absoluteRoot, targetPath, "Write target");
  await fs.mkdir(path.dirname(backupPath), { recursive: true });
  await assertNoLinkTraversal(absoluteRoot, backupPath, "Write backup");
  await fs.writeFile(backupPath, plan.before, { encoding: "utf8", flag: "wx" });

  const after = stringifyCsv(plan.rows);
  await assertNoLinkTraversal(absoluteRoot, targetPath, "Write target");
  await fs.writeFile(targetPath, after, "utf8");
  const readBack = await fs.readFile(targetPath, "utf8");
  if (readBack !== after) {
    throw new Error("Full-record read-back did not match the applied local write.");
  }

  const replayPlan = await buildWritePlan(absoluteRoot, manifest);
  if (replayPlan.changes.length !== 0) {
    throw new Error("Idempotent replay check predicted additional writes.");
  }

  const receipt = {
    schemaVersion: "1.0.0",
    manifestId: manifest.manifestId,
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
    backupFile: backupRelativePath,
    rollbackPlan: manifest.controls.rollbackPlan,
    rolledBack: false,
    createdAt: new Date().toISOString()
  };
  const receiptErrors = validatePublishedSchema(
    "workbook-write-receipt.schema.json",
    receipt
  );
  if (receiptErrors.length > 0) {
    throw new Error(`Generated write receipt is invalid:\n- ${receiptErrors.join("\n- ")}`);
  }
  await assertNoLinkTraversal(absoluteRoot, receiptPath, "Write receipt");
  await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx"
  });

  return { ...receipt, receiptFile: receiptRelativePath };
}

export async function rollbackLocalWrite(root, receiptRelativePath) {
  const absoluteRoot = path.resolve(root);
  const safeReceipt = assertSafeRelativePath(receiptRelativePath, "Receipt path");
  const receiptPath = resolveInside(absoluteRoot, safeReceipt, "Receipt path");
  await assertNoLinkTraversal(absoluteRoot, receiptPath, "Receipt path");
  const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
  if (receipt.rolledBack) {
    return { ...receipt, rollbackReplay: true };
  }

  const targetPath = resolveInside(absoluteRoot, receipt.targetFile, "Rollback target");
  const backupPath = resolveInside(absoluteRoot, receipt.backupFile, "Rollback backup");
  await assertNoLinkTraversal(absoluteRoot, targetPath, "Rollback target");
  await assertNoLinkTraversal(absoluteRoot, backupPath, "Rollback backup");
  const current = await fs.readFile(targetPath, "utf8");
  if (sha256(current) !== receipt.afterSha256) {
    throw new Error("Rollback refused because the target changed after the controlled write.");
  }
  const backup = await fs.readFile(backupPath, "utf8");
  if (sha256(backup) !== receipt.beforeSha256) {
    throw new Error("Rollback refused because the backup integrity check failed.");
  }

  await assertNoLinkTraversal(absoluteRoot, targetPath, "Rollback target");
  await fs.writeFile(targetPath, backup, "utf8");
  const readBack = await fs.readFile(targetPath, "utf8");
  if (sha256(readBack) !== receipt.beforeSha256) {
    throw new Error("Rollback read-back did not match the original content.");
  }

  const updated = {
    ...receipt,
    rolledBack: true,
    rollbackReadbackMatch: true,
    rolledBackAt: new Date().toISOString()
  };
  const receiptErrors = validatePublishedSchema(
    "workbook-write-receipt.schema.json",
    updated
  );
  if (receiptErrors.length > 0) {
    throw new Error(`Rollback receipt is invalid:\n- ${receiptErrors.join("\n- ")}`);
  }
  await assertNoLinkTraversal(absoluteRoot, receiptPath, "Receipt path");
  await fs.writeFile(receiptPath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  return updated;
}

async function buildWritePlan(root, manifest) {
  const targetPath = resolveInside(root, manifest.target.file, "Write target");
  await assertNoLinkTraversal(root, targetPath, "Write target");
  const before = await fs.readFile(targetPath, "utf8");
  const rows = parseCsv(before);
  const headers = rows[0] ?? [];
  const indexes = new Map(headers.map((header, index) => [header, index]));
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

  for (const requested of manifest.scope.rows) {
    const rowIndex = rows.findIndex(
      (row, index) =>
        index > 0 &&
        Object.entries(requested.key).every(
          ([field, value]) => row[indexes.get(field)] === scalar(value)
        )
    );
    if (rowIndex < 1) {
      throw new Error(
        `Write target does not contain requested key ${JSON.stringify(requested.key)}.`
      );
    }

    for (const [field, newValue] of Object.entries(requested.changes)) {
      const columnIndex = indexes.get(field);
      const currentValue = rows[rowIndex][columnIndex] ?? "";
      const expectedValue = scalar(requested.preconditions[field]);
      const desiredValue = scalar(newValue);
      if (currentValue === desiredValue) {
        continue;
      }
      if (currentValue !== expectedValue) {
        throw new Error(
          `Precondition mismatch for row ${rowIndex + 1} field "${field}".`
        );
      }
      rows[rowIndex][columnIndex] = desiredValue;
      changes.push({ rowIndex, field, from: currentValue, to: desiredValue });
    }
  }

  const planHash = sha256(
    JSON.stringify({
      manifest,
      beforeSha256: sha256(before),
      changes
    })
  );
  return { before, rows, changes, planHash };
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

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
