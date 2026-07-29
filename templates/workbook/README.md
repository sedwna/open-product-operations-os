# Google-Sheets-ready workbook template set

The `tabs/` directory is one workbook expressed as portable UTF-8 CSV files. It covers the complete
idea-to-release lineage and keeps categorical values in the `Config`, `Status Catalog`, and `Role
Registry` tabs.

## Create the workbook

1. Create a blank Google Sheets workbook in an approved workspace.
2. Import each CSV in `tabs/` as a new sheet, in the order listed in `workbook-map.csv`.
3. Rename each sheet to the exact `sheet_name` from `workbook-map.csv`.
4. Freeze row 1, enable filters, wrap long text, and keep identifier columns formatted as plain
   text.
5. Apply dropdowns from `data-validation-map.csv`. Do not type alternate lifecycle values directly
   into operational tabs.
6. Protect `Config`, `Status Catalog`, `Role Registry`, and ownership columns so changes follow
   governance.
7. Keep dates as ISO-8601 values and use UTC unless the central catalog specifies another timezone.

## Usability baseline

- Use a dark, high-contrast header fill and one consistent body font.
- Keep gridlines hidden only if explicit row/section borders preserve readability.
- Left-align text, center compact status/role fields, and format timestamps as
  `yyyy-mm-dd hh:mm:ss`.
- Add conditional formatting for blocked/failed/mismatch states and for high/critical risk.
- Do not merge cells in data tabs.
- Keep formulas visible and auditable if you add rollups. Never hardcode status logic in a formula;
  reference the catalog tabs.

## Data rules

- One row is one immutable logical record. Corrections append a new record and use `supersedes_id`.
- Multi-value relationships use pipe-separated IDs only for convenience; the `Lineage` tab is the
  normalized relationship authority.
- Writer tabs contain aliases and references, never secret values.
- A validation result row requires an actual run row.
- Producer and verifier actor IDs must differ for the same material claim.
- A live-write claim requires a writer receipt with complete read-back.

## Integrity checks

- Every non-empty identifier matches the pattern in `Config`.
- Every categorical value exists in `Status Catalog`.
- Every role key exists in `Role Registry`.
- Every foreign ID resolves to a record or is explicitly marked external.
- Every result resolves to a run, scenario, plan, ticket, and evidence manifest.
- Every material producer row resolves to an independent QC row.
- Every release resolves to readiness, authorization, validation, and rollback records.
- No cell contains a credential, token, cookie, key, private URL, personal data, or production
  payload.
