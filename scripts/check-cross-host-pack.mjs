import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { npmInvocation, runProcess } from "./process-runner.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), "product-ops-cross-host-")
);
const remote = path.join(temporary, "source.git");
const bundle = path.join(temporary, "source.bundle");
const windowsClone = path.join(temporary, "windows-autocrlf-clone");
const windowsPack = path.join(temporary, "windows-pack");
const linuxPack = path.join(temporary, "linux-pack");
const globalConfig = path.join(temporary, "gitconfig");
const sourceHead = run("git", ["rev-parse", "HEAD"], root).stdout.trim();

assert.equal(
  process.platform,
  "win32",
  "exact cross-host regression starts from an ordinary Windows checkout"
);
assert.equal(
  run("git", ["status", "--porcelain=v1"], root).stdout,
  "",
  "cross-host regression requires a clean committed source checkout"
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
  await fs.mkdir(windowsPack);
  await fs.mkdir(linuxPack);
  run("git", ["init", "--bare", remote], root, gitEnvironment);
  run(
    "git",
    [
      `--git-dir=${remote}`,
      "fetch",
      "--no-tags",
      root,
      "HEAD:refs/heads/canonical"
    ],
    root,
    gitEnvironment
  );
  run(
    "git",
    [
      `--git-dir=${remote}`,
      "bundle",
      "create",
      bundle,
      "refs/heads/canonical"
    ],
    root,
    gitEnvironment
  );
  run(
    "git",
    [
      "clone",
      "--no-local",
      "--branch",
      "canonical",
      remote,
      windowsClone
    ],
    root,
    gitEnvironment
  );
  assert.match(
    run(
      "git",
      ["ls-files", "--eol", "--", "README.md"],
      windowsClone,
      gitEnvironment
    ).stdout,
    /i\/lf\s+w\/crlf\s+attr\/text=auto/
  );
  const windowsTarball = await packTarball(
    windowsClone,
    windowsPack,
    gitEnvironment
  );

  run(
    "docker",
    [
      "run",
      "--rm",
      "-v",
      `${temporary}:/analysis`,
      "node:20-bookworm",
      "bash",
      "-lc",
      [
        "set -eu",
        "git clone --no-local --branch canonical /analysis/source.bundle /linux-clone",
        "git -C /linux-clone archive --format=tar --output=/analysis/linux-source.tar HEAD",
        "mkdir /linux-source",
        "tar -xf /analysis/linux-source.tar -C /linux-source",
        "test ! -e /linux-source/.git",
        "cd /linux-source",
        "npm pack --json --pack-destination /analysis/linux-pack >/analysis/linux-pack.json"
      ].join("; ")
    ],
    root
  );
  const linuxTarball = await fs.readFile(
    path.join(linuxPack, "open-product-operations-os-0.1.0.tgz")
  );
  assert.deepEqual(
    windowsTarball,
    linuxTarball,
    "real Windows autocrlf clone and clean Linux Git archive must produce identical tarball bytes"
  );
  const actualHash = sha256(windowsTarball);
  const [expectedHash] = (
    await fs.readFile(
      path.join(root, ".github", "pack-artifact.sha256"),
      "utf8"
    )
  )
    .trim()
    .split(/\s+/);
  assert.equal(actualHash, expectedHash);
  assert.equal(
    run(
      "git",
      ["status", "--porcelain=v1"],
      windowsClone,
      gitEnvironment
    ).stdout,
    "",
    "Windows prepack/postpack must restore the ordinary clone exactly"
  );
  console.log(
    `Real Windows autocrlf clone and clean Linux archive produced identical package ${actualHash} at ${sourceHead}.`
  );
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}

async function packTarball(source, destination, env) {
  const invocation = npmInvocation([
    "pack",
    "--json",
    "--pack-destination",
    destination
  ]);
  const result = run(invocation.command, invocation.args, source, env);
  const [pack] = JSON.parse(result.stdout);
  return fs.readFile(path.join(destination, pack.filename));
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

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
