import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");
const excludedDirectories = new Set([".git", "node_modules"]);
const defaultExclusions = new Map([
  [
    "3b157db12dcbd930640f29f5be15e78f73f7d83608bef0d1e29491bb0ea096f9",
    "excluded-source-product-name"
  ]
]);

export async function scanExcludedSourceIdentity(
  root,
  { exclusions = defaultExclusions } = {}
) {
  const findings = [];
  await visit(path.resolve(root), path.resolve(root), findings, exclusions);
  return findings;
}

if (path.resolve(process.argv[1] ?? "") === scriptPath) {
  const findings = await scanExcludedSourceIdentity(repositoryRoot);
  if (findings.length > 0) {
    throw new Error(
      `Clean-room source-identity scan found ${findings.length} excluded value(s):\n${findings
        .map(
          (finding) =>
            `- ${finding.file}: ${finding.policyLabel} (${finding.location})`
        )
        .join("\n")}`
    );
  }
  console.log("Clean-room source-identity scan found no excluded values.");
}

async function visit(root, current, findings, exclusions) {
  for (const entry of await fs.readdir(current, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) {
      continue;
    }
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).replaceAll("\\", "/");
    if (entry.isDirectory()) {
      await visit(root, absolute, findings, exclusions);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const pathFinding = findExcludedToken(relative, exclusions);
    if (pathFinding) {
      findings.push({
        file: relative,
        policyLabel: pathFinding,
        location: "path"
      });
    }
    const bytes = await fs.readFile(absolute);
    const encodings = [
      ["utf8", bytes.toString("utf8")],
      ["latin1", bytes.toString("latin1")],
      ["utf16le", bytes.toString("utf16le")],
      ["utf16be", swapUtf16Bytes(bytes).toString("utf16le")]
    ];
    for (const [encoding, text] of encodings) {
      const policyLabel = findExcludedToken(text, exclusions);
      if (policyLabel) {
        findings.push({
          file: relative,
          policyLabel,
          location: encoding
        });
        break;
      }
    }
  }
}

function findExcludedToken(text, exclusions) {
  const words = String(text).match(/[A-Za-z][A-Za-z0-9_-]*/g) ?? [];
  for (const word of words) {
    const digest = crypto
      .createHash("sha256")
      .update(word.toLowerCase())
      .digest("hex");
    if (exclusions.has(digest)) {
      return exclusions.get(digest);
    }
  }
  return null;
}

function swapUtf16Bytes(bytes) {
  const swapped = Buffer.alloc(bytes.length - (bytes.length % 2));
  for (let index = 0; index < swapped.length; index += 2) {
    swapped[index] = bytes[index + 1];
    swapped[index + 1] = bytes[index];
  }
  return swapped;
}
