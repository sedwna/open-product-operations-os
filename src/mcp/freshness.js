import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_SOURCE_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

/**
 * Hash the code tree a running MCP process was loaded from.
 *
 * Local checkouts keep the package version constant while fixes land, so the version alone cannot
 * tell an operator that the host retained an older process. Relative names are included in the
 * digest and links are hashed as links rather than followed; the result is stable and never exposes
 * an absolute path through the MCP surface.
 */
export async function fingerprintSourceTree(sourceRoot = DEFAULT_SOURCE_ROOT) {
  const root = path.resolve(sourceRoot);
  const hash = crypto.createHash("sha256");

  async function walk(directory) {
    const entries = (await fs.readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        hash.update(`directory\0${relative}\0`);
        await walk(absolute);
      } else if (entry.isSymbolicLink()) {
        hash.update(`link\0${relative}\0${await fs.readlink(absolute)}\0`);
      } else if (entry.isFile()) {
        hash.update(`file\0${relative}\0`);
        hash.update(await fs.readFile(absolute));
        hash.update("\0");
      }
    }
  }

  await walk(root);
  return hash.digest("hex");
}
export async function captureRuntimeFreshness({
  sourceRoot = DEFAULT_SOURCE_ROOT,
  version = "0.0.0",
  now = () => new Date()
} = {}) {
  try {
    return {
      sourceRoot: path.resolve(sourceRoot),
      version,
      startedAt: now().toISOString(),
      startupFingerprint: await fingerprintSourceTree(sourceRoot),
      captureError: null
    };
  } catch {
    return {
      sourceRoot: path.resolve(sourceRoot),
      version,
      startedAt: now().toISOString(),
      startupFingerprint: null,
      captureError: "SOURCE_FINGERPRINT_UNAVAILABLE"
    };
  }
}

export async function inspectRuntimeFreshness(captured) {
  if (!captured?.sourceRoot || !captured.startupFingerprint) {
    return {
      status: "unknown",
      version: captured?.version ?? "0.0.0",
      startedAt: captured?.startedAt ?? null,
      startupFingerprint: captured?.startupFingerprint ?? null,
      currentFingerprint: null,
      restartRequired: false,
      error: captured?.captureError ?? "SOURCE_FINGERPRINT_UNAVAILABLE"
    };
  }

  try {
    const currentFingerprint = await fingerprintSourceTree(captured.sourceRoot);
    const restartRequired = currentFingerprint !== captured.startupFingerprint;
    return {
      status: restartRequired ? "restart_required" : "fresh",
      version: captured.version,
      startedAt: captured.startedAt,
      startupFingerprint: captured.startupFingerprint,
      currentFingerprint,
      restartRequired,
      error: null
    };
  } catch {
    return {
      status: "unknown",
      version: captured.version,
      startedAt: captured.startedAt,
      startupFingerprint: captured.startupFingerprint,
      currentFingerprint: null,
      restartRequired: false,
      error: "SOURCE_FINGERPRINT_UNAVAILABLE"
    };
  }
}
