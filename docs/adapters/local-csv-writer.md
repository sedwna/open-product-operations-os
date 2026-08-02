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
environment policy, old-value preconditions for updates, explicit absent-record preconditions for
inserts, complete file read-back, and a zero-write replay check. An insert uses
`operation: "insert"` and the exact precondition `{ "$record": "absent" }`; an existing canonical
key makes it fail closed. Each manifest must use the exact canonical key fields for its sheet, row selectors cannot add
alternate keys, and duplicate canonical IDs are rejected before mutation. Existing hard-linked
targets are rejected. The replacement and receipt are staged. For the target, the adapter moves the
current file to a same-directory transaction quarantine, verifies its captured filesystem identity
and bytes, and installs the stage with a no-overwrite hard link. Source retirement first moves the
pathname to a private location and rechecks identity; it never blindly unlinks a pathname after a
concurrent replacement window. A recreated source or destination is preserved and the transaction
fails.

After receipt installation, the adapter revalidates the target twice, the backup, and the persisted
receipt as one state. Target divergence moves the receipt to an explicit invalidated recovery path
and returns no success. Committed quarantine cleanup also uses captured identity. A mismatch or
cleanup failure is a structured fail-closed error that reports every retained recovery path;
initializer and writer callers do not emit a success summary. Replay refuses any retained
quarantine or invalidated receipt. `rollbackLocalWrite` restores the backup only when both backup
and current post-write hashes match the receipt and applies the same identity and retention rules.
It refuses rollback after unrelated target changes.

This reference implementation proves local control mechanics only. It is not cross-host evidence,
an independent QC verdict, a production authorization, or a provider writer.
