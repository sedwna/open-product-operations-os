import fs from "node:fs";
import path from "node:path";

const DEBOUNCE_MS = 500;

/**
 * Which canonical file backs which resource. A change to one of these means a subscriber holding
 * that URI is now looking at stale content.
 */
const WATCHED = [
  { directory: "taskboard", file: "tasks.csv", uris: ["productops://taskboard"] },
  { directory: ".product-ops/runtime", file: "approvals.json", uris: ["productops://approvals/pending"] },
  { directory: ".product-ops/runtime/autopilot", file: "state.json", uris: ["productops://cycle/latest", "productops://events/recent"] },
  { directory: ".product-ops/runtime/autopilot", file: "events.jsonl", uris: ["productops://events/recent"] }
];

/**
 * Lease files are rewritten on every heartbeat and temporary files appear mid-write. Neither is a
 * content change a subscriber cares about; without this the server would emit a notification every
 * few seconds forever.
 */
function isNoise(name) {
  return /\.lease\.json$/.test(name)
    || /\.tmp$/.test(name)
    || /\.bak$/.test(name)
    || /\.stale\./.test(name);
}

/**
 * Watch the canonical records and report which resource URIs went stale.
 *
 * Directories are watched rather than individual files: an atomic replace unlinks and recreates the
 * file, which drops a file-level watch on every platform.
 */
export function watchCanonicalRecords(root, onChanged, { debounceMs = DEBOUNCE_MS } = {}) {
  const absolute = path.resolve(root);
  const watchers = [];
  const dirty = new Set();
  let timer = null;

  const flush = () => {
    timer = null;
    if (dirty.size === 0) return;
    const uris = [...dirty];
    dirty.clear();
    onChanged(uris);
  };

  const byDirectory = new Map();
  for (const entry of WATCHED) {
    if (!byDirectory.has(entry.directory)) byDirectory.set(entry.directory, []);
    byDirectory.get(entry.directory).push(entry);
  }

  for (const [directory, entries] of byDirectory) {
    const target = path.join(absolute, directory);
    // The runtime directories are created on first write. Watching only what already exists would
    // mean a fresh project never reports an approval or a cycle change until the server restarts,
    // so create them up front rather than silently watching nothing.
    try {
      fs.mkdirSync(target, { recursive: true });
    } catch {
      continue;
    }
    let watcher;
    try {
      watcher = fs.watch(target, { persistent: false }, (_event, name) => {
        if (!name || isNoise(name)) return;
        const base = path.basename(String(name));
        const matched = entries.find((entry) => entry.file === base);
        if (!matched) return;
        for (const uri of matched.uris) dirty.add(uri);
        if (timer) clearTimeout(timer);
        timer = setTimeout(flush, debounceMs);
        timer.unref?.();
      });
    } catch (error) {
      // A project that has not produced runtime state yet simply has nothing to watch there.
      if (error.code === "ENOENT") continue;
      throw error;
    }
    watcher.on("error", () => {});
    watchers.push(watcher);
  }

  return {
    watching: watchers.length,
    close() {
      if (timer) clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
      watchers.length = 0;
    }
  };
}

export const WATCHED_RESOURCE_URIS = Object.freeze([...new Set(WATCHED.flatMap((entry) => entry.uris))]);
