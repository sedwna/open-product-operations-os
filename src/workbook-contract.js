import { canonicalCatalog, getCanonicalWorkbookSheets } from "./catalog.js";

const columnsBySheet = new Map(
  getCanonicalWorkbookSheets().map((sheet) => [sheet.key, new Set(sheet.columns)])
);

export const CANONICAL_RECORD_KEYS = Object.freeze(
  Object.fromEntries(
    Object.entries(canonicalCatalog.workbook_tabs).map(([sheetKey, sheet]) => {
      if (
        !Array.isArray(sheet.key_fields) ||
        sheet.key_fields.length === 0 ||
        sheet.key_fields.some(
          (field) => typeof field !== "string" || field.trim() === ""
        )
      ) {
        throw new Error(
          `Canonical workbook sheet "${sheetKey}" must define non-empty key_fields.`
        );
      }
      if (
        sheet.key_fields.some(
          (field) => !columnsBySheet.get(sheetKey)?.has(field)
        )
      ) {
        throw new Error(
          `Canonical workbook sheet "${sheetKey}" key_fields must exist in its template columns.`
        );
      }
      return [sheetKey, Object.freeze([...sheet.key_fields])];
    })
  )
);

export function canonicalRecordKeys(sheetKey) {
  const fields = CANONICAL_RECORD_KEYS[sheetKey];
  if (!fields) {
    throw new Error(
      `Workbook sheet "${sheetKey}" has no canonical controlled-write key contract.`
    );
  }
  return fields;
}
