import fs from "node:fs/promises";
import path from "node:path";
import { CONFIG_FILE, REQUIRED_ADAPTERS, SCHEMA_VERSION } from "./constants.js";
import { assertSafeRelativePath } from "./paths.js";

export async function loadConfig(target) {
  const configPath = path.join(path.resolve(target), CONFIG_FILE);
  let text;
  try {
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
  const errors = [];
  const object = isObject(config);

  if (!object) {
    return ["Project configuration must be a JSON object."];
  }
  if (config.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`schemaVersion must be "${SCHEMA_VERSION}".`);
  }

  requireString(config.project?.id, "project.id", errors);
  if (
    typeof config.project?.id === "string" &&
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(config.project.id)
  ) {
    errors.push("project.id must be a lowercase, hyphen-separated identifier.");
  }
  requireString(config.project?.name, "project.name", errors);
  requireString(config.project?.vision, "project.vision", errors);
  requireStringArray(config.project?.targetUsers, "project.targetUsers", errors);
  requireStringArray(config.project?.environments, "project.environments", errors);

  if (!Array.isArray(config.agents) || config.agents.length === 0) {
    errors.push("agents must contain at least one agent.");
  } else {
    const ids = new Set();
    config.agents.forEach((agent, index) => {
      const label = `agents[${index}]`;
      requireString(agent?.id, `${label}.id`, errors);
      requireString(agent?.name, `${label}.name`, errors);
      requireString(agent?.role, `${label}.role`, errors);
      requireStringArray(agent?.responsibilities, `${label}.responsibilities`, errors);
      if (!["active", "inactive", "proposed"].includes(agent?.lifecycle)) {
        errors.push(`${label}.lifecycle must be active, inactive, or proposed.`);
      }
      if (typeof agent?.id === "string") {
        if (!/^[A-Z][A-Z0-9_-]{1,31}$/.test(agent.id)) {
          errors.push(`${label}.id must use 2-32 uppercase letters, digits, "_" or "-".`);
        }
        if (ids.has(agent.id)) {
          errors.push(`Duplicate agent id "${agent.id}".`);
        }
        ids.add(agent.id);
      }
    });
  }

  if (!Array.isArray(config.ownership) || config.ownership.length === 0) {
    errors.push("ownership must contain at least one assignment.");
  } else {
    const artifacts = new Set();
    config.ownership.forEach((entry, index) => {
      requireString(entry?.artifact, `ownership[${index}].artifact`, errors);
      requireString(entry?.owner, `ownership[${index}].owner`, errors);
      if (typeof entry?.artifact === "string" && artifacts.has(entry.artifact)) {
        errors.push(`Duplicate ownership artifact "${entry.artifact}".`);
      }
      artifacts.add(entry?.artifact);
    });
  }

  if (!Array.isArray(config.routing) || config.routing.length === 0) {
    errors.push("routing must contain at least one route.");
  } else {
    const events = new Set();
    config.routing.forEach((route, index) => {
      requireString(route?.event, `routing[${index}].event`, errors);
      requireString(route?.owner, `routing[${index}].owner`, errors);
      requireStringArray(route?.reviewers, `routing[${index}].reviewers`, errors, true);
      requireString(route?.output, `routing[${index}].output`, errors);
      if (typeof route?.event === "string" && events.has(route.event)) {
        errors.push(`Duplicate routing event "${route.event}".`);
      }
      events.add(route?.event);
    });
  }

  requireString(config.taskIds?.prefix, "taskIds.prefix", errors);
  if (
    typeof config.taskIds?.prefix === "string" &&
    !/^[A-Z][A-Z0-9]{1,7}$/.test(config.taskIds.prefix)
  ) {
    errors.push("taskIds.prefix must use 2-8 uppercase letters or digits.");
  }
  requireString(config.taskIds?.pattern, "taskIds.pattern", errors);
  if (typeof config.taskIds?.pattern === "string") {
    try {
      new RegExp(config.taskIds.pattern);
    } catch (error) {
      errors.push(`taskIds.pattern is not a valid regular expression: ${error.message}`);
    }
  }

  if (!Array.isArray(config.statuses) || config.statuses.length === 0) {
    errors.push("statuses must contain at least one status definition.");
  } else {
    const statuses = new Set();
    config.statuses.forEach((status, index) => {
      const label = `statuses[${index}]`;
      requireString(status?.id, `${label}.id`, errors);
      requireString(status?.description, `${label}.description`, errors);
      if (typeof status?.terminal !== "boolean") {
        errors.push(`${label}.terminal must be a boolean.`);
      }
      requireStringArray(status?.transitions, `${label}.transitions`, errors, true);
      if (typeof status?.id === "string" && statuses.has(status.id)) {
        errors.push(`Duplicate status id "${status.id}".`);
      }
      statuses.add(status?.id);
    });
  }

  if (!Array.isArray(config.workbook?.sheets) || config.workbook.sheets.length === 0) {
    errors.push("workbook.sheets must contain at least one sheet.");
  } else {
    const names = new Set();
    const files = new Set();
    config.workbook.sheets.forEach((sheet, index) => {
      const label = `workbook.sheets[${index}]`;
      requireString(sheet?.name, `${label}.name`, errors);
      requireString(sheet?.owner, `${label}.owner`, errors);
      requireStringArray(sheet?.columns, `${label}.columns`, errors);
      validateSafePath(sheet?.file, `${label}.file`, "workbook/", errors);
      if (typeof sheet?.name === "string" && names.has(sheet.name)) {
        errors.push(`Duplicate workbook sheet name "${sheet.name}".`);
      }
      if (typeof sheet?.file === "string" && files.has(sheet.file)) {
        errors.push(`Duplicate workbook file "${sheet.file}".`);
      }
      names.add(sheet?.name);
      files.add(sheet?.file);
    });
  }

  for (const adapterName of REQUIRED_ADAPTERS) {
    const adapter = config.adapters?.[adapterName];
    if (!isObject(adapter)) {
      errors.push(`adapters.${adapterName} must be an object.`);
      continue;
    }
    requireString(adapter.type, `adapters.${adapterName}.type`, errors);
    if (typeof adapter.enabled !== "boolean") {
      errors.push(`adapters.${adapterName}.enabled must be a boolean.`);
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
  const artifacts = new Set(config.ownership.map((entry) => entry.artifact));
  const statusIds = new Set(config.statuses.map((status) => status.id));
  const generatedPaths = new Map();
  const taskPattern = new RegExp(config.taskIds.pattern);

  if (!taskPattern.test(`${config.taskIds.prefix}-0001`)) {
    errors.push(
      `taskIds.pattern must accept generated IDs such as "${config.taskIds.prefix}-0001".`
    );
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
    }
    if (!artifacts.has(route.output)) {
      errors.push(
        `Route "${route.event}" output "${route.output}" has no ownership assignment.`
      );
    }
  }

  for (const sheet of config.workbook.sheets) {
    if (!agentIds.has(sheet.owner)) {
      errors.push(
        `Workbook sheet "${sheet.name}" references unknown owner "${sheet.owner}".`
      );
    }
    addGeneratedPath(sheet.file, `workbook sheet "${sheet.name}"`, generatedPaths, errors);
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

function requireString(value, label, errors) {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${label} must be a non-empty string.`);
  }
}

function requireStringArray(value, label, errors, allowEmpty = false) {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.some((item) => typeof item !== "string" || item.trim() === "")
  ) {
    errors.push(
      `${label} must be ${allowEmpty ? "an" : "a non-empty"} array of non-empty strings.`
    );
  } else if (new Set(value).size !== value.length) {
    errors.push(`${label} must not contain duplicate values.`);
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

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
