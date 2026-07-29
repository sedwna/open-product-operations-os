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

export function toPosixPath(value) {
  return value.replaceAll("\\", "/");
}
