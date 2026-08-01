<div align="center">

# Product workbook

### A portable, auditable workbook from idea to release—expressed as UTF-8 CSV.

</div>

---

## Import checklist

- [ ] Create a blank workbook in an approved workspace.
- [ ] Import every file under [`tabs/`](tabs/) in [`workbook-map.csv`](workbook-map.csv) order.
- [ ] Rename each sheet to its exact mapped name.
- [ ] Freeze row 1, enable filters, wrap long text, and format identifiers as plain text.
- [ ] Apply dropdowns from [`data-validation-map.csv`](data-validation-map.csv).
- [ ] Protect configuration, status, role, ownership, and other governed columns.
- [ ] Keep timestamps in ISO-8601 and use UTC unless the central catalog says otherwise.

## Visual baseline

| Area | Recommendation |
| --- | --- |
| Header | One dark, high-contrast fill with readable white text |
| Body | One consistent sans-serif font; wrap long evidence and outcome fields |
| Status | Conditional formatting for blocked, failed, mismatch, and critical risk |
| Alignment | Left-align narrative text; center compact status and role values |
| Timestamps | Display as `yyyy-mm-dd hh:mm:ss` without losing the underlying ISO value |
| Structure | Avoid merged cells; preserve explicit rows and columns for auditability |

Formulas should remain visible and reference catalog tabs. Never hide lifecycle logic inside
hard-coded formulas.

## Data rules

1. One row represents one immutable logical record.
2. Corrections append a new row and use `supersedes_id`.
3. Multi-value convenience fields use pipe-separated IDs; the Lineage tab remains the normalized
   relationship authority.
4. Writer tabs contain aliases and references, never secrets.
5. A validation result requires an executed run.
6. Producer and verifier actors differ for the same material claim.
7. A live-write claim requires a receipt with complete read-back.

## Integrity gates

Every identifier matches the central pattern; every status exists in the catalog; every role key
resolves; every result links to its run, scenario, plan, ticket, and evidence; material producer
claims resolve to independent QC; releases resolve to readiness, authorization, validation, and
rollback; and no cell contains credential or production-secret material.
