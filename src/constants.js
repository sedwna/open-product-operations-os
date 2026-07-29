export const CONFIG_FILE = "product-ops.config.json";
export const SCHEMA_VERSION = "1.0.0";

export const REGISTRY_FILE = "agents/registry.json";
export const GOVERNANCE_FILE = "governance/governance.json";
export const TASKBOARD_FILE = "taskboard/tasks.csv";

export const TASKBOARD_COLUMNS = [
  "Task ID",
  "Title",
  "Owner",
  "Status",
  "Route",
  "Depends On",
  "Evidence",
  "Updated At"
];

export const REQUIRED_ADAPTERS = ["development", "git", "spreadsheet"];
