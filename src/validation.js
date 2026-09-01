import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  GOVERNANCE_FILE,
  REGISTRY_FILE,
  SCHEMA_VERSION,
  TASKBOARD_COLUMNS,
  TASKBOARD_FILE
} from "./constants.js";
import { parseCsv, rowsToObjects } from "./csv.js";
import {
  canonicalCatalog,
  getCanonicalRoles,
  getCanonicalWorkbookSheets,
  readPackagedTemplate
} from "./catalog.js";
import { buildGovernance, buildProjectFiles, buildRegistry } from "./generator.js";
import { assertNoLinkTraversal, resolveInside, toPosixPath } from "./paths.js";
import { validatePublishedSchema } from "./schema-validation.js";
import { CANONICAL_RECORD_KEYS, canonicalRecordKeys } from "./workbook-contract.js";

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

export const RECORD_ID_PATTERNS = {
  events: /^EVT-[0-9]{8}-[0-9]{3}$/,
  idea_inbox: /^IDEA-[0-9]{8}-[0-9]{3}$/,
  discovery: /^DSC-[0-9]{8}-[0-9]{3}$/,
  decision_log: /^DEC-[0-9]{8}-[0-9]{3}$/,
  issues: /^ISS-[0-9]{8}-[0-9]{3}$/,
  delivery_tickets: /^TKT-[0-9]{8}-[0-9]{3}$/,
  validation_plans: /^VPL-[0-9]{8}-[0-9]{3}$/,
  validation_scenarios: /^VSC-[0-9]{8}-[0-9]{3}$/,
  validation_runs: /^VRN-[0-9]{8}-[0-9]{3}$/,
  validation_results: /^VRS-[0-9]{8}-[0-9]{3}$/,
  evidence: /^EVD-[0-9]{8}-[0-9]{3}$/,
  human_observations: /^HOB-[0-9]{8}-[0-9]{3}$/,
  qc_log: /^QCV-[0-9]{8}-[0-9]{3}$/,
  readiness: /^RDY-[0-9]{8}-[0-9]{3}$/,
  releases: /^REL-[0-9]{8}-[0-9]{3}$/,
  writer_manifests: /^WFM-[A-Za-z0-9._-]+$/,
  writer_receipts: /^WRC-[A-Za-z0-9._-]+$/
};

export const STATUS_FIELDS = {
  role_registry: ["lifecycle", "role_lifecycle"],
  events: ["status", "event"],
  taskboard: ["status", "task"],
  idea_inbox: ["status", "idea"],
  discovery: ["status", "discovery"],
  decision_log: ["status", "decision"],
  issues: ["status", "issue"],
  delivery_tickets: ["status", "ticket"],
  validation_plans: ["status", "validation_plan"],
  validation_scenarios: ["status", "validation_scenario"],
  validation_runs: ["status", "validation_run"],
  validation_results: ["disposition", "validation_result"],
  evidence: ["status", "evidence_item"],
  human_observations: ["status", "human_observation"],
  qc_log: ["disposition", "qc"],
  readiness: ["status", "readiness"],
  releases: ["status", "release"],
  writer_manifests: ["status", "write_manifest"],
  writer_receipts: ["status", "write_receipt"]
};

const ROLE_ACTOR_PAIRS = [
  ["role_key", "assigned_actor_id"],
  ["coordinator_role", "coordinator_actor_id"],
  ["owner_role", "owner_actor_id"],
  ["design_owner_role", "design_owner_actor_id"],
  ["executor_role", "executor_actor_id"],
  ["producer_role", "producer_actor_id"],
  ["verifier_role", "verifier_actor_id"],
  ["independent_verifier_role", "verifier_actor_id"],
  ["writer_role", "writer_actor_id"],
  ["semantic_owner_role", "semantic_owner_actor_id"]
];

const PRODUCER_ACTOR_FIELDS = [
  "producer_actor_id",
  "owner_actor_id",
  "design_owner_actor_id",
  "executor_actor_id",
  "writer_actor_id",
  "semantic_owner_actor_id"
];

const CANONICAL_PLACEHOLDER_KEYS = new Map(
  getCanonicalWorkbookSheets().map((sheet) => {
    const keyFields = canonicalRecordKeys(sheet.key);
    const parsed = rowsToObjects(parseCsv(sheet.template));
    return [
      sheet.key,
      new Set(
        parsed.records
          .map((record) => keyFields.map((field) => record[field]?.trim() ?? ""))
          .filter((parts) => parts.some(isPlaceholder))
          .map((parts) => JSON.stringify(parts))
      )
    ];
  })
);

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
      validateWorkbook(sheet, contents.get(sheet.file), config, errors);
    }
  }
  validateCrossWorkbookRelationships(contents, config, errors);

  for (const [name, adapter] of Object.entries(config.adapters)) {
    if (contents.has(adapter.file)) {
      validateAdapter(name, adapter, contents.get(adapter.file), errors);
    }
  }

  if (contents.has("adapters/providers.json")) {
    validateJsonSchemaFile(
      "adapters/providers.json",
      contents.get("adapters/providers.json"),
      "provider-catalog.schema.json",
      errors
    );
  }
  if (contents.has("adapters/controlled-writer.json")) {
    validateJsonSchemaFile(
      "adapters/controlled-writer.json",
      contents.get("adapters/controlled-writer.json"),
      "controlled-writer-adapter.schema.json",
      errors
    );
  }

  const inventory = await inventoryTree(root, config.validation.excludedDirectories, errors);
  validateEventRecords(contents, config, inventory.files.map((file) => file.relativePath), errors);
  for (const file of inventory.files) {
    const buffer = await fs.readFile(file.absolutePath);
    const searchable = searchableText(buffer);
    scanForSensitiveData(
      file.relativePath,
      searchable,
      config.validation.allowedSyntheticEmailDomains,
      errors
    );
    if (!file.binary) {
      const text = buffer.toString("utf8");
      validateRuntimeStateFile(file.relativePath, text, errors);
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

/**
 * Every event the board works under must have a canonical record behind it.
 *
 * This is the chain rule the whole model rests on, and nothing checked it. A real product ran six
 * cards to a sealed delivery contract under an event that appeared in no event file and no workbook
 * row, and validation passed the workspace every time it was asked. A missing link that every gate
 * waves through is worse than no gate.
 */
function validateEventRecords(contents, config, files, errors) {
  if (!contents.has(TASKBOARD_FILE)) return;
  const tasks = rowsToObjects(parseCsv(contents.get(TASKBOARD_FILE))).records;
  const referenced = [...new Set(tasks
    .map((task) => task.event_id)
    .filter((eventId) => eventId && !isPlaceholder(eventId)))];
  if (referenced.length === 0) return;

  const eventSheet = config.workbook.sheets.find((sheet) => sheet.key === "events");
  const recordedInWorkbook = new Set(
    eventSheet && contents.has(eventSheet.file)
      ? rowsToObjects(parseCsv(contents.get(eventSheet.file))).records
        .map((row) => row.event_id)
        .filter((eventId) => eventId && !isPlaceholder(eventId))
      : []
  );
  const documented = files.filter((relative) => relative.startsWith("events/"));

  for (const eventId of referenced) {
    const hasFile = documented.some((relative) => relative.includes(eventId));
    if (!hasFile && !recordedInWorkbook.has(eventId)) {
      errors.push(
        `Task board works under event "${eventId}", which has no record in events/ and no row in the events workbook.`
      );
    }
  }
}

function validateCrossWorkbookRelationships(contents, config, errors) {
  let canonicalTasks = [];
  const workbookTaskboard = config.workbook.sheets.find((sheet) => sheet.key === "taskboard");
  if (contents.has(TASKBOARD_FILE) && workbookTaskboard && contents.has(workbookTaskboard.file)) {
    const canonical = rowsToObjects(parseCsv(contents.get(TASKBOARD_FILE))).records;
    canonicalTasks = canonical;
    const projection = rowsToObjects(parseCsv(contents.get(workbookTaskboard.file))).records;
    const projectedById = new Map(projection.filter((row) => !isPlaceholder(row.task_id)).map((row) => [row.task_id, row]));
    for (const task of canonical.filter((row) => !isPlaceholder(row.task_id))) {
      const projected = projectedById.get(task.task_id);
      if (!projected) {
        errors.push(`Workbook taskboard projection is missing canonical task "${task.task_id}".`);
        continue;
      }
      for (const field of TASKBOARD_COLUMNS) {
        if ((projected[field] ?? "") !== (task[field] ?? "")) {
          errors.push(`Workbook taskboard projection for "${task.task_id}" differs from canonical field "${field}".`);
        }
      }
    }
  }

  const sheetRecords = (key) => {
    const sheet = config.workbook.sheets.find((candidate) => candidate.key === key);
    return sheet && contents.has(sheet.file)
      ? rowsToObjects(parseCsv(contents.get(sheet.file))).records.filter((row) => !isPlaceholder(row[canonicalRecordKeys(key)[0]]))
      : [];
  };
  const decisions = new Map(sheetRecords("decision_log").map((row) => [row.decision_id, row]));
  const issues = sheetRecords("issues");
  const tickets = new Map(sheetRecords("delivery_tickets").map((row) => [row.ticket_id, row]));
  for (const event of sheetRecords("events")) {
    if (event.status !== "closed") continue;
    const unfinished = canonicalTasks.filter((task) =>
      task.event_id === event.event_id && !isPlaceholder(task.task_id) && task.status !== "done"
    );
    if (unfinished.length > 0) {
      errors.push(`Workbook event "${event.event_id}" is closed while ${unfinished.length} canonical task(s) remain unfinished.`);
    }
  }
  for (const [kind, rows] of [["issue", issues], ["delivery ticket", [...tickets.values()]]]) {
    for (const row of rows) {
      // `needs_decision` explicitly means product direction is unresolved. It is the waiting state,
      // not an advanced claim, so requiring a decision_id here makes the only honest pre-decision
      // representation invalid. Every later issue state, and every delivery ticket, still fails
      // closed without an approved attributed decision.
      if (kind === "issue" && row.status === "needs_decision") continue;
      const decision = decisions.get(row.decision_id);
      if (!row.decision_id || !decision || decision.status !== "approved" || !decision.decision_maker_actor_id) {
        errors.push(`Workbook ${kind} "${row.issue_id ?? row.ticket_id}" advanced without an approved attributed decision.`);
      }
    }
  }
  const releases = new Map(sheetRecords("releases").map((row) => [row.release_id, row]));
  for (const readiness of sheetRecords("readiness")) {
    if (readiness.status !== "ready") continue;
    const missing = [];
    if (!readiness.human_risk_acceptance_id || /^(?:none|n\/a|not_applicable)$/i.test(readiness.human_risk_acceptance_id)) missing.push("human_risk_acceptance_id");
    if (!readiness.rollback_reference) missing.push("rollback_reference");
    if (!readiness.release_id || !releases.has(readiness.release_id)) missing.push("release_id");
    if (missing.length) errors.push(`Readiness "${readiness.readiness_id}" may not be ready without ${missing.join(", ")}.`);
  }

  const results = new Map(sheetRecords("validation_results").map((row) => [row.result_id, row]));
  const observations = sheetRecords("human_observations");
  const qcRecords = new Map(sheetRecords("qc_log").map((row) => [row.qc_record_id, row]));
  for (const issue of issues) {
    if (issue.status !== "closed" || issue.closure_disposition?.trim().toLowerCase() !== "resolved") continue;

    const missing = [];
    const ticketIds = splitList(issue.ticket_ids ?? "");
    const resultIds = splitList(issue.result_ids ?? "");
    if (!issue.evidence_refs?.trim()) missing.push("evidence_refs");
    if (ticketIds.length === 0) missing.push("ticket_ids");
    if (resultIds.length === 0) missing.push("result_ids");

    const invalidTickets = ticketIds.filter((id) => tickets.get(id)?.status !== "released");
    if (invalidTickets.length > 0) missing.push(`released tickets (${invalidTickets.join("|")})`);
    const invalidResults = resultIds.filter((id) => results.get(id)?.disposition !== "pass");
    if (invalidResults.length > 0) missing.push(`passing results (${invalidResults.join("|")})`);

    const matchingReleases = [...releases.values()].filter((release) => {
      const releasedTickets = new Set(splitList(release.ticket_ids ?? ""));
      return release.status === "completed" && ticketIds.length > 0 && ticketIds.every((id) => releasedTickets.has(id));
    });
    if (matchingReleases.length === 0) {
      missing.push("a completed release covering every linked ticket");
    }

    const acceptedObservations = observations.filter((observation) =>
      observation.status === "accepted" &&
      ticketIds.includes(observation.ticket_id) &&
      observation.expected_behavior?.trim() &&
      observation.observed_behavior?.trim() &&
      observation.evidence_ids?.trim()
    );
    if (acceptedObservations.length === 0) {
      missing.push("an accepted post-release human observation");
    } else {
      const independentlyPassed = acceptedObservations.some((observation) => {
        const qc = qcRecords.get(observation.qc_record_id);
        const observedAt = Date.parse(observation.observed_at);
        const verifiedAt = Date.parse(qc?.verified_at);
        return qc?.disposition === "pass" && Number.isFinite(observedAt) &&
          Number.isFinite(verifiedAt) && verifiedAt >= observedAt;
      });
      if (!independentlyPassed) missing.push("passing independent QC for the outcome observation");

      const completedAt = matchingReleases
        .map((release) => Date.parse(release.ended_at))
        .filter(Number.isFinite);
      const observedAt = acceptedObservations
        .map((observation) => Date.parse(observation.observed_at))
        .filter(Number.isFinite);
      if (matchingReleases.length > 0 && (completedAt.length === 0 || observedAt.length === 0 ||
          !observedAt.some((observationTime) => completedAt.some((releaseTime) => observationTime >= releaseTime)))) {
        missing.push("a dated observation at or after the completed release");
      }
    }

    if (missing.length > 0) {
      errors.push(`Issue "${issue.issue_id}" may not claim resolved closure without ${missing.join(", ")}.`);
    }
  }
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
  let canonicalKeyFields = [];
  try {
    canonicalKeyFields = canonicalRecordKeys(sheet.key);
  } catch (error) {
    errors.push(`${relativePath} ${error.message}`);
  }
  if (
    canonicalKeyFields.length > 0 &&
    !sameArray(manifest.scope.keyFields, canonicalKeyFields)
  ) {
    errors.push(
      `${relativePath} keyFields must exactly match the canonical key contract for "${sheet.name}": ${canonicalKeyFields.join(
        ", "
      )}.`
    );
  }
  const protectedFields = new Set([
    ...config.fieldAuthority.protectedDevelopmentFields,
    ...config.fieldAuthority.protectedHumanFields
  ]);
  const humanAuthorityEvidence = manifest.authorization.authorityEvidence?.some((item) => item.kind === "human_approval")
    && manifest.authorization.authorizedByActorId === config.project.humanAuthorityActorId;
  const developmentAuthorityEvidence = manifest.authorization.authorityEvidence?.some((item) => item.kind === "development_result");
  for (const field of manifest.scope.keyFields) {
    if (!columns.has(field)) {
      errors.push(`${relativePath} key field "${field}" is not in "${sheet.name}".`);
    }
  }
  for (const field of allowed) {
    if (!columns.has(field)) {
      errors.push(`${relativePath} allowed field "${field}" is not in "${sheet.name}".`);
    }
    if (config.fieldAuthority.protectedHumanFields.includes(field) && !humanAuthorityEvidence) {
      errors.push(`${relativePath} may not allow protected field "${field}".`);
    }
    if (config.fieldAuthority.protectedDevelopmentFields.includes(field) && !developmentAuthorityEvidence) {
      errors.push(`${relativePath} may not allow protected field "${field}".`);
    }
    if (prohibited.has(field)) {
      errors.push(`${relativePath} field "${field}" is both allowed and prohibited.`);
    }
    const authorizedRekeyField = canonicalKeyFields.includes(field) &&
      manifest.scope.rows.some((row) => row.operation === "rekey" && field in row.changes);
    if (canonicalKeyFields.includes(field) && !authorizedRekeyField) {
      errors.push(`${relativePath} may not allow canonical key field "${field}".`);
    }
  }
  for (const field of sheet.columns.filter((column) => protectedFields.has(column))) {
    const authorized = (config.fieldAuthority.protectedHumanFields.includes(field) && humanAuthorityEvidence)
      || (config.fieldAuthority.protectedDevelopmentFields.includes(field) && developmentAuthorityEvidence);
    if (!authorized && !prohibited.has(field)) {
      errors.push(`${relativePath} must explicitly prohibit protected field "${field}".`);
    }
  }

  for (const [index, row] of manifest.scope.rows.entries()) {
    const label = `${relativePath} row ${index + 1}`;
    const rowKeyFields = Object.keys(row.key);
    if (
      canonicalKeyFields.length > 0 &&
      !sameSet(rowKeyFields, canonicalKeyFields)
    ) {
      errors.push(
        `${label} key selectors must contain exactly ${canonicalKeyFields.join(
          ", "
        )}.`
      );
    }
    const insert = row.operation === "insert";
    const rekey = row.operation === "rekey";
    if (insert && (row.preconditions.$record !== "absent" || Object.keys(row.preconditions).length !== 1)) {
      errors.push(`${label} insert requires the exact precondition {"$record":"absent"}.`);
    }
    if (rekey && !canonicalKeyFields.some((field) => field in row.changes)) {
      errors.push(`${label} rekey must change at least one canonical key field.`);
    }
    for (const field of Object.keys(row.changes)) {
      const authorizedProtected = (config.fieldAuthority.protectedHumanFields.includes(field) && humanAuthorityEvidence)
        || (config.fieldAuthority.protectedDevelopmentFields.includes(field) && developmentAuthorityEvidence);
      if (!allowed.has(field) || prohibited.has(field) || (protectedFields.has(field) && !authorizedProtected)) {
        errors.push(`${label} change to field "${field}" is not authorized.`);
      }
      if (!insert && !(field in row.preconditions)) {
        errors.push(`${label} change to field "${field}" requires an old-value precondition.`);
      }
      if (canonicalKeyFields.includes(field) && !rekey) {
        errors.push(`${label} canonical key field "${field}" may change only through rekey.`);
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

function validateRuntimeStateFile(relativePath, text, errors) {
  const normalized = relativePath.replaceAll("\\", "/");
  let schemaFile = null;
  if (normalized === ".product-ops/runtime/approvals.json") {
    schemaFile = "approval-store.schema.json";
  } else if (/^\.product-ops\/runtime\/development\/[^/]+-result\.json$/.test(normalized)) {
    schemaFile = "development-run.schema.json";
  } else if (/^\.product-ops\/runtime\/control-plane\/[^/]+\.json$/.test(normalized)) {
    schemaFile = "runtime-receipt.schema.json";
  }
  if (schemaFile) {
    validateJsonSchemaFile(relativePath, text, schemaFile, errors);
    return;
  }
  if (![".product-ops/runtime/intake.json", ".product-ops/runtime/provider-outbox.json"].includes(normalized)) {
    return;
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    errors.push(`Invalid JSON in "${relativePath}": ${error.message}`);
    return;
  }
  const entries = normalized.endsWith("intake.json") ? value.records : value.items;
  const itemSchema = normalized.endsWith("intake.json")
    ? "intake-record.schema.json"
    : "provider-outbox-item.schema.json";
  if (!Array.isArray(entries)) {
    errors.push(`Runtime store "${relativePath}" must contain an array of records.`);
    return;
  }
  for (const [index, entry] of entries.entries()) {
    for (const error of validatePublishedSchema(itemSchema, entry)) {
      errors.push(`${relativePath} item ${index + 1}: ${error}.`);
    }
  }
}

function validateJsonSchemaFile(relativePath, text, schemaFile, errors) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    errors.push(`Invalid JSON in "${relativePath}": ${error.message}`);
    return;
  }
  for (const error of validatePublishedSchema(schemaFile, value)) {
    errors.push(`${relativePath}: ${error}.`);
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
    const requiredVerifierRole =
      task.owner_role === config.separation.independentVerifierRole
        ? config.separation.verificationOfVerifierRole ?? "RB-08"
        : config.separation.independentVerifierRole;
    if (task.independent_verifier_role !== requiredVerifierRole) {
      errors.push(
        `${label} verifier role must be "${requiredVerifierRole}" for this producer role.`
      );
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

function validateWorkbook(sheet, text, config, errors) {
  let parsed;
  try {
    parsed = rowsToObjects(parseCsv(text));
  } catch (error) {
    errors.push(`Invalid workbook CSV "${sheet.file}": ${error.message}`);
    return;
  }
  if (!sameArray(parsed.headers, sheet.columns)) {
    errors.push(
      `Workbook "${sheet.file}" headers do not match sheet "${sheet.name}" in the canonical project configuration.`
    );
    return;
  }

  const seenKeys = new Set();
  for (const [index, record] of parsed.records.entries()) {
    const label = `Workbook "${sheet.file}" row ${index + 2}`;
    validateCanonicalWorkbookRecord(sheet, record, config, errors, { label, seenKeys });
  }

  if (sheet.key === "role_registry") {
    const recordsByRole = new Map(
      parsed.records
        .filter((record) => !isPlaceholder(record.role_key))
        .map((record) => [record.role_key, record])
    );
    const canonicalRoles = getCanonicalRoles();
    if (
      recordsByRole.size !== canonicalRoles.length ||
      [...recordsByRole.keys()].some(
        (role) => !canonicalRoles.some((candidate) => candidate.roleKey === role)
      )
    ) {
      errors.push(
        `Workbook "${sheet.file}" must contain exactly the 13 canonical role records.`
      );
    }
    for (const role of canonicalRoles) {
      const record = recordsByRole.get(role.roleKey);
      if (record && record.lifecycle !== role.lifecycle) {
        errors.push(
          `Workbook "${sheet.file}" role "${role.roleKey}" must remain "${role.lifecycle}".`
        );
      }
    }
  }
  if (sheet.key === "status_catalog") {
    const expected = new Set(
      Object.entries(canonicalCatalog.statuses).flatMap(([family, values]) =>
        values.map((value) => `${family}|${value}`)
      )
    );
    const actual = new Set(
      parsed.records.map(
        (record) => `${record.status_family}|${record.status_value}`
      )
    );
    if (
      actual.size !== expected.size ||
      [...expected].some((status) => !actual.has(status))
    ) {
      errors.push(
        `Workbook "${sheet.file}" must contain the complete canonical status catalog.`
      );
    }
  }
}

/**
 * Apply the canonical workbook semantics to one proposed row.
 *
 * Product-run preflight calls this same function before it seals a result. That keeps submission
 * and whole-project validation aligned on identities, statuses, actors and environments.
 */
export function validateCanonicalWorkbookRecord(
  sheet,
  record,
  config,
  errors,
  { label = `Proposed ${sheet.key} record`, seenKeys = new Set() } = {}
) {
  const keyFields = CANONICAL_RECORD_KEYS[sheet.key] ?? [sheet.columns[0]];
  const actorByRole = new Map(config.agents.map((agent) => [agent.id, agent.actorId]));
  const roles = new Set(actorByRole.keys());
  const statusRule = STATUS_FIELDS[sheet.key];
  const idPattern = sheet.key === "taskboard"
    ? new RegExp(config.taskIds.pattern)
    : RECORD_ID_PATTERNS[sheet.key];
  const keyParts = keyFields.map((field) => record[field]?.trim() ?? "");

  if (keyParts.some((value) => value === "")) {
    errors.push(`${label} must define record key ${keyFields.join("|")}.`);
  } else {
    const key = JSON.stringify(keyParts);
    if (seenKeys.has(key)) {
      errors.push(`${label} duplicates record key "${keyParts.join("|")}".`);
    }
    seenKeys.add(key);
  }

  const identity = keyParts[0];
  const placeholderKeyParts = keyParts.filter(isPlaceholder);
  if (placeholderKeyParts.length > 0) {
    if (placeholderKeyParts.length !== keyParts.length) {
      errors.push(`${label} mixes placeholder and real canonical key values.`);
    } else if (!CANONICAL_PLACEHOLDER_KEYS.get(sheet.key)?.has(JSON.stringify(keyParts))) {
      errors.push(`${label} uses a non-canonical placeholder record key.`);
    }
    validatePlaceholderRecord(record, label, sheet, config, errors);
  }
  if (idPattern && identity && !isPlaceholder(identity) && !idPattern.test(identity)) {
    errors.push(`${label} has invalid canonical identity "${identity}".`);
  }

  if (statusRule) {
    const [field, family] = statusRule;
    const value = record[field]?.trim() ?? "";
    if (!value) {
      errors.push(`${label} must define ${family} status.`);
    } else if (!isPlaceholder(value) && !canonicalCatalog.statuses[family].includes(value)) {
      errors.push(`${label} uses undefined ${family} status "${value}".`);
    }
  }
  if (
    sheet.key === "status_catalog" &&
    (!Object.hasOwn(canonicalCatalog.statuses, record.status_family) ||
      !canonicalCatalog.statuses[record.status_family]?.includes(record.status_value))
  ) {
    errors.push(
      `${label} defines non-canonical status "${record.status_family}|${record.status_value}".`
    );
  }

  if (!isPlaceholder(identity)) {
    validateRecordRoles(record, label, roles, actorByRole, errors);
    validateRecordSeparation(record, label, config, actorByRole, errors);
    validateRecordEnvironment(record, label, config, errors);
    validateProtectedRecordFields(record, label, sheet, config, errors);
  }
}

function validateRecordRoles(record, label, roles, actorByRole, errors) {
  for (const [field, value] of Object.entries(record)) {
    if (
      (field.endsWith("_role") || field.endsWith("_roles") || field === "created_by_role") &&
      value &&
      !isPlaceholder(value)
    ) {
      for (const role of splitList(value)) {
        if (!roles.has(role)) {
          errors.push(`${label} field "${field}" references unknown role "${role}".`);
        }
      }
    }
  }
  for (const [roleField, actorField] of ROLE_ACTOR_PAIRS) {
    if (!(roleField in record) || !(actorField in record)) {
      continue;
    }
    const role = record[roleField]?.trim();
    const actor = record[actorField]?.trim();
    if (
      role &&
      !isPlaceholder(role) &&
      (!actor || isPlaceholder(actor))
    ) {
      errors.push(`${label} field "${roleField}" requires an assigned "${actorField}".`);
      continue;
    }
    if (
      actor &&
      !isPlaceholder(actor) &&
      (!role || isPlaceholder(role))
    ) {
      errors.push(`${label} field "${actorField}" requires an assigned "${roleField}".`);
      continue;
    }
    if (
      role &&
      actor &&
      !isPlaceholder(role) &&
      !isPlaceholder(actor) &&
      actor !== actorByRole.get(role)
    ) {
      errors.push(
        `${label} field "${actorField}" is not the configured actor for "${role}".`
      );
    }
  }
}

function validateRecordSeparation(
  record,
  label,
  config,
  actorByRole,
  errors
) {
  const verifier = record.verifier_actor_id?.trim();
  if ("verifier_actor_id" in record) {
    const producerRole = record.owner_role?.trim() || record.producer_role?.trim();
    const requiredRole = producerRole === config.separation.independentVerifierRole
      ? config.separation.verificationOfVerifierRole ?? "RB-08"
      : config.separation.independentVerifierRole;
    const requiredActor = actorByRole.get(requiredRole);
    for (const roleField of ["verifier_role", "independent_verifier_role"]) {
      if (
        roleField in record &&
        record[roleField]?.trim() !== requiredRole
      ) {
        errors.push(
          `${label} field "${roleField}" must assign the active independent verifier "${requiredRole}".`
        );
      }
    }
    if (!verifier || verifier !== requiredActor) {
      errors.push(
        `${label} verifier actor must be the configured actor for "${requiredRole}".`
      );
    }
  }

  if (!verifier || isPlaceholder(verifier)) {
    return;
  }
  for (const producerField of PRODUCER_ACTOR_FIELDS) {
    const producer = record[producerField]?.trim();
    if (producer && !isPlaceholder(producer) && producer === verifier) {
      errors.push(
        `${label} producer and verifier actors must be different (producer field "${producerField}").`
      );
    }
  }
}

function validatePlaceholderRecord(record, label, sheet, config, errors) {
  const statusField = STATUS_FIELDS[sheet.key]?.[0];
  const controlledFields = new Set([
    statusField,
    "environment_alias",
    "target_environment",
    "authorized_by_actor_id",
    ...config.fieldAuthority.protectedDevelopmentFields,
    ...config.fieldAuthority.protectedHumanFields
  ]);
  for (const field of Object.keys(record)) {
    if (
      field.endsWith("_actor_id") ||
      field.startsWith("human_") ||
      field.includes("environment") ||
      field.includes("deployment") ||
      /(?:^|_)(?:status|disposition|priority|risk|lifecycle)$/.test(field)
    ) {
      controlledFields.add(field);
    }
  }
  for (const field of controlledFields) {
    if (!field) {
      continue;
    }
    const value = record[field]?.trim();
    if (value && !isPlaceholder(value)) {
      errors.push(
        `${label} placeholder record may not carry real controlled value in "${field}".`
      );
    }
  }
}

function validateRecordEnvironment(record, label, config, errors) {
  for (const field of ["environment_alias", "target_environment"]) {
    const value = record[field]?.trim();
    if (
      value &&
      !isPlaceholder(value) &&
      !config.project.environments.includes(value)
    ) {
      errors.push(`${label} field "${field}" uses unauthorized environment "${value}".`);
    }
  }
}

function validateProtectedRecordFields(record, label, sheet, config, errors) {
  for (const field of config.fieldAuthority.protectedDevelopmentFields) {
    const value = record[field]?.trim();
    if (!value || isPlaceholder(value)) {
      continue;
    }
    const attributed =
      (sheet.key === "delivery_tickets" &&
        record.development_adapter_role === config.separation.developmentRole) ||
      (sheet.key === "validation_runs" &&
        record.executor_role === "RB-09" &&
        record.executor_actor_id ===
          config.agents.find((agent) => agent.id === "RB-09")?.actorId);
    if (!attributed) {
      errors.push(
        `${label} protected development field "${field}" lacks an authorized development/observation attribution.`
      );
    }
  }

  for (const field of config.fieldAuthority.protectedHumanFields) {
    const value = record[field]?.trim();
    if (!value || isPlaceholder(value)) {
      continue;
    }
    if (["decision_maker_actor_id", "observer_actor_id"].includes(field)) {
      if (value !== config.project.humanAuthorityActorId) {
        errors.push(
          `${label} protected human field "${field}" is not the configured human authority actor.`
        );
      }
      continue;
    }
    if (record.authorized_by_actor_id !== config.project.humanAuthorityActorId) {
      errors.push(
        `${label} protected human field "${field}" lacks attributed human authorization.`
      );
    }
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
    actual.implementation !== (expected.implementation ?? "not-configured") ||
    typeof actual.settings !== "object" ||
    actual.settings === null ||
    Array.isArray(actual.settings) ||
    JSON.stringify(actual.settings) !== JSON.stringify(expected.settings ?? {})
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

function searchableText(buffer) {
  const representations = [
    buffer.toString("latin1"),
    buffer.toString("utf8")
  ];
  for (const offset of [0, 1]) {
    const available = buffer.length - offset;
    const evenLength = available - (available % 2);
    if (evenLength < 2) {
      continue;
    }
    const littleEndian = Buffer.from(
      buffer.subarray(offset, offset + evenLength)
    );
    representations.push(littleEndian.toString("utf16le"));
    const bigEndian = Buffer.from(littleEndian);
    for (let index = 0; index < bigEndian.length; index += 2) {
      const first = bigEndian[index];
      bigEndian[index] = bigEndian[index + 1];
      bigEndian[index + 1] = first;
    }
    representations.push(bigEndian.toString("utf16le"));
  }
  return representations.join("\n");
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

function isPlaceholder(value) {
  return /^<[^>]+>$/.test(value?.trim() ?? "");
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameSet(left, right) {
  return (
    left.length === right.length &&
    left.every((value) => right.includes(value))
  );
}
