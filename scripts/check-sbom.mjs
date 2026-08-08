import assert from "node:assert/strict";
import fs from "node:fs";
import { fillSbomLicensesFromLock, normalizeSbomRoot, productionSbom } from "./sbom-contract.mjs";
import { npmInvocation, runProcess } from "./process-runner.mjs";

// Generated over the whole tree and narrowed afterwards against the lockfile. Asking npm to omit
// the development tree drops anything shared with it, including production dependencies.
const invocation = npmInvocation(["sbom", "--sbom-format", "cyclonedx"]);
const result = runProcess(invocation.command, invocation.args, {
  encoding: "utf8"
});
if (result.status !== 0) {
  throw new Error(
    `npm SBOM generation failed: ${result.error?.message ?? result.stderr ?? result.stdout}`
  );
}

const packageMetadata = JSON.parse(fs.readFileSync("package.json", "utf8"));
const lockPath = fs.existsSync("package-lock.json") ? "package-lock.json" : "npm-shrinkwrap.json";
const packageLock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
const { sbom: narrowed, expected } = productionSbom(
  normalizeSbomRoot(JSON.parse(result.stdout), packageMetadata),
  packageLock
);
const sbom = fillSbomLicensesFromLock(narrowed, packageLock);

// The bill must name every shipped dependency, not merely a subset that all happened to be
// approved. A silently short bill is the failure mode this whole gate exists to prevent.
assert.deepEqual(
  sbom.components.map((component) => `${component.name}@${component.version}`).sort(),
  [...expected].sort(),
  "the bill of materials must list exactly the production dependencies the lockfile records"
);
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
