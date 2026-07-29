import path from "node:path";
import { SCHEMA_VERSION } from "./constants.js";

export function createDefaultConfig(target) {
  const folderName = path.basename(path.resolve(target));
  const projectId = toProjectId(folderName);
  const taskPrefix = toTaskPrefix(projectId);

  return {
    schemaVersion: SCHEMA_VERSION,
    project: {
      id: projectId,
      name: toDisplayName(folderName),
      vision: "Describe the product outcome this operating system should support.",
      targetUsers: ["Describe the primary user group."],
      environments: ["development", "production"]
    },
    agents: [
      {
        id: "CONTROL",
        name: "Control Plane Coordinator",
        role: "Routes events, resolves dependencies, and consolidates reporting.",
        responsibilities: ["routing", "taskboard", "governance"],
        lifecycle: "active"
      },
      {
        id: "PRODUCT",
        name: "Product Definition",
        role: "Owns discovery, decisions, product topology, and user journeys.",
        responsibilities: ["discovery", "decisions", "product-map"],
        lifecycle: "active"
      },
      {
        id: "DELIVERY",
        name: "Delivery Contract",
        role: "Translates approved product intent into implementation-ready contracts.",
        responsibilities: ["delivery-contracts", "acceptance-criteria"],
        lifecycle: "active"
      },
      {
        id: "VALIDATION",
        name: "Validation Design",
        role: "Defines reproducible validation plans before implementation completes.",
        responsibilities: ["validation-plans", "test-data"],
        lifecycle: "active"
      },
      {
        id: "QUALITY",
        name: "Independent Quality Control",
        role: "Verifies claims, evidence, and operational state independently.",
        responsibilities: ["evidence-review", "read-back", "quality-verdicts"],
        lifecycle: "active"
      }
    ],
    ownership: [
      { artifact: "agent-registry", owner: "CONTROL" },
      { artifact: "governance", owner: "CONTROL" },
      { artifact: "taskboard", owner: "CONTROL" },
      { artifact: "product-map", owner: "PRODUCT" },
      { artifact: "delivery-contracts", owner: "DELIVERY" },
      { artifact: "validation-plan", owner: "VALIDATION" },
      { artifact: "quality-evidence", owner: "QUALITY" }
    ],
    routing: [
      {
        event: "new-idea",
        owner: "CONTROL",
        reviewers: ["PRODUCT"],
        output: "product-map"
      },
      {
        event: "approved-decision",
        owner: "DELIVERY",
        reviewers: ["PRODUCT", "VALIDATION"],
        output: "delivery-contracts"
      },
      {
        event: "implementation-ready",
        owner: "VALIDATION",
        reviewers: ["DELIVERY"],
        output: "validation-plan"
      },
      {
        event: "verification-requested",
        owner: "QUALITY",
        reviewers: ["CONTROL"],
        output: "quality-evidence"
      }
    ],
    taskIds: {
      prefix: taskPrefix,
      pattern: `^${taskPrefix}-[0-9]{4}$`
    },
    statuses: [
      {
        id: "Backlog",
        description: "Captured but not ready to start.",
        terminal: false,
        transitions: ["Ready", "Blocked"]
      },
      {
        id: "Ready",
        description: "Inputs and ownership are sufficient to start.",
        terminal: false,
        transitions: ["In Progress", "Blocked"]
      },
      {
        id: "In Progress",
        description: "The owner is actively producing the required output.",
        terminal: false,
        transitions: ["Blocked", "In Review"]
      },
      {
        id: "Blocked",
        description: "Progress requires an explicit dependency or decision.",
        terminal: false,
        transitions: ["Ready", "In Progress"]
      },
      {
        id: "In Review",
        description: "Output is awaiting independent review or acceptance.",
        terminal: false,
        transitions: ["In Progress", "Done", "Blocked"]
      },
      {
        id: "Done",
        description: "Required outputs and evidence have passed their completion gates.",
        terminal: true,
        transitions: []
      }
    ],
    workbook: {
      sheets: [
        {
          name: "Product Map",
          file: "workbook/product-map.csv",
          owner: "PRODUCT",
          columns: ["Item ID", "Area", "Capability", "Description", "Status", "Evidence"]
        },
        {
          name: "Decision Log",
          file: "workbook/decision-log.csv",
          owner: "PRODUCT",
          columns: ["Decision ID", "Question", "Disposition", "Owner", "Date", "Evidence"]
        },
        {
          name: "Delivery Contracts",
          file: "workbook/delivery-contracts.csv",
          owner: "DELIVERY",
          columns: [
            "Contract ID",
            "Scope",
            "Acceptance Criteria",
            "Dependencies",
            "Status",
            "Evidence"
          ]
        },
        {
          name: "Validation Plan",
          file: "workbook/validation-plan.csv",
          owner: "VALIDATION",
          columns: [
            "Validation ID",
            "Contract ID",
            "Scenario",
            "Expected Result",
            "Environment",
            "Status"
          ]
        },
        {
          name: "Evidence Log",
          file: "workbook/evidence-log.csv",
          owner: "QUALITY",
          columns: [
            "Evidence ID",
            "Claim",
            "Source",
            "Observed At",
            "Verifier",
            "Verdict"
          ]
        },
        {
          name: "Release Readiness",
          file: "workbook/release-readiness.csv",
          owner: "CONTROL",
          columns: ["Release ID", "Scope", "Gate", "Owner", "Status", "Evidence"]
        }
      ]
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
        type: "placeholder",
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
