# Open Product Operations OS

Open Product Operations OS is a vendor-neutral operating system for running product work from an
unstructured idea to an evidence-backed release.

It combines:

- role-based AI agents with explicit authority boundaries;
- a Git-backed task board and durable handoffs;
- a product workbook that links discovery, decisions, delivery, validation, QA, and readiness;
- controlled-write contracts and a provider-free local CSV reference adapter;
- reproducible QA evidence and human acceptance;
- independent quality control before closure;
- an adapter boundary for one or more development agents.

The system is designed so that a human product owner receives one consolidated report instead of
coordinating every specialist directly.

## Status

This repository is being extracted from a production-tested operating model. The first public
release is not yet declared stable.

```text
Current stage: Foundation
Public API stability: Not guaranteed
Recommended use: Evaluation and pilot projects
```

## License

Open Product Operations OS is available under the
[Apache License 2.0](LICENSE).

## Start here

Read:

1. [START-HERE.md](START-HERE.md)
2. [Architecture overview](docs/architecture/overview.md)
3. [Event lifecycle](docs/architecture/event-lifecycle.md)
4. [Security model](docs/security-model.md)
5. [Public release gates](docs/publication-gates.md)
6. [Clean-room extraction policy](docs/migration/clean-room-extraction.md)
7. [Safe local CSV writer](docs/adapters/local-csv-writer.md)

## Quick start

Node.js 20 or newer is required. From this repository:

```text
node ./src/cli.js init ./my-product --dry-run
node ./src/cli.js init ./my-product
node ./src/cli.js validate ./my-product
```

To regenerate only the workbook templates:

```text
node ./src/cli.js generate-workbook ./my-product
```

The dry run reports the planned writes without changing the target directory. Existing generated
files are preserved unless the explicit `--force` option is used. `--force` refreshes replaceable
scaffold, but it never deletes workbook or taskboard rows. Operational CSVs retain their rows;
newly required columns are appended with blank values. A valid existing
`product-ops.config.json`, including human authority, actor assignments, environments, and bounded
workbook extensions, is retained byte-for-byte. If authority assignments change, migrate affected
operational rows explicitly before expecting validation to pass. Changed scaffold is created in a
same-directory stage and atomically renamed into place; existing hard-linked destinations are
rejected, and a hard-link swap cannot cause the initializer to truncate the linked peer.

## Core promise

Every material product claim should be reconstructable as:

```text
source event
→ owned task
→ canonical artifact
→ live operational state
→ read-back proof
→ independent verification
→ human disposition when required
```

If one link is missing, the work is not silently treated as complete.

## What this repository generates

The current initializer creates:

- the canonical 13-role registry and 13 complete role packages with distinct default actor IDs;
- governance, ownership, routing, and communication contracts;
- a shared task board with its first owned task;
- the canonical 23-tab CSV workbook;
- a first draft discovery event, idea, and discovery record;
- status guides and lifecycle definitions;
- idea, decision, discovery, issue, ticket, validation, QA, and release templates;
- local copies of the published schemas for manifests, evidence, handoffs, and controlled writes;
- a project initializer and integrity validator;
- disabled Git and development-agent adapter contracts;
- a disabled local-CSV adapter plus an executable safe local writer library requiring dry-run plan
  approval, owner authorization, preconditions, complete read-back, zero-write replay, and
  hash-guarded rollback. Existing hard-linked targets are rejected; the current target is atomically
  quarantined and verified before a same-filesystem no-overwrite install. A concurrently recreated
  target is preserved with no success receipt, failed post-install transactions recover without
  overwriting concurrent bytes, and replay requires a matching validated receipt and backup;
- a synthetic example project.

`templates/config/operating-model.yaml` is the single role, tab, record-key, field-authority,
environment, and scan-policy catalog used by the initializer. Each generated project receives a byte-for-byte
snapshot at `config/operating-model.yaml`. Validation scans the whole bounded target tree,
including binary inventory and UTF-8/Latin-1/UTF-16LE/UTF-16BE canaries, except for the explicit
`.git` and `node_modules` directory exclusions. Workbook validation checks row widths, record-key
uniqueness, canonical identities and placeholder rows, canonical statuses, actor/role assignments,
mandatory RB-12 verification, producer/verifier separation, environments, and protected values.

The project is still a foundation release: generated formats and public interfaces may change
before the first stable release.

Portable example evidence uses repository-controlled LF bytes via `.gitattributes`. The
`npm run portability` check reproduces declared SHA-256 hashes and byte lengths on a normal clone.
The npm payload includes the portability contract, tests, and a publishable shrinkwrap lock;
`npm run packed:check` installs the actual tarball and executes its checks without relying on
repository-only files.

## Non-goals

- It is not an autonomous production deployer.
- It does not grant agents authority over real money, credentials, destructive actions, or product
  decisions.
- It does not replace a development repository or its release governance.
- It does not allow a producer to certify its own work.

## Project origin

The public package is generalized from a real multi-agent Product Operations system. Product-
specific names, IDs, credentials, URLs, screenshots, customer data, and proprietary decisions are
excluded from this repository.
