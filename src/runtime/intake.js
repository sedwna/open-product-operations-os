import crypto from "node:crypto";
import path from "node:path";
import { INTAKE_STORE_FILE, SCHEMA_VERSION } from "../constants.js";
import { applyWrites, planWrites } from "../file-writer.js";
import { validatePublishedSchema } from "../schema-validation.js";
import { compactDate, readJsonOptional, utcTimestamp, writeJson } from "./io.js";
import { assertNoCredentialMaterial } from "./security.js";
import { withControlPlaneLease } from "./control-plane-lease.js";

const EMPTY_STORE = { schemaVersion: SCHEMA_VERSION, records: [] };
const TYPES = new Set(["new_idea", "user_finding", "incident", "feedback", "request"]);

export async function ingestRecord(root, input, { dryRun = true, now = new Date() } = {}) {
  validateInput(input);
  // Deduplication reads the store, decides, and writes it back. Without the lease a second surface
  // can insert between the duplicate check and the write, so the same idea lands twice under
  // different event identifiers.
  return dryRun ? ingest(root, input, { dryRun, now }) : withControlPlaneLease(root, () => ingest(root, input, { dryRun, now }));
}

async function ingest(root, input, { dryRun, now }) {
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

  // An event that only exists in the intake store is a link missing from the chain. The board hangs
  // its cards off this identifier and every artifact downstream cites it, so canonical state has to
  // recognise it — otherwise a whole product can be built under an event the record does not know
  // about, which is exactly what happened in a real run while validation stayed green.
  //
  // A duplicate joins an event that already has its record; only a new one opens a file.
  const eventFile = duplicate ? null : await writeEventRecord(root, record, { dryRun });
  return { record, duplicate: Boolean(duplicate), eventFile, dryRun };
}

/** The event's own canonical home. The workbook row follows later through a controlled write. */
async function writeEventRecord(root, record, { dryRun }) {
  const relative = `events/${record.eventId}-${slug(record.title)}.md`;
  const document = [
    `# ${record.eventId} — ${record.title}`,
    "",
    `- Status: \`proposed\``,
    `- Type: \`${record.type}\``,
    `- Priority: \`${record.priority}\``,
    `- Opened: \`${record.createdAt}\``,
    `- Intake: \`${record.intakeId}\``,
    "",
    "## What was reported",
    "",
    record.description,
    "",
    "## Where it came from",
    "",
    record.source,
    "",
    "## Standing",
    "",
    "Recording an event is not accepting it. Nothing here is a product decision, a finding, or an",
    "approval; those arrive as their own attributed records and cite this identifier.",
    ""
  ].join("\n");

  const operations = await planWrites(path.resolve(root), new Map([[relative, document]]), { force: true });
  if (!dryRun) await applyWrites(path.resolve(root), operations);
  return relative;
}

function slug(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "event";
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
