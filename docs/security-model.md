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
quarantine before verifying the approved bytes. The staged replacement is installed with a
no-overwrite hard link. Source retirement moves the pathname to a private location and verifies its
captured identity instead of unlinking a stale pathname.
If another actor recreates the target after quarantine verification, installation fails with
`EEXIST`, preserves those concurrent bytes, retains the approved original for recovery, and emits
no success receipt. Target divergence during receipt commit invalidates the canonical receipt.
Handled post-install failures and committed cleanup retention report bounded recovery paths instead
of guessing that deletion or overwrite is safe. Replay is accepted only with a matching validated receipt and
original preconditions. Rollback is refused if the target changed after the write. The
implementation does not connect to a provider or production system.

## Runtime adapters

Runtime commands default to dry-run. Provider configurations are disabled by default, accept only
HTTPS, refuse redirects and destructive HTTP methods, resolve credentials from named environment
variables, and persist response hashes instead of bodies. Workbook-provider writes additionally
require an approved plan hash and attributed human authorization.

The RB-13 command runner never invokes a command shell and forwards only a minimal environment plus
explicitly allowlisted variable names. It rejects obvious credential material in inputs and
returns. It is not an operating-system sandbox; untrusted coding agents require an independently
constrained worker, container, or virtual machine.

Development OS executors follow the same boundary. Configuration is disabled and dry-run-first;
activation requires a passing read-only doctor. The Codex preset uses an ephemeral, workspace-write,
schema-bound non-interactive run. Every returned result is attributed to the dispatched plan,
workstream, role, and actor, and both output channels are bounded. External isolation remains a
deployment requirement, not a claim made by this repository.

Completed engineering results must bind the canonical plan digest, every planned workstream run,
the implementation revision, and content-addressed evidence inside the managed evidence boundary.
Product-to-development exports require a matching canonical approval, and reverse imports require
the source synchronization receipt. These receipts prove integrity and lineage; they are not
cryptographic signatures or proof of an external identity.

## Validation scan boundary

`product-ops validate` inventories the complete bounded target tree, rejects filesystem links,
scans text and binary bytes (including UTF-16LE and UTF-16BE) for obvious credentials, checks
non-reserved email canaries and private absolute paths, and reports binary inventory. Only `.git`
and `node_modules` directories are excluded; both are dependency or version-control stores outside
the generated operating records.

## Public-package boundary

This repository must not include source-product credentials, spreadsheet IDs, private URLs,
customer data, proprietary screenshots, internal evidence, or product-specific decisions.
