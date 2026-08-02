import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { captureClaudeCommand, inspectClaudeReadiness } from "../src/claude/readiness.js";
import { makeTempDirectory } from "./helpers.js";

test("Claude readiness distinguishes installation, login, and a usable authenticated CLI", async () => {
  const missing = await inspectClaudeReadiness({
    findExecutable: async () => [],
    execute: async () => { throw new Error("must not execute"); }
  });
  assert.equal(missing.status, "not-installed");

  const loginRequired = await inspectClaudeReadiness({
    findExecutable: async () => ["C:/tools/claude.exe"],
    execute: async (_executable, args) => args[0] === "--version"
      ? { ok: true, stdout: "2.1.220 (Claude Code)\n", stderr: "" }
      : { ok: false, code: 1, stdout: '{"loggedIn":false}', stderr: "" }
  });
  assert.equal(loginRequired.status, "login-required");
  assert.equal(loginRequired.executableUsable, true);
  assert.equal(loginRequired.authenticated, false);

  const ready = await inspectClaudeReadiness({
    findExecutable: async () => ["C:/tools/claude.exe"],
    execute: async (_executable, args) => args[0] === "--version"
      ? { ok: true, stdout: "2.1.220 (Claude Code)\n", stderr: "" }
      : { ok: true, code: 0, stdout: '{"loggedIn":true,"authMethod":"claude.ai subscription","apiProvider":"firstParty"}', stderr: "" }
  });
  assert.equal(ready.status, "ready");
  assert.equal(ready.canAutomate, true);
  assert.equal(ready.authenticationMode, "claude-subscription");
  assert.equal(ready.version, "2.1.220 (Claude Code)");
});

test("Claude readiness tries another discovered executable", async () => {
  const ready = await inspectClaudeReadiness({
    findExecutable: async () => ["C:/broken/claude.exe", "C:/working/claude.exe"],
    execute: async (executable, args) => {
      if (executable.includes("broken")) return { ok: false, stdout: "", stderr: "broken" };
      if (args[0] === "--version") return { ok: true, stdout: "claude 2.2.0", stderr: "" };
      return { ok: true, stdout: '{"loggedIn":true,"authMethod":"apiKey","apiProvider":"anthropic"}', stderr: "" };
    }
  });
  assert.equal(ready.executable, "C:/working/claude.exe");
  assert.equal(ready.authenticationMode, "api-key");
});

test("Claude readiness never treats installation as authentication", async () => {
  const result = await inspectClaudeReadiness({
    findExecutable: async () => "C:/tools/claude.exe",
    execute: async (_executable, args) => args[0] === "--version"
      ? { ok: true, stdout: "claude 2.1.220", stderr: "" }
      : { ok: true, stdout: '{"loggedIn":false}', stderr: "" }
  });
  assert.equal(result.status, "login-required");
  assert.equal(result.canAutomate, false);
});

test("Claude readiness does not cross an arbitrary Windows batch boundary", { skip: process.platform !== "win32" }, async () => {
  const result = await captureClaudeCommand("C:/tools/not-claude.cmd", ["argument & untrusted"]);
  assert.equal(result.ok, false);
  assert.match(result.error, /refuses non-Claude Windows batch launchers/);
});

test("Claude readiness resolves the current official Windows native npm launcher without cmd.exe", { skip: process.platform !== "win32" }, async (t) => {
  const root = await makeTempDirectory("product-ops-claude-native-");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const packageBin = path.join(root, "node_modules", "@anthropic-ai", "claude-code", "bin");
  await fs.mkdir(packageBin, { recursive: true });
  await fs.writeFile(path.join(root, "claude.cmd"), "@echo off\r\n", "utf8");
  await fs.copyFile(process.execPath, path.join(packageBin, "claude.exe"));

  const result = await captureClaudeCommand(path.join(root, "claude.cmd"), ["--version"], { cwd: root });
  assert.equal(result.ok, true, result.error || result.stderr);
  assert.match(result.stdout, /^v\d+/);
});
