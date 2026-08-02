import assert from "node:assert/strict";
import test from "node:test";
import { inspectCodexReadiness } from "../src/codex/readiness.js";

test("Codex readiness distinguishes missing installation from a usable authenticated CLI", async () => {
  const missing = await inspectCodexReadiness({
    findExecutable: async () => []
  });
  assert.equal(missing.status, "not-installed");
  assert.equal(missing.canAutomate, false);

  const calls = [];
  const ready = await inspectCodexReadiness({
    findExecutable: async () => ["C:/tools/codex.exe"],
    execute: async (_executable, args) => {
      calls.push(args);
      if (args[0] === "--version") return { ok: true, stdout: "codex-cli 1.2.3\n", stderr: "" };
      return { ok: true, stdout: "Logged in using ChatGPT\n", stderr: "" };
    }
  });
  assert.equal(ready.status, "ready");
  assert.equal(ready.authenticationMode, "chatgpt");
  assert.equal(ready.version, "codex-cli 1.2.3");
  assert.equal(ready.entitlementVerified, false);
  assert.equal(ready.canAutomate, true);
  assert.deepEqual(calls, [["--version"], ["login", "status"]]);
});

test("Codex readiness tries another discovered executable when a desktop alias is not runnable", async () => {
  const ready = await inspectCodexReadiness({
    findExecutable: async () => ["C:/WindowsApps/codex.exe", "C:/npm/codex.cmd"],
    execute: async (executable, args) => {
      if (executable.includes("WindowsApps")) {
        return { ok: false, stdout: "", stderr: "Access is denied", error: "" };
      }
      if (args[0] === "--version") return { ok: true, stdout: "codex 2.0.0", stderr: "" };
      return { ok: true, stdout: "Authenticated with API key", stderr: "" };
    }
  });
  assert.equal(ready.status, "ready");
  assert.equal(ready.executable, "C:/npm/codex.cmd");
  assert.equal(ready.authenticationMode, "api-key");
});

test("Codex readiness never treats installation as authentication", async () => {
  const result = await inspectCodexReadiness({
    findExecutable: async () => "C:/tools/codex.exe",
    execute: async (_executable, args) => args[0] === "--version"
      ? { ok: true, stdout: "codex 3.0.0", stderr: "" }
      : { ok: false, stdout: "", stderr: "Not logged in", error: "" }
  });
  assert.equal(result.status, "login-required");
  assert.equal(result.installed, true);
  assert.equal(result.executableUsable, true);
  assert.equal(result.authenticated, false);
  assert.equal(result.canAutomate, false);
});
