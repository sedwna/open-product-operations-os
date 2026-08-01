import fs from "node:fs/promises";
import path from "node:path";
import { parseCsv, rowsToObjects } from "../csv.js";
import { applyWrites, planWrites } from "../file-writer.js";
import { assertNoLinkTraversal, resolveInside } from "../paths.js";

export async function readJsonOptional(root, relativePath, fallback) {
  const file = resolveInside(root, relativePath, `Runtime file "${relativePath}"`);
  await assertNoLinkTraversal(root, file, `Runtime file "${relativePath}"`);
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return structuredClone(fallback);
    }
    throw error;
  }
}

export async function writeJson(root, relativePath, value, { dryRun = true } = {}) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  const operations = await planWrites(
    path.resolve(root),
    new Map([[relativePath, content]]),
    { force: true }
  );
  if (!dryRun) {
    await applyWrites(path.resolve(root), operations);
  }
  return operations;
}

export async function readCsvRecords(root, relativePath) {
  const file = resolveInside(root, relativePath, `CSV file "${relativePath}"`);
  await assertNoLinkTraversal(root, file, `CSV file "${relativePath}"`);
  return rowsToObjects(parseCsv(await fs.readFile(file, "utf8")));
}

export function splitReferences(value) {
  return String(value ?? "")
    .split(/[|;]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function utcTimestamp(now = new Date()) {
  return now.toISOString();
}

export function compactDate(now = new Date()) {
  return now.toISOString().slice(0, 10).replaceAll("-", "");
}
