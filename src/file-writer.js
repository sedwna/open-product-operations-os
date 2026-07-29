import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
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
        content: merged
      });
    } else {
      operations.push({
        action: existing === undefined ? "create" : "replace",
        relativePath,
        destination,
        content
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
      await assertNoLinkTraversal(root, stagePath, `${label} stage`);
      await assertNoHardLinkedFile(stagePath, `${label} stage`);
      if ((await fs.readFile(stagePath, "utf8")) !== operation.content) {
        throw new Error(`${label} stage changed before atomic replacement.`);
      }
      await fs.rename(stagePath, operation.destination);
    } finally {
      await fs.rm(stagePath, { force: true });
    }
  }
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
