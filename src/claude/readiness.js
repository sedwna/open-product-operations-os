import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

export async function inspectClaudeReadiness({
  cwd = process.cwd(),
  environment = process.env,
  findExecutable = findClaudeExecutables,
  execute = captureClaudeCommand
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
  const authResult = await execute(executable, ["auth", "status"], { cwd, environment });
  const auth = parseAuthenticationStatus(authResult.stdout);
  if (!authResult.ok || auth?.loggedIn !== true) {
    return readiness("login-required", {
      installed: true,
      executable,
      version,
      executableUsable: true,
      diagnostic: safeDiagnostic(authResult)
    });
  }

  return readiness("ready", {
    installed: true,
    executable,
    version,
    executableUsable: true,
    authenticated: true,
    authenticationMode: authenticationMode(auth)
  });
}

export async function findClaudeExecutable({ cwd = process.cwd(), environment = process.env } = {}) {
  return (await findClaudeExecutables({ cwd, environment }))[0] ?? null;
}

export async function findClaudeExecutables({ cwd = process.cwd(), environment = process.env } = {}) {
  const explicit = String(environment.PRODUCT_OPS_CLAUDE_EXECUTABLE ?? "").trim();
  const candidates = explicit
    ? executableVariants(path.resolve(cwd, explicit), environment)
    : pathCandidates("claude", cwd, environment);
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

export async function captureClaudeCommand(
  executable,
  args,
  {
    cwd = process.cwd(),
    environment = process.env,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxOutputBytes = MAX_OUTPUT_BYTES
  } = {}
) {
  const outputLimit = Number.isSafeInteger(maxOutputBytes) && maxOutputBytes >= 1024
    ? maxOutputBytes
    : MAX_OUTPUT_BYTES;
  let command;
  try { command = await resolveClaudeCommand(executable, args); }
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
      if (Buffer.byteLength(current, "utf8") + chunk.length > outputLimit) {
        child.kill();
        finish({ ok: false, code: null, stdout, stderr, error: `${channel} exceeded the configured output limit` });
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
    "not-installed": "ابزار خط فرمان کلاد کد پیدا نشد.",
    "not-executable": "کلاد کد نصب شده است، اما موتور خط فرمان قابل اجرا نیست.",
    "login-required": "موتور کلاد کد آماده است، اما ورود معتبر پیدا نشد.",
    ready: "کلاد کد نصب، قابل اجرا و دارای ورود معتبر است."
  };
  return {
    provider: "claude",
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

function parseAuthenticationStatus(output) {
  try {
    const value = JSON.parse(String(output ?? "").trim());
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function authenticationMode(auth) {
  const normalized = `${auth?.authMethod ?? ""} ${auth?.apiProvider ?? ""}`.toLowerCase();
  if (normalized.includes("subscription") || normalized.includes("claude.ai") || normalized.includes("oauth")) return "claude-subscription";
  if (normalized.includes("api") || normalized.includes("console")) return "api-key";
  if (normalized.includes("bedrock")) return "bedrock";
  if (normalized.includes("vertex")) return "vertex";
  if (normalized.includes("foundry")) return "foundry";
  return "authenticated";
}

function safeDiagnostic(result) {
  const value = firstLine(result?.error || result?.stderr || result?.stdout);
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

export async function resolveClaudeCommand(executable, args) {
  if (process.platform !== "win32" || !/\.(?:cmd|bat)$/i.test(executable)) {
    return { executable, args };
  }
  if (path.basename(executable).toLowerCase() !== "claude.cmd") {
    throw new Error("Claude readiness refuses non-Claude Windows batch launchers.");
  }
  const packageRoot = path.join(path.dirname(executable), "node_modules", "@anthropic-ai", "claude-code");
  const nativeLauncher = path.join(packageRoot, "bin", "claude.exe");
  try {
    await fs.access(nativeLauncher);
    return { executable: nativeLauncher, args };
  } catch {
    // Older official npm releases use the JavaScript launcher below.
  }
  const javascriptLauncher = path.join(packageRoot, "cli.js");
  try { await fs.access(javascriptLauncher); }
  catch { throw new Error("The Claude command shim has no resolvable package-owned native or JavaScript launcher."); }
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
    "CLAUDE_CONFIG_DIR", "LANG", "LC_ALL", "NO_COLOR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"
  ];
  return Object.fromEntries(allowed
    .filter((name) => environment[name] !== undefined)
    .map((name) => [name, environment[name]]));
}
