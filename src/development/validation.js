import fs from "node:fs/promises";
import path from "node:path";
import { parseCsv } from "../csv.js";
import { assertNoCredentialMaterial } from "../runtime/security.js";
import { validatePublishedSchema } from "../schema-validation.js";
import { contractDigest } from "./contracts.js";
import { loadDevelopmentConfig, validateDevelopmentConfig } from "./config.js";
import { DEVELOPMENT_REQUIRED_FILES } from "./generator.js";
import { validateResultRelationships } from "./result.js";

const WORKSTREAM_HEADERS = ["workstream_id", "request_id", "owner_role", "domain", "title", "status", "dependency_ids", "evidence_refs", "updated_at"];

export async function validateDevelopmentOs(root) {
  const absoluteRoot = path.resolve(root);
  const config = await loadDevelopmentConfig(absoluteRoot);
  const errors = validateDevelopmentConfig(config);
  const warnings = [];
  let checkedFiles = 1;
  for (const relative of DEVELOPMENT_REQUIRED_FILES) {
    try {
      const stat = await fs.lstat(path.join(absoluteRoot, relative));
      checkedFiles += 1;
      if (!stat.isFile() || stat.isSymbolicLink()) errors.push(`Required development file is not a regular file: ${relative}.`);
    } catch (error) {
      if (error.code === "ENOENT") errors.push(`Missing required development file: ${relative}.`);
      else errors.push(`Cannot inspect ${relative}: ${error.message}.`);
    }
  }
  if (errors.length === 0) {
    await validateCatalogSnapshots(absoluteRoot, config, errors);
    await validateWorkstreamBoard(absoluteRoot, errors);
  }
  const contractCounts = { requests: 0, plans: 0, results: 0, receipts: 0, runs: 0 };
  if (errors.length === 0) {
    const requests = await readJsonDirectory(absoluteRoot, config.sync.inbox, "development-request.schema.json", errors);
    const plans = await readJsonDirectory(absoluteRoot, ".development-os/plans", "engineering-plan.schema.json", errors);
    const results = await readJsonDirectory(absoluteRoot, config.sync.outbox, "engineering-result.schema.json", errors);
    const receipts = await readJsonDirectory(absoluteRoot, config.sync.receipts, "development-sync-receipt.schema.json", errors);
    const runs = await readRunResults(absoluteRoot, errors);
    contractCounts.requests = requests.size;
    contractCounts.plans = plans.size;
    contractCounts.results = results.size;
    contractCounts.receipts = receipts.size;
    contractCounts.runs = runs.length;
    checkedFiles += requests.size + plans.size + results.size + receipts.size + runs.length;
    for (const plan of plans.values()) {
      const request = requests.get(plan.requestId);
      if (!request) errors.push(`Engineering plan ${plan.planId} has no stored request.`);
      else if (plan.sourceDigest !== contractDigest(request)) errors.push(`Engineering plan ${plan.planId} has a stale source digest.`);
    }
    for (const result of results.values()) {
      const request = requests.get(result.requestId);
      const plan = plans.get(result.planId);
      if (!request || !plan) errors.push(`Engineering result ${result.resultId} is missing its request or plan.`);
      else {
        try { validateResultRelationships(result, request, plan, config); }
        catch (error) { errors.push(error.message); }
      }
    }
    for (const receipt of receipts.values()) {
      const contract = receipt.contractType === "development_request"
        ? requests.get(receipt.contractId)
        : results.get(receipt.contractId);
      if (!contract) errors.push(`Sync receipt ${receipt.receiptId} references a missing contract.`);
      else if (receipt.contractDigest !== contractDigest(contract)) errors.push(`Sync receipt ${receipt.receiptId} digest does not match its contract.`);
    }
    if (requests.size === 0) warnings.push("No approved product request has been synchronized yet.");
  }
  await scanManagedTree(absoluteRoot, errors);
  return { root: absoluteRoot, config, errors, warnings, checkedFiles, contractCounts };
}

async function readRunResults(root, errors) {
  const directory = path.join(root, ".development-os/runs");
  let entries = [];
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code !== "ENOENT") errors.push(`Cannot read engineering runs: ${error.message}.`); }
  const results = [];
  for (const entry of entries.filter((candidate) => candidate.isFile() && candidate.name.endsWith("-result.json"))) {
    try {
      const value = JSON.parse(await fs.readFile(path.join(directory, entry.name), "utf8"));
      const schemaErrors = validatePublishedSchema("engineering-workstream-run.schema.json", value);
      if (schemaErrors.length) errors.push(`Engineering run ${entry.name}: ${schemaErrors.join("; ")}.`);
      else results.push(value);
    } catch (error) { errors.push(`Invalid engineering run ${entry.name}: ${error.message}.`); }
  }
  return results;
}

async function validateCatalogSnapshots(root, config, errors) {
  const roles = JSON.parse(await fs.readFile(path.join(root, "engineering/governance/roles.json"), "utf8"));
  const gates = JSON.parse(await fs.readFile(path.join(root, "engineering/quality/gates.json"), "utf8"));
  if (JSON.stringify(roles.roles) !== JSON.stringify(config.roles)) errors.push("Generated engineering role snapshot does not match configuration.");
  if (JSON.stringify(gates.gates) !== JSON.stringify(config.qualityGates)) errors.push("Generated quality-gate snapshot does not match configuration.");
}

async function validateWorkstreamBoard(root, errors) {
  const rows = parseCsv(await fs.readFile(path.join(root, "engineering/taskboard/workstreams.csv"), "utf8"));
  const headers = rows[0] ?? [];
  if (JSON.stringify(headers) !== JSON.stringify(WORKSTREAM_HEADERS)) errors.push("Engineering workstream taskboard headers are invalid.");
}

async function readJsonDirectory(root, relative, schema, errors) {
  const values = new Map();
  const directory = path.join(root, relative);
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if (error.code === "ENOENT") return values;
    errors.push(`Cannot read contract directory ${relative}: ${error.message}.`);
    return values;
  }
  for (const entry of entries) {
    if (entry.name === "README.md") continue;
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      errors.push(`Unsupported contract entry in ${relative}: ${entry.name}.`);
      continue;
    }
    try {
      const value = JSON.parse(await fs.readFile(path.join(directory, entry.name), "utf8"));
      const schemaErrors = validatePublishedSchema(schema, value);
      if (schemaErrors.length) errors.push(`${relative}/${entry.name}: ${schemaErrors.join("; ")}.`);
      else {
        assertNoCredentialMaterial(`${relative}/${entry.name}`, value);
        const id = identityForSchema(schema, value);
        if (values.has(id)) errors.push(`${relative} duplicates contract identity ${id}.`);
        values.set(id, value);
      }
    } catch (error) { errors.push(`Invalid contract ${relative}/${entry.name}: ${error.message}.`); }
  }
  return values;
}

function identityForSchema(schema, value) {
  if (schema === "development-request.schema.json") return value.requestId;
  if (schema === "engineering-plan.schema.json") return value.planId;
  if (schema === "engineering-result.schema.json") return value.resultId;
  return value.receiptId;
}

async function scanManagedTree(root, errors) {
  for (const relative of ["engineering", ".development-os", "DEVELOPMENT.md", "development-os.config.json"]) {
    await visit(path.join(root, relative), relative);
  }
  async function visit(absolute, relative) {
    let stat;
    try { stat = await fs.lstat(absolute); }
    catch (error) { if (error.code !== "ENOENT") errors.push(`Cannot scan ${relative}: ${error.message}.`); return; }
    if (stat.isSymbolicLink()) { errors.push(`Managed development path contains a link: ${relative}.`); return; }
    if (stat.isDirectory()) {
      for (const entry of await fs.readdir(absolute)) await visit(path.join(absolute, entry), `${relative}/${entry}`);
      return;
    }
    if (stat.isFile()) {
      try { assertNoCredentialMaterial(relative, await fs.readFile(absolute, "utf8")); }
      catch (error) { errors.push(error.message); }
    }
  }
}
