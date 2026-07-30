import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
    `Ordinary autocrlf clean clone ${sourceHead} produced and installed canonical package ${expectedHash}.`
  );
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}

function runNpm(args, cwd, env) {
  const invocation = npmInvocation(args);
  return run(invocation.command, invocation.args, cwd, env);
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
