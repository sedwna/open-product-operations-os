import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

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

const sbom = JSON.parse(result.stdout);
assert.equal(sbom.bomFormat, "CycloneDX");
assert.equal(sbom.metadata?.component?.name, "open-product-operations-os");
assert.ok(Array.isArray(sbom.components));
assert.ok(sbom.components.length >= 3);
for (const component of sbom.components) {
  assert.equal(typeof component.name, "string");
  assert.equal(typeof component.version, "string");
  assert.ok(Array.isArray(component.licenses) && component.licenses.length > 0);
}
console.log(`CycloneDX SBOM generated and checked for ${sbom.components.length} component(s).`);
