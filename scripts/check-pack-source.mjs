import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");

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
      bytes = await fs.readFile(path.join(root, relativePath));
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
    if (actualObjectId !== expectedObjectId) {
      files.push({
        path: relativePath.replaceAll("\\", "/"),
        expectedObjectId,
        actualObjectId,
        containsCrlf: bytes.includes(Buffer.from("\r\n"))
      });
    }
  }
  return { gitWorktree: true, objectFormat: algorithm, files };
}

if (path.resolve(process.argv[1] ?? "") === scriptPath) {
  const result = await findNonCanonicalTrackedFiles(repositoryRoot);
  if (!result.gitWorktree) {
    process.exit(0);
  }
  if (result.files.length > 0) {
    throw new Error(
      `Pack source differs byte-for-byte from the Git index:\n${result.files
        .map(
          (entry) =>
            `- ${entry.path}: expected ${entry.expectedObjectId}, actual ${
              entry.actualObjectId ?? entry.reason
            }${entry.containsCrlf ? " (contains CRLF)" : ""}`
        )
        .join(
          "\n"
        )}\nRefusing to pack a clean-filtered or otherwise non-canonical worktree.`
    );
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
