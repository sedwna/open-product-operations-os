import path from "node:path";
import { CONFIG_FILE } from "../constants.js";
import { loadConfig, validateConfig, validateConfigRelationships } from "../config.js";
import { createDefaultConfig } from "../defaults.js";
import { applyWrites, planWrites, summarizeWrites } from "../file-writer.js";
import { buildProjectFiles } from "../generator.js";
import { bootstrapRepository, describeBootstrap } from "./git-bootstrap.js";

export async function initCommand(target, options) {
  const root = path.resolve(target);
  let config;
  let includeConfig = true;
  try {
    config = await loadConfig(root);
    includeConfig = false;
    const errors = validateConfig(config);
    if (errors.length === 0) {
      errors.push(...validateConfigRelationships(config));
    }
    if (errors.length > 0) {
      throw new Error(
        `Existing ${CONFIG_FILE} is invalid and will not be replaced:\n- ${errors.join("\n- ")}`
      );
    }
  } catch (error) {
    if (!error.message.startsWith("Missing project configuration:")) {
      throw error;
    }
    // A suite keeps Product records in product/ while deriving the durable project identity from
    // the repository root. Standalone callers omit identityRoot and retain the legacy behaviour.
    config = createDefaultConfig(options.identityRoot ?? root);
  }
  const files = buildProjectFiles(config, { includeConfig });
  const operations = await planWrites(root, files, options);

  let bootstrap = null;
  if (!options.dryRun) {
    await applyWrites(root, operations);
    // After the files exist, so the first commit is the workspace rather than an empty tree.
    if (options.noGit !== true) bootstrap = await bootstrapRepository(root);
  }

  return [
    `${
      options.dryRun ? "Planned Product Operations OS initialization" : "Initialized Product Operations OS project"
    } at ${root}.`,
    ...summarizeWrites(root, operations, options.dryRun),
    ...(options.dryRun && options.noGit !== true
      ? ["Would start a Git history here if there is not one already; exporting to the engineering side needs a revision to stamp."]
      : []),
    ...(bootstrap ? describeBootstrap(bootstrap) : [])
  ];
}
