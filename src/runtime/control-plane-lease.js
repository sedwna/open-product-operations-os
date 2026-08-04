import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { RUNTIME_DIRECTORY } from "../constants.js";
import { validatePublishedSchema } from "../schema-validation.js";

export const CONTROL_PLANE_LEASE_FILE = `${RUNTIME_DIRECTORY}/control-plane.lease.json`;

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_WAIT_MS = 5_000;
const POLL_INTERVAL_MS = 50;

/**
 * One process is one surface. Set once at startup; every lease it takes is attributed to it, so a
 * refusal can name who is holding the write authority rather than reporting a bare conflict.
 */
let surface = "cli";
export function setControlPlaneSurface(value) {
  if (!["cli", "dashboard", "mcp", "autopilot"].includes(value)) {
    throw new Error(`Unknown control-plane surface "${value}".`);
  }
  surface = value;
}
export function controlPlaneSurface() {
  return surface;
}

export class ControlPlaneLeaseError extends Error {
  constructor(holder) {
    super(`Another local surface holds the control-plane write lease${holder?.surface ? ` (${holder.surface})` : ""}.`);
    this.name = "ControlPlaneLeaseError";
    this.code = "WRITE_LEASE_HELD";
    this.holderSurface = holder?.surface ?? null;
  }
}

/**
 * Re-entrant per resolved project root, so a guarded operation may call another guarded operation
 * without deadlocking against itself.
 */
const held = new Map();

/**
 * Serialise a canonical control-plane mutation across the CLI, the dashboard, the autopilot
 * coordinator, and the MCP surface.
 *
 * The lease serialises writes; it does not by itself make a read-modify-write atomic. A caller that
 * loads records, edits them, and writes them back must hold the lease across the whole sequence.
 * Wrapping such a sequence is safe: nesting re-enters rather than blocking.
 */
export async function withControlPlaneLease(root, run, options = {}) {
  const key = leaseKey(root);
  const current = held.get(key);
  if (current) {
    current.depth += 1;
    try {
      return await run(current.lease);
    } finally {
      current.depth -= 1;
    }
  }

  const lease = await acquireControlPlaneLease(root, options);
  held.set(key, { lease, depth: 1 });
  try {
    return await run(lease);
  } finally {
    held.delete(key);
    await releaseControlPlaneLease(lease).catch(() => {});
  }
}

export async function acquireControlPlaneLease(
  root,
  { ttlMs = DEFAULT_TTL_MS, waitMs = DEFAULT_WAIT_MS, now = () => new Date(), sleep = defaultSleep } = {}
) {
  const target = path.join(path.resolve(root), CONTROL_PLANE_LEASE_FILE);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const deadline = now().getTime() + Math.max(0, waitMs);
  let blocker = null;

  while (true) {
    const moment = now();
    const lease = {
      schemaVersion: "1.0.0",
      holderId: crypto.randomUUID(),
      surface,
      pid: process.pid,
      acquiredAt: moment.toISOString(),
      expiresAt: new Date(moment.getTime() + ttlMs).toISOString()
    };
    const errors = validatePublishedSchema("control-plane-lease.schema.json", lease);
    if (errors.length) throw new Error(`Control-plane lease is invalid:\n- ${errors.join("\n- ")}`);

    try {
      await fs.writeFile(target, `${JSON.stringify(lease)}\n`, { encoding: "utf8", flag: "wx" });
      return { ...lease, file: target };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }

    const existing = await readLease(target);
    blocker = existing;
    if (existing && isLive(existing, moment)) {
      if (now().getTime() >= deadline) throw new ControlPlaneLeaseError(existing);
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    // Expired, unreadable, or owned by a process that no longer exists. Reclaim it, then contend
    // for the exclusive create again rather than assuming this process won the race.
    await reclaim(target, existing);
  }
}

export async function releaseControlPlaneLease(lease) {
  if (!lease?.file || !lease.holderId) return;
  const existing = await readLease(lease.file);
  if (existing?.holderId !== lease.holderId) return;
  await fs.rm(lease.file, { force: true });
}

export async function readControlPlaneLease(root) {
  return readLease(path.join(path.resolve(root), CONTROL_PLANE_LEASE_FILE));
}

async function reclaim(target, expected) {
  // Compare and set: only remove the exact holder observed as dead, so a lease taken between the
  // observation and this call survives.
  const current = await readLease(target);
  if (current && expected && current.holderId !== expected.holderId) return;
  await fs.rm(target, { force: true });
}

function isLive(lease, moment) {
  const expiry = Date.parse(lease.expiresAt ?? "");
  if (!Number.isFinite(expiry) || expiry <= moment.getTime()) return false;
  return processIsAlive(lease.pid);
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function readLease(file) {
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    return validatePublishedSchema("control-plane-lease.schema.json", value).length === 0 ? value : null;
  } catch {
    return null;
  }
}

function leaseKey(root) {
  const resolved = path.resolve(root);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function defaultSleep(ms) {
  // Deliberately not unref'd. This timer is the only pending work while a caller waits for the
  // lease; unref'ing it lets the process exit mid-wait, so a CLI invocation would return success
  // having written nothing and reported nothing.
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}
