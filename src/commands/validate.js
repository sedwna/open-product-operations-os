import path from "node:path";
import { loadConfig, validateConfig, validateConfigRelationships } from "../config.js";
import { validateProject } from "../validation.js";

export async function validateCommand(target) {
  const root = path.resolve(target);
  const config = await loadConfig(root);
  const configErrors = validateConfig(config);
  const relationshipErrors =
    configErrors.length === 0 ? validateConfigRelationships(config) : [];

  if (configErrors.length > 0 || relationshipErrors.length > 0) {
    throw new ValidationError([...configErrors, ...relationshipErrors], 1);
  }

  const result = await validateProject(root, config);
  if (result.errors.length > 0) {
    throw new ValidationError(result.errors, result.checkedFiles);
  }

  return [
    `Validation passed for ${root}.`,
    `Checked project configuration and ${result.checkedFiles} generated file(s).`
  ];
}

export class ValidationError extends Error {
  constructor(errors, checkedFiles) {
    super(`Validation failed with ${errors.length} error(s):\n- ${errors.join("\n- ")}`);
    this.name = "ValidationError";
    this.errors = errors;
    this.checkedFiles = checkedFiles;
  }
}
