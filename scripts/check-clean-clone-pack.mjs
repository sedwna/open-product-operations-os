import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { publishExactCanonicalRef } from "./git-fixture.mjs";
import { npmInvocation, runProcess } from "./process-runner.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), "product-ops-clean-clone-")
);
const remote = path.join(temporary, "source.git");
const clone = path.join(temporary, "ordinary-clone");
const clonePack = path.join(temporary, "clone-pack");
const sourceArchive = path.join(temporary, "source.tar");
const archiveSource = path.join(temporary, "archive-source");
const archivePack = path.join(temporary, "archive-pack");
const globalConfig = path.join(temporary, "gitconfig");
const sourceHead = run("git", ["rev-parse", "HEAD"], root).stdout.trim();
assert.equal(
  run("git", ["status", "--porcelain=v1"], root).stdout,
  "",
  "clean-clone regression requires a clean committed source checkout"
);

await fs.writeFile(
  globalConfig,
  "[core]\n\tautocrlf = true\n",
  "utf8"
);
const gitEnvironment = {
  ...process.env,
  GIT_CONFIG_GLOBAL: globalConfig,
  GIT_CONFIG_NOSYSTEM: "1"
};

try {
  run("git", ["init", "--bare", remote], root, gitEnvironment);
  publishExactCanonicalRef({
    source: root,
    remote,
    sourceHead,
    cwd: root,
    env: gitEnvironment
  });
  run(
    "git",
    [
      "clone",
      "--no-local",
      "--branch",
      "canonical",
      remote,
      clone
    ],
    root,
    gitEnvironment
  );
  assert.equal(
    run("git", ["rev-parse", "HEAD"], clone, gitEnvironment).stdout.trim(),
    sourceHead
  );
  assert.equal(
    run(
      "git",
      ["status", "--porcelain=v1"],
      clone,
      gitEnvironment
    ).stdout,
    ""
  );
  const eol = run(
    "git",
    ["ls-files", "--eol", "--", "README.md"],
    clone,
    gitEnvironment
  ).stdout;
  assert.match(
    eol,
    /i\/lf\s+w\/crlf\s+attr\/text=auto/,
    `clone did not exercise the autocrlf checkout path:\n${eol}`
  );

  runNpm(["ci"], clone, gitEnvironment);
  await fs.mkdir(clonePack);
  await fs.mkdir(archiveSource);
  await fs.mkdir(archivePack);
  const cloneTarball = await packTarball(
    clone,
    clonePack,
    gitEnvironment
  );
  run(
    "git",
    [
      "archive",
      "--format=tar",
      `--output=${sourceArchive}`,
      sourceHead
    ],
    clone,
    gitEnvironment
  );
  run(
    "tar",
    ["-xf", sourceArchive, "-C", archiveSource],
    clone,
    gitEnvironment
  );
  assert.equal(
    await exists(path.join(archiveSource, ".git")),
    false,
    "archive regression must run without Git metadata"
  );
  const archiveReadme = await fs.readFile(
    path.join(archiveSource, "README.md")
  );
  assert.equal(
    archiveReadme.includes(Buffer.from("\r\n")),
    true,
    "archive regression must exercise CRLF export bytes"
  );
  const archiveTarball = await packTarball(
    archiveSource,
    archivePack,
    gitEnvironment
  );
  assert.deepEqual(
    archiveTarball,
    cloneTarball,
    "ordinary autocrlf clone and CRLF Git archive must pack byte-for-byte identically"
  );
  assert.deepEqual(
    await fs.readFile(path.join(archiveSource, "README.md")),
    archiveReadme,
    "archive postpack must restore exported CRLF bytes"
  );
  const packed = runNpm(
    ["run", "packed:check"],
    clone,
    gitEnvironment
  );
  const [expectedHash] = (
    await fs.readFile(
      path.join(clone, ".github", "pack-artifact.sha256"),
      "utf8"
    )
  )
    .trim()
    .split(/\s+/);
  assert.equal(sha256(cloneTarball), expectedHash);
  assert.match(packed.stdout, new RegExp(expectedHash));
  assert.equal(
    run(
      "git",
      ["status", "--porcelain=v1"],
      clone,
      gitEnvironment
    ).stdout,
    "",
    "prepack/postpack must restore the ordinary clone exactly"
  );
  console.log(
    `Ordinary autocrlf clean clone and CRLF archive ${sourceHead} produced identical canonical package ${expectedHash}; the installed CLI path passed.`
  );
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}

function runNpm(args, cwd, env) {
  const invocation = npmInvocation(args);
  return run(invocation.command, invocation.args, cwd, env);
}

async function packTarball(source, destination, env) {
  const result = runNpm(
    ["pack", "--json", "--pack-destination", destination],
    source,
    env
  );
  const [pack] = JSON.parse(result.stdout);
  return fs.readFile(path.join(destination, pack.filename));
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

function run(command, args, cwd, env = process.env) {
  const result = runProcess(command, args, {
    cwd,
    env,
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
