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

export function toolFailure(error) {
  const code = error instanceof ToolFailure ? error.code : "INTERNAL";
  const details = error instanceof ToolFailure ? error.details : {};
  return {
    content: [{ type: "text", text: `${code}: ${error.message}` }],
    structuredContent: { code, message: error.message, ...details },
    isError: true
  };
}
