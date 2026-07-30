import path from "node:path";
import { loadConfig, validateConfig, validateConfigRelationships } from "../config.js";
import { applyWrites, planWrites, summarizeWrites } from "../file-writer.js";
import { buildWorkbookFiles } from "../generator.js";

export async function generateWorkbookCommand(target, options) {
  const root = path.resolve(target);
  const config = await loadConfig(root);
  const configErrors = validateConfig(config);
  const errors = [
    ...configErrors,
    ...(configErrors.length === 0 ? validateConfigRelationships(config) : [])
  ];
  if (errors.length > 0) {
    throw new Error(`Project configuration is invalid:\n- ${errors.join("\n- ")}`);
  }

  const operations = await planWrites(root, buildWorkbookFiles(config), options);
  if (!options.dryRun) {
    await applyWrites(root, operations);
  }

  return [
    `Generated workbook templates at ${root}.`,
    ...summarizeWrites(root, operations, options.dryRun)
  ];
}
