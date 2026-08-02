import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { validatePublishedSchema } from "../schema-validation.js";

const ROOT = ".product-ops/runtime/autopilot";
const STATE_FILE = `${ROOT}/state.json`;
const LINK_FILE = ".product-ops/runtime/automation/link.json";
const LEASE_FILE = `${ROOT}/orchestrator.lease.json`;
const EVENT_FILE = `${ROOT}/events.jsonl`;

export function emptyAutopilotState(now = new Date()) {
  return {
    schemaVersion: "1.0.0",
    status: "idle",
    activeCycleId: null,
    activeEventId: null,
    phase: "idle",
    currentTaskId: null,
    currentRoleId: null,
    applicationRoot: null,
    attempt: 0,
    startedAt: null,
    updatedAt: now.toISOString(),
    completedAt: null,
    lastError: null,
    latestReport: null
  };
}

export async function readAutopilotState(root) {
  try {
    const value = JSON.parse(await fs.readFile(path.join(root, STATE_FILE), "utf8"));
    assertSchema("autopilot-state.schema.json", value, "Autopilot state");
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return emptyAutopilotState();
    throw error;
  }
}

export async function writeAutopilotState(root, value) {
  assertSchema("autopilot-state.schema.json", value, "Autopilot state");
  const target = path.join(root, STATE_FILE);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await replaceFile(temporary, target);
  return value;
}

export async function patchAutopilotState(root, patch, now = new Date()) {
  const current = await readAutopilotState(root);
  return writeAutopilotState(root, { ...current, ...patch, updatedAt: now.toISOString() });
}

export async function readAutomationLink(root) {
  const file = path.join(root, LINK_FILE);
  const value = JSON.parse(await fs.readFile(file, "utf8"));
  assertSchema("automation-link.schema.json", value, "Automation link");
  const applicationRoot = path.resolve(root, value.applicationRelativePath);
  if (samePath(root, applicationRoot)) throw new Error("Automation application repository must be separate from Product Operations.");
  const stat = await fs.lstat(applicationRoot).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error("Linked application repository is unavailable or unsafe.");
  const config = await fs.lstat(path.join(applicationRoot, "development-os.config.json")).catch(() => null);
  if (!config?.isFile() || config.isSymbolicLink()) throw new Error("Linked application does not contain a safe Development OS configuration.");
  return { ...value, applicationRoot };
}

export async function writeAutomationLink(root, value) {
  assertSchema("automation-link.schema.json", value, "Automation link");
  const target = path.join(root, LINK_FILE);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function appendAutopilotEvent(root, event) {
  const directory = path.join(root, ROOT);
  await fs.mkdir(directory, { recursive: true });
  const safe = {
    schemaVersion: "1.0.0",
    eventId: crypto.randomUUID(),
    at: new Date().toISOString(),
    ...event
  };
  await fs.appendFile(path.join(root, EVENT_FILE), `${JSON.stringify(safe)}\n`, "utf8");
  return safe;
}

export async function readAutopilotEvents(root, limit = 200) {
  try {
    const lines = (await fs.readFile(path.join(root, EVENT_FILE), "utf8")).trim().split(/\r?\n/).filter(Boolean);
    return lines.slice(-Math.max(1, Math.min(limit, 1000))).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export async function acquireAutopilotLease(root, { ttlMs = 24 * 60 * 60 * 1000, now = new Date() } = {}) {
  const target = path.join(root, LEASE_FILE);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const token = crypto.randomUUID();
  const lease = {
    token,
    pid: process.pid,
    acquiredAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString()
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fs.writeFile(target, `${JSON.stringify(lease)}\n`, { encoding: "utf8", flag: "wx" });
      return { ...lease, file: target };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = await readJson(target).catch(() => null);
      if (existing?.expiresAt && Date.parse(existing.expiresAt) > now.getTime() && processIsAlive(existing.pid)) {
        return null;
      }
      const stale = `${target}.stale.${crypto.randomUUID()}.json`;
      try { await fs.rename(target, stale); }
      catch (renameError) { if (renameError.code !== "ENOENT") throw renameError; }
    }
  }
  return null;
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export async function renewAutopilotLease(lease, { ttlMs = 24 * 60 * 60 * 1000, now = new Date() } = {}) {
  if (!lease?.file || !lease.token) throw new Error("Cannot renew an invalid autopilot lease.");
  const existing = await readJson(lease.file);
  if (existing.token !== lease.token) throw new Error("Autopilot lease ownership changed while the cycle was running.");
  const renewed = { ...existing, expiresAt: new Date(now.getTime() + ttlMs).toISOString() };
  const temporary = `${lease.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(renewed)}\n`, { encoding: "utf8", flag: "wx" });
  await replaceFile(temporary, lease.file);
  return { ...renewed, file: lease.file };
}

export async function releaseAutopilotLease(lease) {
  if (!lease?.file || !lease.token) return;
  const existing = await readJson(lease.file).catch(() => null);
  if (existing?.token !== lease.token) return;
  await fs.rm(lease.file, { force: true });
}

function assertSchema(schema, value, label) {
  const errors = validatePublishedSchema(schema, value);
  if (errors.length) throw new Error(`${label} is invalid:\n- ${errors.join("\n- ")}`);
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function replaceFile(temporary, target) {
  if (process.platform !== "win32") {
    await fs.rename(temporary, target);
    return;
  }
  const backup = `${target}.${crypto.randomUUID()}.bak`;
  let backedUp = false;
  try {
    await fs.rename(target, backup);
    backedUp = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    await fs.rename(temporary, target);
    if (backedUp) await fs.rm(backup, { force: true });
  } catch (error) {
    if (backedUp) await fs.rename(backup, target).catch(() => {});
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export const AUTOPILOT_PATHS = Object.freeze({ root: ROOT, state: STATE_FILE, link: LINK_FILE, events: EVENT_FILE });
