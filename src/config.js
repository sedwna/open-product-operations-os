import fs from "node:fs/promises";
import path from "node:path";
import { canonicalCatalog, getCanonicalRoles, getCanonicalWorkbookSheets } from "./catalog.js";
import { CONFIG_FILE, REQUIRED_ADAPTERS, SCHEMA_VERSION } from "./constants.js";
import { assertNoLinkTraversal, assertSafeRelativePath } from "./paths.js";
import { validatePublishedSchema } from "./schema-validation.js";

export async function loadConfig(target) {
  const root = path.resolve(target);
  const configPath = path.join(root, CONFIG_FILE);
  let text;
  try {
    await assertNoLinkTraversal(root, configPath, "Project configuration");
    text = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`Missing project configuration: ${configPath}`);
    }
    throw error;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON in ${configPath}: ${error.message}`);
  }
}

export function validateConfig(config) {
  if (!isObject(config)) {
    return ["Project configuration must be a JSON object."];
  }
  const errors = validatePublishedSchema("project-config.schema.json", config).map(
    (error) => `Project configuration schema: ${error}.`
  );
  if (config.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`schemaVersion must be "${SCHEMA_VERSION}".`);
  }

  validateUnique(config.agents, "id", "agent id", errors);
  validateUnique(config.agents, "actorId", "agent actorId", errors);
  validateUnique(config.ownership, "artifact", "ownership artifact", errors);
  validateUnique(config.routing, "event", "routing event", errors);
  validateUnique(config.statuses, "id", "status id", errors);
  validateUnique(config.workbook?.sheets, "key", "workbook sheet key", errors);
  validateUnique(config.workbook?.sheets, "name", "workbook sheet name", errors);
  validateUnique(config.workbook?.sheets, "file", "workbook file", errors);

  for (const [index, sheet] of (config.workbook?.sheets ?? []).entries()) {
    validateSafePath(sheet?.file, `workbook.sheets[${index}].file`, "workbook/", errors);
  }
  for (const adapterName of REQUIRED_ADAPTERS) {
    const adapter = config.adapters?.[adapterName];
    if (!isObject(adapter)) {
      continue;
    }
    validateSafePath(
      adapter.file,
      `adapters.${adapterName}.file`,
      "adapters/",
      errors
    );
  }

  return errors;
}

export function validateConfigRelationships(config) {
  const errors = [];
  const agentIds = new Set(config.agents.map((agent) => agent.id));
  const actorByRole = new Map(config.agents.map((agent) => [agent.id, agent.actorId]));
  const artifacts = new Set(config.ownership.map((entry) => entry.artifact));
  const statusIds = new Set(config.statuses.map((status) => status.id));
  const generatedPaths = new Map();
  const taskPattern = new RegExp(config.taskIds.pattern);

  if (!taskPattern.test(`${config.taskIds.prefix}-0001`)) {
    errors.push(
      `taskIds.pattern must accept generated IDs such as "${config.taskIds.prefix}-0001".`
    );
  }

  const agentsById = new Map(config.agents.map((agent) => [agent.id, agent]));
  for (const canonicalRole of getCanonicalRoles()) {
    const agent = agentsById.get(canonicalRole.roleKey);
    if (!agent) {
      errors.push(`Canonical role "${canonicalRole.roleKey}" is missing from agents.`);
      continue;
    }
    if (
      agent.role !== canonicalRole.purpose ||
      !sameArray(agent.responsibilities, canonicalRole.may) ||
      !sameArray(agent.prohibitedActions, canonicalRole.mustNot)
    ) {
      errors.push(
        `Canonical role "${canonicalRole.roleKey}" authority must match ${config.catalogAuthority}.`
      );
    }
  }
  if (config.catalogVersion !== canonicalCatalog.catalog_version) {
    errors.push(
      `catalogVersion must match canonical catalog version ${canonicalCatalog.catalog_version}.`
    );
  }

  if (config.separation.requireDistinctActiveActors) {
    const seenActors = new Map();
    for (const agent of config.agents.filter((entry) => entry.lifecycle === "active")) {
      if (seenActors.has(agent.actorId)) {
        errors.push(
          `Active roles "${seenActors.get(agent.actorId)}" and "${agent.id}" use the same actor "${agent.actorId}"; producer, writer, development, and verifier actors must be distinct.`
        );
      } else {
        seenActors.set(agent.actorId, agent.id);
      }
    }
    if (seenActors.has(config.project.humanAuthorityActorId)) {
      errors.push(
        `Human authority actor "${config.project.humanAuthorityActorId}" must be distinct from active role "${seenActors.get(config.project.humanAuthorityActorId)}".`
      );
    }
  }

  for (const entry of config.ownership) {
    if (!agentIds.has(entry.owner)) {
      errors.push(
        `Ownership for "${entry.artifact}" references unknown agent "${entry.owner}".`
      );
    }
  }

  for (const route of config.routing) {
    if (!agentIds.has(route.owner)) {
      errors.push(`Route "${route.event}" references unknown owner "${route.owner}".`);
    }
    for (const reviewer of route.reviewers) {
      if (!agentIds.has(reviewer)) {
        errors.push(
          `Route "${route.event}" references unknown reviewer "${reviewer}".`
        );
      }
      if (actorByRole.get(route.owner) === actorByRole.get(reviewer)) {
        errors.push(
          `Route "${route.event}" owner and reviewer must be assigned to different actors.`
        );
      }
    }
    if (!artifacts.has(route.output)) {
      errors.push(
        `Route "${route.event}" output "${route.output}" has no ownership assignment.`
      );
    }
  }

  const sheetsByKey = new Map(config.workbook.sheets.map((sheet) => [sheet.key, sheet]));
  for (const canonicalSheet of getCanonicalWorkbookSheets()) {
    const sheet = sheetsByKey.get(canonicalSheet.key);
    if (!sheet) {
      errors.push(`Canonical workbook tab "${canonicalSheet.key}" is missing.`);
      continue;
    }
    if (
      sheet.name !== canonicalSheet.name ||
      sheet.file !== canonicalSheet.file ||
      sheet.owner !== canonicalSheet.owner ||
      !sameArray(sheet.columns, canonicalSheet.columns)
    ) {
      errors.push(
        `Canonical workbook tab "${canonicalSheet.key}" must match ${config.catalogAuthority}.`
      );
    }
  }

  const protectedFields = new Set([
    ...config.fieldAuthority.protectedDevelopmentFields,
    ...config.fieldAuthority.protectedHumanFields
  ]);
  for (const sheet of config.workbook.sheets) {
    if (!agentIds.has(sheet.owner)) {
      errors.push(
        `Workbook sheet "${sheet.name}" references unknown owner "${sheet.owner}".`
      );
    }
    addGeneratedPath(sheet.file, `workbook sheet "${sheet.name}"`, generatedPaths, errors);
    for (const field of sheet.columns.filter((column) => protectedFields.has(column))) {
      const allowedTabs = config.fieldAuthority.protectedFieldTabs[field] ?? [];
      if (!allowedTabs.includes(sheet.key)) {
        errors.push(
          `Protected field "${field}" is not authorized in workbook tab "${sheet.key}".`
        );
      }
    }
  }

  for (const field of [
    ...canonicalCatalog.field_authority.protected_development_fields,
    ...canonicalCatalog.field_authority.protected_human_fields
  ]) {
    if (!protectedFields.has(field)) {
      errors.push(`Canonical protected field "${field}" may not be removed.`);
    }
  }
  for (const [field, canonicalTabs] of Object.entries(
    canonicalCatalog.field_authority.protected_field_tabs
  )) {
    if (!sameArray(config.fieldAuthority.protectedFieldTabs[field] ?? [], canonicalTabs)) {
      errors.push(
        `Protected-field tab authority for "${field}" must match ${config.catalogAuthority}.`
      );
    }
  }
  if (
    !sameArray(
      config.validation.allowedSyntheticEmailDomains,
      canonicalCatalog.validation.allowed_synthetic_email_domains
    )
  ) {
    errors.push("Synthetic email-domain allowlist must match the canonical catalog.");
  }

  for (const [name, adapter] of Object.entries(config.adapters)) {
    addGeneratedPath(adapter.file, `adapter "${name}"`, generatedPaths, errors);
  }

  for (const status of config.statuses) {
    if (status.terminal && status.transitions.length > 0) {
      errors.push(`Terminal status "${status.id}" must not define transitions.`);
    }
    for (const transition of status.transitions) {
      if (!statusIds.has(transition)) {
        errors.push(
          `Status "${status.id}" transitions to undefined status "${transition}".`
        );
      }
    }
  }

  if (!config.statuses.some((status) => !status.terminal)) {
    errors.push("statuses must define at least one non-terminal starting status.");
  }

  return errors;
}

function addGeneratedPath(file, owner, paths, errors) {
  const key = file.toLowerCase();
  if (paths.has(key)) {
    errors.push(
      `Generated file "${file}" is shared by ${paths.get(key)} and ${owner}.`
    );
  } else {
    paths.set(key, owner);
  }
}

function validateUnique(entries, key, label, errors) {
  if (!Array.isArray(entries)) {
    return;
  }
  const seen = new Set();
  for (const entry of entries) {
    const value = entry?.[key];
    if (typeof value === "string" && seen.has(value)) {
      errors.push(`Duplicate ${label} "${value}".`);
    }
    seen.add(value);
  }
}

function validateSafePath(value, label, prefix, errors) {
  try {
    const safe = assertSafeRelativePath(value, label);
    if (!safe.startsWith(prefix)) {
      errors.push(`${label} must be inside "${prefix}".`);
    }
  } catch (error) {
    errors.push(error.message);
  }
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
