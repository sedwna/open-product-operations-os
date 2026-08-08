import fs from "node:fs/promises";
import path from "node:path";
import { parseCsv, rowsToObjects } from "../csv.js";
import { applyWrites, planWrites } from "../file-writer.js";
import { assertNoLinkTraversal, resolveInside } from "../paths.js";

/**
 * Read a JSON file a person supplied, by absolute or relative path.
 *
 * The byte-order mark matters here. PowerShell's `Set-Content -Encoding utf8` writes one, so the
 * ordinary way a Windows user creates an intake or answers file produces a file `JSON.parse`
 * rejects outright — with a parse error about an invisible character, at the first command a
 * newcomer runs. The mark is legal UTF-8 and carries no meaning at the start of a document, so it
 * is dropped rather than reported.
 */
export async function readSuppliedJson(file, label) {
  let text;
  try {
    text = await fs.readFile(path.resolve(file), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`${label} not found: ${file}`);
    throw error;
  }
  try {
    return JSON.parse(text.replace(/^﻿/, ""));
  } catch (error) {
    throw new Error(`${label} is not valid JSON (${file}): ${error.message}`);
  }
}

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
