import { validateConfig, validateConfigRelationships } from "../config.js";
import { readSuppliedJson } from "./io.js";
import { CONFIG_FILE } from "../constants.js";
import { applyWrites, planWrites } from "../file-writer.js";
import { buildProjectFiles } from "../generator.js";

export async function configureProject(root, config, answersFile, { dryRun = true } = {}) {
  const answers = await readSuppliedJson(answersFile, "Configuration answer file");
  const allowed = new Set(["name", "vision", "targetUsers", "environments", "humanAuthorityActorId", "developmentAdapter"]);
  const unknown = Object.keys(answers).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`Unknown configuration answer "${unknown[0]}".`);
  const updated = structuredClone(config);
  for (const key of ["name", "vision", "targetUsers", "environments", "humanAuthorityActorId"]) {
    if (answers[key] !== undefined) updated.project[key] = answers[key];
  }
  if (answers.developmentAdapter) {
    updated.adapters.development = { ...updated.adapters.development, ...answers.developmentAdapter };
  }
  const schemaErrors = validateConfig(updated);
  const errors = [...schemaErrors, ...(schemaErrors.length === 0 ? validateConfigRelationships(updated) : [])];
  if (errors.length > 0) throw new Error(`Configured project is invalid:\n- ${errors.join("\n- ")}`);
  const files = buildProjectFiles(updated, { includeConfig: true });
  const operations = await planWrites(root, files, { force: true });
  if (!dryRun) await applyWrites(root, operations);
  return { dryRun, configFile: CONFIG_FILE, operations: operations.map(({ action, relativePath }) => ({ action, relativePath })) };
}
