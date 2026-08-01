import { OPERATING_MODEL_VERSION, RUNTIME_DIRECTORY } from "../constants.js";
import { validateConfig, validateConfigRelationships } from "../config.js";
import { applyWrites, planWrites } from "../file-writer.js";
import { buildProjectFiles } from "../generator.js";
import { utcTimestamp, writeJson } from "./io.js";
import { createDefaultConfig } from "../defaults.js";

export function migrateConfig(config, defaults = null) {
  const current = config.operations?.modelVersion ?? 1;
  if (current > OPERATING_MODEL_VERSION) throw new Error(`Project model version ${current} is newer than this CLI supports.`);
  const updated = structuredClone(config);
  const changes = [];
  if (current < 2) {
    updated.operations = {
      modelVersion: 2,
      runtimeDirectory: RUNTIME_DIRECTORY,
      externalWritesDefaultDryRun: true,
      requireHumanGateAttribution: true
    };
    updated.separation.verificationOfVerifierRole ??= "RB-08";
    if (defaults) {
      updated.routing = updated.routing.map((route) => ({
        ...route,
        steps:
          route.steps ??
          defaults.routing.find((candidate) => candidate.event === route.event)?.steps
      }));
    }
    upgradeAdapter(updated.adapters.development, {
      type: "command", implementation: "command-runner",
      settings: { executable: "", arguments: [], workingDirectory: ".", timeoutMs: 1800000, allowedPaths: ["src", "tests"], environmentAllowlist: [] }
    });
    upgradeAdapter(updated.adapters.git, {
      type: "local-git", implementation: "local-git",
      settings: { repositoryPath: ".", branchPrefix: "product-ops/", requireCleanWorktree: true }
    });
    upgradeAdapter(updated.adapters.spreadsheet, {
      type: "local-csv", implementation: "safe-local-csv",
      settings: { requireApprovedPlanHash: true, requireCompleteReadback: true }
    });
    changes.push("operating_model_v1_to_v2");
  }
  const schemaErrors = validateConfig(updated);
  const errors = [...schemaErrors, ...(schemaErrors.length === 0 ? validateConfigRelationships(updated) : [])];
  if (errors.length > 0) throw new Error(`Migrated project configuration is invalid:\n- ${errors.join("\n- ")}`);
  return { fromVersion: current, toVersion: OPERATING_MODEL_VERSION, changes, config: updated };
}

export async function migrateProject(root, config, { dryRun = true, now = new Date() } = {}) {
  const migration = migrateConfig(config, createDefaultConfig(root));
  const runId = `MIG-${utcTimestamp(now).replace(/[-:.TZ]/g, "")}`;
  if (migration.changes.length === 0) return { dryRun, runId, ...migration, operations: [] };
  if (!dryRun) {
    await writeJson(root, `.product-ops/migrations/${runId}/product-ops.config.json`, config, { dryRun: false });
  }
  const operations = await planWrites(root, buildProjectFiles(migration.config, { includeConfig: true }), { force: true });
  if (!dryRun) await applyWrites(root, operations);
  return { dryRun, runId, ...migration, config: undefined, operations: operations.map(({ action, relativePath }) => ({ action, relativePath })) };
}

function upgradeAdapter(adapter, defaults) {
  if (adapter.type === "placeholder") adapter.type = defaults.type;
  adapter.implementation ??= defaults.implementation;
  adapter.settings ??= defaults.settings;
}
