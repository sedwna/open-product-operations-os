import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { RUNTIME_DIRECTORY } from "../constants.js";
import { validatePublishedSchema } from "../schema-validation.js";

export const CONTROL_PLANE_LEASE_FILE = `${RUNTIME_DIRECTORY}/control-plane.lease.json`;

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_WAIT_MS = 5_000;
const POLL_INTERVAL_MS = 50;
/** Renew comfortably inside the term, so two consecutive missed beats still leave the lease live. */
const RENEW_FRACTION = 3;

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
 * Raised when this process discovers that the lease it believes it holds has been taken by someone
 * else. It means the work in flight was never exclusive, so the only safe report is a failure: a
 * caller that swallowed this would announce a write it may have raced.
 */
export class ControlPlaneLeaseLostError extends Error {
  constructor(lease, current) {
    super(
      `The control-plane write lease taken by ${lease?.surface ?? "this surface"} was lost before the write completed` +
        `${current?.surface ? ` and is now held by ${current.surface}` : ""}.`
    );
    this.name = "ControlPlaneLeaseLostError";
    this.code = "WRITE_LEASE_LOST";
    this.holderSurface = current?.surface ?? null;
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
  const entry = { lease, depth: 1, lost: false, released: false, heartbeat: null };
  held.set(key, entry);
  entry.heartbeat = startHeartbeat(entry, options);
  try {
    const result = await run(lease);
    // The work finished, but finishing is not the same as having been exclusive throughout. If the
    // term lapsed at any point, report the failure rather than a write nobody can vouch for.
    if (entry.lost) throw new ControlPlaneLeaseLostError(lease, await readLease(lease.file));
    return result;
  } finally {
    entry.released = true;
    clearTimeout(entry.heartbeat);
    held.delete(key);
    // Releasing compares holder identity, so a lease already taken by someone else is left alone.
    await releaseControlPlaneLease(lease).catch(() => {});
  }
}

/**
 * A term that cannot be extended is a deadline on the work, not a lock: exceed it and the lease is
 * reclaimed from a process that is still writing. Beating keeps a healthy holder's term current, so
 * expiry once again means what it is supposed to mean — the holder is gone or wedged.
 */
function startHeartbeat(entry, { ttlMs = DEFAULT_TTL_MS, now = () => new Date() } = {}) {
  const interval = Math.max(POLL_INTERVAL_MS, Math.floor(ttlMs / RENEW_FRACTION));
  const beat = async () => {
    if (entry.lost || entry.released) return;
    const outcome = await renewControlPlaneLease(entry.lease, { ttlMs, now }).catch(() => "retry");
    // A transient failure is worth another attempt. What it is not worth is inferring displacement
    // from our own clock: under load a beat can fire after the term it was meant to extend has
    // already lapsed, and one unlucky replace at that moment used to condemn a lease nobody had
    // touched. The file is the only thing that knows who holds it, so ask it. A term past its
    // expiry with our own identity still written in it has not been reclaimed — it is a term we are
    // late renewing, and we renew it.
    //
    // Both questions are asked before the entry is read, so the state this decides on is the state
    // as it stands now rather than as it stood before the awaits.
    const keepBeating = outcome === "retry" ? await stillOurs(entry.lease) : false;
    if (entry.lost || entry.released) return;
    if (outcome === "renewed") {
      entry.heartbeat = schedule(beat, interval);
      return;
    }
    if (keepBeating) {
      entry.heartbeat = schedule(beat, Math.max(POLL_INTERVAL_MS, Math.floor(interval / 2)));
      return;
    }
    entry.lost = true;
  };
  return schedule(beat, interval);
}

/**
 * Does the lease file still name us?
 *
 * An unreadable file is not an answer, so it counts as still ours and the beat tries again. That is
 * the safe direction: keeping a lease we may not hold costs one refused write at the fence, which
 * reads from disk before every canonical write. Dropping one we do hold costs the work.
 */
async function stillOurs(lease) {
  try {
    const current = await readLease(lease.file);
    return current === null || current.holderId === lease.holderId;
  } catch {
    return true;
  }
}

function schedule(beat, interval) {
  // Unref'd on purpose, the opposite of the acquisition poll: a heartbeat is never the reason a
  // process should stay alive. While work is in flight that work holds the loop open; once it is
  // done the lease is released, and a beat firing after that would have nothing to extend.
  const timer = setTimeout(() => { void beat(); }, interval);
  timer.unref?.();
  return timer;
}

/**
 * Extend our own term. Compare and set: a lease that is missing or now belongs to another holder is
 * not ours to rewrite, and saying so is what lets the holder discover it was displaced.
 *
 * Returns `renewed`, `displaced`, or `retry`. The third matters: a replace that fails because a
 * reader has the file open is a fact about this instant, not about who owns the lease, and turning
 * it into displacement would fail writes that were never in danger.
 */
export async function renewControlPlaneLease(lease, { ttlMs = DEFAULT_TTL_MS, now = () => new Date() } = {}) {
  if (!lease?.file || !lease.holderId) return "displaced";
  // Read again before concluding, the way the write fence does. A lease being replaced — by another
  // surface's acquisition or by our own previous beat — is briefly absent or half-visible on some
  // filesystems, and treating that instant as displacement condemns a lease nobody took. A genuine
  // displacement is still there on the second look.
  let existing = await readLease(lease.file);
  if (existing?.holderId !== lease.holderId) existing = await readLease(lease.file);
  if (!existing || existing.holderId !== lease.holderId) return "displaced";

  const renewed = { ...existing, expiresAt: new Date(now().getTime() + ttlMs).toISOString() };
  if (validatePublishedSchema("control-plane-lease.schema.json", renewed).length) return "displaced";
  try {
    await replaceLeaseFile(lease.file, renewed);
  } catch {
    return "retry";
  }

  const confirmed = await readLease(lease.file);
  if (!confirmed) return "retry";
  if (confirmed.holderId !== lease.holderId) return "displaced";
  lease.expiresAt = renewed.expiresAt;
  return "renewed";
}

/**
 * The fence in front of a canonical write. Cheap when no lease is in play, and a fresh read from
 * disk rather than a cached flag when one is: the in-memory view is only as current as the last
 * beat, and a write must be gated on who owns the lease now.
 */
export async function assertControlPlaneLeaseHeld(root) {
  const entry = held.get(leaseKey(root));
  if (!entry) return;
  let current = await readLease(entry.lease.file);
  if (current?.holderId !== entry.lease.holderId) {
    // Read again before blocking the write. A lease being replaced by its own holder's heartbeat is
    // briefly unreadable on some filesystems, and refusing on that would stop a write that was never
    // at risk. A genuine displacement is still there on the second look.
    current = await readLease(entry.lease.file);
  }
  if (current?.holderId !== entry.lease.holderId) {
    entry.lost = true;
    throw new ControlPlaneLeaseLostError(entry.lease, current);
  }
}

export async function acquireControlPlaneLease(
  root,
  { ttlMs = DEFAULT_TTL_MS, waitMs = DEFAULT_WAIT_MS, now = () => new Date(), sleep = defaultSleep } = {}
) {
  const target = path.join(path.resolve(root), CONTROL_PLANE_LEASE_FILE);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const deadline = now().getTime() + Math.max(0, waitMs);

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
      await createLeaseFileExclusively(target, lease);
      return { ...lease, file: target };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }

    const existing = await readLease(target);
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
  if (expected) {
    if (current && current.holderId !== expected.holderId) return;
  } else if (current) {
    // We are here because the lease did not parse. It parses now, so what we saw was a file being
    // written rather than the corruption we took it for, and it belongs to a live holder. Removing
    // it on that evidence is how two surfaces end up writing at once.
    return;
  }
  await fs.rm(target, { force: true });
}

/**
 * Create the lease with its content already complete.
 *
 * `writeFile(..., "wx")` is exclusive but not atomic: it creates the file and then fills it, and a
 * contender reading in between sees zero bytes, cannot parse them, and concludes the lease is
 * corrupt. Linking a fully written staging file into place has the same "fails if it exists"
 * guarantee with nothing observable in between.
 */
async function createLeaseFileExclusively(target, lease) {
  const staging = `${target}.${lease.holderId}.tmp`;
  await fs.writeFile(staging, `${JSON.stringify(lease)}\n`, { encoding: "utf8", flag: "wx" });
  try {
    await fs.link(staging, target);
  } finally {
    await fs.rm(staging, { force: true });
  }
}

/**
 * Replace our own lease with a renewed term. Rename is the atomic-replace counterpart to the link
 * above: a reader sees either the old term or the new one, never a partial file.
 */
async function replaceLeaseFile(target, lease) {
  const staging = `${target}.${lease.holderId}.renew.tmp`;
  await fs.writeFile(staging, `${JSON.stringify(lease)}\n`, { encoding: "utf8", flag: "wx" });
  try {
    await fs.rename(staging, target);
  } catch (error) {
    await fs.rm(staging, { force: true });
    throw error;
  }
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
