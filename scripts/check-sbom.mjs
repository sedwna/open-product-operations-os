import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { normalizeSbomRoot } from "./sbom-contract.mjs";

const npmCli = process.env.npm_execpath;
const command = npmCli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
const args = npmCli
  ? [npmCli, "sbom", "--sbom-format", "cyclonedx"]
  : ["sbom", "--sbom-format", "cyclonedx"];
const result = spawnSync(command, args, {
  encoding: "utf8",
  shell: !npmCli && process.platform === "win32"
});
if (result.status !== 0) {
  throw new Error(
    `npm SBOM generation failed: ${result.error?.message ?? result.stderr ?? result.stdout}`
  );
}

const packageMetadata = JSON.parse(fs.readFileSync("package.json", "utf8"));
const sbom = normalizeSbomRoot(JSON.parse(result.stdout), packageMetadata);
assert.equal(sbom.bomFormat, "CycloneDX");
assert.equal(sbom.metadata.component.name, packageMetadata.name);
assert.equal(sbom.metadata.component.version, packageMetadata.version);
assert.equal(
  sbom.metadata.component["bom-ref"],
  `${packageMetadata.name}@${packageMetadata.version}`
);
assert.equal(
  sbom.metadata.component.purl,
  `pkg:npm/${packageMetadata.name}@${packageMetadata.version}`
);
assert.ok(
  sbom.dependencies.some(
    (dependency) =>
      dependency.ref === `${packageMetadata.name}@${packageMetadata.version}`
  )
);
assert.ok(Array.isArray(sbom.components));
assert.ok(sbom.components.length >= 3);
for (const component of sbom.components) {
  assert.equal(typeof component.name, "string");
  assert.equal(typeof component.version, "string");
  assert.ok(Array.isArray(component.licenses) && component.licenses.length > 0);
}
console.log(`CycloneDX SBOM generated and checked for ${sbom.components.length} component(s).`);
