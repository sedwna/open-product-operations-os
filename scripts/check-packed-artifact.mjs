import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "product-ops-pack-"));
const extracted = path.join(temporary, "extracted");
const consumer = path.join(temporary, "consumer");
await fs.mkdir(extracted);
await fs.mkdir(consumer);

try {
  const packResult = runNpm(["pack", "--json", "--pack-destination", temporary], root);
  const [pack] = JSON.parse(packResult.stdout);
  const tarball = path.join(temporary, pack.filename);
  run("tar", ["-xzf", tarball, "-C", extracted], root);
  const packageRoot = path.join(extracted, "arbitrary-archive-directory");
  await fs.rename(path.join(extracted, "package"), packageRoot);

  for (const required of [
    ".gitattributes",
    "npm-shrinkwrap.json",
    "tests/package.test.js",
    "scripts/check-licenses.mjs",
    "scripts/check-sbom.mjs",
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
  const cli = path.join(
    consumer,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "product-ops.cmd" : "product-ops"
  );
  const help = run(cli, ["--help"], consumer);
  assert.match(help.stdout, /Product Operations OS CLI/);
  assert.match(help.stdout, /product-ops init <target>/);
  console.log(
    "Packed artifact installed, its consumer CLI executed, and tests, smoke, portability, license, and SBOM checks passed."
  );
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}

function runNpm(args, cwd) {
  const npmCli = process.env.npm_execpath;
  return npmCli
    ? run(process.execPath, [npmCli, ...args], cwd)
    : run(process.platform === "win32" ? "npm.cmd" : "npm", args, cwd);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell: process.platform === "win32" && command.endsWith(".cmd")
  });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout || result.error?.message}`
  );
  return result;
}
