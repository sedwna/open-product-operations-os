import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  findNonCanonicalTrackedFiles,
  gitBlobObjectId,
  prepareCanonicalPackSource,
  restorePackSource
} from "../scripts/check-pack-source.mjs";
import { publishExactCanonicalRef } from "../scripts/git-fixture.mjs";
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

test("clean-clone fixture publishes the exact head from a shallow checkout", async (t) => {
  const root = await makeTempDirectory();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const shallow = path.join(root, "shallow");
  const remote = path.join(root, "remote.git");
  const clone = path.join(root, "clone");
  await fs.mkdir(source);
  runGit(source, ["init", "-q"]);
  runGit(source, ["config", "user.email", "fixture@example.invalid"]);
  runGit(source, ["config", "user.name", "Pack Fixture"]);
  const proof = path.join(source, "proof.md");
  await fs.writeFile(proof, "first revision\n", "utf8");
  runGit(source, ["add", "proof.md"]);
  runGit(source, ["commit", "-qm", "first"]);
  await fs.writeFile(proof, "second revision\n", "utf8");
  runGit(source, ["commit", "-qam", "second"]);

  runGit(root, [
    "clone",
    "--depth",
    "1",
    "--no-local",
    source,
    shallow
  ]);
  assert.equal(
    runGit(shallow, ["rev-parse", "--is-shallow-repository"]).stdout.trim(),
    "true"
  );
  const sourceHead = runGit(shallow, ["rev-parse", "HEAD"]).stdout.trim();
  runGit(root, ["init", "--bare", "-q", remote]);
  publishExactCanonicalRef({
    source: shallow,
    remote,
    sourceHead,
    cwd: root
  });
  runGit(root, [
    "clone",
    "--no-local",
    "--branch",
    "canonical",
    remote,
    clone
  ]);
  assert.equal(
    runGit(clone, ["rev-parse", "HEAD"]).stdout.trim(),
    sourceHead
  );
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

test("prepack canonicalizes and restores a Git-declared CRLF checkout", async (t) => {
  const root = await makeCrlfCheckout(t);
  const proof = path.join(root, "proof.md");
  const original = await fs.readFile(proof);
  assert.equal(original.includes(Buffer.from("\r\n")), true);
  assert.equal(runGit(root, ["status", "--porcelain"]).stdout, "");

  const before = await findNonCanonicalTrackedFiles(root);
  assert.deepEqual(before.files, []);
  assert.deepEqual(
    before.conversions.map((entry) => entry.path),
    [".gitattributes", "proof.md"]
  );

  await prepareCanonicalPackSource(root);
  assert.equal(
    (await fs.readFile(proof)).includes(Buffer.from("\r\n")),
    false
  );
  await restorePackSource(root);
  assert.deepEqual(await fs.readFile(proof), original);
  assert.equal(runGit(root, ["status", "--porcelain"]).stdout, "");
});

test("prepack guard rejects true content tamper in a CRLF checkout", async (t) => {
  const root = await makeCrlfCheckout(t);
  const proof = path.join(root, "proof.md");
  await fs.writeFile(proof, "first line\r\ntampered line\r\n", "utf8");

  const result = await findNonCanonicalTrackedFiles(root);
  assert.deepEqual(result.conversions.map((entry) => entry.path), [
    ".gitattributes"
  ]);
  assert.deepEqual(result.files.map((entry) => entry.path), ["proof.md"]);
  assert.match(
    result.files[0].reason,
    /do(?:es)? not match the current Git checkout filter/
  );
});

test("prepack refuses a concurrent normalization session", async (t) => {
  const root = await makeCrlfCheckout(t);
  await prepareCanonicalPackSource(root);
  await assert.rejects(
    prepareCanonicalPackSource(root),
    /prior pack normalization state remains/
  );
  await restorePackSource(root);
});

test("postpack recovery cannot overwrite concurrent bytes", async (t) => {
  const root = await makeCrlfCheckout(t);
  const proof = path.join(root, "proof.md");
  await prepareCanonicalPackSource(root);
  await fs.writeFile(proof, "concurrent bytes\n", "utf8");

  await assert.rejects(
    restorePackSource(root),
    /recovery is fail-closed/
  );
  assert.equal(await fs.readFile(proof, "utf8"), "concurrent bytes\n");
  const statePath = runGit(root, [
    "rev-parse",
    "--git-path",
    "product-ops-pack-source-state.json"
  ]).stdout.trim();
  await fs.access(path.resolve(root, statePath));
});

test("worktree normalization preserves bytes injected after final read and retains recovery state", async (t) => {
  const root = await makeCrlfCheckout(t);
  const proof = path.join(root, "proof.md");
  const concurrentBytes = Buffer.from(
    "concurrent worktree normalization bytes\n",
    "utf8"
  );
  let injections = 0;

  await assert.rejects(
    prepareCanonicalPackSource(root, {
      operationObserver: async (event) => {
        if (
          event.phase === "after-final-read-before-write" &&
          event.operation === "normalize" &&
          event.sourceKind === "git" &&
          event.entryPath === "proof.md"
        ) {
          injections += 1;
          await replacePathWithConcurrentBytes(event.file, concurrentBytes);
        }
      }
    }),
    (error) =>
      error.code === "EPACKATOMIC" &&
      /recovery state remains/.test(error.message)
  );

  assert.equal(injections, 1);
  assert.deepEqual(await fs.readFile(proof), concurrentBytes);
  await fs.access(await gitPackStatePath(root));
});

test("archive normalization preserves bytes injected after final read and retains recovery state", async (t) => {
  const root = await makeArchiveSource(t);
  const proof = path.join(root, "docs", "proof.md");
  const concurrentBytes = Buffer.from(
    "concurrent archive normalization bytes\n",
    "utf8"
  );
  let injections = 0;

  await assert.rejects(
    prepareCanonicalPackSource(root, {
      operationObserver: async (event) => {
        if (
          event.phase === "after-final-read-before-write" &&
          event.operation === "normalize" &&
          event.sourceKind === "archive" &&
          event.entryPath === "docs/proof.md"
        ) {
          injections += 1;
          await replacePathWithConcurrentBytes(event.file, concurrentBytes);
        }
      }
    }),
    (error) =>
      error.code === "EPACKATOMIC" &&
      /recovery state remains/.test(error.message)
  );

  assert.equal(injections, 1);
  assert.deepEqual(await fs.readFile(proof), concurrentBytes);
  await fs.access(
    path.join(root, ".product-ops-pack-source-state.json")
  );
});

test("worktree postpack restoration preserves bytes injected after final read and retains recovery state", async (t) => {
  const root = await makeCrlfCheckout(t);
  const proof = path.join(root, "proof.md");
  const concurrentBytes = Buffer.from(
    "concurrent worktree restore bytes\n",
    "utf8"
  );
  let injections = 0;
  await prepareCanonicalPackSource(root);

  await assert.rejects(
    restorePackSource(root, {
      operationObserver: async (event) => {
        if (
          event.phase === "after-final-read-before-write" &&
          event.operation === "restore" &&
          event.sourceKind === "git" &&
          event.entryPath === "proof.md"
        ) {
          injections += 1;
          await replacePathWithConcurrentBytes(event.file, concurrentBytes);
        }
      }
    }),
    (error) => error.code === "EPACKATOMIC"
  );

  assert.equal(injections, 1);
  assert.deepEqual(await fs.readFile(proof), concurrentBytes);
  await fs.access(await gitPackStatePath(root));
});

test("archive postpack restoration preserves bytes injected after final read and retains recovery state", async (t) => {
  const root = await makeArchiveSource(t);
  const proof = path.join(root, "docs", "proof.md");
  const concurrentBytes = Buffer.from(
    "concurrent archive restore bytes\n",
    "utf8"
  );
  let injections = 0;
  await prepareCanonicalPackSource(root);

  await assert.rejects(
    restorePackSource(root, {
      operationObserver: async (event) => {
        if (
          event.phase === "after-final-read-before-write" &&
          event.operation === "restore" &&
          event.sourceKind === "archive" &&
          event.entryPath === "docs/proof.md"
        ) {
          injections += 1;
          await replacePathWithConcurrentBytes(event.file, concurrentBytes);
        }
      }
    }),
    (error) => error.code === "EPACKATOMIC"
  );

  assert.equal(injections, 1);
  assert.deepEqual(await fs.readFile(proof), concurrentBytes);
  await fs.access(
    path.join(root, ".product-ops-pack-source-state.json")
  );
});

test("prepack canonicalizes and restores promised CRLF files from a Git archive", async (t) => {
  const root = await makeArchiveSource(t);
  const proof = path.join(root, "docs", "proof.md");
  const original = await fs.readFile(proof);

  const result = await prepareCanonicalPackSource(root);
  assert.equal(result.gitWorktree, false);
  assert.deepEqual(
    result.conversions.map((entry) => entry.path),
    ["LICENSE", "README.md", "docs/proof.md"]
  );
  assert.equal(
    (await fs.readFile(proof)).includes(Buffer.from("\r\n")),
    false
  );
  await fs.access(
    path.join(root, ".product-ops-pack-source-state.json")
  );

  await restorePackSource(root);
  assert.deepEqual(await fs.readFile(proof), original);
  await assert.rejects(
    fs.access(path.join(root, ".product-ops-pack-source-state.json")),
    { code: "ENOENT" }
  );
});

test("archive prepack refuses concurrent normalization and restore preserves concurrent bytes", async (t) => {
  const root = await makeArchiveSource(t);
  const proof = path.join(root, "docs", "proof.md");
  await prepareCanonicalPackSource(root);

  await assert.rejects(
    prepareCanonicalPackSource(root),
    /prior pack normalization state remains/
  );
  await fs.writeFile(proof, "concurrent archive bytes\n", "utf8");
  await assert.rejects(
    restorePackSource(root),
    /recovery is fail-closed/
  );
  assert.equal(
    await fs.readFile(proof, "utf8"),
    "concurrent archive bytes\n"
  );
  await fs.access(
    path.join(root, ".product-ops-pack-source-state.json")
  );
});

test("archive prepack refuses CRLF normalization in promised binary bytes", async (t) => {
  const root = await makeArchiveSource(t);
  const binary = path.join(root, "docs", "binary.dat");
  await fs.writeFile(binary, Buffer.from([0, 13, 10, 255]));

  await assert.rejects(
    prepareCanonicalPackSource(root),
    /CRLF in a binary file: docs\/binary\.dat/
  );
  await assert.rejects(
    fs.access(path.join(root, ".product-ops-pack-source-state.json")),
    { code: "ENOENT" }
  );
});

async function makeCrlfCheckout(t) {
  const root = await makeTempDirectory();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  runGit(root, ["init", "-q"]);
  runGit(root, ["config", "user.email", "fixture@example.invalid"]);
  runGit(root, ["config", "user.name", "Pack Fixture"]);
  runGit(root, ["config", "core.autocrlf", "true"]);
  await fs.writeFile(
    path.join(root, ".gitattributes"),
    "* text=auto\n",
    "utf8"
  );
  await fs.writeFile(
    path.join(root, "proof.md"),
    "first line\nsecond line\n",
    "utf8"
  );
  runGit(root, ["add", ".gitattributes", "proof.md"]);
  runGit(root, ["commit", "-qm", "base"]);
  await fs.rm(path.join(root, ".gitattributes"));
  await fs.rm(path.join(root, "proof.md"));
  runGit(root, ["checkout", "--", ".gitattributes", "proof.md"]);
  return root;
}

async function makeArchiveSource(t) {
  const root = await makeTempDirectory();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "docs"));
  await fs.writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({
      name: "archive-pack-fixture",
      version: "1.0.0",
      files: ["docs"],
      bin: {
        proof: "./docs/proof.md"
      }
    }, null, 2)}\n`,
    "utf8"
  );
  await fs.writeFile(
    path.join(root, "README.md"),
    "archive readme\r\nsecond line\r\n",
    "utf8"
  );
  await fs.writeFile(
    path.join(root, "LICENSE"),
    "archive license\r\n",
    "utf8"
  );
  await fs.writeFile(
    path.join(root, "docs", "proof.md"),
    "first line\r\nsecond line\r\n",
    "utf8"
  );
  return root;
}

async function replacePathWithConcurrentBytes(file, bytes) {
  await fs.unlink(file);
  await fs.writeFile(file, bytes, { flag: "wx" });
}

async function gitPackStatePath(root) {
  const statePath = runGit(root, [
    "rev-parse",
    "--git-path",
    "product-ops-pack-source-state.json"
  ]).stdout.trim();
  return path.resolve(root, statePath);
}

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
