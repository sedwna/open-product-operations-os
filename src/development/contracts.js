import crypto from "node:crypto";
import fs from "node:fs/promises";
import { assertSafeRelativePath } from "../paths.js";
import { assertNoCredentialMaterial } from "../runtime/security.js";
import { validatePublishedSchema } from "../schema-validation.js";

export async function readContract(file, schemaFile, label) {
  let value;
  try {
    value = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  assertContract(value, schemaFile, label);
  return value;
}

export function assertContract(value, schemaFile, label) {
  const errors = validatePublishedSchema(schemaFile, value);
  if (errors.length) throw new Error(`${label} is invalid:\n- ${errors.join("\n- ")}`);
  assertNoCredentialMaterial(label, value);
}

export function contractDigest(value) {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function safeContractId(value, label = "Contract ID") {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error(`${label} is unsafe for a file path.`);
  return value;
}

export function assertRequestBoundary(request, config) {
  for (const field of ["allowedPaths", "prohibitedPaths"]) {
    for (const value of request.writeBoundary[field]) assertSafeRelativePath(value, `Request ${field}`);
  }
  for (const requested of request.writeBoundary.allowedPaths) {
    const permitted = config.policies.allowedPaths.some((allowed) =>
      requested === allowed || requested.startsWith(`${allowed}/`)
    );
    if (!permitted) throw new Error(`Request path "${requested}" is outside the configured development write boundary.`);
    if (config.policies.prohibitedPaths.some((blocked) => requested === blocked || requested.startsWith(`${blocked}/`))) {
      throw new Error(`Request path "${requested}" is prohibited by development policy.`);
    }
  }
}

export function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
