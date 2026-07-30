import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { moveFileNoOverwrite } from "./atomic-move.js";
import { parseCsv, stringifyCsv } from "./csv.js";
import {
  assertNoHardLinkedFile,
  assertNoLinkTraversal,
  resolveInside,
  toPosixPath
} from "./paths.js";

export async function planWrites(root, files, { force = false } = {}) {
  const operations = [];
  const conflicts = [];

  for (const [relativePath, content] of files) {
    const destination = resolveInside(root, relativePath, `Generated file "${relativePath}"`);
    await assertNoLinkTraversal(root, destination, `Generated file "${relativePath}"`);
    await assertNoHardLinkedFile(destination, `Generated file "${relativePath}"`);
    let existing;
    try {
      existing = await fs.readFile(destination, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }

    if (existing === content) {
      operations.push({ action: "unchanged", relativePath, destination, content });
    } else if (existing !== undefined && !force) {
      conflicts.push(relativePath);
    } else if (existing !== undefined && isOperationalCsv(relativePath)) {
      const merged = mergeCsvScaffold(existing, content, relativePath);
      operations.push({
        action: merged === existing ? "preserved" : "merge",
        relativePath,
        destination,
        content: merged,
        expectedCurrent: existing
      });
    } else {
      operations.push({
        action: existing === undefined ? "create" : "replace",
        relativePath,
        destination,
        content,
        expectedCurrent: existing
      });
    }
  }

  if (conflicts.length > 0) {
    throw new Error(
      `Refusing to overwrite existing generated files: ${conflicts.join(
        ", "
      )}. Re-run with --force to refresh replaceable scaffold; operational CSV rows are preserved.`
    );
  }

  return operations;
}

export async function applyWrites(
  root,
  operations,
  { transactionObserver = async () => {} } = {}
) {
  if (typeof transactionObserver !== "function") {
    throw new Error("transactionObserver must be a function when provided.");
  }
  for (const operation of operations) {
    if (["unchanged", "preserved"].includes(operation.action)) {
      continue;
    }
    await assertNoLinkTraversal(
      root,
      operation.destination,
      `Generated file "${operation.relativePath}"`
    );
    await assertNoHardLinkedFile(
      operation.destination,
      `Generated file "${operation.relativePath}"`
    );
    await fs.mkdir(path.dirname(operation.destination), { recursive: true });
    await assertNoLinkTraversal(
      root,
      operation.destination,
      `Generated file "${operation.relativePath}"`
    );
    const label = `Generated file "${operation.relativePath}"`;
    await assertNoHardLinkedFile(operation.destination, label);
    const stagePath = path.join(
      path.dirname(operation.destination),
      `.${path.basename(operation.destination)}.${crypto.randomUUID()}.tmp`
    );
    const quarantinePath = path.join(
      path.dirname(operation.destination),
      `.${path.basename(operation.destination)}.${crypto.randomUUID()}.before.tmp`
    );
    const displacedPath = path.join(
      path.dirname(operation.destination),
      `.${path.basename(operation.destination)}.${crypto.randomUUID()}.displaced.tmp`
    );
    try {
      await assertNoLinkTraversal(root, stagePath, `${label} stage`);
      await fs.writeFile(stagePath, operation.content, {
        encoding: "utf8",
        flag: "wx"
      });
      if ((await fs.readFile(stagePath, "utf8")) !== operation.content) {
        throw new Error(`${label} stage read-back did not match.`);
      }
      await assertNoLinkTraversal(root, operation.destination, label);
      await assertNoHardLinkedFile(operation.destination, label);
      await transactionObserver({
        phase: "before-atomic-replace",
        relativePath: operation.relativePath,
        destination: operation.destination,
        stagePath
      });
      await assertNoLinkTraversal(root, operation.destination, label);
      await assertStageIntegrity(root, stagePath, operation.content, `${label} stage`);
      if (operation.action === "create") {
        await installStageNoOverwrite(root, stagePath, operation.destination, label);
      } else {
        await replaceWithNoOverwrite(root, {
          destination: operation.destination,
          stagePath,
          quarantinePath,
          displacedPath,
          expectedCurrent: operation.expectedCurrent,
          replacement: operation.content,
          label,
          transactionObserver,
          relativePath: operation.relativePath
        });
      }
    } finally {
      await fs.rm(stagePath, { force: true });
    }
  }
}

async function replaceWithNoOverwrite(
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
    relativePath
  }
) {
  let quarantined = false;
  let installed = false;
  try {
    await assertNoLinkTraversal(root, quarantinePath, `${label} quarantine`);
    await assertNoLinkTraversal(root, displacedPath, `${label} displaced recovery`);
    await assertAbsent(quarantinePath, `${label} quarantine`);
    await assertAbsent(displacedPath, `${label} displaced recovery`);
    await assertNoHardLinkedFile(destination, label);
    const current = await fs.readFile(destination, "utf8");
    if (current !== expectedCurrent) {
      throw new Error(`${label} changed before atomic quarantine.`);
    }

    await transactionObserver({
      phase: "before-target-quarantine-move",
      relativePath,
      destination,
      stagePath,
      quarantinePath,
      displacedPath
    });
    try {
      await moveFileNoOverwrite(
        root,
        destination,
        quarantinePath,
        `${label} quarantine`,
        { expectedContent: expectedCurrent }
      );
      quarantined = true;
    } catch (error) {
      quarantined = error.sourceUnlinked === true;
      throw error;
    }
    await assertNoLinkTraversal(root, quarantinePath, `${label} quarantine`);
    await assertNoHardLinkedFile(quarantinePath, `${label} quarantine`);
    if ((await fs.readFile(quarantinePath, "utf8")) !== expectedCurrent) {
      throw new Error(
        `${label} changed during atomic quarantine; the moved bytes will be preserved.`
      );
    }

    await transactionObserver({
      phase: "after-target-quarantine-verified",
      relativePath,
      destination,
      stagePath,
      quarantinePath
    });
    await assertStageIntegrity(root, stagePath, replacement, `${label} stage`);
    try {
      await installStageNoOverwrite(root, stagePath, destination, label);
      installed = true;
    } catch (error) {
      installed = error.sourceUnlinked === true;
      throw error;
    }
    await transactionObserver({
      phase: "after-target-installed",
      relativePath,
      destination,
      stagePath,
      quarantinePath,
      displacedPath
    });
    await cleanupCommittedQuarantine(
      root,
      quarantinePath,
      expectedCurrent,
      `${label} quarantine`
    );
  } catch (error) {
    if (!quarantined) {
      throw error;
    }
    const recovery = await recoverReplacement(root, {
      destination,
      quarantinePath,
      displacedPath,
      replacement,
      installed,
      transactionObserver,
      relativePath
    });
    if (recovery.status === "retained") {
      throw new Error(
        `${error.message} Recoverable prior bytes were retained at "${quarantinePath}" without overwriting the current destination.`,
        { cause: error }
      );
    }
    if (recovery.status === "failed") {
      throw new AggregateError(
        [error, recovery.error],
        `${label} replacement failed and automatic recovery also failed; recoverable artifacts were retained.`
      );
    }
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

async function installStageNoOverwrite(root, stagePath, destination, label) {
  await assertNoLinkTraversal(root, path.dirname(destination), `${label} parent`);
  try {
    await moveFileNoOverwrite(root, stagePath, destination, `${label} install`);
  } catch (error) {
    if (error.code === "EEXIST") {
      const concurrent = new Error(
        `${label} was created or recreated concurrently; no-overwrite installation refused to replace it.`,
        { cause: error }
      );
      concurrent.destinationLinked = error.destinationLinked === true;
      concurrent.sourceUnlinked = error.sourceUnlinked === true;
      throw concurrent;
    }
    throw error;
  }
}

async function recoverReplacement(
  root,
  {
    destination,
    quarantinePath,
    displacedPath,
    replacement,
    installed,
    transactionObserver,
    relativePath
  }
) {
  if (!installed) {
    return restoreRetainedPath(root, quarantinePath, destination);
  }

  try {
    await assertNoLinkTraversal(
      root,
      path.dirname(destination),
      "Generated-file recovery target parent"
    );
    await assertAbsent(displacedPath, "Generated-file displaced recovery");
    await transactionObserver({
      phase: "before-displaced-recovery-move",
      relativePath,
      destination,
      quarantinePath,
      displacedPath
    });
    await moveFileNoOverwrite(
      root,
      destination,
      displacedPath,
      "Generated-file displaced recovery"
    );
  } catch (error) {
    if (error.code === "ENOENT") {
      return restoreRetainedPath(root, quarantinePath, destination);
    }
    return { status: "failed", error };
  }

  let displaced;
  try {
    displaced = await fs.readFile(displacedPath, "utf8");
  } catch (error) {
    const restored = await restoreRetainedPath(root, displacedPath, destination);
    return restored.status === "restored" ? { status: "retained" } : restored;
  }

  if (displaced === replacement) {
    const restored = await restoreRetainedPath(root, quarantinePath, destination);
    if (restored.status === "restored") {
      await fs.rm(displacedPath, { force: true });
      return restored;
    }
    return restored;
  }

  const concurrent = await restoreRetainedPath(root, displacedPath, destination);
  return concurrent.status === "restored" ? { status: "retained" } : concurrent;
}

async function restoreRetainedPath(root, source, destination) {
  try {
    await assertNoLinkTraversal(
      root,
      path.dirname(source),
      "Generated-file recovery source parent"
    );
    await assertNoLinkTraversal(
      root,
      path.dirname(destination),
      "Generated-file recovery target parent"
    );
    await moveFileNoOverwrite(
      root,
      source,
      destination,
      "Generated-file retained recovery"
    );
    return { status: "restored" };
  } catch (error) {
    if (error.code === "EEXIST") {
      return { status: "retained" };
    }
    return { status: "failed", error };
  }
}

async function cleanupCommittedQuarantine(root, file, expected, label) {
  try {
    await assertNoLinkTraversal(root, file, label);
    await assertNoHardLinkedFile(file, label);
    if ((await fs.readFile(file, "utf8")) !== expected) {
      return false;
    }
    await fs.rm(file);
    return true;
  } catch (error) {
    return error.code === "ENOENT";
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
  throw new Error(`${label} already exists.`);
}

export function summarizeWrites(root, operations, dryRun) {
  const changed = operations.filter((operation) =>
    ["create", "replace", "merge"].includes(operation.action)
  );
  const preserved = operations.filter(
    (operation) => operation.action === "preserved"
  ).length;
  const unchanged = operations.filter(
    (operation) => operation.action === "unchanged"
  ).length;
  const verb = dryRun ? "would write" : "wrote";
  const lines = [
    `${dryRun ? "Dry run: " : ""}${verb} ${changed.length} file(s); ${preserved} operational file(s) preserved; ${unchanged} unchanged.`
  ];
  for (const operation of changed) {
    lines.push(
      `  ${operation.action}: ${toPosixPath(
        path.relative(path.resolve(root), operation.destination)
      )}`
    );
  }
  return lines;
}

function isOperationalCsv(relativePath) {
  return (
    relativePath === "taskboard/tasks.csv" ||
    (relativePath.startsWith("workbook/") && relativePath.endsWith(".csv"))
  );
}

function mergeCsvScaffold(existing, desired, relativePath) {
  let existingRows;
  let desiredRows;
  try {
    existingRows = parseCsv(existing);
    desiredRows = parseCsv(desired);
  } catch (error) {
    throw new Error(
      `Cannot safely preserve operational rows in "${relativePath}": ${error.message}`
    );
  }

  const existingHeaders = existingRows[0] ?? [];
  const desiredHeaders = desiredRows[0] ?? [];
  if (existingHeaders.length === 0 || desiredHeaders.length === 0) {
    throw new Error(
      `Cannot safely preserve operational rows in "${relativePath}" without CSV headers.`
    );
  }

  const mergedHeaders = [
    ...existingHeaders,
    ...desiredHeaders.filter((header) => !existingHeaders.includes(header))
  ];
  if (
    mergedHeaders.length === existingHeaders.length &&
    mergedHeaders.every((header, index) => header === existingHeaders[index])
  ) {
    return existing;
  }

  const existingIndexes = new Map(
    existingHeaders.map((header, index) => [header, index])
  );
  const mergedRows = [
    mergedHeaders,
    ...existingRows.slice(1).map((row) =>
      mergedHeaders.map((header) => {
        const index = existingIndexes.get(header);
        return index === undefined ? "" : row[index] ?? "";
      })
    )
  ];
  return stringifyCsv(mergedRows);
}
