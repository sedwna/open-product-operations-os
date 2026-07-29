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
import { readPackagedTemplate } from "./catalog.js";
import { buildGovernance, buildProjectFiles, buildRegistry } from "./generator.js";
import { assertNoLinkTraversal, resolveInside, toPosixPath } from "./paths.js";
import { validatePublishedSchema } from "./schema-validation.js";

const SECRET_PATTERNS = [
  { name: "private key", expression: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "cloud access key", expression: /\bAKIA[0-9A-Z]{16}\b/ },
  {
    name: "personal access token",
    expression: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/
  },
  { name: "chat token", expression: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  {
    name: "assigned credential",
    expression:
      /(?:api[_-]?key|client[_-]?secret|password|access[_-]?token)\s*["']?\s*[:=]\s*["']?(?!not-configured|placeholder|example|changeme)([A-Za-z0-9/+_.=-]{12,})/i
  }
];

const PRIVATE_PATH_PATTERNS = [
  /\b[A-Za-z]:\\Users\\(?!Public\\)[^\\\s]+\\/,
  /\/Users\/(?!Shared\/)[^/\s]+\//,
  /\/home\/[^/\s]+\//
];

export async function validateProject(target, config) {
  const errors = [];
  const warnings = [];
  const root = path.resolve(target);
  const requiredFiles = [
    ...buildProjectFiles(config, { includeConfig: false }).keys()
  ];

  const contents = new Map();
  for (const relativePath of requiredFiles) {
    const destination = resolveInside(root, relativePath, `Required file "${relativePath}"`);
    try {
      await assertNoLinkTraversal(root, destination, `Required file "${relativePath}"`);
      contents.set(relativePath, await fs.readFile(destination, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") {
        errors.push(`Missing required file "${relativePath}".`);
      } else {
        errors.push(`Cannot read required file "${relativePath}": ${error.message}`);
      }
    }
  }

  validateGeneratedJson(
    REGISTRY_FILE,
    contents.get(REGISTRY_FILE),
    buildRegistry(config),
    errors
  );
  if (
    contents.get("config/operating-model.yaml") !==
    readPackagedTemplate("config/operating-model.yaml")
  ) {
    errors.push(
      `"config/operating-model.yaml" has drifted from the packaged canonical catalog.`
    );
  }
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

  const inventory = await inventoryTree(root, config.validation.excludedDirectories, errors);
  for (const file of inventory.files) {
    const buffer = await fs.readFile(file.absolutePath);
    const searchable = buffer.toString("latin1");
    scanForSensitiveData(
      file.relativePath,
      searchable,
      config.validation.allowedSyntheticEmailDomains,
      errors
    );
    if (!file.binary) {
      const text = buffer.toString("utf8");
      if (
        isWriteManifestPath(file.relativePath) ||
        looksLikeWriteManifest(file.relativePath, text)
      ) {
        validateManifestText(file.relativePath, text, config, errors);
      } else if (looksLikeWriteReceipt(file.relativePath, text)) {
        validateReceiptText(file.relativePath, text, errors);
      }
    }
  }

  if (inventory.binaryFiles.length > 0) {
    warnings.push(
      `Binary inventory (${inventory.binaryFiles.length}): ${inventory.binaryFiles.join(", ")}`
    );
  }

  return {
    errors,
    warnings,
    checkedFiles: inventory.files.length,
    binaryFiles: inventory.binaryFiles
  };
}

export function validateWriteManifest(manifest, config, relativePath = "write manifest") {
  const errors = validatePublishedSchema(
    "workbook-write-manifest.schema.json",
    manifest
  ).map((error) => `${relativePath} schema: ${error}.`);
  if (errors.length > 0) {
    return errors;
  }
  scanForSensitiveData(
    relativePath,
    JSON.stringify(manifest),
    config.validation.allowedSyntheticEmailDomains,
    errors
  );
  if (errors.length > 0) {
    return errors;
  }

  const sheet = config.workbook.sheets.find(
    (candidate) =>
      candidate.file === manifest.target.file &&
      candidate.name === manifest.scope.sheet
  );
  if (!sheet) {
    errors.push(
      `${relativePath} target file and sheet must identify one configured workbook tab.`
    );
    return errors;
  }

  const actorByRole = new Map(config.agents.map((agent) => [agent.id, agent.actorId]));
  const ownerActor = actorByRole.get(sheet.owner);
  const writerActor = actorByRole.get(config.separation.writerRole);
  if (manifest.semanticOwner.role !== sheet.owner) {
    errors.push(`${relativePath} semantic owner role is not authorized for "${sheet.name}".`);
  }
  if (
    manifest.semanticOwner.actorId !== ownerActor ||
    manifest.authorization.ownerActorId !== ownerActor
  ) {
    errors.push(`${relativePath} owner authorization does not match the configured owner actor.`);
  }
  if (
    ![
      manifest.authorization.ownerActorId,
      config.project.humanAuthorityActorId
    ].includes(manifest.authorization.authorizedByActorId)
  ) {
    errors.push(`${relativePath} was not authorized by its owner or human authority.`);
  }
  if (
    manifest.writer.role !== config.separation.writerRole ||
    manifest.writer.actorId !== writerActor
  ) {
    errors.push(`${relativePath} writer does not match the configured mechanical writer.`);
  }
  if (manifest.writer.actorId === manifest.semanticOwner.actorId) {
    errors.push(`${relativePath} semantic owner and writer actors must be different.`);
  }

  if (
    !config.project.environments.includes(manifest.target.environment) ||
    !config.fieldAuthority.writerEnvironments.includes(manifest.target.environment)
  ) {
    errors.push(`${relativePath} target environment is not explicitly allowed.`);
  }
  if (
    manifest.target.environment === "production" &&
    ["not_applicable", "none", "n/a"].includes(
      manifest.authorization.humanProductionAuthorizationId.toLowerCase()
    )
  ) {
    errors.push(`${relativePath} production write requires attributed human authorization.`);
  }

  const columns = new Set(sheet.columns);
  const allowed = new Set(manifest.scope.allowedFields);
  const prohibited = new Set(manifest.scope.prohibitedFields);
  const protectedFields = new Set([
    ...config.fieldAuthority.protectedDevelopmentFields,
    ...config.fieldAuthority.protectedHumanFields
  ]);
  for (const field of manifest.scope.keyFields) {
    if (!columns.has(field)) {
      errors.push(`${relativePath} key field "${field}" is not in "${sheet.name}".`);
    }
  }
  for (const field of allowed) {
    if (!columns.has(field)) {
      errors.push(`${relativePath} allowed field "${field}" is not in "${sheet.name}".`);
    }
    if (protectedFields.has(field)) {
      errors.push(`${relativePath} may not allow protected field "${field}".`);
    }
    if (prohibited.has(field)) {
      errors.push(`${relativePath} field "${field}" is both allowed and prohibited.`);
    }
  }
  for (const field of sheet.columns.filter((column) => protectedFields.has(column))) {
    if (!prohibited.has(field)) {
      errors.push(`${relativePath} must explicitly prohibit protected field "${field}".`);
    }
  }

  for (const [index, row] of manifest.scope.rows.entries()) {
    const label = `${relativePath} row ${index + 1}`;
    for (const keyField of manifest.scope.keyFields) {
      if (!(keyField in row.key)) {
        errors.push(`${label} is missing key field "${keyField}".`);
      }
    }
    for (const field of Object.keys(row.changes)) {
      if (!allowed.has(field) || prohibited.has(field) || protectedFields.has(field)) {
        errors.push(`${label} change to field "${field}" is not authorized.`);
      }
      if (!(field in row.preconditions)) {
        errors.push(`${label} change to field "${field}" requires an old-value precondition.`);
      }
    }
  }

  return errors;
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
      `"${relativePath}" has drifted from the project configuration; regenerate replaceable scaffold with init --force.`
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
    errors.push(`Taskboard headers must be: ${TASKBOARD_COLUMNS.join(", ")}.`);
    return;
  }

  const taskPattern = new RegExp(config.taskIds.pattern);
  const agentIds = new Set(config.agents.map((agent) => agent.id));
  const actorByRole = new Map(config.agents.map((agent) => [agent.id, agent.actorId]));
  const statuses = new Set(config.statuses.map((status) => status.id));
  const taskIds = new Set();

  for (const [index, task] of parsed.records.entries()) {
    const label = `Taskboard row ${index + 2}`;
    if (!taskPattern.test(task.task_id)) {
      errors.push(
        `${label} task ID "${task.task_id}" does not match ${config.taskIds.pattern}.`
      );
    }
    if (taskIds.has(task.task_id)) {
      errors.push(`${label} duplicates task ID "${task.task_id}".`);
    }
    taskIds.add(task.task_id);
    if (task.title.trim() === "") {
      errors.push(`${label} must have a title.`);
    }
    if (!agentIds.has(task.owner_role)) {
      errors.push(`${label} references unknown owner "${task.owner_role}".`);
    }
    if (task.owner_actor_id !== actorByRole.get(task.owner_role)) {
      errors.push(`${label} owner actor is not authorized for "${task.owner_role}".`);
    }
    if (!statuses.has(task.status)) {
      errors.push(`${label} uses undefined status "${task.status}".`);
    }
    if (!agentIds.has(task.independent_verifier_role)) {
      errors.push(`${label} references unknown verifier role.`);
    }
    if (
      task.verifier_actor_id !== actorByRole.get(task.independent_verifier_role) ||
      task.verifier_actor_id === task.owner_actor_id
    ) {
      errors.push(`${label} requires an independently assigned verifier actor.`);
    }
    for (const dependency of splitList(task.dependency_ids)) {
      if (!taskPattern.test(dependency)) {
        errors.push(`${label} has invalid dependency task ID "${dependency}".`);
      }
    }
  }

  for (const [index, task] of parsed.records.entries()) {
    for (const dependency of splitList(task.dependency_ids)) {
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
      `Workbook "${sheet.file}" headers do not match sheet "${sheet.name}" in the canonical project configuration.`
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
    errors.push(`Adapter "${expected.file}" does not match its project configuration placeholder.`);
  }
}

async function inventoryTree(root, exclusions, errors) {
  const files = [];
  const binaryFiles = [];

  async function visit(directory) {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      errors.push(`Cannot inventory "${directory}": ${error.message}`);
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && exclusions.includes(entry.name)) {
        continue;
      }
      const absolutePath = path.join(directory, entry.name);
      const relativePath = toPosixPath(path.relative(root, absolutePath));
      let stat;
      try {
        stat = await fs.lstat(absolutePath);
      } catch (error) {
        errors.push(`Cannot inspect "${relativePath}": ${error.message}`);
        continue;
      }
      if (stat.isSymbolicLink()) {
        errors.push(
          `Project tree contains a symbolic link, junction, or reparse traversal at "${relativePath}".`
        );
        continue;
      }
      if (stat.isDirectory()) {
        await visit(absolutePath);
      } else if (stat.isFile()) {
        const buffer = await fs.readFile(absolutePath);
        const binary = isBinary(buffer);
        files.push({ absolutePath, relativePath, binary });
        if (binary) {
          binaryFiles.push(relativePath);
        }
      } else {
        errors.push(`Project tree contains unsupported filesystem entry "${relativePath}".`);
      }
    }
  }

  await visit(root);
  return { files, binaryFiles };
}

function isBinary(buffer) {
  if (buffer.includes(0)) {
    return true;
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return false;
  } catch {
    return true;
  }
}

function scanForSensitiveData(relativePath, content, allowedDomains, errors) {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.expression.test(content)) {
      errors.push(
        `Possible ${pattern.name} found in "${relativePath}"; remove credentials before continuing.`
      );
    }
  }
  for (const expression of PRIVATE_PATH_PATTERNS) {
    if (expression.test(content)) {
      errors.push(`Possible private absolute path found in "${relativePath}".`);
    }
  }
  const emails = content.match(/[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,}|invalid)\b/gi) ?? [];
  for (const email of emails) {
    const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
    if (!allowedDomains.includes(domain)) {
      errors.push(`Possible personal email address found in "${relativePath}".`);
    }
  }
}

function validateManifestText(relativePath, text, config, errors) {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    errors.push(`Invalid JSON write manifest "${relativePath}": ${error.message}`);
    return;
  }
  errors.push(...validateWriteManifest(manifest, config, relativePath));
}

function isWriteManifestPath(relativePath) {
  return /(?:^|\/)(?:[^/]*write-manifest|writer-manifest)\.json$/i.test(relativePath);
}

function looksLikeWriteManifest(relativePath, text) {
  if (!relativePath.toLowerCase().endsWith(".json")) {
    return false;
  }
  try {
    const value = JSON.parse(text);
    return (
      value !== null &&
      typeof value === "object" &&
      "manifestId" in value &&
      ("scope" in value || "writes" in value)
    );
  } catch {
    return false;
  }
}

function looksLikeWriteReceipt(relativePath, text) {
  if (!relativePath.toLowerCase().endsWith(".json")) {
    return false;
  }
  try {
    const value = JSON.parse(text);
    return (
      value !== null &&
      typeof value === "object" &&
      "manifestId" in value &&
      "replayWrites" in value &&
      "targetFile" in value
    );
  } catch {
    return false;
  }
}

function validateReceiptText(relativePath, text, errors) {
  let receipt;
  try {
    receipt = JSON.parse(text);
  } catch (error) {
    errors.push(`Invalid JSON write receipt "${relativePath}": ${error.message}`);
    return;
  }
  errors.push(
    ...validatePublishedSchema("workbook-write-receipt.schema.json", receipt).map(
      (error) => `${relativePath} schema: ${error}.`
    )
  );
}

function splitList(value) {
  return value
    .split(/[;,|]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
