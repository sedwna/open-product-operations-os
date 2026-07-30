import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats(ajv);

const validators = new Map();

export function validatePublishedSchema(schemaFile, value) {
  let validator = validators.get(schemaFile);
  if (!validator) {
    const schema = JSON.parse(
      fs.readFileSync(path.join(packageRoot, "schemas", schemaFile), "utf8")
    );
    validator = ajv.compile(schema);
    validators.set(schemaFile, validator);
  }
  if (validator(value)) {
    return [];
  }
  return (validator.errors ?? []).map((error) => {
    const location = error.instancePath || "/";
    return `${location} ${error.message}`;
  });
}
