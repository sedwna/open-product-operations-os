# Safe local CSV writer

`src/local-writer.js` is an executable, provider-free reference adapter for a generated project's
configured CSV workbook. It never connects to a live spreadsheet or production provider.

The caller must:

1. validate an authorized JSON manifest against
   `schemas/workbook-write-manifest.schema.json`;
2. call `applyLocalWrite` in its default dry-run mode;
3. present the returned bounded plan to the caller's approval flow;
4. pass the exact returned `planHash` with `dryRun: false`;
5. retain the generated backup and receipt under `.product-ops/writes/<manifestId>/`.

The adapter enforces configured owner and writer actors, protected-field denies, explicit
environment policy, old-value preconditions, complete file read-back, and a zero-write replay
check. `rollbackLocalWrite` restores the backup only when both backup and current post-write hashes
match the receipt. It refuses rollback after unrelated target changes.

This reference implementation proves local control mechanics only. It is not cross-host evidence,
an independent QC verdict, a production authorization, or a provider writer.
