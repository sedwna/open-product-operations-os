import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");
const packStateName = "product-ops-pack-source-state.json";

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
    return result;
  }
  assertNoPackDrift(result);
  const statePath = packStatePath(root);
  if (await exists(statePath)) {
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
  if (worktree.status !== 0 || worktree.stdout.trim() !== "true") {
    return;
  }
  const statePath = packStatePath(root);
  if (!(await exists(statePath))) {
    return;
  }

  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  if (
    state.version !== 1 ||
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
