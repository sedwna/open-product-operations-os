# Operating model customization checklist

- [ ] Set the project key, product name, timezone, repository reference, adapter, and non-secret
  workbook alias in `operating-model.yaml`.
- [ ] Confirm identifier patterns before creating records; never recycle an issued identifier.
- [ ] Confirm every status family. Add statuses only in the catalog and document migration effects.
- [ ] Assign actors to all 13 role boundaries in the role registry.
- [ ] Ensure every producer-owned artifact has an independent verifier boundary.
- [ ] Confirm human approvers for every configured human gate.
- [ ] Tailor ownership and routing without weakening semantic-owner or writer boundaries.
- [ ] Import workbook tabs with the exact catalog tab names.
- [ ] Configure data validation from `workbook/data-validation-map.csv`.
- [ ] Confirm the canonical repository and live workbook are distinct sources of truth.
- [ ] Test manifest preconditions, complete read-back, idempotent replay, and rollback in a safe
  non-production fixture.
- [ ] Run a secret scan before the first commit. Commit only aliases such as
  `store://approved-store/runtime-alias`, never secret values.
- [ ] Run one fictional or local dry run from idea through independent verification and readiness.
