import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  captureFileSnapshot,
  moveFileNoOverwrite,
  removeFileIfUnchanged
} from "../src/atomic-move.js";
import { assertNoLinkTraversal } from "../src/paths.js";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");
const packStateName = "product-ops-pack-source-state.json";
const archivePackStateName = ".product-ops-pack-source-state.json";
const declaredBinaryExtensions = new Set([
  ".exe", ".gif", ".gz", ".jpeg", ".jpg", ".pdf", ".png", ".woff", ".woff2", ".zip"
]);

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

export async function prepareCanonicalPackSource(
  root,
  { operationObserver = async () => {} } = {}
) {
  assertOperationObserver(operationObserver);
  const result = await findNonCanonicalTrackedFiles(root);
  if (!result.gitWorktree) {
    return prepareCanonicalArchiveSource(root, { operationObserver });
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
      await replacePackSourceFile(
        root,
        resolveStateEntry(root, entry.path),
        Buffer.from(entry.originalBase64, "base64"),
        canonicalBytes,
        `Git worktree pack normalization for ${entry.path}`,
        {
          operation: "normalize",
          sourceKind: "git",
          entryPath: entry.path,
          operationObserver
        }
      );
    }
  } catch (error) {
    throw retainedPackStateError(
      error,
      statePath,
      "Pack normalization failed"
    );
  }
  return result;
}

export async function restorePackSource(
  root,
  { operationObserver = async () => {} } = {}
) {
  assertOperationObserver(operationObserver);
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
  const stateRoot = containmentRootFor(root, statePath);
  const stateSnapshot = await captureFileSnapshot(
    stateRoot,
    statePath,
    "Pack recovery state"
  );
  assertSingleLinkSnapshot(
    stateSnapshot,
    "Pack recovery state must not be hard-linked."
  );
  const state = JSON.parse(stateSnapshot.bytes.toString("utf8"));
  if (state.sourceKind === "archive") {
    try {
      await restoreCanonicalArchiveSource(
        root,
        statePath,
        state,
        stateRoot,
        stateSnapshot,
        { operationObserver }
      );
    } catch (error) {
      throw retainedPackStateError(
        error,
        statePath,
        "Archive pack source restoration failed"
      );
    }
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

  try {
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
      await replacePackSourceFile(
        root,
        file,
        canonicalBytes,
        originalBytes,
        `Git worktree postpack restoration for ${entry.path}`,
        {
          operation: "restore",
          sourceKind: "git",
          entryPath: entry.path,
          operationObserver
        }
      );
    }

    if (unsafe.length > 0) {
      throw new Error(
        `Pack source recovery is fail-closed; preserved ${statePath}:\n` +
          unsafe.map((entry) => `- ${entry}`).join("\n")
      );
    }
    await removeRecoveryState(
      stateRoot,
      statePath,
      stateSnapshot,
      "Pack recovery state"
    );
  } catch (error) {
    throw retainedPackStateError(
      error,
      statePath,
      "Pack source restoration failed"
    );
  }
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

async function prepareCanonicalArchiveSource(
  root,
  { operationObserver }
) {
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
    if (declaredBinaryExtensions.has(path.extname(relativePath).toLowerCase())) {
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
      await replacePackSourceFile(
        root,
        file,
        currentBytes,
        canonicalBytes,
        `Archive pack normalization for ${entry.path}`,
        {
          operation: "normalize",
          sourceKind: "archive",
          entryPath: entry.path,
          operationObserver
        }
      );
    }
  } catch (error) {
    throw retainedPackStateError(
      error,
      statePath,
      "Archive pack normalization failed"
    );
  }
  return {
    gitWorktree: false,
    files: [],
    conversions: state.files.map(({ originalBase64, ...entry }) => entry)
  };
}

async function restoreCanonicalArchiveSource(
  root,
  statePath,
  state,
  stateRoot,
  stateSnapshot,
  { operationObserver }
) {
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
    await replacePackSourceFile(
      root,
      file,
      canonicalBytes,
      originalBytes,
      `Archive postpack restoration for ${entry.path}`,
      {
        operation: "restore",
        sourceKind: "archive",
        entryPath: entry.path,
        operationObserver
      }
    );
  }
  if (unsafe.length > 0) {
    throw new Error(
      `Archive pack source recovery is fail-closed; preserved ${statePath}:\n` +
        unsafe.map((entry) => `- ${entry}`).join("\n")
    );
  }
  await removeRecoveryState(
    stateRoot,
    statePath,
    stateSnapshot,
    "Archive pack recovery state"
  );
}

async function replacePackSourceFile(
  root,
  file,
  expectedBytes,
  replacementBytes,
  label,
  {
    operation,
    sourceKind,
    entryPath,
    operationObserver
  }
) {
  const initial = await captureFileSnapshot(root, file, `${label} source`);
  assertSingleLinkSnapshot(
    initial,
    `${label} source is hard-linked; refusing ambiguous replacement.`
  );
  if (!initial.bytes.equals(expectedBytes)) {
    throw new Error(`${label} source changed before atomic replacement.`);
  }

  const stagePath = privatePackPath(file, "stage");
  const retiredPath = privatePackPath(file, "retired");
  await assertNoLinkTraversal(root, stagePath, `${label} stage`);
  await assertNoLinkTraversal(root, retiredPath, `${label} retired source`);
  const stageHandle = await fs.open(stagePath, "wx");
  try {
    await stageHandle.writeFile(replacementBytes);
  } finally {
    await stageHandle.close();
  }
  const stageSnapshot = await captureFileSnapshot(
    root,
    stagePath,
    `${label} stage`
  );
  assertSingleLinkSnapshot(
    stageSnapshot,
    `${label} stage is hard-linked; refusing ambiguous replacement.`
  );
  if (!stageSnapshot.bytes.equals(replacementBytes)) {
    throw new Error(`${label} stage bytes changed before installation.`);
  }

  let step = "retire";
  let retired = false;
  let installed = false;
  try {
    await moveFileNoOverwrite(
      root,
      file,
      retiredPath,
      `${label} source retirement`,
      {
        expectedContent: expectedBytes,
        moveObserver: async (event) => {
          if (event.phase === "after-final-pre-unlink-validation") {
            await operationObserver({
              phase: "after-final-read-before-write",
              operation,
              sourceKind,
              entryPath,
              file,
              stagePath,
              retiredPath
            });
          }
        }
      }
    );
    retired = true;

    step = "install";
    await moveFileNoOverwrite(
      root,
      stagePath,
      file,
      `${label} replacement install`,
      { expectedContent: replacementBytes }
    );
    installed = true;

    const installedSnapshot = await captureFileSnapshot(
      root,
      file,
      `${label} installed replacement`
    );
    assertSingleLinkSnapshot(
      installedSnapshot,
      `${label} installed replacement has an ambiguous link count.`
    );
    if (!installedSnapshot.bytes.equals(replacementBytes)) {
      throw new Error(`${label} installed replacement failed byte read-back.`);
    }

    step = "cleanup";
    const retiredSnapshot = await captureFileSnapshot(
      root,
      retiredPath,
      `${label} retired source`
    );
    assertSingleLinkSnapshot(
      retiredSnapshot,
      `${label} retired source has an ambiguous link count.`
    );
    if (!retiredSnapshot.bytes.equals(expectedBytes)) {
      throw new Error(`${label} retired source failed byte read-back.`);
    }
    const cleanup = await removeFileIfUnchanged(
      root,
      retiredPath,
      retiredSnapshot,
      `${label} retired source`,
      { missingIsSuccess: false }
    );
    if (cleanup.status !== "removed") {
      const cleanupError = new Error(
        `${label} replacement committed, but retired-source cleanup was uncertain.`
      );
      cleanupError.code = "EPACKCLEANUP";
      cleanupError.committed = true;
      cleanupError.recoveryPaths = cleanup.recoveryPaths;
      throw cleanupError;
    }
  } catch (error) {
    const recoveryPaths = new Set(error.recoveryPaths ?? []);
    if (retired || (step === "retire" && error.destinationLinked)) {
      recoveryPaths.add(retiredPath);
    }
    if (!installed) {
      const stageCleanup = await removeFileIfUnchanged(
        root,
        stagePath,
        stageSnapshot,
        `${label} stage cleanup`
      );
      for (const recoveryPath of stageCleanup.recoveryPaths) {
        recoveryPaths.add(recoveryPath);
      }
    }
    if (step === "install" && error.destinationLinked) {
      recoveryPaths.add(file);
    }
    const atomicError = new Error(
      `${label} failed closed; concurrent bytes and atomic recovery artifacts were not overwritten.`,
      { cause: error }
    );
    atomicError.code = "EPACKATOMIC";
    atomicError.committed = installed || error.committed === true;
    atomicError.recoveryPaths = [...recoveryPaths];
    throw atomicError;
  }
}

async function removeRecoveryState(
  stateRoot,
  statePath,
  stateSnapshot,
  label
) {
  const removal = await removeFileIfUnchanged(
    stateRoot,
    statePath,
    stateSnapshot,
    label,
    { missingIsSuccess: false }
  );
  if (removal.status !== "removed") {
    const error = new Error(
      `${label} changed before cleanup; success is refused and recovery state was retained.`
    );
    error.code = "EPACKSTATE";
    error.recoveryPaths = removal.recoveryPaths;
    throw error;
  }
}

function retainedPackStateError(error, statePath, message) {
  const retained = new Error(
    `${message}; recovery is fail-closed and recovery state remains at ${statePath}.`,
    { cause: error }
  );
  retained.code = error.code ?? "EPACKNORMALIZE";
  retained.committed = error.committed === true;
  retained.recoveryPaths = [
    ...new Set([statePath, ...(error.recoveryPaths ?? [])])
  ];
  return retained;
}

function privatePackPath(file, kind) {
  return path.join(
    path.dirname(file),
    `.product-ops-pack-${kind}.${crypto.randomUUID()}.${path.basename(file)}`
  );
}

function containmentRootFor(root, file) {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
    ? path.dirname(file)
    : root;
}

function assertSingleLinkSnapshot(snapshot, message) {
  if (snapshot.stat.nlink !== 1n) {
    throw new Error(message);
  }
}

function assertOperationObserver(operationObserver) {
  if (typeof operationObserver !== "function") {
    throw new Error("operationObserver must be a function when provided.");
  }
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
