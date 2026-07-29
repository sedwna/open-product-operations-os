export const CONFIG_FILE = "product-ops.config.json";
export const SCHEMA_VERSION = "1.0.0";

export const REGISTRY_FILE = "agents/registry.json";
export const GOVERNANCE_FILE = "governance/governance.json";
export const TASKBOARD_FILE = "taskboard/tasks.csv";

export const TASKBOARD_COLUMNS = [
  "task_id",
  "event_id",
  "title",
  "owner_role",
  "owner_actor_id",
  "status",
  "priority",
  "dependency_ids",
  "blocked_reason",
  "next_owner_role",
  "unblock_condition",
  "canonical_output_refs",
  "evidence_refs",
  "handoff_id",
  "independent_verifier_role",
  "verifier_actor_id",
  "human_gate",
  "due_at",
  "updated_at"
];

export const REQUIRED_ADAPTERS = ["development", "git", "spreadsheet"];
