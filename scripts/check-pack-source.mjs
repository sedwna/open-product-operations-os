import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");
const packStateName = "product-ops-pack-source-state.json";
const archivePackStateName = ".product-ops-pack-source-state.json";

export function gitBlobObjectId(bytes, algorithm = "sha1") {
  const content = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return crypto
    .createHash(algorithm)
    .update(`blob ${content.length}\0`)
    .update(content)
    .digest("hex");
}

export async function findNonCanonicalTrackedFiles(root) {
  const worktree = runGit(root, ["rev-parse", "--is-inside-work-tree"], {
    allowFailure: true
  });
  if (worktree.status !== 0 || worktree.stdout.trim() !== "true") {
    return { gitWorktree: false, files: [] };
  }

  const algorithm = runGit(root, ["rev-parse", "--show-object-format"]).stdout.trim();
  if (!["sha1", "sha256"].includes(algorithm)) {
    throw new Error(`Unsupported Git object format: ${algorithm}`);
  }
  const staged = runGit(root, ["ls-files", "--stage", "-z"], {
    encoding: null
  }).stdout;
  const files = [];
  const conversions = [];
  for (const record of staged.toString("utf8").split("\0")) {
    if (!record) {
      continue;
    }
    const match = /^(\d+) ([a-f0-9]+) (\d)\t(.+)$/.exec(record);
    if (!match) {
      throw new Error(`Cannot parse Git index entry: ${record}`);
    }
    const [, mode, expectedObjectId, stage, relativePath] = match;
    if (stage !== "0" || mode === "160000") {
      continue;
    }
    let bytes;
    try {
      bytes = await readTrackedBytes(root, relativePath, mode);
    } catch (error) {
      files.push({
        path: relativePath.replaceAll("\\", "/"),
        expectedObjectId,
        actualObjectId: null,
        reason: error.code ?? error.message
      });
      continue;
    }
    const actualObjectId = gitBlobObjectId(bytes, algorithm);
    if (actualObjectId === expectedObjectId) {
      continue;
    }

    const canonicalBytes = runGit(
      root,
      ["cat-file", "blob", expectedObjectId],
      { encoding: null }
    ).stdout;
    const checkout = runGit(
      root,
      [
        "cat-file",
        "--filters",
        `--path=${relativePath}`,
        expectedObjectId
      ],
      { allowFailure: true, encoding: null }
    );
    const expectedCheckoutBytes =
      checkout.status === 0 ? checkout.stdout : null;
    const pathLabel = relativePath.replaceAll("\\", "/");
    if (
      mode !== "120000" &&
      expectedCheckoutBytes &&
      bytes.equals(expectedCheckoutBytes) &&
      isEolOnlyConversion(bytes, canonicalBytes)
    ) {
      conversions.push({
        path: pathLabel,
        mode,
        expectedObjectId,
        actualObjectId,
        containsCrlf: bytes.includes(Buffer.from("\r\n"))
      });
      continue;
    }

    files.push({
      path: pathLabel,
      expectedObjectId,
      actualObjectId,
      expectedCheckoutObjectId: expectedCheckoutBytes
        ? gitBlobObjectId(expectedCheckoutBytes, algorithm)
        : null,
      containsCrlf: bytes.includes(Buffer.from("\r\n")),
      reason:
        checkout.status === 0
          ? "working bytes do not match the current Git checkout filter"
          : checkout.stderr?.toString().trim() ||
            "cannot calculate current Git checkout bytes"
    });
  }
  return {
    gitWorktree: true,
    objectFormat: algorithm,
    files,
    conversions
  };
}

export async function prepareCanonicalPackSource(root) {
  const result = await findNonCanonicalTrackedFiles(root);
  if (!result.gitWorktree) {
    return prepareCanonicalArchiveSource(root);
  }
  assertNoPackDrift(result);
  const statePath = packStatePath(root);
  if ((await existingPackStatePaths(root, true)).length > 0) {
    throw new Error(
      `A prior pack normalization state remains at ${statePath}. ` +
        "Refusing concurrent or ambiguous packing; run " +
        "`node scripts/check-pack-source.mjs restore` first."
    );
  }
  if (result.conversions.length === 0) {
    return result;
  }

  const state = {
    version: 1,
    sourceKind: "git",
    objectFormat: result.objectFormat,
    files: []
  };
  for (const conversion of result.conversions) {
    const originalBytes = await fs.readFile(
      path.join(root, conversion.path)
    );
    if (
      gitBlobObjectId(originalBytes, result.objectFormat) !==
      conversion.actualObjectId
    ) {
      throw new Error(
        `Pack source changed during validation: ${conversion.path}`
      );
    }
    state.files.push({
      ...conversion,
      originalBase64: originalBytes.toString("base64")
    });
  }

  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const stateHandle = await fs.open(statePath, "wx");
  try {
    await stateHandle.writeFile(`${JSON.stringify(state, null, 2)}\n`);
  } finally {
    await stateHandle.close();
  }

  try {
    for (const entry of state.files) {
      const canonicalBytes = runGit(
        root,
        ["cat-file", "blob", entry.expectedObjectId],
        { encoding: null }
      ).stdout;
      await fs.writeFile(path.join(root, entry.path), canonicalBytes);
    }
  } catch (error) {
    try {
      await restorePackSource(root);
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        `Pack normalization failed and recovery remains at ${statePath}`
      );
    }
    throw error;
  }
  return result;
}

export async function restorePackSource(root) {
  const worktree = runGit(root, ["rev-parse", "--is-inside-work-tree"], {
    allowFailure: true
  });
  const gitWorktree =
    worktree.status === 0 && worktree.stdout.trim() === "true";
  const statePaths = await existingPackStatePaths(root, gitWorktree);
  if (statePaths.length === 0) {
    return;
  }
  if (statePaths.length > 1) {
    throw new Error(
      `Multiple pack recovery states remain; refusing ambiguous restore:\n${statePaths
        .map((entry) => `- ${entry}`)
        .join("\n")}`
    );
  }
  const [statePath] = statePaths;
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  if (state.sourceKind === "archive") {
    await restoreCanonicalArchiveSource(root, statePath, state);
    return;
  }
  if (
    !gitWorktree ||
    state.version !== 1 ||
    ![undefined, "git"].includes(state.sourceKind) ||
    !["sha1", "sha256"].includes(state.objectFormat) ||
    !Array.isArray(state.files)
  ) {
    throw new Error(`Invalid pack recovery state: ${statePath}`);
  }

  const unsafe = [];
  for (const entry of state.files) {
    const file = path.join(root, entry.path);
    const originalBytes = Buffer.from(entry.originalBase64, "base64");
    const canonicalBytes = runGit(
      root,
      ["cat-file", "blob", entry.expectedObjectId],
      { encoding: null }
    ).stdout;
    const checkout = runGit(
      root,
      [
        "cat-file",
        "--filters",
        `--path=${entry.path}`,
        entry.expectedObjectId
      ],
      { allowFailure: true, encoding: null }
    );
    const originalIsValid =
      gitBlobObjectId(originalBytes, state.objectFormat) ===
        entry.actualObjectId &&
      checkout.status === 0 &&
      originalBytes.equals(checkout.stdout) &&
      isEolOnlyConversion(originalBytes, canonicalBytes);
    if (!originalIsValid) {
      unsafe.push(`${entry.path}: saved checkout bytes are no longer valid`);
      continue;
    }

    const currentBytes = await fs.readFile(file);
    if (currentBytes.equals(originalBytes)) {
      continue;
    }
    if (!currentBytes.equals(canonicalBytes)) {
      unsafe.push(`${entry.path}: changed while canonical packing was active`);
      continue;
    }
    await fs.writeFile(file, originalBytes);
  }

  if (unsafe.length > 0) {
    throw new Error(
      `Pack source recovery is fail-closed; preserved ${statePath}:\n` +
        unsafe.map((entry) => `- ${entry}`).join("\n")
    );
  }
  await fs.unlink(statePath);
}

if (path.resolve(process.argv[1] ?? "") === scriptPath) {
  const action = process.argv[2] ?? "check";
  if (action === "prepare") {
    await prepareCanonicalPackSource(repositoryRoot);
  } else if (action === "restore") {
    await restorePackSource(repositoryRoot);
  } else if (action === "check") {
    const result = await findNonCanonicalTrackedFiles(repositoryRoot);
    if (result.gitWorktree) {
      assertNoPackDrift(result);
    }
  } else {
    throw new Error(`Unknown pack-source action: ${action}`);
  }
}

function assertNoPackDrift(result) {
  if (result.files.length === 0) {
    return;
  }
  throw new Error(
    `Pack source does not match the Git blob or its current checkout filter:\n${result.files
      .map(
        (entry) =>
          `- ${entry.path}: expected blob ${entry.expectedObjectId}, actual ${
            entry.actualObjectId ?? entry.reason
          }, expected checkout ${
            entry.expectedCheckoutObjectId ?? "unavailable"
          }${entry.containsCrlf ? " (contains CRLF)" : ""}`
      )
      .join(
        "\n"
      )}\nRefusing to pack tampered bytes or stale attributes-transition drift.`
  );
}

function packStatePath(root) {
  const gitPath = runGit(root, [
    "rev-parse",
    "--git-path",
    packStateName
  ]).stdout.trim();
  return path.isAbsolute(gitPath) ? gitPath : path.resolve(root, gitPath);
}

async function prepareCanonicalArchiveSource(root) {
  const statePath = archivePackStatePath(root);
  if ((await existingPackStatePaths(root, false)).length > 0) {
    throw new Error(
      `A prior pack normalization state remains at ${statePath}. ` +
        "Refusing concurrent or ambiguous archive packing; run " +
        "`node scripts/check-pack-source.mjs restore` first."
    );
  }
  const payloadFiles = await collectArchivePayloadFiles(root);
  const conversions = [];
  for (const relativePath of payloadFiles) {
    const bytes = await fs.readFile(path.join(root, relativePath));
    if (!bytes.includes(Buffer.from("\r\n"))) {
      continue;
    }
    assertCanonicalizableArchiveText(bytes, relativePath);
    const canonicalBytes = normalizeCrlf(bytes);
    conversions.push({
      path: relativePath,
      actualSha256: sha256(bytes),
      canonicalSha256: sha256(canonicalBytes),
      originalBase64: bytes.toString("base64")
    });
  }
  if (conversions.length === 0) {
    return {
      gitWorktree: false,
      files: [],
      conversions: []
    };
  }

  const state = {
    version: 1,
    sourceKind: "archive",
    files: conversions
  };
  const stateHandle = await fs.open(statePath, "wx");
  try {
    await stateHandle.writeFile(`${JSON.stringify(state, null, 2)}\n`);
  } finally {
    await stateHandle.close();
  }

  try {
    for (const entry of state.files) {
      const file = resolveStateEntry(root, entry.path);
      const currentBytes = await fs.readFile(file);
      const currentSha256 = sha256(currentBytes);
      if (currentSha256 !== entry.actualSha256) {
        throw new Error(
          `Archive pack source changed during validation: ${entry.path}; ` +
            `expected ${entry.actualSha256}, actual ${currentSha256}`
        );
      }
      const canonicalBytes = normalizeCrlf(currentBytes);
      if (sha256(canonicalBytes) !== entry.canonicalSha256) {
        throw new Error(
          `Archive pack canonical hash changed during validation: ${entry.path}`
        );
      }
      await fs.writeFile(file, canonicalBytes);
    }
  } catch (error) {
    try {
      await restoreCanonicalArchiveSource(root, statePath, state);
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        `Archive pack normalization failed and recovery remains at ${statePath}`
      );
    }
    throw error;
  }
  return {
    gitWorktree: false,
    files: [],
    conversions: state.files.map(({ originalBase64, ...entry }) => entry)
  };
}

async function restoreCanonicalArchiveSource(root, statePath, state) {
  if (
    state.version !== 1 ||
    state.sourceKind !== "archive" ||
    !Array.isArray(state.files)
  ) {
    throw new Error(`Invalid archive pack recovery state: ${statePath}`);
  }
  const unsafe = [];
  const seen = new Set();
  for (const entry of state.files) {
    if (
      typeof entry.path !== "string" ||
      typeof entry.actualSha256 !== "string" ||
      typeof entry.canonicalSha256 !== "string" ||
      typeof entry.originalBase64 !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.actualSha256) ||
      !/^[a-f0-9]{64}$/.test(entry.canonicalSha256) ||
      seen.has(entry.path)
    ) {
      throw new Error(`Invalid archive pack recovery entry in ${statePath}`);
    }
    seen.add(entry.path);
    const file = resolveStateEntry(root, entry.path);
    const originalBytes = Buffer.from(entry.originalBase64, "base64");
    const canonicalBytes = normalizeCrlf(originalBytes);
    const savedBytesAreValid =
      sha256(originalBytes) === entry.actualSha256 &&
      sha256(canonicalBytes) === entry.canonicalSha256 &&
      !originalBytes.equals(canonicalBytes);
    if (!savedBytesAreValid) {
      unsafe.push(`${entry.path}: saved archive bytes are invalid`);
      continue;
    }
    let currentBytes;
    try {
      currentBytes = await fs.readFile(file);
    } catch (error) {
      unsafe.push(`${entry.path}: ${error.code ?? error.message}`);
      continue;
    }
    if (currentBytes.equals(originalBytes)) {
      continue;
    }
    if (!currentBytes.equals(canonicalBytes)) {
      unsafe.push(`${entry.path}: changed while canonical packing was active`);
      continue;
    }
    await fs.writeFile(file, originalBytes);
  }
  if (unsafe.length > 0) {
    throw new Error(
      `Archive pack source recovery is fail-closed; preserved ${statePath}:\n` +
        unsafe.map((entry) => `- ${entry}`).join("\n")
    );
  }
  await fs.unlink(statePath);
}

async function collectArchivePayloadFiles(root) {
  const packageMetadata = JSON.parse(
    await fs.readFile(path.join(root, "package.json"), "utf8")
  );
  if (!Array.isArray(packageMetadata.files)) {
    throw new Error(
      "Archive packing requires an explicit package.json files allowlist."
    );
  }
  const roots = new Set([
    "package.json",
    ...packageMetadata.files,
    ...Object.values(
      typeof packageMetadata.bin === "object" && packageMetadata.bin
        ? packageMetadata.bin
        : {}
    )
  ]);
  for (const automatic of [
    "README.md",
    "LICENSE",
    "LICENCE",
    "NOTICE",
    "CHANGELOG.md"
  ]) {
    if (await exists(path.join(root, automatic))) {
      roots.add(automatic);
    }
  }

  const files = new Set();
  for (const declared of roots) {
    if (
      typeof declared !== "string" ||
      declared.length === 0 ||
      /[*?[\]{}!]/.test(declared)
    ) {
      throw new Error(
        `Archive packing does not permit ambiguous package path: ${declared}`
      );
    }
    const relativePath = normalizeStatePath(declared);
    const location = resolveStateEntry(root, relativePath);
    const stat = await fs.lstat(location);
    if (stat.isSymbolicLink()) {
      throw new Error(
        `Archive packing refuses symbolic package path: ${relativePath}`
      );
    }
    if (stat.isDirectory()) {
      await collectDirectoryFiles(root, location, files);
    } else if (stat.isFile()) {
      files.add(relativePath);
    } else {
      throw new Error(
        `Archive packing refuses non-file package path: ${relativePath}`
      );
    }
  }
  return [...files].sort(comparePaths);
}

async function collectDirectoryFiles(root, directory, files) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => comparePaths(left.name, right.name));
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") {
      continue;
    }
    const location = path.join(directory, entry.name);
    const relativePath = normalizeStatePath(path.relative(root, location));
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Archive packing refuses symbolic package path: ${relativePath}`
      );
    }
    if (entry.isDirectory()) {
      await collectDirectoryFiles(root, location, files);
    } else if (entry.isFile()) {
      files.add(relativePath);
    } else {
      throw new Error(
        `Archive packing refuses non-file package path: ${relativePath}`
      );
    }
  }
}

function assertCanonicalizableArchiveText(bytes, relativePath) {
  if (bytes.includes(0)) {
    throw new Error(
      `Archive pack source contains CRLF in a binary file: ${relativePath}`
    );
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(
      `Archive pack source contains CRLF in non-UTF-8 bytes: ${relativePath}`
    );
  }
}

async function existingPackStatePaths(root, gitWorktree) {
  const candidates = [archivePackStatePath(root)];
  if (gitWorktree) {
    candidates.push(packStatePath(root));
  }
  const existing = [];
  for (const candidate of candidates) {
    if (await exists(candidate)) {
      existing.push(candidate);
    }
  }
  return existing;
}

function archivePackStatePath(root) {
  return path.join(root, archivePackStateName);
}

function resolveStateEntry(root, relativePath) {
  const normalized = normalizeStatePath(relativePath);
  const location = path.resolve(root, ...normalized.split("/"));
  const relative = path.relative(root, location);
  if (
    relative === "" ||
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Pack recovery path escapes source root: ${relativePath}`);
  }
  return location;
}

function normalizeStatePath(relativePath) {
  const slashed = relativePath.replaceAll("\\", "/");
  const normalized = path.posix.normalize(slashed);
  if (
    normalized === "." ||
    normalized.startsWith("/") ||
    /^[a-zA-Z]:\//.test(normalized) ||
    normalized.split("/").some((segment) => segment === ".." || segment === "")
  ) {
    throw new Error(`Invalid pack source path: ${relativePath}`);
  }
  return normalized;
}

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function readTrackedBytes(root, relativePath, mode) {
  const file = path.join(root, relativePath);
  if (mode === "120000") {
    return Buffer.from(await fs.readlink(file), "utf8");
  }
  return fs.readFile(file);
}

function isEolOnlyConversion(actual, canonical) {
  if (actual.equals(canonical)) {
    return false;
  }
  return normalizeCrlf(actual).equals(normalizeCrlf(canonical));
}

function normalizeCrlf(value) {
  return Buffer.from(
    value.toString("latin1").replaceAll("\r\n", "\n"),
    "latin1"
  );
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function runGit(root, args, { allowFailure = false, encoding = "utf8" } = {}) {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding,
    windowsHide: true
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${
        result.stderr?.toString().trim() ||
        result.stdout?.toString().trim() ||
        result.error?.message
      }`
    );
  }
  return result;
}
