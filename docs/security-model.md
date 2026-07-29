# Security model

## Default position

Credentials, tokens, cookies, private keys, recovery codes, personal data, production-derived
fixtures, and provider secrets do not belong in Git, prompts, screenshots, receipts, or handoffs.

Runtime secrets are resolved from an approved local or managed store.

## Human gates

Explicit human authorization is required before:

- real-money movement;
- provider-backed payment or identity operations;
- production writes;
- destructive or irreversible changes;
- credential creation, rotation, export, or disclosure;
- changes to governance or role lifecycle;
- acceptance of unresolved risk.

## Test fixtures

Committed fixtures may contain public test constants only when all of these are true:

- identities are visibly synthetic;
- domains are reserved and non-deliverable;
- the runtime is proven local and non-production;
- a confirmation flag is mandatory;
- remote, staging, production, or ambiguous databases are refused before connection;
- reset is namespace-scoped, deterministic, and independently verified;
- no provider identity, real payment instrument, or production-derived data is present;
- deployment artifacts reject fixture identities and constants.

## Controlled writes

Initializer and workbook scaffold updates are written to exclusive same-directory stages and
atomically renamed into place after containment checks. Existing hard-linked destinations are
rejected. If a destination is swapped to a hard link after the final link-count check, rename
replaces the directory entry without truncating the linked peer.

A live writer must:

1. accept only an owner-authorized manifest;
2. validate scope and field authority;
3. check old-value preconditions;
4. write the smallest bounded range;
5. read back through two independent paths where possible;
6. compare the entire affected record or tab;
7. prove idempotent replay performs zero writes;
8. produce a receipt and rollback plan.

The packaged local CSV writer is deliberately limited to configured files inside the generated
project. It requires the exact hash from a preceding dry run, writes an integrity-checked backup
and receipt, rejects hard-linked targets, requires each sheet's canonical record key, rejects
duplicate canonical keys, and atomically moves the current target to a same-directory transaction
quarantine before verifying the approved bytes. The staged replacement is installed with an atomic
no-overwrite hard link and the stage link is removed before success, leaving a one-link target.
If another actor recreates the target after quarantine verification, installation fails with
`EEXIST`, preserves those concurrent bytes, retains the approved original for recovery, and emits
no success receipt. Handled post-install failures use the same no-overwrite recovery rule; an
interrupted process leaves bounded transaction-owned backup or quarantine artifacts instead of
guessing that overwrite is safe. Replay is accepted only with a matching validated receipt and
original preconditions. Rollback is refused if the target changed after the write. The
implementation does not connect to a provider or production system.

## Validation scan boundary

`product-ops validate` inventories the complete bounded target tree, rejects filesystem links,
scans text and binary bytes (including UTF-16LE and UTF-16BE) for obvious credentials, checks
non-reserved email canaries and private absolute paths, and reports binary inventory. Only `.git`
and `node_modules` directories are excluded; both are dependency or version-control stores outside
the generated operating records.

## Public-package boundary

This repository must not include source-product credentials, spreadsheet IDs, private URLs,
customer data, proprietary screenshots, internal evidence, or product-specific decisions.
