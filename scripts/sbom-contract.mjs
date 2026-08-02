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
