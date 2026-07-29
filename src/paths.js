import fs from "node:fs/promises";
import path from "node:path";

export function assertSafeRelativePath(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty relative path.`);
  }

  const normalized = value.replaceAll("\\", "/");
  if (
    path.posix.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.includes("\0")
  ) {
    throw new Error(`${label} must stay inside the project directory.`);
  }

  return normalized.replace(/^\.\//, "");
}

export function resolveInside(root, relativePath, label = "Path") {
  const safe = assertSafeRelativePath(relativePath, label);
  const absoluteRoot = path.resolve(root);
  const resolved = path.resolve(absoluteRoot, safe);
  const relative = path.relative(absoluteRoot, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} resolves outside the project directory.`);
  }
  return resolved;
}

export async function assertNoLinkTraversal(root, destination, label = "Path") {
  const absoluteRoot = path.resolve(root);
  const absoluteDestination = path.resolve(destination);
  const relative = path.relative(absoluteRoot, absoluteDestination);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} resolves outside the project directory.`);
  }

  const filesystemRoot = path.parse(absoluteRoot).root;
  const candidates = [filesystemRoot];
  let current = filesystemRoot;
  for (const segment of path.relative(filesystemRoot, absoluteRoot).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    candidates.push(current);
  }
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    candidates.push(current);
  }

  for (const candidate of candidates) {
    let stat;
    try {
      stat = await fs.lstat(candidate);
    } catch (error) {
      if (error.code === "ENOENT") {
        break;
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(
        `${label} traverses a symbolic link, junction, or reparse point at "${candidate}".`
      );
    }

    const real = await fs.realpath(candidate);
    if (!sameFilesystemPath(real, candidate)) {
      throw new Error(
        `${label} traverses a redirected filesystem path at "${candidate}".`
      );
    }
  }
}

function sameFilesystemPath(left, right) {
  const normalize = (value) => {
    const resolved = path.resolve(value).replace(/[\\/]+$/, "");
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

export function toPosixPath(value) {
  return value.replaceAll("\\", "/");
}
