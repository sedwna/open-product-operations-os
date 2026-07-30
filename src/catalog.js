import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { parseCsv } from "./csv.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = path.join(
  packageRoot,
  "templates",
  "config",
  "operating-model.yaml"
);
const roleRegistryPath = path.join(
  packageRoot,
  "templates",
  "governance",
  "role-registry.yaml"
);

export const canonicalCatalog = parse(fs.readFileSync(catalogPath, "utf8"));
const roleRegistryTemplate = parse(fs.readFileSync(roleRegistryPath, "utf8"));

export function getCanonicalRoles() {
  const details = new Map(
    roleRegistryTemplate.roles.map((role) => [role.role_key, role])
  );
  return Object.entries(canonicalCatalog.roles).map(([roleKey, role]) => {
    const detail = details.get(roleKey);
    if (!detail || detail.boundary !== role.boundary) {
      throw new Error(
        `Role template "${roleKey}" does not match the canonical operating-model catalog.`
      );
    }
    return {
      roleKey,
      boundary: role.boundary,
      lifecycle: role.lifecycle,
      purpose: detail.purpose,
      may: detail.may,
      mustNot: detail.must_not
    };
  });
}

export function getCanonicalWorkbookSheets() {
  return Object.entries(canonicalCatalog.workbook_tabs).map(([key, tab]) => {
    const templatePath = path.join(
      packageRoot,
      "templates",
      "workbook",
      "tabs",
      tab.file
    );
    const template = fs.readFileSync(templatePath, "utf8");
    const [columns = []] = parseCsv(template);
    return {
      key,
      name: tab.name,
      file: `workbook/${tab.file}`,
      owner: tab.owner,
      columns,
      template
    };
  });
}

export function readPackagedTemplate(relativePath) {
  return fs.readFileSync(path.join(packageRoot, "templates", relativePath), "utf8");
}

export function readPackagedFile(relativePath) {
  return fs.readFileSync(path.join(packageRoot, relativePath), "utf8");
}
