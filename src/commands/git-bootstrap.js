import fs from "node:fs/promises";
import path from "node:path";
import { runGit } from "../autopilot/shared.js";

/**
 * Give a new workspace a Git history.
 *
 * Exporting an approved delivery contract across the Product/Development boundary stamps it with
 * the product workspace's revision — that is what lets the engineering side prove which state of
 * the product operations it was answering. Without a repository there is no revision, so the export
 * fails at the moment the owner has just approved crossing into engineering: the worst possible
 * place to discover a missing prerequisite, and one nobody would think to check.
 *
 * Three rules govern this:
 *
 * - It never touches an existing repository. If the target is already inside a work tree, that
 *   history belongs to someone else and this leaves it alone.
 * - It never fails initialisation. A missing `git`, an unusable one, or a refused commit is
 *   reported and the workspace still exists.
 * - It never invents an identity silently. If the machine has no configured Git identity, the
 *   commit is made under a named workspace identity and the report says so.
 */
const FALLBACK_NAME = "Product Operations OS";
const FALLBACK_EMAIL = "product-ops@localhost";

export async function bootstrapRepository(root) {
  if (await insideWorkTree(root)) {
    return { created: false, reason: "existing_repository" };
  }

  try {
    await runGit(root, ["init", "--quiet"]);
  } catch (error) {
    return { created: false, reason: "git_unavailable", detail: error.message };
  }

  try {
    await writeIgnoreFile(root);
    await runGit(root, ["add", "-A"]);
    const identity = await configuredIdentity(root);
    await runGit(root, [
      "-c", `user.name=${identity.name}`,
      "-c", `user.email=${identity.email}`,
      "commit", "--quiet",
      "-m", "chore: initialize the product operations workspace"
    ]);
    const revision = (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim();
    return { created: true, revision, identity };
  } catch (error) {
    return { created: false, reason: "commit_failed", detail: error.message };
  }
}

/** What the report should say, in the owner's terms rather than Git's. */
export function describeBootstrap(result) {
  if (result.created) {
    const attribution = result.identity.configured
      ? ""
      : ` The machine has no configured Git identity, so the first commit is attributed to ${result.identity.name} <${result.identity.email}>.`;
    return [`Started a Git history for this workspace at ${result.revision.slice(0, 8)}.${attribution}`];
  }
  if (result.reason === "existing_repository") return [];
  return [
    "Could not start a Git history here, so this workspace has no revision yet.",
    "Exporting an approved delivery contract to the engineering side stamps it with that revision and will refuse without one.",
    `Reason: ${result.detail ?? result.reason}.`
  ];
}

async function insideWorkTree(root) {
  try {
    await fs.access(path.join(root, ".git"));
    return true;
  } catch {
    // Not the repository root. It may still sit inside one, which counts just as much.
  }
  try {
    return (await runGit(root, ["rev-parse", "--is-inside-work-tree"])).stdout.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * A workspace records what the product decided. The control plane's own scratch state — leases,
 * run stores, in-flight receipts — is machine state, not product history.
 */
async function writeIgnoreFile(root) {
  const file = path.join(root, ".gitignore");
  try {
    await fs.access(file);
    return;
  } catch {
    // No ignore file yet, which is the only case this writes one.
  }
  await fs.writeFile(file, [
    "# Control-plane scratch state, not product history.",
    ".product-ops/runtime/locks/",
    ".product-ops/runtime/metrics.json",
    "",
    "node_modules/",
    ""
  ].join("\n"), "utf8");
}

async function configuredIdentity(root) {
  const [name, email] = await Promise.all([
    gitConfig(root, "user.name"),
    gitConfig(root, "user.email")
  ]);
  if (name && email) return { name, email, configured: true };
  return { name: FALLBACK_NAME, email: FALLBACK_EMAIL, configured: false };
}

async function gitConfig(root, key) {
  try {
    return (await runGit(root, ["config", "--get", key])).stdout.trim() || null;
  } catch {
    return null;
  }
}
