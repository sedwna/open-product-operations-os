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
