import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  captureFileSnapshot,
  moveFileNoOverwrite,
  removeFileIfUnchanged
} from "./atomic-move.js";
import { parseCsv, stringifyCsv } from "./csv.js";
import { FEEDBACK_FILE } from "./runtime/feedback-loop.js";
import {
  assertNoHardLinkedFile,
  assertNoLinkTraversal,
  resolveInside,
  toPosixPath
} from "./paths.js";
import { assertControlPlaneLeaseHeld } from "./runtime/control-plane-lease.js";

export async function planWrites(
  root,
  files,
  { force = false, replaceOperational = false } = {}
) {
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
    } else if (
      existing !== undefined &&
      isOperationalCsv(relativePath) &&
      replaceOperational
    ) {
      operations.push({
        action: "replace",
        relativePath,
        destination,
        content,
        expectedCurrent: existing
      });
    } else if (existing !== undefined && relativePath === "adapters/providers.json") {
      const merged = mergeProviderCatalog(existing, content, relativePath);
      operations.push({
        action: merged === existing ? "preserved" : "merge",
        relativePath,
        destination,
        content: merged,
        expectedCurrent: existing
      });
    } else if (existing !== undefined && relativePath === FEEDBACK_FILE) {
      // This is a product record, not refreshable scaffold. `init` creates its empty shell, then
      // product notes and the owner's own words accumulate in it for the workspace's lifetime.
      // A force refresh or migration must therefore leave its exact bytes alone.
      operations.push({
        action: "preserved",
        relativePath,
        destination,
        content: existing,
        expectedCurrent: existing
      });
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
  // Guarding the single apply path covers every surface at once. A caller writing without the
  // control-plane lease — init, generation — is unaffected; a caller that took one and has since
  // lost it is stopped here rather than racing the surface that now holds it.
  await assertControlPlaneLeaseHeld(root);
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
    // A destination such as `.gitignore` must produce one hidden staging filename, not a `..` path
    // segment that the traversal guard correctly rejects. Strip only the destination's leading
    // dots; the generated transaction file remains hidden because we add one below.
    const transactionBase = path.basename(operation.destination).replace(/^\.+/, "") || "generated";
    const stagePath = path.join(
      path.dirname(operation.destination),
      `.${transactionBase}.${crypto.randomUUID()}.tmp`
    );
    const quarantinePath = path.join(
      path.dirname(operation.destination),
      `.${transactionBase}.${crypto.randomUUID()}.before.tmp`
    );
    const displacedPath = path.join(
      path.dirname(operation.destination),
      `.${transactionBase}.${crypto.randomUUID()}.displaced.tmp`
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
        await installStageNoOverwrite(
          root,
          stagePath,
          operation.destination,
          label,
          transactionObserver
        );
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
  let quarantineSnapshot;
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
    quarantineSnapshot = await captureFileSnapshot(
      root,
      quarantinePath,
      `${label} quarantine`
    );
    await assertNoHardLinkedFile(quarantinePath, `${label} quarantine`);
    if (quarantineSnapshot.bytes.toString("utf8") !== expectedCurrent) {
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
      relativePath,
      destination,
      stagePath,
      quarantinePath,
      displacedPath
    });
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
    if ((recovery.retainedRecoveryPaths?.length ?? 0) > 0) {
      throw recoveryError(
        `${error.message} The original destination was restored, but concurrent recovery bytes were retained at ${formatPaths(
          recovery.retainedRecoveryPaths
        )}.`,
        error,
        {
          code: "ERECOVERYRETAINED",
          recoveryPaths: recovery.retainedRecoveryPaths
        }
      );
    }
    if (recovery.status === "retained") {
      throw recoveryError(
        `${error.message} Recoverable prior bytes were retained at "${quarantinePath}" without overwriting the current destination.`,
        error,
        {
          code: "ERECOVERYRETAINED",
          recoveryPaths: uniquePaths([
            quarantinePath,
            ...(recovery.recoveryPaths ?? [])
          ])
        }
      );
    }
    if (recovery.status === "failed") {
      throw new AggregateError(
        [error, recovery.error],
        `${label} replacement failed and automatic recovery also failed; recoverable artifacts were retained. ${error.message}`
      );
    }
    throw error;
  }
  const cleanup = await cleanupCommittedQuarantine(
    root,
    quarantinePath,
    quarantineSnapshot,
    `${label} quarantine`
  );
  if (cleanup.status === "retained") {
    throw recoveryError(
      `${label} replacement committed, but quarantine cleanup retained recoverable bytes at ${formatPaths(
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
      const concurrent = new Error(
        `${label} was created or recreated concurrently; no-overwrite installation refused to replace it.`,
        { cause: error }
      );
      concurrent.destinationLinked = error.destinationLinked === true;
      concurrent.sourceUnlinked = error.sourceUnlinked === true;
      concurrent.sourceRestored = error.sourceRestored === true;
      concurrent.moveCommitted = false;
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
    return restoreRetainedPath(
      root,
      quarantinePath,
      destination,
      transactionObserver
    );
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
      "Generated-file displaced recovery",
      { moveObserver: transactionObserver }
    );
  } catch (error) {
    if (error.code === "ENOENT") {
      return restoreRetainedPath(
        root,
        quarantinePath,
        destination,
        transactionObserver
      );
    }
    return { status: "failed", error };
  }

  let displacedSnapshot;
  try {
    displacedSnapshot = await captureFileSnapshot(
      root,
      displacedPath,
      "Generated-file displaced recovery"
    );
  } catch (error) {
    const restored = await restoreRetainedPath(
      root,
      displacedPath,
      destination,
      transactionObserver
    );
    return restored.status === "restored"
      ? { status: "retained", recoveryPaths: [destination] }
      : restored;
  }
  const displaced = displacedSnapshot.bytes.toString("utf8");

  if (displaced === replacement) {
    const restored = await restoreRetainedPath(
      root,
      quarantinePath,
      destination,
      transactionObserver
    );
    if (restored.status === "restored") {
      const cleanup = await cleanupCommittedQuarantine(
        root,
        displacedPath,
        displacedSnapshot,
        "Generated-file displaced recovery"
      );
      return cleanup.status === "retained"
        ? {
            status: "restored",
            retainedRecoveryPaths: cleanup.recoveryPaths
          }
        : restored;
    }
    return restored;
  }

  const concurrent = await restoreRetainedPath(
    root,
    displacedPath,
    destination,
    transactionObserver
  );
  return concurrent.status === "restored"
    ? {
        status: "retained",
        recoveryPaths: [destination, quarantinePath]
      }
    : concurrent;
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
      "Generated-file retained recovery",
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

async function cleanupCommittedQuarantine(root, file, expectedSnapshot, label) {
  return removeFileIfUnchanged(root, file, expectedSnapshot, label);
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

function mergeProviderCatalog(existing, desired, relativePath) {
  let current;
  let scaffold;
  try {
    current = JSON.parse(existing);
    scaffold = JSON.parse(desired);
  } catch (error) {
    throw new Error(`Cannot safely preserve provider configuration in "${relativePath}": ${error.message}`);
  }
  if (!current?.providers || typeof current.providers !== "object" || Array.isArray(current.providers)) {
    throw new Error(`Cannot safely preserve provider configuration in "${relativePath}" without a providers object.`);
  }
  const merged = {
    ...scaffold,
    ...current,
    schemaVersion: scaffold.schemaVersion,
    defaultDryRun: true,
    providers: Object.fromEntries(
      Object.entries({ ...scaffold.providers, ...current.providers }).map(([name, provider]) => [
        name,
        { ...(scaffold.providers[name] ?? {}), ...provider }
      ])
    )
  };
  const content = `${JSON.stringify(merged, null, 2)}\n`;
  return content === existing ? existing : content;
}
