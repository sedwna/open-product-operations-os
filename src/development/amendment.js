import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { applyWrites, planWrites } from "../file-writer.js";
import { assertNoLinkTraversal, resolveInside } from "../paths.js";
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

  const corrections = (input.corrections ?? []).map((correction) => ({
    field: String(correction.field ?? ""),
    priorValue: correction.priorValue ?? null,
    correctedValue: correction.correctedValue ?? null
  }));
  if (corrections.some((item) => canonicalJson(item.priorValue) === canonicalJson(item.correctedValue))) {
    throw new Error("An engineering amendment must change every corrected claim.");
  }
  const targetValue = await readJsonTarget(artifact);
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
  const operations = await planWrites(absoluteRoot, new Map([[storedAt, json(amendment)]]), {});
  if (!dryRun) await applyWrites(absoluteRoot, operations);
  return { dryRun, amendment, storedAt, operations };
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
  return amendments;
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
  if (current !== null && typeof current === "object") {
    throw new Error(`Engineering amendment field must identify a scalar claim: ${text}.`);
  }
  return current;
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
