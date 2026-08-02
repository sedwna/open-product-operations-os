import fs from "node:fs/promises";

export async function writeCodexCompatibleSchema(canonicalFile, targetFile, writeValue) {
  const schema = JSON.parse(await fs.readFile(canonicalFile, "utf8"));
  const compatible = codexCompatibleSchema(schema);
  if (writeValue) return writeValue(targetFile, compatible);
  await fs.writeFile(targetFile, `${JSON.stringify(compatible, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

export function codexCompatibleSchema(value) {
  if (Array.isArray(value)) return value.map(codexCompatibleSchema);
  if (!value || typeof value !== "object") return value;
  const compatible = Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "uniqueItems")
    .map(([key, nested]) => [key, codexCompatibleSchema(nested)]));
  if (!compatible.type) {
    const sample = compatible.const ?? compatible.enum?.find((item) => item !== null);
    const inferred = jsonSchemaType(sample);
    if (inferred) compatible.type = inferred;
  }
  return compatible;
}

function jsonSchemaType(value) {
  if (typeof value === "string") return "string";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "boolean") return "boolean";
  return null;
}
