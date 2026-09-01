import { validatePublishedSchema } from "../schema-validation.js";

const CONTRACT_SCHEMA = "controlled-writer-adapter.schema.json";
const REQUIRED_METHODS = ["plan", "apply", "readBack", "replay", "rollback"];

/**
 * Validate the provider-neutral descriptor and, when supplied, the executable adapter surface.
 * This function does not execute a write and does not grant authority to an adapter.
 */
export function validateControlledWriterAdapter(descriptor, implementation) {
  const errors = validatePublishedSchema(CONTRACT_SCHEMA, descriptor);
  if (implementation === undefined) return errors;
  if (!implementation || typeof implementation !== "object" || Array.isArray(implementation)) {
    return [...errors, "/implementation must be an object"];
  }
  for (const contractMethod of REQUIRED_METHODS) {
    const methodName = descriptor?.methods?.[contractMethod] ?? contractMethod;
    if (typeof implementation[methodName] !== "function") {
      errors.push(`/implementation/${methodName} must be a function`);
    }
  }
  return errors;
}

export function assertControlledWriterAdapter(descriptor, implementation) {
  const errors = validateControlledWriterAdapter(descriptor, implementation);
  if (errors.length > 0) {
    throw new Error(`Invalid controlled writer adapter:\n- ${errors.join("\n- ")}`);
  }
  return { descriptor, implementation };
}

export function controlledWriterMethodNames() {
  return [...REQUIRED_METHODS];
}
