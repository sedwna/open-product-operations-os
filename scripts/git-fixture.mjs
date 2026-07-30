import assert from "node:assert/strict";
import { runProcess } from "./process-runner.mjs";

const CANONICAL_REF = "refs/heads/canonical";

export function publishExactCanonicalRef({
  source,
  remote,
  sourceHead,
  cwd = source,
  env = process.env
}) {
  assert.match(
    sourceHead,
    /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/,
    "source head must be a complete Git object ID"
  );
  const remoteGitDirectory = `--git-dir=${remote}`;
  runGit(
    [
      remoteGitDirectory,
      "fetch",
      "--update-shallow",
      "--no-tags",
      source,
      sourceHead
    ],
    cwd,
    env
  );
  runGit(
    [remoteGitDirectory, "cat-file", "-e", `${sourceHead}^{commit}`],
    cwd,
    env
  );

  const absentObjectId = "0".repeat(sourceHead.length);
  runGit(
    [
      remoteGitDirectory,
      "update-ref",
      "--no-deref",
      CANONICAL_REF,
      sourceHead,
      absentObjectId
    ],
    cwd,
    env
  );
  assert.equal(
    runGit(
      [
        remoteGitDirectory,
        "rev-parse",
        "--verify",
        `${CANONICAL_REF}^{commit}`
      ],
      cwd,
      env
    ).stdout.trim(),
    sourceHead,
    "temporary remote must read back the exact canonical commit"
  );
  assert.equal(
    runGit(
      ["ls-remote", "--heads", remote, CANONICAL_REF],
      cwd,
      env
    ).stdout.trim(),
    `${sourceHead}\t${CANONICAL_REF}`,
    "temporary remote must advertise the exact canonical ref before clone"
  );
}

function runGit(args, cwd, env) {
  const result = runProcess("git", args, {
    cwd,
    env,
    encoding: "utf8"
  });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed:\n${
      result.stderr || result.stdout || result.error?.message
    }`
  );
  return result;
}
