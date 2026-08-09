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
  if (current < 3) {
    updated.operations.modelVersion = 3;
    // Routing gained step keys, so a step can wait on what it actually needs instead of on whoever
    // was written before it. A route the project has not touched is upgraded to the current default;
    // one that has been edited is left exactly as its owner wrote it, because a routing table is a
    // statement about how that product works and this migration has no standing to rewrite it.
    if (defaults) {
      let upgraded = 0;
      let kept = 0;
      updated.routing = updated.routing.map((route) => {
        const canonical = defaults.routing.find((candidate) => candidate.event === route.event);
        if (!canonical) return route;
        if (!isUnmodifiedRoute(route.event, route.steps)) {
          kept += 1;
          return route;
        }
        upgraded += 1;
        return { ...route, steps: structuredClone(canonical.steps) };
      });
      if (upgraded > 0) changes.push(`routing_steps_parallelised:${upgraded}`);
      if (kept > 0) changes.push(`routing_steps_left_as_customised:${kept}`);
    }
    changes.push("operating_model_v2_to_v3");
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

/**
 * The routing every version-2 project was generated with.
 *
 * A migration has to know the shape it is migrating *from*, and the current defaults no longer
 * describe it. Recording the old sequences here is what lets the upgrade tell an untouched route
 * from one its owner has deliberately changed.
 */
const VERSION_2_ROUTE_ROLES = Object.freeze({
  new_idea: ["RB-02", "RB-03", "RB-02", "RB-04", "RB-05", "RB-06", "RB-07", "RB-13", "RB-09", "RB-10", "RB-12", "RB-11"],
  user_finding: ["RB-05", "RB-06", "RB-07", "RB-13", "RB-09", "RB-10", "RB-12", "RB-11"],
  delivery_ready_issue: ["RB-06", "RB-07", "RB-13", "RB-09", "RB-10", "RB-12", "RB-11"],
  qa_retest: ["RB-07", "RB-09", "RB-10", "RB-12", "RB-11"],
  workbook_or_status_change: ["RB-10", "RB-08", "RB-12"],
  release_transition: ["RB-11", "RB-12"],
  governance_or_role_change: ["RB-01", "RB-08", "RB-12"]
});

function isUnmodifiedRoute(event, steps) {
  const baseline = VERSION_2_ROUTE_ROLES[event];
  if (!baseline || !Array.isArray(steps) || steps.length !== baseline.length) return false;
  return steps.every((step, index) => step.role === baseline[index] && !step.key && !step.after);
}

function upgradeAdapter(adapter, defaults) {
  if (adapter.type === "placeholder") adapter.type = defaults.type;
  adapter.implementation ??= defaults.implementation;
  adapter.settings ??= defaults.settings;
}
