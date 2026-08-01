import path from "node:path";
import { canonicalCatalog, getCanonicalRoles, getCanonicalWorkbookSheets } from "./catalog.js";
import { OPERATING_MODEL_VERSION, RUNTIME_DIRECTORY, SCHEMA_VERSION } from "./constants.js";

const ROUTES = [
  {
    event: "new_idea", owner: "RB-02", reviewers: ["RB-03", "RB-12"], output: "idea_inbox",
    steps: [
      step("RB-02", "Triage idea"), step("RB-03", "Complete discovery"),
      step("RB-02", "Prepare decision brief"),
      step("RB-04", "Update topology and impact", "product_direction_or_priority"),
      step("RB-05", "Create or disposition issue"), step("RB-06", "Author delivery contract"),
      step("RB-07", "Design validation"), step("RB-13", "Implement approved delivery"),
      step("RB-09", "Execute QA and capture evidence"), step("RB-10", "Apply controlled operational update"),
      step("RB-12", "Independently verify material claims"), step("RB-11", "Assess readiness and release")
    ]
  },
  {
    event: "user_finding", owner: "RB-05", reviewers: ["RB-06", "RB-12"], output: "issues",
    steps: [step("RB-05", "Triage finding"), step("RB-06", "Author delivery contract"), step("RB-07", "Design validation"), step("RB-13", "Implement approved delivery"), step("RB-09", "Execute QA and capture evidence"), step("RB-10", "Apply controlled operational update"), step("RB-12", "Independently verify material claims"), step("RB-11", "Assess readiness")]
  },
  {
    event: "delivery_ready_issue",
    owner: "RB-06",
    reviewers: ["RB-07", "RB-13", "RB-12"],
    output: "delivery_tickets",
    steps: [step("RB-06", "Confirm delivery contract"), step("RB-07", "Design validation"), step("RB-13", "Implement approved delivery"), step("RB-09", "Execute QA and capture evidence"), step("RB-10", "Apply controlled operational update"), step("RB-12", "Independently verify material claims"), step("RB-11", "Assess readiness")]
  },
  { event: "qa_retest", owner: "RB-07", reviewers: ["RB-09", "RB-12"], output: "validation_results", steps: [step("RB-07", "Confirm retest scenario"), step("RB-09", "Execute QA retest"), step("RB-10", "Apply controlled result update"), step("RB-12", "Independently verify retest"), step("RB-11", "Recalculate readiness")] },
  {
    event: "workbook_or_status_change",
    owner: "RB-10",
    reviewers: ["RB-08", "RB-12"],
    output: "writer_manifests",
    steps: [step("RB-10", "Prepare controlled workbook change"), step("RB-08", "Audit control and logic"), step("RB-12", "Independently verify workbook change")]
  },
  { event: "release_transition", owner: "RB-11", reviewers: ["RB-12"], output: "releases", steps: [step("RB-11", "Prepare release transition"), step("RB-12", "Independently verify release claims")] },
  {
    event: "governance_or_role_change",
    owner: "RB-01",
    reviewers: ["RB-08", "RB-12"],
    output: "role_registry",
    steps: [step("RB-01", "Prepare governance change", "governance_or_role_lifecycle_change"), step("RB-08", "Audit governance change"), step("RB-12", "Independently verify governance change")]
  }
];

function step(role, title, humanGate = "") {
  return { role, title, humanGate };
}

const TASK_STATUSES = [
  {
    id: "backlog",
    description: "Captured but not ready to start.",
    terminal: false,
    transitions: ["ready", "blocked", "cancelled"]
  },
  {
    id: "ready",
    description: "Inputs and ownership are sufficient to start.",
    terminal: false,
    transitions: ["in_progress", "blocked", "cancelled"]
  },
  {
    id: "in_progress",
    description: "The owner is actively producing the required output.",
    terminal: false,
    transitions: ["blocked", "in_review", "cancelled"]
  },
  {
    id: "blocked",
    description: "Progress requires an explicit dependency or decision.",
    terminal: false,
    transitions: ["ready", "in_progress", "cancelled"]
  },
  {
    id: "in_review",
    description: "Output is awaiting independent review or acceptance.",
    terminal: false,
    transitions: ["in_progress", "done", "blocked", "cancelled"]
  },
  {
    id: "done",
    description: "Required outputs and evidence passed completion gates.",
    terminal: true,
    transitions: []
  },
  {
    id: "cancelled",
    description: "Work was explicitly cancelled with a durable disposition.",
    terminal: true,
    transitions: []
  }
];

export function createDefaultConfig(target) {
  const folderName = path.basename(path.resolve(target));
  const projectId = toProjectId(folderName);
  const taskPrefix = toTaskPrefix(projectId);
  const roles = getCanonicalRoles();
  const sheets = getCanonicalWorkbookSheets();

  return {
    schemaVersion: SCHEMA_VERSION,
    catalogVersion: canonicalCatalog.catalog_version,
    catalogAuthority: canonicalCatalog.catalog_authority,
    project: {
      id: projectId,
      name: toDisplayName(folderName),
      vision: "Describe the product outcome this operating system should support.",
      targetUsers: ["Describe the primary user group."],
      environments: ["local", "test", "staging", "production"],
      humanAuthorityActorId: "human-product-owner"
    },
    agents: roles.map((role) => ({
      id: role.roleKey,
      actorId: `actor-${role.roleKey.toLowerCase()}`,
      name: toDisplayName(role.boundary),
      role: role.purpose,
      responsibilities: role.may,
      prohibitedActions: role.mustNot,
      lifecycle: role.lifecycle
    })),
    separation: {
      requireDistinctActiveActors: true,
      writerRole: "RB-10",
      independentVerifierRole: "RB-12",
      developmentRole: "RB-13",
      verificationOfVerifierRole: "RB-08"
    },
    ownership: sheets.map((sheet) => ({ artifact: sheet.key, owner: sheet.owner })),
    routing: ROUTES,
    taskIds: {
      prefix: taskPrefix,
      pattern: `^${taskPrefix}-[0-9]{4}$`
    },
    statuses: TASK_STATUSES,
    workbook: {
      sheets: sheets.map(({ template, ...sheet }) => sheet)
    },
    fieldAuthority: {
      protectedDevelopmentFields:
        canonicalCatalog.field_authority.protected_development_fields,
      protectedHumanFields: canonicalCatalog.field_authority.protected_human_fields,
      protectedFieldTabs: canonicalCatalog.field_authority.protected_field_tabs,
      writerEnvironments: canonicalCatalog.field_authority.writer_environments
    },
    validation: {
      excludedDirectories: canonicalCatalog.validation.excluded_directories,
      allowedSyntheticEmailDomains:
        canonicalCatalog.validation.allowed_synthetic_email_domains
    },
    operations: {
      modelVersion: OPERATING_MODEL_VERSION,
      runtimeDirectory: RUNTIME_DIRECTORY,
      externalWritesDefaultDryRun: true,
      requireHumanGateAttribution: true
    },
    adapters: {
      development: {
        type: "command",
        enabled: false,
        file: "adapters/development.json",
        implementation: "command-runner",
        settings: {
          executable: "",
          arguments: [],
          workingDirectory: ".",
          timeoutMs: 1800000,
          allowedPaths: ["src", "tests"],
          environmentAllowlist: []
        }
      },
      git: {
        type: "local-git",
        enabled: false,
        file: "adapters/git.json",
        implementation: "local-git",
        settings: {
          repositoryPath: ".",
          branchPrefix: "product-ops/",
          requireCleanWorktree: true
        }
      },
      spreadsheet: {
        type: "local-csv",
        enabled: false,
        file: "adapters/spreadsheet.json",
        implementation: "safe-local-csv",
        settings: {
          requireApprovedPlanHash: true,
          requireCompleteReadback: true
        }
      }
    }
  };
}

function toProjectId(value) {
  const id = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return id || "product-operations";
}

function toDisplayName(value) {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  return words.length === 0
    ? "Product Operations Project"
    : words.map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");
}

function toTaskPrefix(projectId) {
  const words = projectId.split("-").filter(Boolean);
  const initials = words.map((word) => word[0]).join("");
  const source = initials.length >= 2 ? initials : projectId;
  let prefix = source.replace(/[^a-z0-9]/gi, "").toUpperCase();
  if (!/^[A-Z]/.test(prefix) || prefix.length < 2) {
    prefix = `P${prefix}`;
  }
  return prefix.slice(0, 8) || "OPS";
}
