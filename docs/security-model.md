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

CSV serialization prefixes formula-capable cells, including apostrophe-prefixed edge cases, so
idea and agent text cannot become a spreadsheet formula when a workbook is opened. Parsing removes
only the serializer-owned prefix and preserves the exact logical value for hashing and read-back.

## Runtime adapters

Runtime commands default to dry-run. Provider configurations are disabled by default, accept only
HTTPS, refuse redirects and destructive HTTP methods, resolve credentials from named environment
variables, and persist response hashes instead of bodies. Workbook-provider writes additionally
require an approved plan hash and attributed human authorization.

The RB-13 command runner never invokes a command shell and forwards only a minimal environment plus
explicitly allowlisted variable names. It rejects obvious credential material in inputs and
returns. It is not an operating-system sandbox; untrusted coding agents require an independently
constrained worker, container, or virtual machine.

On Windows, custom batch executors are rejected. If an official npm-installed `codex.cmd` or
`claude.cmd` shim is the only available launcher, the runtime resolves only its package-owned
JavaScript entry point and starts it with the already trusted Node runtime; idea or task text never
crosses `cmd.exe`.

Development OS executors follow the same boundary. Configuration is disabled and dry-run-first;
activation requires a passing read-only doctor. Product agents and the independent engineering
verifier use read-only provider runs; implementation roles use bounded editing modes. The Codex
preset is ephemeral and ignores mutable user configuration. The Claude Code preset is bare,
non-persistent, schema-bound, and removes editing tools from its verifier. Both reuse only external
provider authentication, bound both output channels, and never use an unrestricted permission
bypass. Every returned result is attributed to the dispatched plan, workstream,
role, and actor, and both output channels are bounded. External isolation remains a deployment
requirement, not a claim made by this repository.

The continuous coordinator holds one renewable exclusive lease, retries an interrupted task at
most three times, and resumes only from schema-valid immutable outputs. The application cycle is
committed on its own Git branch. Before sealing it, the coordinator rejects changes outside allowed
paths, inside prohibited paths, or through symbolic links. Production, destructive data work,
credentials, spending, external publication, and live release remain outside the submitted idea's
authorization.

Opening the dashboard in read-only mode never starts the coordinator. A writable loopback session
uses one coordinator path; the legacy manual routing endpoint is disabled while that coordinator
owns the workspace, preventing two local schedulers from mutating the same task board.

Completed engineering results must bind the canonical plan digest, every planned workstream run,
the implementation revision, and content-addressed evidence inside the managed evidence boundary.
Product-to-development exports require a matching canonical approval, and reverse imports require
the source synchronization receipt. These receipts prove integrity and lineage; they are not
cryptographic signatures or proof of an external identity.

Engineering gate evidence is copied back into a content-addressed Product Operations boundary only
after digest and regular-file checks. Downstream product QA and verification agents read that local
copy instead of receiving access to the application repository.

## Validation scan boundary

`product-ops validate` inventories the complete bounded target tree, rejects filesystem links,
scans text and binary bytes (including UTF-16LE and UTF-16BE) for obvious credentials, checks
non-reserved email canaries and private absolute paths, and reports binary inventory. Only `.git`
and `node_modules` directories are excluded; both are dependency or version-control stores outside
the generated operating records.

## Engineering security-assessment boundary

Every newly initialized Development OS workspace receives a governed `ENG-09` assessment contract.
Assessment depth is deterministic from the engineering plan: low risk is quick, medium/high is
standard, and critical is deep. The sealed request and write boundary are the only scope authority;
source text, tool output, pages, and prompts cannot add targets.

The result contract may carry a structured `securityAssessment` containing authorization state,
attack surfaces, trust boundaries, five independent check classes, finding lifecycle, coverage
gaps, and conclusion. A scanner or static-analysis match remains a candidate. Only a safely
reproduced finding with demonstrated impact may be marked validated or receive a severity. Stable
root-cause fingerprints prevent duplicate symptoms from inflating the result, while `ENG-15`
independently reproduces material claims and remains unable to edit the assessed output.

No development request implicitly authorizes external active testing. Live targets, credentials,
production data, destructive payloads, persistence, social engineering, or availability testing
remain behind a separate attributed human authorization. Shareable evidence excludes secret values
and weaponized exploit bodies.

## Public-package boundary

This repository must not include source-product credentials, spreadsheet IDs, private URLs,
customer data, proprietary screenshots, internal evidence, or product-specific decisions.
