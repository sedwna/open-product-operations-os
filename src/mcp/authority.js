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

export function toolResult({ structuredContent, text }) {
  return { content: [{ type: "text", text }], structuredContent, isError: false };
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
  "AUTOPILOT_NOT_CONFIGURED"
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
