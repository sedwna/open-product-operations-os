import { TIERS } from "./authority.js";
import * as read from "./tools/read.js";
import * as write from "./tools/write.js";
import * as work from "./tools/work.js";
import * as engineering from "./tools/engineering.js";
import { adopt } from "./tools/adopt.js";
import { decide } from "./tools/decide.js";
import { PANEL_URI } from "./app/panel.js";

const READ_ONLY_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
});

const PLAN_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false
});

/**
 * The single source of truth for the tool surface. The read tier is always registered; the plan
 * tier is registered only under explicit write authorisation, so a read-only server has no
 * reachable mutation path rather than a rejected one. The human-authority tier lands with
 * elicitation.
 */
export const TOOL_DEFINITIONS = Object.freeze([
  {
    name: "product_ops_panel",
    title: "Open the control tower",
    description: "Open the interactive control-tower panel: current phase, task counts, open risks, and the gates waiting on the product owner.",
    tier: TIERS.READ,
    annotations: READ_ONLY_ANNOTATIONS,
    // Binds this tool to its MCP App. The host preloads the resource and renders it in place of a
    // text result; `visibility` keeps the summary available to the model if it cannot.
    meta: { ui: { resourceUri: PANEL_URI, visibility: ["app", "model"] } },
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: read.panel
  },
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
  },
  {
    name: "product_ops_intake",
    title: "Record product intake",
    description: "Record a new idea, finding, incident, feedback item, or request. Plans by default; set apply true to write it.",
    tier: TIERS.PLAN,
    annotations: PLAN_ANNOTATIONS,
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["new_idea", "user_finding", "incident", "feedback", "request"] },
        title: { type: "string", minLength: 3, maxLength: 200 },
        description: { type: "string", minLength: 3, maxLength: 4000 },
        source: { type: "string", minLength: 1, maxLength: 200, description: "Where this came from. Report the real origin; do not invent one." },
        targetUser: { type: "string", maxLength: 200 },
        priority: { type: "string", enum: ["P0", "P1", "P2", "P3"], default: "P2" },
        apply: { type: "boolean", default: false, description: "Write the record. Omitted or false returns the plan only." },
        autopilotAuthorized: {
          type: "boolean",
          default: false,
          description: "Authorise one bounded autonomous cycle for this intake. Only set it when the product owner has said so in this conversation."
        }
      },
      required: ["type", "title", "description", "source"],
      additionalProperties: false
    },
    handler: write.intake
  },
  {
    name: "product_ops_operate",
    title: "Run a control-plane cycle",
    description: "Plan or run one bounded control-plane scheduling cycle: promote ready work, route intake, and open required human gates.",
    tier: TIERS.PLAN,
    annotations: PLAN_ANNOTATIONS,
    inputSchema: {
      type: "object",
      properties: { apply: { type: "boolean", default: false, description: "Run the cycle. Omitted or false returns the plan only." } },
      additionalProperties: false
    },
    handler: write.operate
  },
  {
    name: "product_ops_autopilot",
    title: "Control the autonomous coordinator",
    description: "Start, pause, resume, or retry the local autonomous coordinator. Pause is cooperative and takes effect after the running agent returns.",
    tier: TIERS.PLAN,
    annotations: PLAN_ANNOTATIONS,
    inputSchema: {
      type: "object",
      properties: { action: { type: "string", enum: ["start", "pause", "resume", "retry"] } },
      required: ["action"],
      additionalProperties: false
    },
    handler: write.autopilot
  },
  // Two tools below read without writing and are still registered under the plan tier rather than
  // the read tier. That is deliberate, not an oversight in either direction.
  //
  // `adopt` reads a *different repository* than the one this server is bound to. Reaching outside
  // the project boundary is a larger thing to grant than reading inside it, whatever the tool then
  // does with what it finds.
  //
  // `next_work` hands out a claim whose only use is `submit_work`. On a read-only server it could
  // only ever produce work nobody can return, which is a worse answer than not offering it.
  {
    name: "product_ops_adopt",
    title: "Survey the existing application",
    description: "Account for every path in the linked application and assign each to the boundary that must read it. Reads only.",
    tier: TIERS.PLAN,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: adopt
  },
  {
    name: "product_ops_next_work",
    title: "Take the next ready product task",
    description: "Hand out one bounded brief — the team, its boundary, and the task — for you to delegate to a subagent. Reads only.",
    tier: TIERS.PLAN,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: work.nextWork
  },
  {
    name: "product_ops_submit_work",
    title: "Return a completed product task",
    description: "Record what your subagent produced for a claimed task. Plans by default; set apply true to record it.",
    tier: TIERS.PLAN,
    annotations: PLAN_ANNOTATIONS,
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", minLength: 1, maxLength: 80 },
        claimToken: { type: "string", minLength: 32, maxLength: 32, description: "Issued by product_ops_next_work. Take the work before returning it; this cannot be constructed." },
        result: {
          type: "object",
          description: "The subagent's output. Validated against product-agent-run.schema.json and against the dispatched task; a mismatch is refused, not recorded.",
          additionalProperties: true
        },
        apply: { type: "boolean", default: false, description: "Record the result. Omitted or false returns the plan only." }
      },
      required: ["taskId", "claimToken", "result"],
      additionalProperties: false
    },
    handler: work.submitWork
  },
  {
    name: "product_ops_next_engineering_work",
    title: "Take the next ready engineering workstream",
    description: "Hand out one bounded engineering brief from the linked application for you to delegate. Reads only.",
    tier: TIERS.PLAN,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: engineering.nextEngineeringWork
  },
  {
    name: "product_ops_submit_engineering_work",
    title: "Return a completed engineering workstream",
    description: "Record what your subagent produced for a claimed workstream. Plans by default; set apply true to record it.",
    tier: TIERS.PLAN,
    annotations: PLAN_ANNOTATIONS,
    inputSchema: {
      type: "object",
      properties: {
        workstreamId: { type: "string", minLength: 1, maxLength: 80 },
        claimToken: { type: "string", minLength: 32, maxLength: 32, description: "Issued by product_ops_next_engineering_work; it cannot be constructed." },
        result: {
          type: "object",
          description: "The subagent's output. Validated against engineering-workstream-run.schema.json and against the dispatched workstream; a mismatch is refused, not recorded.",
          additionalProperties: true
        },
        apply: { type: "boolean", default: false, description: "Record the result. Omitted or false returns the plan only." }
      },
      required: ["workstreamId", "claimToken", "result"],
      additionalProperties: false
    },
    handler: engineering.submitEngineeringWork
  },
  {
    name: "product_ops_decide",
    title: "Record a human decision",
    description: "Put a pending human gate to the product owner and record their disposition. The decision and rationale are collected from the person, not from you.",
    tier: TIERS.HUMAN_AUTHORITY,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    // Anthropic-specific, honoured by Claude Code v2.1.199 and later: force the permission prompt on
    // every call, in every permission mode. Other hosts apply their own approval model.
    meta: { "anthropic/requiresUserInteraction": true },
    inputSchema: {
      type: "object",
      properties: {
        requestId: { type: "string", pattern: "^APR-[0-9A-F]{12}$" },
        decisionToken: { type: "string", minLength: 32, maxLength: 32, description: "Issued by product_ops_pending_decisions. Read that first; it cannot be constructed." },
        apply: { type: "boolean", default: false, description: "Open the dialog and record the answer. Omitted or false describes what would be asked." },
        source: { type: "string", enum: ["panel"], description: "Set only by the control tower panel, where the product owner composed the disposition themselves. Never set this yourself." },
        decision: { type: "string", enum: ["approved", "rejected"], description: "Only from the panel, or from a host that cannot open a dialog. Supply only what the product owner actually said." },
        selectedOption: { type: "string", maxLength: 200, description: "Which of the gate's offered options the owner chose. Required when the gate offered more than approve or reject." },
        conditions: {
          type: "array",
          maxItems: 20,
          items: { type: "string", minLength: 1, maxLength: 400 },
          description: "What the owner attached to the disposition, in their words. An approval with conditions is not a bare approval."
        },
        actorId: { type: "string", maxLength: 80, description: "Must be the configured human authority actor." },
        rationale: { type: "string", maxLength: 2000, description: "The owner's own reasoning, not your summary of it." }
      },
      required: ["requestId", "decisionToken"],
      additionalProperties: false
    },
    handler: decide
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
