import fs from "node:fs/promises";
import path from "node:path";
import { resolveInside, toPosixPath } from "./paths.js";

export async function planWrites(root, files, { force = false } = {}) {
  const operations = [];
  const conflicts = [];

  for (const [relativePath, content] of files) {
    const destination = resolveInside(root, relativePath, `Generated file "${relativePath}"`);
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
      )}. Re-run with --force to replace them.`
    );
  }

  return operations;
}

export async function applyWrites(operations) {
  for (const operation of operations) {
    if (operation.action === "unchanged") {
      continue;
    }
    await fs.mkdir(path.dirname(operation.destination), { recursive: true });
    await fs.writeFile(operation.destination, operation.content, "utf8");
  }
}

export function summarizeWrites(root, operations, dryRun) {
  const changed = operations.filter((operation) => operation.action !== "unchanged");
  const unchanged = operations.length - changed.length;
  const verb = dryRun ? "would write" : "wrote";
  const lines = [
    `${dryRun ? "Dry run: " : ""}${verb} ${changed.length} file(s); ${unchanged} unchanged.`
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
