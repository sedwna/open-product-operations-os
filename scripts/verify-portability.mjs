import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exampleRoot = path.join(root, "examples", "fictional-saas");
const manifestPath = path.join(exampleRoot, "records", "evidence-manifest.yaml");
const detachedPath = path.join(exampleRoot, "evidence", "evidence-manifest.sha256");
const detached = (await fs.readFile(detachedPath, "utf8")).trim().split(/\s+/);
const detachedTarget = path.resolve(path.dirname(detachedPath), detached[1]);
const manifestBytes = canonicalTextBytes(await fs.readFile(manifestPath));

assert.equal(detachedTarget, manifestPath, "detached manifest path");
assert.equal(sha256(manifestBytes), detached[0], "detached manifest hash");

const manifest = parse(manifestBytes.toString("utf8"));
for (const item of manifest.items) {
  const evidencePath = path.resolve(path.dirname(manifestPath), item.canonical_path);
  const bytes = canonicalTextBytes(await fs.readFile(evidencePath));
  assert.equal(bytes.byteLength, item.byte_length, `${item.evidence_item_id} byte length`);
  assert.equal(sha256(bytes), item.sha256, `${item.evidence_item_id} sha256`);
}

const attributes = await fs.readFile(path.join(root, ".gitattributes"), "utf8");
assert.match(attributes, /^\* text=auto eol=lf$/m);
console.log(
  `Portability contract verified: detached manifest and ${manifest.items.length} evidence item(s).`
);

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalTextBytes(value) {
  return Buffer.from(value.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
}
