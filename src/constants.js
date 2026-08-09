export const CONFIG_FILE = "product-ops.config.json";
export const SCHEMA_VERSION = "1.0.0";
export const OPERATING_MODEL_VERSION = 3;

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

export const RUNTIME_DIRECTORY = ".product-ops/runtime";
export const APPROVAL_STORE_FILE = `${RUNTIME_DIRECTORY}/approvals.json`;
export const INTAKE_STORE_FILE = `${RUNTIME_DIRECTORY}/intake.json`;
export const PROVIDER_OUTBOX_FILE = `${RUNTIME_DIRECTORY}/provider-outbox.json`;
export const PROVIDER_INBOX_FILE = `${RUNTIME_DIRECTORY}/provider-inbox.json`;
export const PROVIDER_RECEIPTS_FILE = `${RUNTIME_DIRECTORY}/provider-receipts.json`;
