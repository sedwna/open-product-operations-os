#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const launcherRoot = path.join(root, "launchers");
const packedArtifact = process.env.PRODUCT_OPS_PACKED_ARTIFACT === "1";
const required = [
  "common/bootstrap-node.sh",
  "linux/open-product-os.sh",
  "linux/OpenProductOS.desktop",
  "macos/OpenProductOS.command",
  "windows/OpenProductOS.cmd",
  "windows/OpenProductOS.ps1",
  "windows/OpenProductOS.cs",
  "windows/OpenProductOS.exe",
  "windows/OpenProductOS.exe.sha256",
  "windows/build.ps1"
];

for (const relative of required) await fs.access(path.join(launcherRoot, relative));

const executable = await fs.readFile(path.join(launcherRoot, "windows", "OpenProductOS.exe"));
assert.equal(executable.subarray(0, 2).toString("ascii"), "MZ", "Windows launcher must be a PE executable");
const expectedHash = (await fs.readFile(path.join(launcherRoot, "windows", "OpenProductOS.exe.sha256"), "utf8"))
  .trim()
  .split(/\s+/)[0];
assert.match(expectedHash, /^[a-f0-9]{64}$/);
assert.equal(crypto.createHash("sha256").update(executable).digest("hex"), expectedHash);

const powershell = await fs.readFile(path.join(launcherRoot, "windows", "OpenProductOS.ps1"), "utf8");
const posix = await fs.readFile(path.join(launcherRoot, "common", "bootstrap-node.sh"), "utf8");
const desktop = await fs.readFile(path.join(launcherRoot, "linux", "OpenProductOS.desktop"), "utf8");
for (const source of [powershell, posix]) {
  assert.match(source, /latest-v22\.x/, "portable runtime must use the maintained Node.js 22 line");
  assert.match(source, /SHA|sha256|shasum|Get-FileHash/i, "portable runtime downloads must be integrity checked");
}
assert.match(desktop, /^\[Desktop Entry\]$/m);
assert.match(desktop, /^Terminal=true$/m);

if (process.platform === "win32") {
  const command = [
    "$errors=$null;",
    "[System.Management.Automation.Language.Parser]::ParseFile(",
    `'${path.join(launcherRoot, "windows", "OpenProductOS.ps1").replaceAll("'", "''")}',`,
    "[ref]$null,[ref]$errors) | Out-Null;",
    "if($errors.Count){$errors | ForEach-Object { Write-Error $_ }; exit 1}"
  ].join(" ");
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", command], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || "PowerShell launcher must parse");
} else {
  for (const relative of ["common/bootstrap-node.sh", "linux/open-product-os.sh", "macos/OpenProductOS.command"]) {
    const filename = path.join(launcherRoot, relative);
    const result = spawnSync("sh", ["-n", filename], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || `${relative} must parse`);
    const mode = (await fs.stat(filename)).mode & 0o777;
    if (packedArtifact) {
      assert.equal(
        mode & 0o111,
        0,
        `${relative} must use the canonical packed-artifact mode`
      );
    } else {
      assert.ok((mode & 0o111) !== 0, `${relative} must be executable`);
    }
  }
}

process.stdout.write("One-click launchers are complete, parseable, and integrity checked.\n");
