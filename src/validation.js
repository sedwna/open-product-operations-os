import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  CONFIG_FILE,
  GOVERNANCE_FILE,
  REGISTRY_FILE,
  SCHEMA_VERSION,
  TASKBOARD_COLUMNS,
  TASKBOARD_FILE
} from "./constants.js";
import { parseCsv, rowsToObjects } from "./csv.js";
import { buildGovernance, buildRegistry } from "./generator.js";
import { resolveInside } from "./paths.js";

const SECRET_PATTERNS = [
  { name: "private key", expression: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "cloud access key", expression: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "personal access token", expression: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/ },
  { name: "chat token", expression: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  {
    name: "assigned credential",
    expression:
      /(?:api[_-]?key|client[_-]?secret|password|access[_-]?token)\s*["']?\s*[:=]\s*["']?(?!not-configured|placeholder|example|changeme)([A-Za-z0-9/+_.=-]{12,})/i
  }
];

export async function validateProject(target, config) {
  const errors = [];
  const warnings = [];
  const root = path.resolve(target);
  const requiredFiles = [
    REGISTRY_FILE,
    GOVERNANCE_FILE,
    TASKBOARD_FILE,
    ...config.workbook.sheets.map((sheet) => sheet.file),
    ...Object.values(config.adapters).map((adapter) => adapter.file)
  ];

  const contents = new Map();
  for (const relativePath of requiredFiles) {
    const destination = resolveInside(root, relativePath, `Required file "${relativePath}"`);
    try {
      contents.set(relativePath, await fs.readFile(destination, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") {
        errors.push(`Missing required file "${relativePath}".`);
      } else {
        errors.push(`Cannot read required file "${relativePath}": ${error.message}`);
      }
    }
  }

  scanForSecrets(CONFIG_FILE, JSON.stringify(config), errors);

  validateGeneratedJson(
    REGISTRY_FILE,
    contents.get(REGISTRY_FILE),
    buildRegistry(config),
    errors
  );
  validateGeneratedJson(
    GOVERNANCE_FILE,
    contents.get(GOVERNANCE_FILE),
    buildGovernance(config),
    errors
  );

  if (contents.has(TASKBOARD_FILE)) {
    validateTaskboard(contents.get(TASKBOARD_FILE), config, errors);
  }

  for (const sheet of config.workbook.sheets) {
    if (contents.has(sheet.file)) {
      validateWorkbook(sheet, contents.get(sheet.file), errors);
    }
  }

  for (const [name, adapter] of Object.entries(config.adapters)) {
    if (contents.has(adapter.file)) {
      validateAdapter(name, adapter, contents.get(adapter.file), errors);
    }
  }

  for (const [relativePath, content] of contents) {
    scanForSecrets(relativePath, content, errors);
  }

  return { errors, warnings, checkedFiles: requiredFiles.length };
}

function validateGeneratedJson(relativePath, text, expected, errors) {
  if (text === undefined) {
    return;
  }
  let actual;
  try {
    actual = JSON.parse(text);
  } catch (error) {
    errors.push(`Invalid JSON in "${relativePath}": ${error.message}`);
    return;
  }

  if (!isDeepStrictEqual(actual, expected)) {
    errors.push(
      `"${relativePath}" has drifted from the project configuration; regenerate it with init --force.`
    );
  }
}

function validateTaskboard(text, config, errors) {
  let parsed;
  try {
    parsed = rowsToObjects(parseCsv(text));
  } catch (error) {
    errors.push(`Invalid taskboard CSV: ${error.message}`);
    return;
  }

  if (!sameArray(parsed.headers, TASKBOARD_COLUMNS)) {
    errors.push(
      `Taskboard headers must be: ${TASKBOARD_COLUMNS.join(", ")}.`
    );
    return;
  }

  const taskPattern = new RegExp(config.taskIds.pattern);
  const agentIds = new Set(config.agents.map((agent) => agent.id));
  const statuses = new Set(config.statuses.map((status) => status.id));
  const routes = new Set(config.routing.map((route) => route.event));
  const taskIds = new Set();

  for (const [index, task] of parsed.records.entries()) {
    const label = `Taskboard row ${index + 2}`;
    if (!taskPattern.test(task["Task ID"])) {
      errors.push(
        `${label} task ID "${task["Task ID"]}" does not match ${config.taskIds.pattern}.`
      );
    }
    if (taskIds.has(task["Task ID"])) {
      errors.push(`${label} duplicates task ID "${task["Task ID"]}".`);
    }
    taskIds.add(task["Task ID"]);
    if (task.Title.trim() === "") {
      errors.push(`${label} must have a title.`);
    }
    if (!agentIds.has(task.Owner)) {
      errors.push(`${label} references unknown owner "${task.Owner}".`);
    }
    if (!statuses.has(task.Status)) {
      errors.push(`${label} uses undefined status "${task.Status}".`);
    }
    if (!routes.has(task.Route)) {
      errors.push(`${label} uses undefined route "${task.Route}".`);
    }
    for (const dependency of splitList(task["Depends On"])) {
      if (!taskPattern.test(dependency)) {
        errors.push(`${label} has invalid dependency task ID "${dependency}".`);
      }
    }
  }

  for (const [index, task] of parsed.records.entries()) {
    for (const dependency of splitList(task["Depends On"])) {
      if (!taskIds.has(dependency)) {
        errors.push(
          `Taskboard row ${index + 2} depends on missing task "${dependency}".`
        );
      }
    }
  }
}

function validateWorkbook(sheet, text, errors) {
  let rows;
  try {
    rows = parseCsv(text);
  } catch (error) {
    errors.push(`Invalid workbook CSV "${sheet.file}": ${error.message}`);
    return;
  }
  const headers = rows[0] ?? [];
  if (!sameArray(headers, sheet.columns)) {
    errors.push(
      `Workbook "${sheet.file}" headers do not match sheet "${sheet.name}" in the project configuration.`
    );
  }
}

function validateAdapter(name, expected, text, errors) {
  let actual;
  try {
    actual = JSON.parse(text);
  } catch (error) {
    errors.push(`Invalid adapter JSON "${expected.file}": ${error.message}`);
    return;
  }

  if (
    actual.name !== name ||
    actual.schemaVersion !== SCHEMA_VERSION ||
    actual.type !== expected.type ||
    actual.enabled !== expected.enabled ||
    actual.implementation !== "not-configured" ||
    typeof actual.settings !== "object" ||
    actual.settings === null ||
    Array.isArray(actual.settings)
  ) {
    errors.push(
      `Adapter "${expected.file}" does not match its project configuration placeholder.`
    );
  }
}

function scanForSecrets(relativePath, content, errors) {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.expression.test(content)) {
      errors.push(
        `Possible ${pattern.name} found in "${relativePath}"; remove credentials before continuing.`
      );
    }
  }
}

function splitList(value) {
  return value
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
