import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  captureFileSnapshot,
  moveFileNoOverwrite,
  removeFileIfUnchanged
} from "./atomic-move.js";
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
  await verifyAuthorityEvidence(absoluteRoot, manifest, config);

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
  await assertNoRetainedRecoveryPath(
    paths.invalidReceiptPath,
    "Controlled write"
  );

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
  const receiptText = `${JSON.stringify(receipt, null, 2)}\n`;

  await prepareWritePaths(absoluteRoot, paths);
  try {
    await writeExclusiveText(
      absoluteRoot,
      paths.backupPath,
      plan.before,
      "Write backup"
    );
    await stageText(absoluteRoot, paths.targetStagePath, after, "Write target stage");
    const targetTransaction = await atomicNoOverwriteReplace(absoluteRoot, {
      destination: paths.targetPath,
      stagePath: paths.targetStagePath,
      quarantinePath: paths.targetQuarantinePath,
      displacedPath: paths.displacedTargetPath,
      expectedCurrent: plan.before,
      replacement: after,
      label: "Write target",
      transactionObserver,
      manifestId: manifest.manifestId,
      afterInstall: async () => {
        await transactionObserver({
          phase: "target-replaced",
          manifestId: manifest.manifestId
        });

        const readBack = await fs.readFile(paths.targetPath, "utf8");
        const secondRead = await fs.readFile(paths.targetPath, "utf8");
        if (readBack !== after || secondRead !== after) {
          throw new Error(
            "Full-record read-back did not match the applied local write."
          );
        }
        if ((await fs.readFile(paths.backupPath, "utf8")) !== plan.before) {
          throw new Error("Write backup changed before receipt commit.");
        }
        await assertNoHardLinkedFile(paths.backupPath, "Write backup");

        await stageText(
          absoluteRoot,
          paths.receiptStagePath,
          receiptText,
          "Write receipt stage"
        );
        await installStageNoOverwrite(
          absoluteRoot,
          paths.receiptStagePath,
          paths.receiptPath,
          "Write receipt",
          transactionObserver
        );
        try {
          await assertCommittedWriteMatchesReceipt(
            absoluteRoot,
            paths,
            receipt,
            receiptText
          );
        } catch (cause) {
          const invalidation = await retainInvalidReceipt(
            absoluteRoot,
            paths,
            receiptText,
            transactionObserver
          );
          throw recoveryError(
            `Controlled write target diverged after receipt installation; no success receipt remains at the canonical path. Invalidated receipt recovery: ${formatPaths(
              invalidation.recoveryPaths
            )}.`,
            cause,
            {
              code: "ESTALERECEIPT",
              recoveryPaths: invalidation.recoveryPaths
            }
          );
        }
      }
    });
    const cleanup = await cleanupCommittedQuarantine(
      absoluteRoot,
      paths.targetQuarantinePath,
      targetTransaction.quarantineSnapshot,
      "Write target quarantine"
    );
    assertCommittedCleanup(
      cleanup,
      "Controlled write committed, but target-quarantine cleanup retained a safety artifact."
    );
    try {
      await assertCommittedWriteMatchesReceipt(
        absoluteRoot,
        paths,
        receipt,
        receiptText
      );
    } catch (cause) {
      const invalidation = await retainInvalidReceipt(
        absoluteRoot,
        paths,
        receiptText,
        transactionObserver
      );
      throw recoveryError(
        `Controlled write target diverged before final success return. The canonical receipt was invalidated; recover from ${formatPaths(
          [
            paths.backupPath,
            ...invalidation.recoveryPaths
          ]
        )}.`,
        cause,
        {
          code: "ESTALERECEIPT",
          recoveryPaths: [
            paths.backupPath,
            ...invalidation.recoveryPaths
          ],
          committed: true
        }
      );
    }
  } catch (error) {
    if (error.committed === true) {
      throw error;
    }
    await cleanupStages(paths);
    if (
      (error.transactionRecovery?.retainedRecoveryPaths?.length ?? 0) > 0
    ) {
      throw recoveryError(
        `Controlled write failed after restoring the pre-transaction target; concurrent recovery bytes were retained at ${formatPaths(
          error.transactionRecovery.retainedRecoveryPaths
        )}. The approved backup remains at "${paths.backupRelativePath}".`,
        error,
        {
          code: "ERECOVERYRETAINED",
          recoveryPaths: [
            ...error.transactionRecovery.retainedRecoveryPaths,
            paths.backupPath
          ]
        }
      );
    }
    if (error.transactionRecovery?.status === "retained") {
      throw recoveryError(
        `Controlled write aborted without overwriting concurrent target bytes; the approved original is retained at "${paths.backupRelativePath}": ${error.message}`,
        error,
        {
          code: "ERECOVERYRETAINED",
          recoveryPaths: uniquePaths([
            ...(error.recoveryPaths ?? []),
            ...(error.transactionRecovery.recoveryPaths ?? []),
            paths.backupPath
          ])
        }
      );
    }
    if (error.transactionRecovery?.status === "failed") {
      throw new AggregateError(
        [error, error.transactionRecovery.error],
        `Controlled write failed and automatic recovery could not safely restore the target; recovery artifacts remain beside the target and at "${paths.backupRelativePath}". ${error.message}`
      );
    }
    await fs.rm(paths.backupPath, { force: true });
    throw new Error(
      `Controlled write failed and the pre-transaction target was preserved: ${error.message}`,
      { cause: error }
    );
  }

  return { ...receipt, receiptFile: paths.receiptRelativePath };
}

async function verifyAuthorityEvidence(root, manifest, config) {
  let productionAuthorizationVerified = manifest.target.environment !== "production";
  for (const evidence of manifest.authorization.authorityEvidence ?? []) {
    const file = resolveInside(root, evidence.reference, "Write authority evidence");
    await assertNoLinkTraversal(root, file, "Write authority evidence");
    await assertNoHardLinkedFile(file, "Write authority evidence");
    const bytes = await fs.readFile(file);
    if (sha256(bytes) !== evidence.sha256) throw new Error(`Write authority evidence changed: ${evidence.reference}.`);
    const value = JSON.parse(bytes.toString("utf8"));
    if (evidence.kind === "human_approval") {
      const approval = value.requests?.find((item) => item.requestId === evidence.recordId);
      if (!approval || approval.status !== "approved" || approval.decidedByActorId !== config.project.humanAuthorityActorId) {
        throw new Error(`Human approval evidence ${evidence.recordId} is missing, undecided, or attributed to the wrong actor.`);
      }
      for (const row of manifest.scope.rows) {
        if (row.changes.decision_maker_actor_id && row.changes.decision_maker_actor_id !== approval.decidedByActorId) {
          throw new Error("Protected decision actor does not match the cited human approval.");
        }
        for (const field of ["human_risk_acceptance_id", "human_authorization_id"]) {
          if (row.changes[field] && row.changes[field] !== approval.requestId) {
            throw new Error(`Protected field ${field} does not match the cited human approval.`);
          }
        }
        if (row.changes.human_risk_acceptance_id && !/risk[_ -]?acceptance/i.test(approval.gate)) {
          throw new Error("Human risk acceptance requires an approval issued for a risk-acceptance gate.");
        }
        if (row.changes.human_authorization_id && !/(?:production|release)/i.test(approval.gate)) {
          throw new Error("Release authorization requires an approval issued for a release or production gate.");
        }
      }
      if (manifest.target.environment === "production"
          && manifest.authorization.humanProductionAuthorizationId === approval.requestId
      ) {
        if (!/production/i.test(approval.gate)) {
          throw new Error("Production writes require approval evidence issued for a production gate.");
        }
        productionAuthorizationVerified = true;
      }
    }
  }
  if (!productionAuthorizationVerified) {
    throw new Error("Production write authorization was not verified against durable human approval evidence.");
  }
}

export async function rollbackLocalWrite(
  root,
  receiptRelativePath,
  { transactionObserver = async () => {} } = {}
) {
  const absoluteRoot = path.resolve(root);
  if (typeof transactionObserver !== "function") {
    throw new Error("transactionObserver must be a function when provided.");
  }
  const safeReceipt = assertSafeRelativePath(receiptRelativePath, "Receipt path");
  const receiptPath = resolveInside(absoluteRoot, safeReceipt, "Receipt path");
  await assertNoLinkTraversal(absoluteRoot, receiptPath, "Receipt path");
  await assertNoHardLinkedFile(receiptPath, "Receipt path");
  const receiptText = await fs.readFile(receiptPath, "utf8");
  const receipt = JSON.parse(receiptText);
  assertValidReceipt(receipt, "Rollback receipt");
  const targetPath = resolveInside(absoluteRoot, receipt.targetFile, "Rollback target");
  const backupPath = resolveInside(absoluteRoot, receipt.backupFile, "Rollback backup");
  await assertWritableExistingFile(absoluteRoot, targetPath, "Rollback target");
  await assertWritableExistingFile(absoluteRoot, backupPath, "Rollback backup");
  if (receipt.rolledBack) {
    await assertNoRetainedRecoveryPath(
      `${targetPath}.${safeManifestId(receipt.manifestId)}.rollback-current.tmp`,
      "Rollback replay"
    );
    const [restored, backup] = await Promise.all([
      fs.readFile(targetPath, "utf8"),
      fs.readFile(backupPath, "utf8")
    ]);
    if (sha256(restored) !== receipt.beforeSha256) {
      throw new Error(
        "Rollback replay refused because the restored target no longer matches beforeSha256."
      );
    }
    if (sha256(backup) !== receipt.beforeSha256) {
      throw new Error(
        "Rollback replay refused because the backup integrity check failed."
      );
    }
    return { ...receipt, rollbackReplay: true };
  }

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
  const targetQuarantine = `${targetPath}.${suffix}.rollback-current.tmp`;
  const displacedTarget = `${targetPath}.${suffix}.rollback-displaced.tmp`;
  const receiptStage = `${receiptPath}.${suffix}.rollback.tmp`;
  try {
    for (const [candidate, label] of [
      [targetStage, "Rollback target stage"],
      [targetQuarantine, "Rollback target quarantine"],
      [displacedTarget, "Rollback displaced target"],
      [receiptStage, "Rollback receipt stage"]
    ]) {
      await assertNoLinkTraversal(absoluteRoot, candidate, label);
      await assertAbsent(candidate, label);
    }
    await stageText(absoluteRoot, targetStage, backup, "Rollback target stage");
    const rollbackTransaction = await atomicNoOverwriteReplace(absoluteRoot, {
      destination: targetPath,
      stagePath: targetStage,
      quarantinePath: targetQuarantine,
      displacedPath: displacedTarget,
      expectedCurrent: current,
      replacement: backup,
      label: "Rollback target",
      transactionObserver,
      manifestId: receipt.manifestId,
      afterInstall: async () => {
        if (sha256(await fs.readFile(targetPath)) !== receipt.beforeSha256) {
          throw new Error("Rollback read-back did not match the original content.");
        }
        await stageText(
          absoluteRoot,
          receiptStage,
          `${JSON.stringify(updated, null, 2)}\n`,
          "Rollback receipt stage"
        );
        await replaceReceipt(
          absoluteRoot,
          receiptPath,
          receiptStage,
          receiptText,
          "Rollback receipt",
          transactionObserver
        );
      }
    });
    const cleanup = await cleanupCommittedQuarantine(
      absoluteRoot,
      targetQuarantine,
      rollbackTransaction.quarantineSnapshot,
      "Rollback target quarantine"
    );
    assertCommittedCleanup(
      cleanup,
      "Rollback committed, but target-quarantine cleanup retained a safety artifact."
    );
  } catch (error) {
    if (error.committed === true) {
      throw error;
    }
    await fs.rm(receiptStage, { force: true });
    await fs.rm(targetStage, { force: true });
    if (
      (error.transactionRecovery?.retainedRecoveryPaths?.length ?? 0) > 0
    ) {
      throw recoveryError(
        `Rollback failed after restoring the pre-rollback target; concurrent recovery bytes were retained at ${formatPaths(
          error.transactionRecovery.retainedRecoveryPaths
        )}.`,
        error,
        {
          code: "ERECOVERYRETAINED",
          recoveryPaths: error.transactionRecovery.retainedRecoveryPaths
        }
      );
    }
    if (error.transactionRecovery?.status === "retained") {
      throw recoveryError(
        `Rollback aborted without overwriting concurrent target bytes; the pre-rollback target remains at "${targetQuarantine}": ${error.message}`,
        error,
        {
          code: "ERECOVERYRETAINED",
          recoveryPaths: uniquePaths([
            ...(error.recoveryPaths ?? []),
            ...(error.transactionRecovery.recoveryPaths ?? []),
            targetQuarantine
          ])
        }
      );
    }
    if (error.transactionRecovery?.status === "failed") {
      throw new AggregateError(
        [error, error.transactionRecovery.error],
        `Rollback failed and automatic transaction recovery also failed; recovery artifacts were retained. ${error.message}`
      );
    }
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
      ...Object.keys(row.preconditions).filter((field) => field !== "$record"),
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
    if (requested.operation === "insert") {
      if (matchingRows.length !== 0) {
        throw new Error(`Write target already contains requested insert key ${JSON.stringify(requested.key)}.`);
      }
      if (requested.preconditions.$record !== "absent" || Object.keys(requested.preconditions).length !== 1) {
        throw new Error("Insert requires an explicit absent-record precondition.");
      }
      const inserted = headers.map(() => "");
      for (const [field, value] of Object.entries({ ...requested.key, ...requested.changes })) {
        inserted[indexes.get(field)] = scalar(value);
      }
      const rowIndex = rows.length;
      rows.push(inserted);
      for (const [field, value] of Object.entries({ ...requested.key, ...requested.changes })) {
        changes.push({ rowIndex, field, from: "", to: scalar(value) });
      }
      continue;
    }
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
  await assertNoRetainedRecoveryPath(
    paths.targetQuarantinePath,
    "Write replay"
  );
  await assertNoRetainedRecoveryPath(
    paths.invalidReceiptPath,
    "Write replay"
  );
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
    targetQuarantinePath: `${targetPath}.${suffix}.before.tmp`,
    displacedTargetPath: `${targetPath}.${suffix}.displaced.tmp`,
    receiptStagePath: `${receiptPath}.${suffix}.write.tmp`,
    invalidReceiptPath: `${receiptPath}.${suffix}.invalidated.tmp`
  };
}

async function prepareWritePaths(root, paths) {
  for (const [candidate, label] of [
    [paths.backupPath, "Write backup"],
    [paths.receiptPath, "Write receipt"],
    [paths.targetPath, "Write target"],
    [paths.targetStagePath, "Write target stage"],
    [paths.targetQuarantinePath, "Write target quarantine"],
    [paths.displacedTargetPath, "Write displaced target"],
    [paths.receiptStagePath, "Write receipt stage"],
    [paths.invalidReceiptPath, "Invalidated write receipt"]
  ]) {
    await assertNoLinkTraversal(root, candidate, label);
  }
  await assertNoHardLinkedFile(paths.targetPath, "Write target");
  await fs.mkdir(path.dirname(paths.backupPath), { recursive: true });
  await assertNoLinkTraversal(root, paths.backupPath, "Write backup");
  await assertAbsent(paths.backupPath, "Write backup");
  await assertAbsent(paths.receiptPath, "Write receipt");
  await assertAbsent(paths.targetStagePath, "Write target stage");
  await assertAbsent(paths.targetQuarantinePath, "Write target quarantine");
  await assertAbsent(paths.displacedTargetPath, "Write displaced target");
  await assertAbsent(paths.receiptStagePath, "Write receipt stage");
  await assertAbsent(paths.invalidReceiptPath, "Invalidated write receipt");
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
  await writeExclusiveText(root, stagePath, content, label);
}

async function writeExclusiveText(root, file, content, label) {
  await assertNoLinkTraversal(root, file, label);
  await fs.writeFile(file, content, { encoding: "utf8", flag: "wx" });
  await assertNoLinkTraversal(root, file, label);
  await assertNoHardLinkedFile(file, label);
  if ((await fs.readFile(file, "utf8")) !== content) {
    throw new Error(`${label} read-back did not match.`);
  }
}

async function atomicNoOverwriteReplace(
  root,
  {
    destination,
    stagePath,
    quarantinePath,
    displacedPath,
    expectedCurrent,
    replacement,
    label,
    transactionObserver,
    manifestId,
    afterInstall
  }
) {
  let quarantined = false;
  let installed = false;
  try {
    const destinationDirectory = path.dirname(destination);
    for (const [candidate, candidateLabel] of [
      [stagePath, `${label} stage`],
      [quarantinePath, `${label} quarantine`],
      [displacedPath, `${label} displaced recovery`]
    ]) {
      if (path.dirname(candidate) !== destinationDirectory) {
        throw new Error(
          `${candidateLabel} must be in the same directory as its destination.`
        );
      }
    }
    await transactionObserver({
      phase: "before-target-replace",
      manifestId
    });
    await assertStageIntegrity(root, stagePath, replacement, `${label} stage`);
    await assertWritableExistingFile(root, destination, label);
    await assertAbsent(quarantinePath, `${label} quarantine`);
    await assertAbsent(displacedPath, `${label} displaced recovery`);
    await transactionObserver({
      phase: "before-target-quarantine-move",
      manifestId,
      label,
      destination,
      quarantinePath,
      displacedPath
    });
    try {
      await moveFileNoOverwrite(
        root,
        destination,
        quarantinePath,
        `${label} quarantine`,
        {
          expectedContent: expectedCurrent,
          moveObserver: transactionObserver
        }
      );
      quarantined = true;
    } catch (error) {
      quarantined = error.moveCommitted === true;
      throw error;
    }

    const quarantineSnapshot = await captureFileSnapshot(
      root,
      quarantinePath,
      `${label} quarantine`
    );
    await assertNoHardLinkedFile(quarantinePath, `${label} quarantine`);
    const movedCurrent = quarantineSnapshot.bytes.toString("utf8");
    if (
      sha256(movedCurrent) !== sha256(expectedCurrent) ||
      movedCurrent !== expectedCurrent
    ) {
      throw new Error(
        `${label} changed before atomic quarantine; the moved concurrent bytes will be preserved.`
      );
    }

    await transactionObserver({
      phase: "after-target-quarantine-verified",
      manifestId
    });
    await assertStageIntegrity(root, stagePath, replacement, `${label} stage`);
    try {
      await installStageNoOverwrite(
        root,
        stagePath,
        destination,
        label,
        transactionObserver
      );
      installed = true;
    } catch (error) {
      installed = error.moveCommitted === true;
      throw error;
    }
    await transactionObserver({
      phase: "after-target-installed",
      manifestId,
      label,
      destination,
      quarantinePath,
      displacedPath
    });
    await afterInstall();
    return { quarantineSnapshot };
  } catch (error) {
    if (error.committed === true) {
      error.recoveryPaths = uniquePaths([
        ...(error.recoveryPaths ?? []),
        ...(quarantined ? [quarantinePath] : [])
      ]);
      throw error;
    }
    error.transactionRecovery = await recoverAtomicReplacement(root, {
      destination,
      quarantinePath,
      displacedPath,
      replacement,
      quarantined,
      installed,
      transactionObserver,
      manifestId,
      label
    });
    throw error;
  }
}

async function assertStageIntegrity(root, stagePath, expected, label) {
  await assertNoLinkTraversal(root, stagePath, label);
  await assertNoHardLinkedFile(stagePath, label);
  if ((await fs.readFile(stagePath, "utf8")) !== expected) {
    throw new Error(`${label} changed before no-overwrite installation.`);
  }
}

async function installStageNoOverwrite(
  root,
  stagePath,
  destination,
  label,
  moveObserver = async () => {}
) {
  await assertNoLinkTraversal(root, path.dirname(destination), `${label} parent`);
  try {
    await moveFileNoOverwrite(
      root,
      stagePath,
      destination,
      `${label} install`,
      { moveObserver }
    );
  } catch (error) {
    if (error.code === "EEXIST") {
      throw Object.assign(
        new Error(
          `${label} was recreated concurrently; no-overwrite installation refused to replace it.`,
          { cause: error }
        ),
        {
          destinationLinked: error.destinationLinked === true,
          sourceUnlinked: error.sourceUnlinked === true,
          sourceRestored: error.sourceRestored === true,
          moveCommitted: false
        }
      );
    }
    throw error;
  }
}

async function recoverAtomicReplacement(
  root,
  {
    destination,
    quarantinePath,
    displacedPath,
    replacement,
    quarantined,
    installed,
    transactionObserver,
    manifestId,
    label
  }
) {
  if (!quarantined) {
    return { status: "restored" };
  }
  if (!installed) {
    return restoreRetainedPath(
      root,
      quarantinePath,
      destination,
      transactionObserver
    );
  }

  let destinationStat;
  try {
    destinationStat = await fs.lstat(destination);
  } catch (error) {
    if (error.code !== "ENOENT") {
      return { status: "failed", error };
    }
  }
  if (!destinationStat) {
    return restoreRetainedPath(
      root,
      quarantinePath,
      destination,
      transactionObserver
    );
  }
  if (!destinationStat.isFile()) {
    return {
      status: "retained",
      recoveryPaths: [quarantinePath, destination]
    };
  }

  try {
    await assertNoLinkTraversal(
      root,
      path.dirname(destination),
      "Transaction recovery target parent"
    );
    await assertAbsent(displacedPath, "Transaction displaced recovery");
    await transactionObserver({
      phase: "before-displaced-recovery-move",
      manifestId,
      label,
      destination,
      quarantinePath,
      displacedPath
    });
    await moveFileNoOverwrite(
      root,
      destination,
      displacedPath,
      "Transaction displaced recovery",
      { moveObserver: transactionObserver }
    );
  } catch (error) {
    return { status: "failed", error };
  }

  let displacedSnapshot;
  try {
    displacedSnapshot = await captureFileSnapshot(
      root,
      displacedPath,
      "Transaction displaced recovery"
    );
  } catch (error) {
    const concurrentRecovery = await restoreRetainedPath(
      root,
      displacedPath,
      destination,
      transactionObserver
    );
    return concurrentRecovery.status === "restored"
      ? { status: "retained", recoveryPaths: [destination] }
      : concurrentRecovery;
  }
  const displaced = displacedSnapshot.bytes.toString("utf8");

  if (displaced === replacement) {
    await transactionObserver({
      phase: "before-original-recovery-restore",
      manifestId,
      label,
      destination,
      quarantinePath,
      displacedPath
    });
    const originalRecovery = await restoreRetainedPath(
      root,
      quarantinePath,
      destination,
      transactionObserver
    );
    if (originalRecovery.status === "restored") {
      const cleanup = await cleanupCommittedQuarantine(
        root,
        displacedPath,
        displacedSnapshot,
        "Transaction displaced recovery"
      );
      return cleanup.status === "retained"
        ? {
            status: "restored",
            retainedRecoveryPaths: cleanup.recoveryPaths
          }
        : { status: "restored" };
    }
    return originalRecovery;
  }

  const concurrentRecovery = await restoreRetainedPath(
    root,
    displacedPath,
    destination,
    transactionObserver
  );
  return concurrentRecovery.status === "restored"
    ? { status: "retained", recoveryPaths: [destination, quarantinePath] }
    : concurrentRecovery;
}

async function restoreRetainedPath(
  root,
  source,
  destination,
  moveObserver = async () => {}
) {
  try {
    await assertNoLinkTraversal(
      root,
      path.dirname(source),
      "Transaction recovery source parent"
    );
    await assertNoLinkTraversal(
      root,
      path.dirname(destination),
      "Transaction recovery target parent"
    );
    await moveFileNoOverwrite(
      root,
      source,
      destination,
      "Transaction retained recovery",
      { moveObserver }
    );
    return { status: "restored" };
  } catch (error) {
    if (error.code === "EEXIST") {
      return {
        status: "retained",
        recoveryPaths: uniquePaths([
          source,
          destination,
          ...(error.recoveryPaths ?? [])
        ])
      };
    }
    return { status: "failed", error };
  }
}

async function replaceReceipt(
  root,
  receiptPath,
  receiptStage,
  current,
  label,
  transactionObserver
) {
  const quarantinePath = `${receiptPath}.rollback-current.tmp`;
  const displacedPath = `${receiptPath}.rollback-displaced.tmp`;
  await assertAbsent(quarantinePath, `${label} quarantine`);
  await assertAbsent(displacedPath, `${label} displaced recovery`);
  const receiptTransaction = await atomicNoOverwriteReplace(root, {
    destination: receiptPath,
    stagePath: receiptStage,
    quarantinePath,
    displacedPath,
    expectedCurrent: current,
    replacement: await fs.readFile(receiptStage, "utf8"),
    label,
    transactionObserver,
    manifestId: "receipt-rollback",
    afterInstall: async () => {}
  });
  const cleanup = await cleanupCommittedQuarantine(
    root,
    quarantinePath,
    receiptTransaction.quarantineSnapshot,
    `${label} quarantine`
  );
  assertCommittedCleanup(
    cleanup,
    `${label} committed, but receipt-quarantine cleanup retained a safety artifact.`
  );
}

async function cleanupCommittedQuarantine(root, file, expectedSnapshot, label) {
  return removeFileIfUnchanged(root, file, expectedSnapshot, label);
}

async function assertCommittedWriteMatchesReceipt(
  root,
  paths,
  receipt,
  receiptText
) {
  for (const [file, label] of [
    [paths.targetPath, "Committed write target"],
    [paths.backupPath, "Committed write backup"],
    [paths.receiptPath, "Committed write receipt"]
  ]) {
    await assertNoLinkTraversal(root, file, label);
    await assertNoHardLinkedFile(file, label);
  }
  const [targetFirst, targetSecond, backup, persistedReceipt] =
    await Promise.all([
      fs.readFile(paths.targetPath),
      fs.readFile(paths.targetPath),
      fs.readFile(paths.backupPath),
      fs.readFile(paths.receiptPath, "utf8")
    ]);
  if (
    sha256(targetFirst) !== receipt.afterSha256 ||
    !targetSecond.equals(targetFirst) ||
    sha256(backup) !== receipt.beforeSha256 ||
    persistedReceipt !== receiptText
  ) {
    throw new Error(
      "Committed target, backup, and receipt do not identify one validated write state."
    );
  }
}

async function retainInvalidReceipt(
  root,
  paths,
  receiptText,
  transactionObserver
) {
  const recoveryPaths = [];
  try {
    await assertAbsent(paths.invalidReceiptPath, "Invalidated write receipt");
    await moveFileNoOverwrite(
      root,
      paths.receiptPath,
      paths.invalidReceiptPath,
      "Invalidated write receipt",
      {
        expectedContent: receiptText,
        moveObserver: transactionObserver
      }
    );
    recoveryPaths.push(paths.invalidReceiptPath);
  } catch (error) {
    recoveryPaths.push(...(error.recoveryPaths ?? []));
    for (const candidate of [
      paths.receiptPath,
      paths.invalidReceiptPath
    ]) {
      if (await pathExists(candidate)) {
        recoveryPaths.push(candidate);
      }
    }
  }
  return { recoveryPaths: uniquePaths(recoveryPaths) };
}

function assertCommittedCleanup(cleanup, message) {
  if (cleanup.status !== "retained") {
    return;
  }
  throw recoveryError(
    `${message} Recoverable bytes remain at ${formatPaths(
      cleanup.recoveryPaths
    )}.`,
    cleanup.error,
    {
      code: "ECOMMITTEDCLEANUP",
      recoveryPaths: cleanup.recoveryPaths,
      committed: true
    }
  );
}

async function assertNoRetainedRecoveryPath(file, label) {
  if (!(await pathExists(file))) {
    return;
  }
  throw recoveryError(
    `${label} refused because a prior recovery artifact remains at "${file}".`,
    undefined,
    {
      code: "ERECOVERYRETAINED",
      recoveryPaths: [file]
    }
  );
}

function recoveryError(
  message,
  cause,
  { code, recoveryPaths = [], committed = false } = {}
) {
  const error = new Error(message, cause ? { cause } : undefined);
  if (code) {
    error.code = code;
  }
  error.recoveryPaths = uniquePaths(recoveryPaths);
  error.committed = committed;
  return error;
}

function formatPaths(paths) {
  const values = uniquePaths(paths);
  return values.length > 0
    ? values.map((value) => `"${value}"`).join(", ")
    : "(path unavailable)";
}

function uniquePaths(paths) {
  return [...new Set(paths.filter(Boolean))];
}

async function pathExists(file) {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function cleanupStages(paths) {
  await Promise.all([
    fs.rm(paths.targetStagePath, { force: true }),
    fs.rm(paths.receiptStagePath, { force: true })
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
