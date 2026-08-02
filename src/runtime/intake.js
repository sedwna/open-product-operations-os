import crypto from "node:crypto";
import { INTAKE_STORE_FILE, SCHEMA_VERSION } from "../constants.js";
import { validatePublishedSchema } from "../schema-validation.js";
import { compactDate, readJsonOptional, utcTimestamp, writeJson } from "./io.js";
import { assertNoCredentialMaterial } from "./security.js";

const EMPTY_STORE = { schemaVersion: SCHEMA_VERSION, records: [] };
const TYPES = new Set(["new_idea", "user_finding", "incident", "feedback", "request"]);

export async function ingestRecord(root, input, { dryRun = true, now = new Date() } = {}) {
  validateInput(input);
  const store = await readJsonOptional(root, INTAKE_STORE_FILE, EMPTY_STORE);
  if (!Array.isArray(store.records)) {
    throw new Error("Invalid intake store: records must be an array.");
  }
  const fingerprint = fingerprintFor(input);
  const duplicate = store.records.find(
    (record) => record.fingerprint === fingerprint && record.status !== "rejected"
  );
  const date = compactDate(now);
  const sequence = String(store.records.filter((record) => record.eventId.startsWith(`EVT-${date}-`)).length + 1).padStart(3, "0");
  const record = {
    intakeId: `INT-${date}-${fingerprint.slice(0, 8).toUpperCase()}`,
    eventId: duplicate?.eventId ?? `EVT-${date}-${sequence}`,
    type: input.type,
    title: input.title.trim(),
    description: input.description.trim(),
    source: input.source.trim(),
    targetUser: String(input.targetUser ?? "").trim(),
    priority: input.priority ?? "P2",
    fingerprint,
    status: duplicate ? "duplicate" : "proposed",
    duplicateOf: duplicate?.intakeId ?? null,
    autopilotAuthorized: input.autopilotAuthorized === true,
    createdAt: utcTimestamp(now)
  };
  const errors = validatePublishedSchema("intake-record.schema.json", record);
  if (errors.length > 0) {
    throw new Error(`Invalid intake record:\n- ${errors.join("\n- ")}`);
  }
  await writeJson(root, INTAKE_STORE_FILE, { ...store, records: [...store.records, record] }, { dryRun });
  return { record, duplicate: Boolean(duplicate), dryRun };
}

function validateInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Intake input must be an object.");
  }
  if (!TYPES.has(input.type)) {
    throw new Error(`Unsupported intake type "${input.type}".`);
  }
  for (const field of ["title", "description", "source"]) {
    if (typeof input[field] !== "string" || input[field].trim() === "") {
      throw new Error(`Intake field "${field}" is required.`);
    }
  }
  if (input.priority && !["P0", "P1", "P2", "P3"].includes(input.priority)) {
    throw new Error(`Unsupported intake priority "${input.priority}".`);
  }
  assertNoCredentialMaterial("Intake input", input);
}

function fingerprintFor(input) {
  const normalized = [input.type, input.title, input.description]
    .map((value) => String(value).normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim())
    .join("\0");
  return crypto.createHash("sha256").update(normalized).digest("hex");
}
