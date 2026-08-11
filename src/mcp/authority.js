/**
 * A failure the calling model can reasonably recover from. Surfaced as an MCP tool result with
 * `isError: true` and a stable code, rather than as a JSON-RPC protocol fault.
 */
export class ToolFailure extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ToolFailure";
    this.code = code;
    this.details = details;
  }
}

export const TIERS = Object.freeze({ READ: "read", PLAN: "plan", HUMAN_AUTHORITY: "human_authority" });

/**
 * Tier B and C tools are not registered at all without explicit write authorisation, so a
 * read-only server has no reachable mutation path rather than a rejected one.
 */
export function selectRegisteredTools(definitions, { allowWrites }) {
  return definitions.filter((definition) => allowWrites || definition.tier === TIERS.READ);
}

/**
 * A tool may return `resources` alongside its text: entries the host renders rather than reads.
 *
 * The panel needed this and did not have it. It returned its data and a sentence saying the control
 * tower was open, and nothing was ever handed to the host — so the owner got the coordinator's prose
 * summary of a panel that had not been drawn. A surface claiming an outcome it did not produce is
 * the one failure this project exists to prevent, so the attachment is the mechanism and the honest
 * sentence is the caller's job.
 */
export function toolResult({ structuredContent, text, resources = [] }) {
  const content = [{ type: "text", text }];
  for (const resource of resources) {
    content.push({ type: "resource", resource });
  }
  return { content, structuredContent, isError: false };
}

/**
 * The published failure taxonomy. Anything outside it is reported as INTERNAL rather than leaking a
 * filesystem or library error code into a contract callers may come to depend on.
 */
export const TOOL_ERROR_CODES = Object.freeze([
  "PROJECT_INVALID",
  "WRITE_LEASE_HELD",
  "APPLY_NOT_AUTHORIZED",
  "DECISION_TOKEN_INVALID",
  "APPROVAL_NOT_PENDING",
  "ACTOR_NOT_HUMAN_AUTHORITY",
  "ELICITATION_UNAVAILABLE",
  "ELICITATION_DECLINED",
  "NOT_FOUND",
  "AUTOPILOT_NOT_CONFIGURED",
  "CLAIM_INVALID",
  "RESULT_REJECTED",
  "NO_LINKED_APPLICATION",
  "SURVEY_FAILED",
  "WORK_INCOMPLETE",
  "DELIVERY_NOT_CLOSEABLE",
  "RECORD_REJECTED"
]);

export function toolFailure(error) {
  // ControlPlaneLeaseError carries WRITE_LEASE_HELD without being a ToolFailure, so match on the
  // published code rather than on the class.
  const code = TOOL_ERROR_CODES.includes(error?.code) ? error.code : "INTERNAL";
  const details = error instanceof ToolFailure
    ? error.details
    : (error?.holderSurface ? { surface: error.holderSurface } : {});
  return {
    content: [{ type: "text", text: `${code}: ${error.message}` }],
    structuredContent: { code, message: error.message, ...details },
    isError: true
  };
}
