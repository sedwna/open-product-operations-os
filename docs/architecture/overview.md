# Architecture overview

## Design goals

Open Product Operations OS is designed for:

- durable operation across different LLM vendors;
- recoverability from Git without chat replay;
- explicit semantic ownership;
- evidence-backed product and QA claims;
- safe automation of spreadsheet-backed operations;
- separation of authoring, mechanical writing, and independent verification;
- incremental adoption by an existing product team.

## Logical components

```text
Human Product Owner
        │
        ▼
Product Operations Control Tower
        │
        ├── Idea and Decision Office
        ├── Product Discovery and Experience
        ├── Product Topology and Journeys
        ├── Intake and Issue Lifecycle
        ├── Delivery Contracts
        ├── Validation Design
        ├── Risk and Logic Audit
        ├── QA Execution and Evidence
        ├── Workbook Automation and Integrity
        ├── Readiness and Release
        └── Independent Controls
```

The default registry is configurable. The architectural boundaries are more important than the
number of agents.

## Four authority types

### Semantic owner

Defines the meaning of a row, field, status, decision, test, or delivery contract.

### Event owner

Coordinates one cross-cutting event from intake to closure without taking over specialist
authority.

### Mechanical writer

Applies an owner-authorized manifest to a canonical or live system, enforces preconditions, and
produces read-back and replay receipts.

### Independent verifier

Reproduces claims without editing the producer's artifact or certifying its own output.

One role must not be both producer and independent verifier for the same claim.

## Decision authority between the human and AI

Each project keeps one decision-authority matrix, calibrated at onboarding and revisited only when
the product's governance or risk changes materially. It is not repeated for every feature.

| Level | Authority | Typical examples |
| --- | --- | --- |
| Human-only | AI may organize evidence but cannot select or act | Product direction, priority, risk acceptance, production, destructive action, final acceptance |
| AI recommends; human decides | AI presents bounded options, consequences, and a recommendation | Material scope or experience trade-offs |
| AI acts within approved bounds | AI may execute a reversible decision already bounded by a contract | Approved implementation, tests, documentation, corrective work |
| Mechanical autonomy | AI performs deterministic bookkeeping without a product decision | Formatting, routing, validation, read-back, status projection |

At initial calibration or a material governance change, the AI proposes 20 product-specific
decision statements and the owner scores each from 1–20 for alignment. The result updates the one
project-level matrix. A low-alignment or boundary-changing statement remains human-decided; the
exercise must not become a per-feature qualification gate.

## Sources of truth

The system distinguishes:

- **Git canonical state** for governance, tasks, product definitions, manifests, and evidence;
- **live operational state** such as a spreadsheet or issue tracker;
- **development canonical state** for code, deployments, and development-owned fields;
- **human decisions** recorded as explicit dispositions.

A document pull request does not imply a spreadsheet write. A spreadsheet write does not imply a
code release. Every cross-system transition requires an explicit receipt.

## Coordination model

Agents do not rely on private direct messages. They:

1. read their owned card;
2. perform work inside their authority;
3. commit the output and evidence;
4. update the card;
5. return control to the Control Tower.

The Control Tower opens the next dependency. This makes the task board a replayable message bus.

The packaged runtime implements a single-cycle scheduler, durable approvals, intake routing,
RB-13 command dispatch, provider outbox, dashboard, metrics, setup, and migration services. It does
not run as an unattended daemon and does not make external writes unless the relevant adapter is
enabled and the caller supplies explicit apply authorization.

