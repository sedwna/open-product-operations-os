import fs from "node:fs/promises";
import path from "node:path";
import { initializeDevelopmentOs } from "../development/init.js";
import { validateDevelopmentOs } from "../development/validation.js";
import { applyWrites, planWrites, summarizeWrites } from "../file-writer.js";
import { readAutomationLink } from "../autopilot/state.js";
import { initCommand } from "./init.js";
import { linkCommand } from "./link.js";
import { validateCommand } from "./validate.js";
import { bootstrapRepository, describeBootstrap } from "./git-bootstrap.js";

export const PRODUCT_DIRECTORY = "product";
export const DEVELOPMENT_DIRECTORY = "development";

/**
 * Create the canonical GitHub-facing product suite.
 *
 * Product and Development remain independent authority systems, but both are visible in one Git
 * repository. The low-level `init` commands stay available for existing split-repository setups;
 * new product setup uses this composed layout.
 */
export async function initSuiteCommand(target, options = {}) {
  const root = path.resolve(target);
  const productRoot = path.join(root, PRODUCT_DIRECTORY);
  const developmentRoot = path.join(root, DEVELOPMENT_DIRECTORY);
  const provider = options.provider ?? "codex";
  if (!["codex", "claude"].includes(provider)) {
    throw new Error('init-suite --provider must be "codex" or "claude".');
  }

  const rootOperations = await planWrites(root, suiteRootFiles(path.basename(root)), options);
  const productLines = await initCommand(productRoot, {
    dryRun: options.dryRun,
    force: options.force,
    noGit: true,
    identityRoot: root
  });
  const development = await initializeDevelopmentOs(developmentRoot, {
    dryRun: options.dryRun,
    force: options.force,
    identityRoot: root
  });

  if (options.dryRun) {
    return [
      `Planned complete Product/Development suite at ${root}.`,
      ...summarizeWrites(root, rootOperations, true),
      ...productLines,
      ...development.lines,
      `Would link ${PRODUCT_DIRECTORY}/ to ${DEVELOPMENT_DIRECTORY}/ with executors disabled.`,
      ...(options.noGit === true
        ? []
        : ["Would start one Git history at the suite root so both operating systems are published together."])
    ];
  }

  await linkCommand(productRoot, {
    application: developmentRoot,
    provider,
    apply: true
  });
  await applyWrites(root, rootOperations);
  const bootstrap = options.noGit === true ? null : await bootstrapRepository(root);

  return [
    `Initialized complete Product/Development suite at ${root}.`,
    `Product Operations: ${productRoot}.`,
    `Development Operations and application code: ${developmentRoot}.`,
    `Linked ${PRODUCT_DIRECTORY}/ to ${DEVELOPMENT_DIRECTORY}/; all executors remain disabled.`,
    ...summarizeWrites(root, rootOperations, false),
    ...(bootstrap ? describeBootstrap(bootstrap) : [])
  ];
}

export async function validateSuiteCommand(target) {
  const root = path.resolve(target);
  const productRoot = path.join(root, PRODUCT_DIRECTORY);
  const developmentRoot = path.join(root, DEVELOPMENT_DIRECTORY);
  const errors = [];

  for (const [label, directory] of [
    ["Product", productRoot],
    ["Development", developmentRoot]
  ]) {
    const stat = await fs.lstat(directory).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) {
      errors.push(`${label} root must be a real directory: ${directory}.`);
    }
  }
  for (const nestedGit of [path.join(productRoot, ".git"), path.join(developmentRoot, ".git")]) {
    if (await exists(nestedGit)) {
      errors.push(`Nested Git history is not allowed in the canonical suite: ${nestedGit}.`);
    }
  }
  for (const required of ["README.md", "AGENTS.md"]) {
    if (!(await exists(path.join(root, required)))) errors.push(`Missing suite root file: ${required}.`);
  }

  let productLines = [];
  let development = null;
  if (errors.length === 0) {
    try { productLines = await validateCommand(productRoot); }
    catch (error) { errors.push(`Product Operations validation: ${error.message}`); }
    try {
      development = await validateDevelopmentOs(developmentRoot);
      errors.push(...development.errors.map((error) => `Development Operations validation: ${error}`));
    } catch (error) {
      errors.push(`Development Operations validation: ${error.message}`);
    }
    try {
      const link = await readAutomationLink(productRoot);
      if (!samePath(link.applicationRoot, developmentRoot)) {
        errors.push(`Product Operations must link to ${DEVELOPMENT_DIRECTORY}/, not ${link.applicationRoot}.`);
      }
    } catch (error) {
      errors.push(`Internal Product/Development link: ${error.message}`);
    }
  }

  if (errors.length) {
    throw new Error(`Suite validation failed with ${errors.length} error(s):\n- ${errors.join("\n- ")}`);
  }
  return [
    `Suite validation passed for ${root}.`,
    `${PRODUCT_DIRECTORY}/: 13 Product roles and the Product task board are present.`,
    `${DEVELOPMENT_DIRECTORY}/: 15 Engineering roles and the Engineering workstream board are present.`,
    `The internal contract link resolves from ${PRODUCT_DIRECTORY}/ to ${DEVELOPMENT_DIRECTORY}/.`,
    ...productLines.slice(1),
    `Checked ${development.checkedFiles} managed Development file(s).`,
    ...development.warnings.map((warning) => `Warning: ${warning}`)
  ];
}

function suiteRootFiles(folderName) {
  const name = displayName(folderName);
  return new Map([
    ["README.md", suiteReadme(name)],
    ["AGENTS.md", suiteAgentContract()],
    [".workspace/README.md", workspaceReadme()],
    [".workspace/resources.csv", workspaceInventory()],
    [".gitignore", suiteGitignore()]
  ]);
}

function suiteReadme(name) {
  return `# ${name}\n\nThis repository contains the complete product-delivery system. Product intent and engineering implementation are kept in separate top-level folders and committed in one Git history.\n\n\`\`\`text\n${PRODUCT_DIRECTORY}/      Product Operations: decisions, discovery, acceptance, Product agents and task board\n${DEVELOPMENT_DIRECTORY}/  Application code: Engineering agents, workstreams, architecture, tests and evidence\n.workspace/                Tracked resource inventory and local managed worktree hierarchy\n\`\`\`\n\n## Product side\n\n- Role contracts: \`${PRODUCT_DIRECTORY}/agents/roles/\`\n- Product task board: \`${PRODUCT_DIRECTORY}/taskboard/tasks.csv\`\n- Governance and routing: \`${PRODUCT_DIRECTORY}/governance/\`\n- Canonical workbook and evidence: \`${PRODUCT_DIRECTORY}/workbook/\` and \`${PRODUCT_DIRECTORY}/validation/\`\n\n## Development side\n\n- Engineering role registry: \`${DEVELOPMENT_DIRECTORY}/engineering/governance/roles.json\`\n- Engineering workstream board: \`${DEVELOPMENT_DIRECTORY}/engineering/taskboard/workstreams.csv\`\n- Architecture, standards and gates: \`${DEVELOPMENT_DIRECTORY}/engineering/\`\n- Source code and tests live only under \`${DEVELOPMENT_DIRECTORY}/\`.\n\n## Workspace resources\n\n- Lifecycle inventory: \`.workspace/resources.csv\`\n- Managed worktrees: \`.workspace/worktrees/<repo>/<card-or-purpose>\`\n- Policy: \`${PRODUCT_DIRECTORY}/governance/workspace-resource-lifecycle.md\` and the identical Engineering copy under \`${DEVELOPMENT_DIRECTORY}/engineering/standards/\`.\n\nThe two sides exchange versioned contracts. Product roles do not claim code completion; Engineering roles do not change product direction or approve their own user-visible outcome.\n`;
}

function suiteAgentContract() {
  return `# Product suite agent contract\n\nThis Git repository always has two independent operating roots:\n\n- \`${PRODUCT_DIRECTORY}/\` is owned by Product Operations roles (RB-01 through RB-13). Read \`${PRODUCT_DIRECTORY}/governance/\`, \`${PRODUCT_DIRECTORY}/agents/roles/\`, and \`${PRODUCT_DIRECTORY}/taskboard/tasks.csv\` before Product work.\n- \`${DEVELOPMENT_DIRECTORY}/\` is owned by Engineering roles (ENG-01 through ENG-15). Read \`${DEVELOPMENT_DIRECTORY}/DEVELOPMENT.md\`, \`${DEVELOPMENT_DIRECTORY}/engineering/governance/\`, and \`${DEVELOPMENT_DIRECTORY}/engineering/taskboard/workstreams.csv\` before implementation work.\n\nNever move Product records into Development or engineering claims into Product. Cross the boundary only through the versioned contract inbox/outbox and preserve independent verification. Application code, tests, migrations and infrastructure stay under \`${DEVELOPMENT_DIRECTORY}/\`; product discovery, decisions, acceptance and readiness stay under \`${PRODUCT_DIRECTORY}/\`.\n\n## Workspace resources\n\nRead \`${PRODUCT_DIRECTORY}/governance/workspace-resource-lifecycle.md\` before creating or cleaning a worktree, Docker resource, temporary folder, mount, or lease. Record every resource from creation through terminal disposition in \`.workspace/resources.csv\`. Keep all managed worktrees under \`.workspace/worktrees/<repo>/<card-or-purpose>\`.\n\nCleanup begins with a read-only inventory. Classify every candidate as exactly \`KEEP_ACTIVE\`, \`REMOVE_PROVEN\`, \`QUARANTINE\`, or \`HOLD_REVIEW\`. Never delete dirty, detached, unpushed, data-bearing, mounted, shared, locked, or authority-ambiguous resources. Registered worktrees use \`git worktree remove\` with registration and ref read-back. A dangling Docker volume is not deletion evidence, and broad \`docker system prune\` is forbidden on shared hosts. Full access is technical capability, not deletion authority. Clean in bounded batches and read back disk, Git, Docker health, and protected paths. No task closes with an ownerless resource or a missing terminal disposition.\n`;
}

function suiteGitignore() {
  return `# Local dependencies and control-plane scratch state.\nnode_modules/\n${PRODUCT_DIRECTORY}/.product-ops/runtime/locks/\n${PRODUCT_DIRECTORY}/.product-ops/runtime/metrics.json\n${DEVELOPMENT_DIRECTORY}/node_modules/\n${DEVELOPMENT_DIRECTORY}/.env\n${DEVELOPMENT_DIRECTORY}/.env.*\n!${DEVELOPMENT_DIRECTORY}/.env.example\n\n# Managed resource contents stay local; lifecycle metadata remains tracked.\n.workspace/worktrees/\n.workspace/quarantine/\n.workspace/temp/\n`;
}

function workspaceReadme() {
  return `# Managed workspace resources\n\n\`.workspace/resources.csv\` is the tracked lifecycle inventory. Record every Git worktree, Docker resource, temporary folder, mount, and lease before creation and maintain it through terminal disposition.\n\nAll managed worktrees live under:\n\n\`\`\`text\n.workspace/worktrees/<repo>/<card-or-purpose>\n\`\`\`\n\nWorktree, quarantine, and temporary contents are ignored because they are local runtime state. Their inventory rows, retained refs, ownership, evidence, and terminal dispositions remain canonical. Read \`../${PRODUCT_DIRECTORY}/governance/workspace-resource-lifecycle.md\` before creation or cleanup.\n`;
}

function workspaceInventory() {
  return "resource_id,resource_type,project_id,owner_actor_id,owner_task_id,purpose,source_repository,authority_root,base_sha,created_at,retention_class,expires_at,cleanup_trigger,inventory_disposition,terminal_disposition,native_resource_id,evidence_refs,updated_at\n";
}

function displayName(value) {
  const words = value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).filter(Boolean);
  return words.length ? words.map((word) => word[0].toUpperCase() + word.slice(1)).join(" ") : "Product Suite";
}

async function exists(target) {
  return Boolean(await fs.lstat(target).catch(() => null));
}

function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}
