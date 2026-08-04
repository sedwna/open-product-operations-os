import { TIERS } from "./authority.js";
import * as read from "./tools/read.js";

const READ_ONLY_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
});

/**
 * The single source of truth for the tool surface. Phase one registers the read tier only; the plan
 * and human-authority tiers land with the shared control-plane write lease.
 */
export const TOOL_DEFINITIONS = Object.freeze([
  {
    name: "product_ops_status",
    title: "Product cycle status",
    description: "Report the current product-cycle state: phase, owning role, active task, task counts, pending human gates, and top risks.",
    tier: TIERS.READ,
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: {
      type: "object",
      properties: { verbosity: { type: "string", enum: ["brief", "full"], default: "brief", description: "brief stays under the result budget; full adds role activity, readiness, and recent events." } },
      additionalProperties: false
    },
    handler: read.status
  },
  {
    name: "product_ops_pending_decisions",
    title: "Pending human gates",
    description: "List the human gates waiting on the product owner, with the question, context, risks, and evidence needed to decide.",
    tier: TIERS.READ,
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 25, default: 10 } },
      additionalProperties: false
    },
    handler: read.pendingDecisions
  },
  {
    name: "product_ops_task",
    title: "Task detail",
    description: "Explain one task: status, owning role, dependency state, blocking reason, and evidence references.",
    tier: TIERS.READ,
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string", minLength: 3, maxLength: 120 } },
      required: ["taskId"],
      additionalProperties: false
    },
    handler: read.task
  },
  {
    name: "product_ops_cycle_report",
    title: "Cycle report",
    description: "Return the report from the latest completed autonomous cycle: idea, acceptance, changed components, and open risks.",
    tier: TIERS.READ,
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: {
      type: "object",
      properties: { cycleId: { type: "string", maxLength: 120 } },
      additionalProperties: false
    },
    handler: read.cycleReport
  },
  {
    name: "product_ops_evidence",
    title: "Evidence for a claim",
    description: "List the evidence items and digests backing a task or event. Returns references, never file contents.",
    tier: TIERS.READ,
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", maxLength: 120 },
        eventId: { type: "string", maxLength: 120 }
      },
      additionalProperties: false
    },
    handler: read.evidence
  },
  {
    name: "product_ops_readiness",
    title: "Release readiness",
    description: "Report release readiness and, when not ready, the specific gates and records that are missing.",
    tier: TIERS.READ,
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: read.readiness
  },
  {
    name: "product_ops_validate",
    title: "Validate project",
    description: "Run project validation and report structural, ownership, routing, and secret-scan findings.",
    tier: TIERS.READ,
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: read.validate
  }
]);

export function toListEntry(definition) {
  const entry = {
    name: definition.name,
    title: definition.title,
    description: definition.description,
    inputSchema: definition.inputSchema,
    annotations: definition.annotations
  };
  if (definition.meta) entry._meta = definition.meta;
  return entry;
}
