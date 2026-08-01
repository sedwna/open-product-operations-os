import fs from "node:fs/promises";
import path from "node:path";
import { validatePublishedSchema } from "../schema-validation.js";
import { DEVELOPMENT_CONFIG_FILE, ENGINEERING_ROLES, QUALITY_GATES } from "./catalog.js";

export async function loadDevelopmentConfig(root) {
  const file = path.join(path.resolve(root), DEVELOPMENT_CONFIG_FILE);
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`Missing development configuration: ${file}`);
    throw new Error(`Invalid development configuration: ${error.message}`);
  }
}

export function validateDevelopmentConfig(config) {
  const errors = validatePublishedSchema("development-os-config.schema.json", config);
  if (errors.length > 0) return errors;
  const expectedRoles = ENGINEERING_ROLES.map((role) => role.id);
  const actualRoles = config.roles.map((role) => role.id);
  if (!sameSet(actualRoles, expectedRoles)) errors.push("Development config must contain exactly the 15 canonical engineering roles.");
  if (new Set(config.roles.map((role) => role.actorId)).size !== config.roles.length) {
    errors.push("Every active engineering role requires a distinct default actor.");
  }
  for (const expected of ENGINEERING_ROLES) {
    const actual = config.roles.find((role) => role.id === expected.id);
    if (actual && (actual.boundary !== expected.boundary || actual.name !== expected.name)) {
      errors.push(`Engineering role ${expected.id} does not match the canonical boundary.`);
    }
  }
  const roles = new Set(actualRoles);
  const gateIds = config.qualityGates.map((gate) => gate.id);
  if (!sameSet(gateIds, QUALITY_GATES.map((gate) => gate.id))) {
    errors.push("Development config must contain the complete canonical quality-gate catalog.");
  }
  for (const gate of config.qualityGates) {
    if (!roles.has(gate.ownerRole)) errors.push(`Quality gate ${gate.id} references an unknown owner role.`);
  }
  if (!sameSet(config.executors.map((executor) => executor.roleId), expectedRoles)) {
    errors.push("Development config must contain exactly one executor for each canonical engineering role.");
  }
  for (const executor of config.executors) {
    if (executor.enabled && executor.executable.trim() === "") {
      errors.push(`Enabled executor ${executor.roleId} requires an executable.`);
    }
  }
  const overlap = config.policies.allowedPaths.filter((allowed) =>
    config.policies.prohibitedPaths.some((blocked) => allowed === blocked || allowed.startsWith(`${blocked}/`))
  );
  if (overlap.length) errors.push(`Allowed paths overlap prohibited paths: ${overlap.join(", ")}.`);
  return errors;
}

function sameSet(left, right) {
  return left.length === right.length && left.every((value) => right.includes(value));
}
