import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { inspectOnboardingEnvironment, normalizeOnboardingRequest, runOnboarding } from "./service.js";
import { renderOnboarding } from "./view.js";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_LOG_LINES = 320;

export async function startOnboardingServer(
  repoRoot,
  {
    host = "127.0.0.1",
    port = 0,
    openBrowser = true,
    skipDependencyInstall = false,
    dashboardLauncher = launchDashboard,
    closeAfterCompletion = true
  } = {}
) {
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new Error("Onboarding may bind only to a loopback address.");
  }
  const root = path.resolve(repoRoot);
  await assertRepository(root);
  const csrfToken = crypto.randomBytes(32).toString("base64url");
  const preflight = await inspectOnboardingEnvironment(root);
  const job = { status: "idle", steps: [], logs: [], result: null, error: null, dashboardUrl: null };
  const server = http.createServer((request, response) => {
    handleRequest({
      root, csrfToken, preflight, job, request, response, skipDependencyInstall,
      server, dashboardLauncher, closeAfterCompletion
    })
      .catch((error) => {
        setSecurityHeaders(response);
        sendJson(response, error.statusCode ?? 500, {
          error: error.statusCode ? error.message : "راه‌اندازی به‌صورت ایمن متوقف شد."
        });
      });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const url = `http://${host === "::1" ? "[::1]" : host}:${actualPort}`;
  if (openBrowser) await openLocalUrl(url);
  return {
    server,
    url,
    job,
    csrfToken,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

async function handleRequest(context) {
  const { request, response, csrfToken, preflight, job, root } = context;
  setSecurityHeaders(response);
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  if (request.method === "GET" && url.pathname === "/") {
    const nonce = crypto.randomBytes(18).toString("base64url");
    setSecurityHeaders(response, nonce);
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(renderOnboarding({ csrfToken, nonce, preflight }));
    return;
  }
  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { status: "ok" });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/status") {
    assertLocalAuthorization(request, csrfToken);
    sendJson(response, 200, job);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/apply") {
    assertLocalAuthorization(request, csrfToken);
    if (job.status === "running") throw httpError(409, "راه‌اندازی دیگری در حال اجرا است.");
    if (job.status === "completed") throw httpError(409, "راه‌اندازی این نشست قبلاً کامل شده است.");
    const body = await readJsonBody(request);
    let normalized;
    try {
      normalized = normalizeOnboardingRequest(body, { repoRoot: root });
    } catch (error) {
      throw httpError(422, safeError(error));
    }
    resetJob(job);
    void executeJob(context, normalized);
    sendJson(response, 202, { status: "running" });
    return;
  }
  sendJson(response, 404, { error: "مسیر درخواستی پیدا نشد." });
}

async function executeJob(context, normalized) {
  const { job, root, skipDependencyInstall, server, dashboardLauncher, closeAfterCompletion } = context;
  job.status = "running";
  try {
    const result = await runOnboarding(normalized, {
      repoRoot: root,
      skipDependencyInstall,
      onProgress(update) {
        const previous = job.steps.find((item) => item.id === update.id);
        if (previous) Object.assign(previous, update);
        else job.steps.push({ ...update });
        if (update.message && update.message !== "شروع شد" && update.message !== "انجام شد") {
          job.logs.push(`[${update.id}] ${stripControlCharacters(update.message)}`);
          if (job.logs.length > MAX_LOG_LINES) job.logs.splice(0, job.logs.length - MAX_LOG_LINES);
        }
      }
    });
    const dashboardUrl = await dashboardLauncher(root, result.operationsPath, result.dashboardWritable);
    job.result = result;
    job.dashboardUrl = dashboardUrl;
    job.status = "completed";
    if (closeAfterCompletion) setTimeout(() => server.close(), 30_000).unref?.();
  } catch (error) {
    job.error = safeError(error);
    job.status = "failed";
  }
}

export async function launchDashboard(repoRoot, operationsPath, writable) {
  const port = await findAvailablePort(4173, 40);
  const args = [path.join(repoRoot, "src", "cli.js"), "dashboard", operationsPath, "--serve", "--port", String(port)];
  if (writable) args.push("--apply");
  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: minimalEnvironment()
  });
  child.unref();
  const url = `http://127.0.0.1:${port}`;
  await waitForHealth(`${url}/health`, 15_000);
  return url;
}

async function findAvailablePort(start, attempts) {
  for (let port = start; port < start + attempts; port += 1) {
    if (await canListen(port)) return port;
  }
  throw new Error("هیچ درگاه محلی آزادی برای پنل پیدا نشد.");
}

function canListen(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

async function waitForHealth(url, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 180));
  }
  throw new Error("پنل ساخته شد اما در مهلت تعیین‌شده پاسخ نداد.");
}

export async function openLocalUrl(url) {
  const command = process.platform === "win32"
    ? ["cmd.exe", ["/d", "/s", "/c", "start", "", url]]
    : process.platform === "darwin"
      ? ["open", [url]]
      : ["xdg-open", [url]];
  return new Promise((resolve) => {
    const child = spawn(command[0], command[1], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      shell: false,
      env: minimalEnvironment()
    });
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}

function assertLocalAuthorization(request, csrfToken) {
  if (request.headers["x-product-ops-csrf"] !== csrfToken) {
    throw httpError(403, "مجوز نشست محلی معتبر نیست.");
  }
  const origin = request.headers.origin;
  if (origin) {
    const hostname = new URL(origin).hostname;
    if (!["127.0.0.1", "[::1]", "::1", "localhost"].includes(hostname)) {
      throw httpError(403, "درخواست باید از همان رایانه ارسال شود.");
    }
  }
}

async function readJsonBody(request) {
  if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
    throw httpError(415, "درخواست باید از نوع دادهٔ ساخت‌یافته باشد.");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw httpError(413, "اندازهٔ درخواست بیش از حد مجاز است.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw httpError(400, "ساختار درخواست معتبر نیست.");
  }
}

async function assertRepository(root) {
  for (const relative of ["package.json", "src/cli.js", "templates", "schemas"]) {
    if (!await fs.access(path.join(root, relative)).then(() => true, () => false)) {
      throw new Error("راه‌انداز باید از داخل مخزن کامل پروژه اجرا شود.");
    }
  }
}

function resetJob(job) {
  job.status = "running";
  job.steps = [];
  job.logs = [];
  job.result = null;
  job.error = null;
  job.dashboardUrl = null;
}

function setSecurityHeaders(response, nonce = "") {
  if (response.headersSent) return;
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-security-policy", `default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'${nonce ? ` 'nonce-${nonce}'` : " 'none'"}; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
  response.setHeader("cross-origin-opener-policy", "same-origin");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
}

function sendJson(response, statusCode, value) {
  if (response.headersSent) return;
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(value)}\n`);
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function stripControlCharacters(value) {
  return String(value).replace(/\u001b\[[0-9;]*m/g, "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, 800);
}

function safeError(error) {
  return stripControlCharacters(error?.message || "راه‌اندازی ناموفق بود.").replace(/[\r\n]+/g, " ").slice(0, 1600);
}

function minimalEnvironment() {
  const allowed = [
    "PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "WINDIR", "COMSPEC",
    "TEMP", "TMP", "TMPDIR", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "HOME", "LANG", "LC_ALL"
  ];
  return Object.fromEntries(allowed.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
}
