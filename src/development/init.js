import path from "node:path";
import { applyWrites, planWrites, summarizeWrites } from "../file-writer.js";
import { DEVELOPMENT_CONFIG_FILE } from "./catalog.js";
import { loadDevelopmentConfig, validateDevelopmentConfig } from "./config.js";
import { buildDevelopmentFiles, createDevelopmentConfig } from "./generator.js";

export async function initializeDevelopmentOs(target, options = {}) {
  const root = path.resolve(target);
  let config;
  let includeConfig = true;
  try {
    config = await loadDevelopmentConfig(root);
    includeConfig = false;
    const errors = validateDevelopmentConfig(config);
    if (errors.length) throw new Error(`Existing ${DEVELOPMENT_CONFIG_FILE} is invalid:\n- ${errors.join("\n- ")}`);
  } catch (error) {
    if (!error.message.startsWith("Missing development configuration:")) throw error;
    // In the canonical suite, development/ is a boundary name rather than the product name.
    config = createDevelopmentConfig(options.identityRoot ?? root);
  }
  const operations = await planWrites(root, buildDevelopmentFiles(config, { includeConfig }), options);
  if (!options.dryRun) await applyWrites(root, operations);
  return { root, config, operations, lines: [
    `${options.dryRun ? "Planned" : "Initialized"} Open Development Operations OS at ${root}.`,
    ...summarizeWrites(root, operations, options.dryRun)
  ] };
}
