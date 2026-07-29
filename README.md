# Open Product Operations OS

Open Product Operations OS is a vendor-neutral operating system for running product work from an
unstructured idea to an evidence-backed release.

It combines:

- role-based AI agents with explicit authority boundaries;
- a Git-backed task board and durable handoffs;
- a product workbook that links discovery, decisions, delivery, validation, QA, and readiness;
- controlled synchronization to a live spreadsheet;
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

## What this repository will generate

The stable release will provide:

- a configurable agent registry;
- governance, ownership, routing, and communication contracts;
- a shared task board;
- a multi-tab product workbook;
- status guides and lifecycle definitions;
- idea, decision, discovery, issue, ticket, validation, QA, and release templates;
- schemas for manifests, evidence, handoffs, and controlled writes;
- a project initializer and integrity validator;
- spreadsheet, Git, and development-agent adapter contracts;
- a complete example project.

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
