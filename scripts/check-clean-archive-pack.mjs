import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { npmInvocation, runProcess } from "./process-runner.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), "product-ops-clean-archive-")
);
const sourceArchive = path.join(temporary, "source.tar");
const extracted = path.join(temporary, "source");
const packed = path.join(temporary, "packed");
const sourceHead = run("git", ["rev-parse", "HEAD"], root).stdout.trim();

assert.equal(
  run("git", ["status", "--porcelain=v1"], root).stdout,
  "",
  "clean-archive regression requires a clean committed source checkout"
);

try {
  await fs.mkdir(extracted);
  await fs.mkdir(packed);
  run(
    "git",
    [
      "archive",
      "--format=tar",
      `--output=${sourceArchive}`,
      sourceHead
    ],
    root
  );
  run("tar", ["-xf", sourceArchive, "-C", extracted], root);
  assert.equal(
    await exists(path.join(extracted, ".git")),
    false,
    "clean archive must not inherit Git metadata"
  );
  const before = await treeDigest(extracted);
  const packResult = runNpm(
    ["pack", "--json", "--pack-destination", packed],
    extracted
  );
  const [pack] = JSON.parse(packResult.stdout);
  const tarball = path.join(packed, pack.filename);
  const actualHash = sha256(await fs.readFile(tarball));
  const [expectedHash] = (
    await fs.readFile(
      path.join(extracted, ".github", "pack-artifact.sha256"),
      "utf8"
    )
  )
    .trim()
    .split(/\s+/);
  assert.equal(
    actualHash,
    expectedHash,
    "clean Git archive must produce the canonical packed-artifact SHA-256"
  );
  assert.equal(
    await treeDigest(extracted),
    before,
    "prepack/postpack must restore the clean archive byte-for-byte"
  );
  assert.equal(
    await exists(
      path.join(extracted, ".product-ops-pack-source-state.json")
    ),
    false,
    "archive pack recovery state must be removed after safe restoration"
  );
  console.log(
    `Clean Git archive ${sourceHead} produced canonical package ${actualHash} and was restored byte-for-byte.`
  );
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}

function runNpm(args, cwd) {
  const invocation = npmInvocation(args);
  return run(invocation.command, invocation.args, cwd);
}

function run(command, args, cwd) {
  const result = runProcess(command, args, {
    cwd,
    encoding: "utf8"
  });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed:\n${
      result.stderr || result.stdout || result.error?.message
    }`
  );
  return result;
}

async function treeDigest(directory) {
  const entries = [];
  await visit(directory, directory, entries);
  return sha256(Buffer.from(JSON.stringify(entries)));
}

async function visit(rootDirectory, directory, entries) {
  const children = await fs.readdir(directory, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name));
  for (const child of children) {
    const location = path.join(directory, child.name);
    const relativePath = path
      .relative(rootDirectory, location)
      .replaceAll("\\", "/");
    if (child.isDirectory()) {
      entries.push([relativePath, "directory"]);
      await visit(rootDirectory, location, entries);
    } else if (child.isFile()) {
      entries.push([
        relativePath,
        "file",
        sha256(await fs.readFile(location))
      ]);
    } else if (child.isSymbolicLink()) {
      entries.push([
        relativePath,
        "symlink",
        await fs.readlink(location)
      ]);
    } else {
      throw new Error(`Unsupported archive entry: ${relativePath}`);
    }
  }
}

async function exists(file) {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
