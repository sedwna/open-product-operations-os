import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { run } from "../src/cli.js";
import { captureIo, makeTempDirectory, readJson } from "./helpers.js";

test("init-suite creates one Git repository with independent Product and Development roots", async (t) => {
  const parent = await makeTempDirectory("product-suite-");
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "sample-suite");
  const output = captureIo();

  assert.equal(await run(["init-suite", root, "--provider", "codex"], output.io), 0);
  assert.equal(await run(["validate-suite", root], output.io), 0);

  const productConfig = await readJson(path.join(root, "product", "product-ops.config.json"));
  const developmentConfig = await readJson(path.join(root, "development", "development-os.config.json"));
  const link = await readJson(path.join(root, "product", ".product-ops", "runtime", "automation", "link.json"));

  assert.equal(productConfig.project.id, "sample-suite");
  assert.equal(productConfig.agents.length, 13);
  assert.equal(developmentConfig.project.id, "sample-suite");
  assert.equal(developmentConfig.roles.length, 15);
  assert.equal(link.applicationRelativePath, "../development");
  assert.equal(link.provider, "codex");
  assert.equal(link.productExecutorsEnabled, false);
  assert.equal(link.engineeringExecutorsEnabled, false);

  await fs.access(path.join(root, "product", "taskboard", "tasks.csv"));
  await fs.access(path.join(root, "development", "engineering", "taskboard", "workstreams.csv"));
  await fs.access(path.join(root, "README.md"));
  await fs.access(path.join(root, "AGENTS.md"));
  await fs.access(path.join(root, ".git"));
  await assert.rejects(fs.access(path.join(root, "product", ".git")), { code: "ENOENT" });
  await assert.rejects(fs.access(path.join(root, "development", ".git")), { code: "ENOENT" });

  assert.match(output.stdout.join("\n"), /Suite validation passed/);
  assert.match(output.stdout.join("\n"), /13 Product roles/);
  assert.match(output.stdout.join("\n"), /15 Engineering roles/);
});

test("init-suite dry-run describes both roots without creating the repository", async (t) => {
  const parent = await makeTempDirectory("product-suite-dry-");
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "dry-suite");
  const output = captureIo();

  assert.equal(await run(["init-suite", root, "--dry-run"], output.io), 0);
  await assert.rejects(fs.access(root), { code: "ENOENT" });
  const report = output.stdout.join("\n");
  assert.match(report, /Product\/Development suite/);
  assert.match(report, /product\//);
  assert.match(report, /development\//);
  assert.match(report, /one Git history/);
});

test("validate-suite rejects a nested Git history under either authority root", async (t) => {
  const parent = await makeTempDirectory("product-suite-nested-git-");
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "nested-suite");
  const output = captureIo();

  assert.equal(await run(["init-suite", root, "--no-git"], output.io), 0);
  await fs.mkdir(path.join(root, "development", ".git"));

  assert.equal(await run(["validate-suite", root], output.io), 1);
  assert.match(output.stderr.at(-1), /Nested Git history is not allowed/);
});
