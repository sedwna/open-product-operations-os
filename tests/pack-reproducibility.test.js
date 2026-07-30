import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  findNonCanonicalTrackedFiles,
  gitBlobObjectId
} from "../scripts/check-pack-source.mjs";
import { makeTempDirectory } from "./helpers.js";

test("raw Git-byte guard detects CRLF payload divergence before packing", () => {
  const canonical = Buffer.from("first line\nsecond line\n", "utf8");
  const windowsTransition = Buffer.from(
    "first line\r\nsecond line\r\n",
    "utf8"
  );
  const expectedObjectId = gitBlobObjectId(canonical);

  assert.equal(gitBlobObjectId(canonical), expectedObjectId);
  assert.notEqual(gitBlobObjectId(windowsTransition), expectedObjectId);
});

test("prepack guard rejects a Git-clean CRLF file retained across an attributes transition", async (t) => {
  const root = await makeTempDirectory();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  runGit(root, ["init", "-q"]);
  runGit(root, ["config", "user.email", "fixture@example.invalid"]);
  runGit(root, ["config", "user.name", "Pack Fixture"]);
  runGit(root, ["config", "core.autocrlf", "true"]);

  const proof = path.join(root, "proof.md");
  await fs.writeFile(proof, "first line\nsecond line\n", "utf8");
  runGit(root, ["add", "proof.md"]);
  runGit(root, ["commit", "-qm", "base"]);
  await fs.rm(proof);
  runGit(root, ["checkout", "--", "proof.md"]);
  assert.equal(
    (await fs.readFile(proof)).includes(Buffer.from("\r\n")),
    true
  );

  await fs.writeFile(
    path.join(root, ".gitattributes"),
    "* text=auto eol=lf\n",
    "utf8"
  );
  runGit(root, ["add", ".gitattributes"]);
  runGit(root, ["commit", "-qm", "add canonical attributes"]);
  assert.equal(runGit(root, ["status", "--porcelain"]).stdout, "");

  const result = await findNonCanonicalTrackedFiles(root);
  assert.equal(result.gitWorktree, true);
  assert.deepEqual(
    result.files.map((entry) => entry.path),
    ["proof.md"]
  );
  assert.equal(result.files[0].containsCrlf, true);
});

function runGit(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true
  });
  assert.equal(
    result.status,
    0,
    result.stderr || result.stdout || result.error?.message
  );
  return result;
}
