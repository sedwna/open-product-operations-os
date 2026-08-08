export function normalizeSbomRoot(sbom, packageMetadata) {
  const normalized = structuredClone(sbom);
  const component = normalized.metadata?.component;
  if (!component) {
    throw new Error("CycloneDX SBOM is missing its root component.");
  }

  const priorReference = component["bom-ref"];
  const canonicalReference = `${packageMetadata.name}@${packageMetadata.version}`;
  component["bom-ref"] = canonicalReference;
  component.name = packageMetadata.name;
  component.version = packageMetadata.version;
  component.purl = `pkg:npm/${packageMetadata.name}@${packageMetadata.version}`;

  for (const dependency of normalized.dependencies ?? []) {
    if (dependency.ref === priorReference) {
      dependency.ref = canonicalReference;
    }
    dependency.dependsOn = (dependency.dependsOn ?? []).map((reference) =>
      reference === priorReference ? canonicalReference : reference
    );
  }
  return normalized;
}

/**
 * Restrict a bill of materials to what a consumer installs, using the lockfile as the authority.
 *
 * `npm sbom --omit dev` looked like the obvious way to do this and is not: a package that both a
 * production dependency and a development one require gets dropped with the development tree, so
 * the bill understates what ships. The lockfile marks each entry `dev` or not on its own terms and
 * does not change that answer because a linter happens to share a transitive dependency.
 */
export function productionSbom(sbom, packageLock) {
  // Keyed by name and version. A development dependency may bring its own copy of a package a
  // production dependency also uses, and the two are different components that share a name.
  const production = new Set(
    Object.entries(packageLock.packages ?? {})
      .filter(([location, entry]) => location.startsWith("node_modules/") && entry.dev !== true)
      .map(([location, entry]) => `${location.slice(location.lastIndexOf("node_modules/") + "node_modules/".length)}@${entry.version}`)
  );
  const normalized = structuredClone(sbom);
  const kept = (normalized.components ?? []).filter((component) => production.has(`${component.name}@${component.version}`));
  const keptRefs = new Set([normalized.metadata?.component?.["bom-ref"], ...kept.map((component) => component["bom-ref"])]);
  normalized.components = kept;
  normalized.dependencies = (normalized.dependencies ?? [])
    .filter((dependency) => keptRefs.has(dependency.ref))
    .map((dependency) => ({
      ...dependency,
      dependsOn: (dependency.dependsOn ?? []).filter((reference) => keptRefs.has(reference))
    }));
  return { sbom: normalized, expected: production };
}

export function fillSbomLicensesFromLock(sbom, packageLock) {
  const normalized = structuredClone(sbom);
  for (const component of normalized.components ?? []) {
    if (Array.isArray(component.licenses) && component.licenses.length > 0) continue;
    const declaredLicense = packageLock.packages?.[`node_modules/${component.name}`]?.license;
    if (typeof declaredLicense !== "string" || declaredLicense.length === 0) continue;
    const spdxLicense = declaredLicense === "OFL" ? "OFL-1.1" : declaredLicense;
    component.licenses = spdxLicense.includes(" OR ") || spdxLicense.includes(" AND ")
      ? [{ expression: spdxLicense }]
      : [{ license: { id: spdxLicense } }];
  }
  return normalized;
}
