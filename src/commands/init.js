import path from "node:path";
import { createDefaultConfig } from "../defaults.js";
import { applyWrites, planWrites, summarizeWrites } from "../file-writer.js";
import { buildProjectFiles } from "../generator.js";

export async function initCommand(target, options) {
  const root = path.resolve(target);
  const config = createDefaultConfig(root);
  const files = buildProjectFiles(config, { includeConfig: true });
  const operations = await planWrites(root, files, options);

  if (!options.dryRun) {
    await applyWrites(operations);
  }

  return [
    `${
      options.dryRun ? "Planned Product Operations OS initialization" : "Initialized Product Operations OS project"
    } at ${root}.`,
    ...summarizeWrites(root, operations, options.dryRun)
  ];
}
