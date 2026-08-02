import crypto from "node:crypto";
import http from "node:http";
import { loadConfig, validateConfig, validateConfigRelationships } from "../config.js";
import { decideApproval } from "./approvals.js";
import { loadDashboardSnapshot } from "./dashboard.js";
import { renderDashboard } from "./dashboard-view.js";
import { runControlTower } from "./control-tower.js";
import { ingestRecord } from "./intake.js";
import { startAutopilotLoop } from "../autopilot/orchestrator.js";
import { patchAutopilotState, readAutomationLink, readAutopilotState } from "../autopilot/state.js";

const MAX_BODY_BYTES = 64 * 1024;

export async function startDashboardServer(
  root,
  { port = 4173, writable = false, host = "127.0.0.1" } = {}
) {
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new Error("Dashboard server may bind only to a loopback address.");
  }
  const parsedPort = Number(port);
  if (!Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65535) {
    throw new Error("Dashboard port must be an integer between 0 and 65535.");
  }
  await validatedConfig(root);
  const automationLink = await readAutomationLink(root).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const autopilot = writable && automationLink?.autoStart ? startAutopilotLoop(root) : null;
  const csrfToken = crypto.randomBytes(32).toString("base64url");
  const server = http.createServer((request, response) => {
    handleRequest(root, { writable, csrfToken, request, response, autopilot }).catch((error) => {
      if (!response.headersSent) setSecurityHeaders(response);
      sendJson(response, error.statusCode ?? 500, {
        error: error.statusCode ? error.message : "Dashboard request failed safely."
      });
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(parsedPort, host, resolve);
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : parsedPort;
  return {
    server,
    url: `http://${host === "::1" ? "[::1]" : host}:${actualPort}`,
    writable,
    close: async () => {
      await autopilot?.close();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

async function handleRequest(root, { writable, csrfToken, request, response, autopilot }) {
  setSecurityHeaders(response);
  const base = `http://${request.headers.host ?? "127.0.0.1"}`;
  const url = new URL(request.url ?? "/", base);
  if (request.method === "GET" && url.pathname === "/") {
    const nonce = crypto.randomBytes(18).toString("base64url");
    setSecurityHeaders(response, nonce);
    const snapshot = await loadDashboardSnapshot(root, { mode: "live", writable });
    const html = renderDashboard(snapshot, { csrfToken, live: true, nonce });
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/snapshot") {
    sendJson(response, 200, await loadDashboardSnapshot(root, { mode: "live", writable }));
    return;
  }
  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { status: "ok", writable });
    return;
  }
  if (request.method === "POST") {
    assertMutationAllowed({ writable, csrfToken, request });
    const body = await readJsonBody(request);
    if (url.pathname === "/api/intake") {
      const result = await ingestRecord(root, { ...body, autopilotAuthorized: true }, { dryRun: false });
      if (autopilot) void autopilot.runNow();
      sendJson(response, 201, result);
      return;
    }
    if (url.pathname === "/api/operate") {
      if (autopilot) throw httpError(409, "The continuous orchestrator owns product-cycle routing in this workspace.");
      const config = await validatedConfig(root);
      const receipt = await runControlTower(root, config, {
        dryRun: false,
        executeDevelopment: false
      });
      sendJson(response, 200, receipt);
      return;
    }
    if (url.pathname === "/api/autopilot/pause") {
      const result = await patchAutopilotState(root, { status: "paused" });
      sendJson(response, 200, result);
      return;
    }
    if (["/api/autopilot/start", "/api/autopilot/resume", "/api/autopilot/retry"].includes(url.pathname)) {
      if (!autopilot) throw httpError(409, "Autopilot is not configured for this workspace.");
      const current = await readAutopilotState(root);
      const result = await patchAutopilotState(root, {
        status: "idle",
        attempt: url.pathname.endsWith("/retry") ? 0 : current.attempt,
        lastError: url.pathname.endsWith("/retry") ? null : current.lastError
      });
      void autopilot.runNow();
      sendJson(response, 202, result);
      return;
    }
    const approvalMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/decision$/);
    if (approvalMatch) {
      const config = await validatedConfig(root);
      const result = await decideApproval(root, config, {
        requestId: decodeURIComponent(approvalMatch[1]),
        decision: body.decision,
        actorId: body.actorId,
        rationale: body.rationale
      }, { dryRun: false });
      sendJson(response, 200, result);
      return;
    }
  }
  sendJson(response, 404, { error: "Dashboard route not found." });
}

function assertMutationAllowed({ writable, csrfToken, request }) {
  if (!writable) throw httpError(403, "Dashboard is running in read-only mode.");
  if (request.headers["x-product-ops-csrf"] !== csrfToken) {
    throw httpError(403, "Dashboard request did not include the active local authorization token.");
  }
  const origin = request.headers.origin;
  if (origin) {
    const parsed = new URL(origin);
    if (!["127.0.0.1", "[::1]", "::1", "localhost"].includes(parsed.hostname)) {
      throw httpError(403, "Dashboard mutation origin must be local.");
    }
  }
}

async function readJsonBody(request) {
  if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
    throw httpError(415, "Dashboard mutations require application/json.");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw httpError(413, "Dashboard request body is too large.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw httpError(400, "Dashboard request body is not valid JSON.");
  }
}

async function validatedConfig(root) {
  const config = await loadConfig(root);
  const schemaErrors = validateConfig(config);
  const errors = [...schemaErrors, ...(schemaErrors.length === 0 ? validateConfigRelationships(config) : [])];
  if (errors.length > 0) throw new Error(`Project configuration is invalid:\n- ${errors.join("\n- ")}`);
  return config;
}

function setSecurityHeaders(response, nonce = "") {
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-security-policy", `default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'${nonce ? ` 'nonce-${nonce}'` : " 'none'"}; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
  response.setHeader("cross-origin-opener-policy", "same-origin");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(value)}\n`);
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
