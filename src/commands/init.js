import path from "node:path";
import { CONFIG_FILE } from "../constants.js";
import { loadConfig, validateConfig, validateConfigRelationships } from "../config.js";
import { createDefaultConfig } from "../defaults.js";
import { applyWrites, planWrites, summarizeWrites } from "../file-writer.js";
import { buildProjectFiles } from "../generator.js";

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
    config = createDefaultConfig(root);
  }
  const files = buildProjectFiles(config, { includeConfig });
  const operations = await planWrites(root, files, options);

  if (!options.dryRun) {
    await applyWrites(root, operations);
  }

  return [
    `${
      options.dryRun ? "Planned Product Operations OS initialization" : "Initialized Product Operations OS project"
    } at ${root}.`,
    ...summarizeWrites(root, operations, options.dryRun)
  ];
}
