import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig, validateConfig, validateConfigRelationships } from "../config.js";
import { readAutomationLink, writeAutomationLink } from "../autopilot/state.js";

/**
 * Point a product workspace at the application repository it operates.
 *
 * Nothing else can create this link, and a good deal depends on it: adoption reads the application
 * through it, the coordinator finds its engineering side through it, and the panel shows an
 * engineering organisation only once it exists.
 *
 * Everything it enables starts switched off. Linking says which repository this workspace is about;
 * it does not say that agents may run in it, and conflating the two would make naming a repository
 * an authorisation to act on it.
 */
export async function linkCommand(target, options) {
  if (!options.application) {
    throw new Error("link requires --application <path-to-application-repository>.");
  }
  await assertValidProject(target);

  const productRoot = path.resolve(target);
  const applicationRoot = path.resolve(options.application);
  if (productRoot === applicationRoot) {
    throw new Error("The application repository must be separate from the product operations repository.");
  }

  const stat = await fs.lstat(applicationRoot).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`No application repository at "${applicationRoot}".`);
  }
  if (stat.isSymbolicLink()) {
    throw new Error("The application path is a symbolic link; give the real directory.");
  }

  const developmentConfig = await fs.lstat(path.join(applicationRoot, "development-os.config.json")).catch(() => null);
  if (!developmentConfig?.isFile()) {
    throw new Error(
      `"${applicationRoot}" has no Development Operations OS configuration. Run \`development-os init\` there first — adding that namespace to a repository is a separate, deliberate step.`
    );
  }

  const existing = await readAutomationLink(productRoot).catch(() => null);
  const link = {
    schemaVersion: "1.0.0",
    applicationRelativePath: toPosix(path.relative(productRoot, applicationRoot)),
    provider: options.provider ?? existing?.provider ?? "claude",
    // Preserved across a re-link so pointing at a moved repository does not silently revoke
    // authorisations the owner granted, or grant ones they did not.
    productExecutorsEnabled: existing?.productExecutorsEnabled ?? false,
    engineeringExecutorsEnabled: existing?.engineeringExecutorsEnabled ?? false,
    autoStart: existing?.autoStart ?? false,
    autoApproveInitialIdea: existing?.autoApproveInitialIdea ?? false,
    createdAt: existing?.createdAt ?? new Date().toISOString()
  };

  if (options.apply !== true) {
    return [
      `Planned link to ${applicationRoot}.`,
      `  relative path: ${link.applicationRelativePath}`,
      `  provider: ${link.provider}`,
      `  executors: product ${state(link.productExecutorsEnabled)}, engineering ${state(link.engineeringExecutorsEnabled)}`,
      `  autonomous start: ${state(link.autoStart)}`,
      "Nothing was written. Add --apply to record the link."
    ];
  }

  await writeAutomationLink(productRoot, link);
  return [
    `${existing ? "Relinked" : "Linked"} ${applicationRoot}.`,
    "The workspace can now read that repository and plan engineering work for it.",
    "Executors and the autonomous coordinator remain disabled; enabling them is a separate decision."
  ];
}

async function assertValidProject(target) {
  const config = await loadConfig(target);
  const schemaErrors = validateConfig(config);
  const errors = [...schemaErrors, ...(schemaErrors.length === 0 ? validateConfigRelationships(config) : [])];
  if (errors.length > 0) {
    throw new Error(`Project configuration is invalid:\n- ${errors.join("\n- ")}`);
  }
}

function state(enabled) {
  return enabled ? "enabled" : "disabled";
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}
