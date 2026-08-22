import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { applyWrites, planWrites } from "../file-writer.js";
import { assertNoLinkTraversal, assertSafeRelativePath, resolveInside } from "../paths.js";
import { loadDevelopmentConfig } from "./config.js";
import { assertContract, canonicalJson, json, readContract, safeContractId } from "./contracts.js";

/**
 * Append a narrowly-scoped correction to immutable engineering evidence.
 *
 * The original artifact is never edited. Its expected digest is a precondition, semantic ownership
 * is derived from the plan, Control Tower attribution is derived from configuration, and ENG-15
 * must independently resolve the amendment before a final delivery can rely on it.
 */
export async function recordEngineeringEvidenceAmendment(root, input, { dryRun = true, now = new Date() } = {}) {
  const absoluteRoot = path.resolve(root);
  safeContractId(input.planId, "Plan ID");
  safeContractId(input.workstreamId, "Workstream ID");
  const config = await loadDevelopmentConfig(absoluteRoot);
  const plan = await readContract(
    path.join(absoluteRoot, ".development-os", "plans", `${input.planId}.json`),
    "engineering-plan.schema.json",
    "Engineering plan"
  );
  const workstream = plan.workstreams.find((candidate) => candidate.id === input.workstreamId);
  if (!workstream) throw new Error(`Engineering plan ${input.planId} has no workstream ${input.workstreamId}.`);
  const ownerActorId = config.roles.find((role) => role.id === workstream.ownerRole)?.actorId;
  const coordinatorActorId = config.roles.find((role) => role.id === "ENG-01")?.actorId;
  if (!ownerActorId || !coordinatorActorId) throw new Error("Engineering amendment actors are not configured.");

  const artifactPath = normalizeManagedArtifactPath(input.artifactPath);
  const artifact = resolveInside(absoluteRoot, artifactPath, "Engineering amendment target");
  await assertNoLinkTraversal(absoluteRoot, artifact, "Engineering amendment target");
  const stat = await fs.lstat(artifact);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Engineering amendment target must be a regular file.");
  const artifactSha256 = crypto.createHash("sha256").update(await fs.readFile(artifact)).digest("hex");
  if (artifactSha256 !== String(input.expectedSha256 ?? "").toLowerCase()) {
    throw new Error("Engineering amendment target digest changed; re-read the immutable artifact before correcting it.");
  }

  const corrections = (input.corrections ?? []).map((correction) => {
    const field = String(correction.field ?? "");
    if (field.startsWith("/changedComponents/") || field === "/changedComponents/-") {
      throw new Error("changedComponents corrections must replace the whole array atomically.");
    }
    return {
      field,
      priorValue: normalizeCorrectionValue(field, correction.priorValue ?? null, "priorValue"),
      correctedValue: normalizeCorrectionValue(field, correction.correctedValue ?? null, "correctedValue")
    };
  });
  if (corrections.some((item) => canonicalJson(item.priorValue) === canonicalJson(item.correctedValue))) {
    throw new Error("An engineering amendment must change every corrected claim.");
  }
  const targetValue = await readJsonTarget(artifact);
  if (corrections.some((correction) => correction.field === "/changedComponents")) {
    const expectedTarget = `.development-os/runs/${input.planId}-${input.workstreamId}-result.json`;
    if (artifactPath !== expectedTarget
      || targetValue.planId !== input.planId
      || targetValue.workstreamId !== input.workstreamId) {
      throw new Error("A changedComponents correction must target the matching immutable workstream result.");
    }
  }
  for (const correction of corrections) {
    const actual = valueAtJsonPointer(targetValue, correction.field);
    if (canonicalJson(actual) !== canonicalJson(correction.priorValue)) {
      throw new Error(`Engineering amendment priorValue does not match ${correction.field} in the immutable target.`);
    }
  }
  const evidence = (input.evidence ?? []).map((item) => ({
    reference: String(item.reference ?? ""),
    ...(item.sha256 ? { sha256: String(item.sha256).toLowerCase() } : {})
  }));
  const seed = canonicalJson({
    planId: input.planId,
    workstreamId: input.workstreamId,
    artifactPath,
    artifactSha256,
    corrections,
    reason: input.reason,
    evidence
  });
  const amendmentId = `AMEND-${crypto.createHash("sha256").update(seed).digest("hex").slice(0, 12).toUpperCase()}`;
  const amendment = {
    schemaVersion: "1.0.0",
    amendmentId,
    planId: input.planId,
    workstreamId: input.workstreamId,
    ownerRole: workstream.ownerRole,
    ownerActorId,
    recordedByRole: "ENG-01",
    recordedByActorId: coordinatorActorId,
    target: { artifactPath, artifactSha256 },
    corrections,
    reason: String(input.reason ?? ""),
    evidence,
    status: "pending_independent_verification",
    verificationRequiredByRole: "ENG-15",
    createdAt: now.toISOString()
  };
  assertContract(amendment, "engineering-evidence-amendment.schema.json", "Engineering evidence amendment");
  const storedAt = `.development-os/evidence/${amendmentId}.amendment.json`;
  const existing = await readExistingAmendment(path.join(absoluteRoot, storedAt));
  if (existing) {
    assertContract(existing, "engineering-evidence-amendment.schema.json", "Stored engineering evidence amendment");
    if (canonicalJson(withoutCreatedAt(existing)) !== canonicalJson(withoutCreatedAt(amendment))) {
      throw new Error(`Stored engineering amendment ${amendmentId} conflicts with the requested correction.`);
    }
    amendment.createdAt = existing.createdAt;
  }
  const content = json(amendment);
  const amendmentSha256 = crypto.createHash("sha256").update(content).digest("hex");
  const operations = await planWrites(absoluteRoot, new Map([[storedAt, content]]), {});
  if (!dryRun) await applyWrites(absoluteRoot, operations);
  return {
    dryRun,
    amendment,
    storedAt,
    amendmentSha256,
    verificationReference: `${storedAt}#sha256=${amendmentSha256}`,
    operations
  };
}

export async function loadEngineeringEvidenceAmendments(root, planId = null) {
  const directory = path.join(path.resolve(root), ".development-os", "evidence");
  let entries = [];
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const amendments = [];
  for (const entry of entries.filter((candidate) => candidate.isFile() && candidate.name.endsWith(".amendment.json"))) {
    const amendment = await readContract(
      path.join(directory, entry.name),
      "engineering-evidence-amendment.schema.json",
      `Engineering evidence amendment ${entry.name}`
    );
    if (entry.name !== `${amendment.amendmentId}.amendment.json`) {
      throw new Error(`Engineering evidence amendment filename does not match ${amendment.amendmentId}.`);
    }
    if (planId && amendment.planId !== planId) continue;
    const storedAt = `.development-os/evidence/${entry.name}`;
    await assertEngineeringEvidenceAmendmentTarget(root, amendment, storedAt);
    amendments.push({ amendment, storedAt });
  }
  assertNoConflictingCorrections(amendments);
  return amendments;
}

/**
 * Project append-only corrections over immutable run bytes without rewriting the original result.
 * Only whole-array changedComponents corrections affect delivery scope; every applied amendment
 * must have been named by the passing ENG-15 run before this function is called.
 */
export function resolveEffectiveEngineeringRuns(runs, amendments) {
  assertNoConflictingCorrections(amendments);
  const effective = new Map([...runs].map(([id, run]) => [id, structuredClone(run)]));
  const applied = [];
  for (const record of amendments) {
    const { amendment, storedAt } = record;
    const run = effective.get(amendment.workstreamId);
    if (!run) throw new Error(`Engineering amendment ${amendment.amendmentId} has no sealed workstream run.`);
    const expectedTarget = `.development-os/runs/${amendment.planId}-${amendment.workstreamId}-result.json`;
    for (const correction of amendment.corrections) {
      if (correction.field !== "/changedComponents") continue;
      if (amendment.target.artifactPath !== expectedTarget) {
        throw new Error(`Engineering amendment ${amendment.amendmentId} targets the wrong workstream result.`);
      }
      if (canonicalJson(run.changedComponents) !== canonicalJson(correction.priorValue)) {
        throw new Error(`Engineering amendment ${amendment.amendmentId} prior changedComponents no longer match the sealed run.`);
      }
      run.changedComponents = [...correction.correctedValue];
      applied.push({ amendment, storedAt });
    }
  }
  return { runs: effective, applied };
}

export async function assertEngineeringEvidenceAmendmentTarget(root, amendment, storedAt) {
  const absoluteRoot = path.resolve(root);
  const artifactPath = normalizeManagedArtifactPath(amendment.target.artifactPath);
  if (artifactPath === storedAt) throw new Error(`Engineering amendment ${amendment.amendmentId} cannot target itself.`);
  const artifact = resolveInside(absoluteRoot, artifactPath, "Engineering amendment target");
  await assertNoLinkTraversal(absoluteRoot, artifact, "Engineering amendment target");
  const stat = await fs.lstat(artifact);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Engineering amendment ${amendment.amendmentId} target is not a regular file.`);
  const bytes = await fs.readFile(artifact);
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  if (digest !== amendment.target.artifactSha256) throw new Error(`Engineering amendment ${amendment.amendmentId} target digest changed.`);
  const targetValue = await readJsonTarget(artifact);
  for (const correction of amendment.corrections) {
    const actual = valueAtJsonPointer(targetValue, correction.field);
    if (canonicalJson(actual) !== canonicalJson(correction.priorValue)) {
      throw new Error(`Engineering amendment ${amendment.amendmentId} priorValue no longer matches ${correction.field}.`);
    }
  }
}

function normalizeManagedArtifactPath(value) {
  const normalized = String(value ?? "").replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized.startsWith(".development-os/runs/") && !normalized.startsWith(".development-os/evidence/")) {
    throw new Error("Engineering amendments may target only managed run or evidence artifacts.");
  }
  if (normalized.includes("..") || path.posix.isAbsolute(normalized)) {
    throw new Error("Engineering amendment target must stay inside the managed namespace.");
  }
  return normalized;
}

async function readJsonTarget(file) {
  if (!file.toLowerCase().endsWith(".json")) {
    throw new Error("Engineering amendments require a JSON target so the prior claim can be verified.");
  }
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { throw new Error(`Engineering amendment target is not valid JSON: ${error.message}`); }
}

function valueAtJsonPointer(value, pointer) {
  const text = String(pointer ?? "");
  if (!text.startsWith("/") || /~(?:[^01]|$)/.test(text)) {
    throw new Error(`Engineering amendment field is not a valid JSON pointer: ${text}.`);
  }
  let current = value;
  for (const token of text.slice(1).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))) {
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, token)) {
      throw new Error(`Engineering amendment field does not exist in the immutable target: ${text}.`);
    }
    current = current[token];
  }
  if (text !== "/changedComponents" && current !== null && typeof current === "object") {
    throw new Error(`Engineering amendment field must identify a scalar claim: ${text}.`);
  }
  return current;
}

function normalizeCorrectionValue(field, value, label) {
  if (field !== "/changedComponents") return value;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`changedComponents ${label} must be a non-empty array.`);
  }
  const normalized = value.map((component, index) => {
    const safe = assertSafeRelativePath(component, `changedComponents ${label}[${index}]`);
    if (safe.startsWith(".development-os/") || safe.startsWith("engineering/taskboard/")) {
      throw new Error(`changedComponents ${label}[${index}] is a managed control-plane path.`);
    }
    return safe;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`changedComponents ${label} must not contain duplicates.`);
  }
  return normalized;
}

function assertNoConflictingCorrections(records) {
  const claims = new Map();
  for (const { amendment } of records) {
    for (const correction of amendment.corrections) {
      if (correction.field !== "/changedComponents") continue;
      const key = `${amendment.target.artifactPath}\0${correction.field}`;
      const previous = claims.get(key);
      if (previous && canonicalJson(previous.correctedValue) !== canonicalJson(correction.correctedValue)) {
        throw new Error(
          `Conflicting changedComponents amendments ${previous.amendmentId} and ${amendment.amendmentId}.`
        );
      }
      claims.set(key, { amendmentId: amendment.amendmentId, correctedValue: correction.correctedValue });
    }
  }
}

async function readExistingAmendment(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function withoutCreatedAt(value) {
  const copy = { ...value };
  delete copy.createdAt;
  return copy;
}
