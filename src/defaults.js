import path from "node:path";
import { canonicalCatalog, getCanonicalRoles, getCanonicalWorkbookSheets } from "./catalog.js";
import { OPERATING_MODEL_VERSION, RUNTIME_DIRECTORY, SCHEMA_VERSION } from "./constants.js";

/**
 * How an event becomes work.
 *
 * A route's steps used to be a strict chain: each one waited on the one written before it, whatever
 * it actually needed. That made the board a queue of one. Validation design sat behind
 * implementation even though both are written from the same delivery contract, and risk audit sat
 * behind everything or was never asked at all.
 *
 * A step names what it waits on by key. `after: []` says it waits on nothing and starts with the
 * event. A step with no `after` at all keeps the old behaviour and waits on the step before it, so a
 * route written before this existed still routes exactly as it did.
 */
const ROUTES = [
  {
    event: "new_idea", owner: "RB-02", reviewers: ["RB-03", "RB-12"], output: "idea_inbox",
    steps: [
      step("RB-02", "Triage idea", { key: "triage", after: [] }),
      step("RB-03", "Complete discovery", { key: "discovery", after: ["triage"] }),
      step("RB-02", "Prepare decision brief", { key: "brief", after: ["discovery"] }),
      step("RB-04", "Update topology and impact", { key: "topology", after: ["brief"], humanGate: "product_direction_or_priority" }),
      step("RB-05", "Create or disposition issue", { key: "issue", after: ["topology"] }),
      step("RB-06", "Author delivery contract", { key: "contract", after: ["issue"] }),
      // Validation is designed from the contract, not from the build. Waiting for the build was the
      // wrong way round: it turned the test plan into a description of what was made.
      step("RB-07", "Design validation", { key: "validation-design", after: ["contract"] }),
      step("RB-08", "Audit assumptions and edges", { key: "risk", after: ["contract"] }),
      step("RB-13", "Implement approved delivery", { key: "implement", after: ["contract"] }),
      step("RB-09", "Execute QA and capture evidence", { key: "qa", after: ["validation-design", "implement"] }),
      step("RB-10", "Apply controlled operational update", { key: "operational-update", after: ["qa"] }),
      step("RB-12", "Independently verify material claims", { key: "verify", after: ["operational-update", "risk"] }),
      step("RB-11", "Assess readiness and release", { key: "readiness", after: ["verify"] })
    ]
  },
  {
    event: "user_finding", owner: "RB-05", reviewers: ["RB-06", "RB-12"], output: "issues",
    steps: [
      step("RB-05", "Triage finding", { key: "triage", after: [] }),
      // Triage may conclude that a finding needs product direction. RB-06 cannot turn that
      // unresolved issue into a canonical delivery ticket until the owner chooses what proceeds.
      step("RB-06", "Author delivery contract", { key: "contract", after: ["triage"], humanGate: "product_direction_or_priority" }),
      step("RB-07", "Design validation", { key: "validation-design", after: ["contract"] }),
      step("RB-08", "Audit assumptions and edges", { key: "risk", after: ["contract"] }),
      step("RB-13", "Implement approved delivery", { key: "implement", after: ["contract"] }),
      step("RB-09", "Execute QA and capture evidence", { key: "qa", after: ["validation-design", "implement"] }),
      step("RB-10", "Apply controlled operational update", { key: "operational-update", after: ["qa"] }),
      step("RB-12", "Independently verify material claims", { key: "verify", after: ["operational-update", "risk"] }),
      step("RB-11", "Assess readiness", { key: "readiness", after: ["verify"] })
    ]
  },
  {
    event: "delivery_ready_issue",
    owner: "RB-06",
    reviewers: ["RB-07", "RB-13", "RB-12"],
    output: "delivery_tickets",
    steps: [
      step("RB-06", "Confirm delivery contract", { key: "contract", after: [], humanGate: "product_direction_or_priority" }),
      step("RB-07", "Design validation", { key: "validation-design", after: ["contract"] }),
      step("RB-08", "Audit assumptions and edges", { key: "risk", after: ["contract"] }),
      step("RB-13", "Implement approved delivery", { key: "implement", after: ["contract"] }),
      step("RB-09", "Execute QA and capture evidence", { key: "qa", after: ["validation-design", "implement"] }),
      step("RB-10", "Apply controlled operational update", { key: "operational-update", after: ["qa"] }),
      step("RB-12", "Independently verify material claims", { key: "verify", after: ["operational-update", "risk"] }),
      step("RB-11", "Assess readiness", { key: "readiness", after: ["verify"] })
    ]
  },
  {
    event: "qa_retest", owner: "RB-07", reviewers: ["RB-09", "RB-12"], output: "validation_results",
    steps: [
      step("RB-07", "Confirm retest scenario", { key: "scenario", after: [] }),
      step("RB-09", "Execute QA retest", { key: "retest", after: ["scenario"] }),
      step("RB-10", "Apply controlled result update", { key: "result-update", after: ["retest"] }),
      step("RB-12", "Independently verify retest", { key: "verify", after: ["result-update"] }),
      step("RB-11", "Recalculate readiness", { key: "readiness", after: ["verify"] })
    ]
  },
  {
    event: "workbook_or_status_change",
    owner: "RB-10",
    reviewers: ["RB-08", "RB-12"],
    output: "writer_manifests",
    steps: [
      step("RB-10", "Prepare controlled workbook change", { key: "change", after: [] }),
      step("RB-08", "Audit control and logic", { key: "audit", after: ["change"] }),
      step("RB-12", "Independently verify workbook change", { key: "verify", after: ["audit"] })
    ]
  },
  {
    event: "release_transition", owner: "RB-11", reviewers: ["RB-12"], output: "releases",
    steps: [
      step("RB-11", "Prepare release transition", { key: "transition", after: [] }),
      step("RB-12", "Independently verify release claims", { key: "verify", after: ["transition"] })
    ]
  },
  {
    event: "governance_or_role_change",
    owner: "RB-01",
    reviewers: ["RB-08", "RB-12"],
    output: "role_registry",
    steps: [
      step("RB-01", "Prepare governance change", { key: "change", after: [], humanGate: "governance_or_role_lifecycle_change" }),
      step("RB-08", "Audit governance change", { key: "audit", after: ["change"] }),
      step("RB-12", "Independently verify governance change", { key: "verify", after: ["audit"] })
    ]
  }
];

function step(role, title, { key, after, humanGate = "" } = {}) {
  const definition = { role, title, humanGate };
  if (key) definition.key = key;
  if (Array.isArray(after)) definition.after = after;
  return definition;
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
