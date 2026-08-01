import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
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
  if (!sameUniqueSet(actualRoles, expectedRoles)) errors.push("Development config must contain exactly the 15 unique canonical engineering roles.");
  if (new Set(config.roles.map((role) => role.actorId)).size !== config.roles.length) {
    errors.push("Every active engineering role requires a distinct default actor.");
  }
  for (const expected of ENGINEERING_ROLES) {
    const actual = config.roles.find((role) => role.id === expected.id);
    if (actual && !sameCanonicalRole(actual, expected)) {
      errors.push(`Engineering role ${expected.id} does not match the canonical name, boundary, or authority contract.`);
    }
  }
  const roles = new Set(actualRoles);
  const gateIds = config.qualityGates.map((gate) => gate.id);
  if (!sameUniqueSet(gateIds, QUALITY_GATES.map((gate) => gate.id))) {
    errors.push("Development config must contain the complete unique canonical quality-gate catalog.");
  }
  for (const expected of QUALITY_GATES) {
    const actual = config.qualityGates.find((gate) => gate.id === expected.id);
    if (actual && !sameJson(actual, expected)) {
      errors.push(`Quality gate ${expected.id} does not match the canonical owner, requirement, domain, or evidence contract.`);
    }
  }
  for (const gate of config.qualityGates) {
    if (!roles.has(gate.ownerRole)) errors.push(`Quality gate ${gate.id} references an unknown owner role.`);
  }
  if (!sameUniqueSet(config.executors.map((executor) => executor.roleId), expectedRoles)) {
    errors.push("Development config must contain exactly one uniquely identified executor for each canonical engineering role.");
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

function sameUniqueSet(left, right) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return left.length === leftSet.size
    && right.length === rightSet.size
    && leftSet.size === rightSet.size
    && [...leftSet].every((value) => rightSet.has(value));
}

function sameCanonicalRole(actual, expected) {
  return actual.name === expected.name
    && actual.boundary === expected.boundary
    && sameJson(actual.may, expected.may)
    && sameJson(actual.mustNot, expected.mustNot);
}

function sameJson(left, right) {
  return isDeepStrictEqual(left, right);
}
