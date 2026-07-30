import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { npmInvocation, runProcess } from "./process-runner.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "product-ops-pack-"));
const extracted = path.join(temporary, "extracted");
const consumer = path.join(temporary, "consumer");
const generatedTarget = path.join(temporary, "installed-cli-project");
await fs.mkdir(extracted);
await fs.mkdir(consumer);

try {
  const packResult = runNpm(["pack", "--json", "--pack-destination", temporary], root);
  const [pack] = JSON.parse(packResult.stdout);
  const tarball = path.join(temporary, pack.filename);
  const tarballSha256 = sha256(await fs.readFile(tarball));
  const [expectedTarballSha256] = (
    await fs.readFile(
      path.join(root, ".github", "pack-artifact.sha256"),
      "utf8"
    )
  )
    .trim()
    .split(/\s+/);
  assert.match(expectedTarballSha256, /^[a-f0-9]{64}$/);
  assert.equal(
    tarballSha256,
    expectedTarballSha256,
    "packed artifact must match the cross-host canonical SHA-256"
  );
  run("tar", ["-xzf", tarball, "-C", extracted], root);
  const packageRoot = path.join(extracted, "arbitrary-archive-directory");
  await fs.rename(path.join(extracted, "package"), packageRoot);

  for (const required of [
    ".gitattributes",
    "npm-shrinkwrap.json",
    "tests/package.test.js",
    "scripts/check-clean-archive-pack.mjs",
    "scripts/check-clean-room.mjs",
    "scripts/check-clean-clone-pack.mjs",
    "scripts/check-cross-host-pack.mjs",
    "scripts/check-licenses.mjs",
    "scripts/check-pack-source.mjs",
    "scripts/git-fixture.mjs",
    "scripts/check-sbom.mjs",
    "scripts/process-runner.mjs",
    "scripts/sbom-contract.mjs",
    "templates/config/operating-model.yaml"
  ]) {
    await fs.access(path.join(packageRoot, required));
  }

  runNpm(["install", "--ignore-scripts", "--no-audit", "--no-fund"], packageRoot);
  for (const script of ["check", "smoke", "licenses:check", "sbom:check"]) {
    runNpm(["run", script], packageRoot);
  }
  await fs.writeFile(
    path.join(consumer, "package.json"),
    `${JSON.stringify({ name: "packed-consumer", private: true }, null, 2)}\n`
  );
  runNpm(
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
    consumer
  );
  const cliShim = path.join(
    consumer,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "product-ops.cmd" : "product-ops"
  );
  await fs.access(cliShim);
  const help = runInstalledCli(["--help"], consumer);
  assert.match(help.stdout, /Product Operations OS CLI/);
  assert.match(help.stdout, /product-ops init <target>/);
  const dryRun = runInstalledCli(
    ["init", generatedTarget, "--dry-run"],
    consumer
  );
  assert.match(dryRun.stdout, /Dry run:/);
  assert.equal(await exists(generatedTarget), false);
  runInstalledCli(["init", generatedTarget], consumer);
  runInstalledCli(["validate", generatedTarget], consumer);
  runInstalledCli(["init", generatedTarget, "--force"], consumer);
  runInstalledCli(["validate", generatedTarget], consumer);
  console.log(
    `Packed artifact ${tarballSha256} matched the cross-host hash; its installed CLI completed dry-run/init/validate/force, and tests, smoke, portability, license, and SBOM checks passed.`
  );
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}

function runNpm(args, cwd) {
  const invocation = npmInvocation(args);
  return run(invocation.command, invocation.args, cwd);
}

function runInstalledCli(args, cwd) {
  return runNpm(
    ["exec", "--offline", "--", "product-ops", ...args],
    cwd
  );
}

function run(command, args, cwd) {
  const result = runProcess(command, args, {
    cwd,
    encoding: "utf8"
  });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout || result.error?.message}`
  );
  return result;
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
