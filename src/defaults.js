import path from "node:path";
import { canonicalCatalog, getCanonicalRoles, getCanonicalWorkbookSheets } from "./catalog.js";
import { SCHEMA_VERSION } from "./constants.js";

const ROUTES = [
  { event: "new_idea", owner: "RB-02", reviewers: ["RB-03", "RB-12"], output: "idea_inbox" },
  { event: "user_finding", owner: "RB-05", reviewers: ["RB-06", "RB-12"], output: "issues" },
  {
    event: "delivery_ready_issue",
    owner: "RB-06",
    reviewers: ["RB-07", "RB-13", "RB-12"],
    output: "delivery_tickets"
  },
  { event: "qa_retest", owner: "RB-07", reviewers: ["RB-09", "RB-12"], output: "validation_results" },
  {
    event: "workbook_or_status_change",
    owner: "RB-10",
    reviewers: ["RB-08", "RB-12"],
    output: "writer_manifests"
  },
  { event: "release_transition", owner: "RB-11", reviewers: ["RB-12"], output: "releases" },
  {
    event: "governance_or_role_change",
    owner: "RB-01",
    reviewers: ["RB-08", "RB-12"],
    output: "role_registry"
  }
];

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
      developmentRole: "RB-13"
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
    adapters: {
      development: {
        type: "placeholder",
        enabled: false,
        file: "adapters/development.json"
      },
      git: {
        type: "placeholder",
        enabled: false,
        file: "adapters/git.json"
      },
      spreadsheet: {
        type: "local-csv",
        enabled: false,
        file: "adapters/spreadsheet.json"
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
