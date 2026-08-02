import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

export async function inspectCodexReadiness({
  cwd = process.cwd(),
  environment = process.env,
  findExecutable = findCodexExecutables,
  execute = captureCodexCommand
} = {}) {
  const discovered = await findExecutable({ cwd, environment });
  const candidates = (Array.isArray(discovered) ? discovered : [discovered]).filter(Boolean);
  if (candidates.length === 0) return readiness("not-installed");

  let executable = candidates[0];
  let versionResult = null;
  for (const candidate of candidates) {
    const result = await execute(candidate, ["--version"], { cwd, environment });
    if (result.ok) {
      executable = candidate;
      versionResult = result;
      break;
    }
    versionResult ??= result;
  }
  if (!versionResult?.ok) {
    return readiness("not-executable", {
      installed: true,
      executable,
      diagnostic: safeDiagnostic(versionResult)
    });
  }

  const version = firstLine(versionResult.stdout || versionResult.stderr);
  const loginResult = await execute(executable, ["login", "status"], { cwd, environment });
  if (!loginResult.ok) {
    return readiness("login-required", {
      installed: true,
      executable,
      version,
      executableUsable: true,
      diagnostic: safeDiagnostic(loginResult)
    });
  }

  return readiness("ready", {
    installed: true,
    executable,
    version,
    executableUsable: true,
    authenticated: true,
    authenticationMode: authenticationMode(loginResult.stdout || loginResult.stderr)
  });
}

export async function findCodexExecutable({ cwd = process.cwd(), environment = process.env } = {}) {
  return (await findCodexExecutables({ cwd, environment }))[0] ?? null;
}

export async function findCodexExecutables({ cwd = process.cwd(), environment = process.env } = {}) {
  const explicit = String(environment.PRODUCT_OPS_CODEX_EXECUTABLE ?? "").trim();
  const candidates = explicit
    ? executableVariants(path.resolve(cwd, explicit), environment)
    : pathCandidates("codex", cwd, environment);
  const found = [];
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) found.push(candidate);
    } catch {
      // Keep searching without invoking candidates.
    }
  }
  return [...new Set(found)];
}

export async function captureCodexCommand(
  executable,
  args,
  { cwd = process.cwd(), environment = process.env, timeoutMs = DEFAULT_TIMEOUT_MS } = {}
) {
  let command;
  try { command = await windowsCommand(executable, args); }
  catch (error) { return { ok: false, code: null, stdout: "", stderr: "", error: error.message }; }
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child;
    try {
      child = spawn(command.executable, command.args, {
        cwd,
        env: minimalEnvironment(environment),
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      finish({ ok: false, code: null, stdout, stderr, error: error.message });
      return;
    }
    const consume = (chunk, channel) => {
      const current = channel === "stdout" ? stdout : stderr;
      if (Buffer.byteLength(current, "utf8") + chunk.length > MAX_OUTPUT_BYTES) {
        child.kill();
        finish({ ok: false, code: null, stdout, stderr, error: `${channel} exceeded the readiness output limit` });
        return;
      }
      if (channel === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk) => consume(chunk, "stdout"));
    child.stderr.on("data", (chunk) => consume(chunk, "stderr"));
    child.once("error", (error) => finish({ ok: false, code: null, stdout, stderr, error: error.message }));
    child.once("close", (code) => finish({ ok: code === 0, code, stdout, stderr, error: "" }));
    timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, code: null, stdout, stderr, error: "readiness check timed out" });
    }, timeoutMs);
  });
}

function readiness(status, overrides = {}) {
  const messages = {
    "not-installed": "ابزار خط فرمان کدکس پیدا نشد.",
    "not-executable": "کدکس نصب شده است، اما موتور خط فرمان قابل اجرا نیست.",
    "login-required": "موتور کدکس آماده است، اما ورود معتبر پیدا نشد.",
    ready: "کدکس نصب، قابل اجرا و دارای ورود معتبر است."
  };
  return {
    provider: "codex",
    status,
    installed: false,
    executable: null,
    version: null,
    executableUsable: false,
    authenticated: false,
    authenticationMode: null,
    entitlementVerified: false,
    canAutomate: status === "ready",
    message: messages[status],
    diagnostic: "",
    ...overrides
  };
}

function authenticationMode(output) {
  const normalized = String(output).toLowerCase();
  if (normalized.includes("chatgpt")) return "chatgpt";
  if (normalized.includes("api key") || normalized.includes("api-key")) return "api-key";
  if (normalized.includes("access token") || normalized.includes("access-token")) return "access-token";
  return "authenticated";
}

function safeDiagnostic(result) {
  const value = firstLine(result.error || result.stderr || result.stdout);
  return value.replace(/[\r\n\t]/g, " ").slice(0, 240);
}

function firstLine(value) {
  return String(value ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

function pathCandidates(executable, cwd, environment) {
  if (executable.includes("/") || executable.includes("\\")) {
    return executableVariants(path.resolve(cwd, executable), environment);
  }
  const searchPath = environment.PATH ?? environment.Path ?? "";
  return searchPath.split(path.delimiter).filter(Boolean)
    .flatMap((directory) => executableVariants(path.join(directory, executable), environment));
}

function executableVariants(base, environment) {
  if (process.platform !== "win32" || path.extname(base)) return [base];
  const extensions = String(environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";").filter(Boolean);
  return [base, ...extensions.flatMap((extension) => [
    `${base}${extension.toLowerCase()}`,
    `${base}${extension.toUpperCase()}`
  ])];
}

async function windowsCommand(executable, args) {
  if (process.platform !== "win32" || !/\.(?:cmd|bat)$/i.test(executable)) {
    return { executable, args };
  }
  if (path.basename(executable).toLowerCase() !== "codex.cmd") {
    throw new Error("Codex readiness refuses non-Codex Windows batch launchers.");
  }
  const javascriptLauncher = path.join(path.dirname(executable), "node_modules", "@openai", "codex", "bin", "codex.js");
  try { await fs.access(javascriptLauncher); }
  catch { throw new Error("The Codex command shim has no resolvable shell-free JavaScript launcher."); }
  const bundledNode = path.join(path.dirname(executable), "node.exe");
  let nodeExecutable = process.execPath;
  try { await fs.access(bundledNode); nodeExecutable = bundledNode; }
  catch { /* Use the trusted Node runtime already running Product Operations OS. */ }
  return { executable: nodeExecutable, args: [javascriptLauncher, ...args] };
}

function minimalEnvironment(environment) {
  const allowed = [
    "PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "WINDIR", "COMSPEC", "ComSpec",
    "TEMP", "TMP", "TMPDIR", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "HOME",
    "CODEX_HOME", "LANG", "LC_ALL", "NO_COLOR"
  ];
  return Object.fromEntries(allowed
    .filter((name) => environment[name] !== undefined)
    .map((name) => [name, environment[name]]));
}
