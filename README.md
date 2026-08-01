<div align="center">
  <img src=".github/assets/og.png" alt="Open Product Operations OS — from signal to evidence-backed release" width="100%">

  <br>

  <a href="https://github.com/sedwna/open-product-operations-os/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/sedwna/open-product-operations-os/ci.yml?branch=main&style=flat-square&label=quality"></a>
  <img alt="Node 20 or newer" src="https://img.shields.io/badge/node-20%2B-67b99a?style=flat-square">
  <img alt="Apache 2.0" src="https://img.shields.io/badge/license-Apache--2.0-4c82c3?style=flat-square">
  <img alt="Dry run first" src="https://img.shields.io/badge/writes-dry--run%20first-f26b4f?style=flat-square">
  <img alt="RTL dashboard" src="https://img.shields.io/badge/dashboard-interactive%20RTL-e1a64a?style=flat-square">

  <h3>A vendor-neutral operating system for evidence-backed product work.</h3>

  <p>
    Turn an unstructured signal into an owned decision, governed delivery,<br>
    reproducible evidence, independent verification, and a release you can explain.
  </p>

  <p>
    <a href="docs/onboarding/one-click.md"><strong>Launch in one click</strong></a>
    ·
    <a href="START-HERE.md">Start here</a>
    ·
    <a href="docs/runtime/README.md">Run the control tower</a>
    ·
    <a href="docs/architecture/overview.md">Explore the architecture</a>
    ·
    <a href="examples/fictional-saas/README.md">See the PineDesk example</a>
  </p>
</div>

---

## Product work should leave a trail

Most product systems hold fragments: an idea in chat, a decision in a meeting, a ticket in a
tracker, test evidence in a folder, and release status somewhere else. Open Product Operations OS
connects those fragments into one reconstructable chain.

<p align="center">
  <img src="docs/assets/flow-loop.svg" alt="Animated product workflow from signal to release" width="100%">
</p>

```text
source event
→ owned task
→ canonical artifact
→ operational state
→ read-back proof
→ independent verification
→ human disposition when required
```

If a link is missing, the system does not silently call the work complete.

## What you get

| Surface | What it gives you |
| --- | --- |
| **Interactive control tower** | A calm RTL workspace for tasks, decisions, intake, risks, evidence, roles, and release readiness |
| **13 role boundaries** | Explicit authority for discovery, decisions, delivery, QA, writes, verification, release, and development |
| **23-tab product workbook** | Portable CSV records spanning idea, discovery, issues, tickets, evidence, QA, lineage, and readiness |
| **Executable workflow** | A dry-run-first scheduler that routes intake, resolves dependencies, opens human gates, and dispatches eligible work |
| **Development adapter** | A bounded handoff to an engineering agent or team through the dedicated development role |
| **Independent Development OS** | A 15-boundary engineering package for architecture, frontend, backend, database, data, infrastructure, network, security, QA, SRE, delivery, SEO, documentation, and verification |
| **Controlled writers** | Precondition checks, authorization, complete read-back, replay protection, and guarded rollback |
| **Provider boundary** | Disabled-by-default adapters for GitHub, GitLab, Jira, Linear, Azure DevOps, Sheets, Graph, and Airtable |
| **Portable proof** | Cross-host package checks, clean-clone/archive tests, SBOM generation, license checks, and secret scans |

## The control tower

The dashboard is generated from the same durable records that drive the control plane. It is not a
second source of truth.

- **Snapshot mode** creates a self-contained RTL report you can open locally.
- **Live mode** serves the current project on a loopback address with search, filters, detail
  drawers, intake, human decisions, and control-plane execution.
- **Read-only is the default.** Live writes require an explicit authorization flag and a
  per-session local request token.
- **Hosted demos stay fictional.** Real project data and write authority never leave the local
  project boundary.

```text
# Create a safe snapshot
product-ops dashboard ./my-product --apply

# Open the interactive panel without write authority
product-ops dashboard ./my-product --serve

# Allow attributed local intake, decisions, and bounded control-plane cycles
product-ops dashboard ./my-product --serve --apply
```

Read the [runtime guide](docs/runtime/README.md) for the complete operating and safety contract.

## One-click start

Clone the repository, then open the launcher for your platform. The graphical wizard asks for the
folder names, product definition, and optional first idea. For a new application it initializes
and validates both Product Operations OS and the independent Development Operations OS, creates
separate Git histories, and opens the read-only live dashboard. Existing application repositories
receive Development Operations OS files only after explicit opt-in.

| Windows | macOS | Linux |
| --- | --- | --- |
| Double-click [`OpenProductOS.exe`](launchers/windows/OpenProductOS.exe) | Open [`OpenProductOS.command`](launchers/macos/OpenProductOS.command) | Open [`OpenProductOS.desktop`](launchers/linux/OpenProductOS.desktop) |

No administrator access is required. If Node.js is missing, the launcher downloads a portable
Node.js 22 runtime from the official distribution and verifies its SHA-256 checksum before use.
See the [one-click onboarding guide](docs/onboarding/one-click.md) for first-open notes, the safety
contract, recovery, and distributable bundles.

```text
# Universal command-line fallback
npm run onboard
```

## Five-minute manual start

**Requirement:** Node.js 20 or newer.

```text
# Preview every generated file
node ./src/cli.js init ./my-product --dry-run

# Create and validate the project
node ./src/cli.js init ./my-product
node ./src/cli.js validate ./my-product

# Open the product-owner dashboard
node ./src/cli.js dashboard ./my-product --serve
```

Then add a safe local intake and inspect the next workflow cycle:

```text
node ./src/cli.js intake ./my-product --file ./idea.json --apply
node ./src/cli.js operate ./my-product
```

> [!TIP]
> Runtime commands plan by default. Add the explicit apply flag only after reviewing the planned
> action and confirming the correct project boundary.

## Architecture at a glance

```mermaid
flowchart LR
    A[Signal] --> B[Control plane]
    B --> C[Owned task chain]
    C --> D{Human gate?}
    D -- Yes --> E[Attributed decision]
    D -- No --> F[Role execution]
    E --> F
    F --> G[Development / QA / writer]
    G --> H[Evidence + read-back]
    H --> I[Independent verification]
    I --> J[Readiness + release]
```

The repository is intentionally layered:

```text
src/          executable initializer, validator, runtime, adapters, and dashboard
templates/    canonical governance, role, workbook, workflow, and release contracts
schemas/      published validation contracts
examples/     fictional end-to-end evidence
docs/         architecture, security, migration, runtime, and verification guidance
site/         public read-only dashboard demonstration with fictional data
```

## Development integration

For full engineering operation, initialize the independent
[Open Development Operations OS](docs/development/README.md) inside the application repository.
It uses versioned request/result contracts and content-addressed receipts to synchronize with this
Product Operations repository without merging their authority or canonical state.

```text
development-os init ./my-application --dry-run
development-os init ./my-application
development-os validate ./my-application
```

The graphical one-click path performs these initialization and validation commands automatically
for a new application. Use the manual commands above when adding Development Operations OS later
or when you prefer command-line control. Specialist executors remain disabled until separately
configured, tested, and authorized.

The original command-runner adapter remains available as a lower-level bounded integration.

Development is a governed adapter, not an implicit side effect. The development role receives an
approved delivery contract, acceptance criteria, dependencies, evidence, a validation recipe, and
a write boundary. It returns an implementation reference, test evidence, environment state, known
risks, and development-owned status.

```text
product-ops development ./my-product --task TASK-RB-13-...        # plan
product-ops development ./my-product --task TASK-RB-13-... --apply # execute
```

An arbitrary coding command is **not** an operating-system sandbox. Run untrusted development
agents inside a separately constrained worker, container, or virtual machine.

## Safety is part of the product

| Invariant | Enforcement |
| --- | --- |
| Producers cannot certify their own material claims | Distinct producer and verifier actors are validated |
| Humans retain product and risk authority | Durable, attributed approval records gate protected transitions |
| External writes are exceptional | Adapters are disabled by default and runtime actions plan first |
| A write is not trusted until read back | Controlled writers require complete post-write comparison |
| Credentials stay outside Git | Whole-tree secret scanning and named environment-variable references |
| History remains explainable | Operational records preserve lineage; corrections supersede rather than erase |

See the [security model](docs/security-model.md) and
[public release gates](docs/publication-gates.md) before enabling real providers.

<details>
<summary><strong>Current maturity and verification evidence</strong></summary>

<br>

```text
Current stage: Foundation
Public API stability: Not guaranteed
Recommended use: Evaluation and pilot projects
```

The project is not yet declared stable. The latest runtime branch introduced the interactive
control plane and extended the suite beyond the original foundation proof. Historical producer and
independent-verifier records remain under [`docs/verification/`](docs/verification/) and follow the
documented [supersession policy](docs/verification/evidence-supersession-and-redaction.md).

The package path validates syntax, clean-room identity, tests, portable hashes, a real packed
artifact, clean clone/archive behavior, dependencies, licenses, and an SBOM. Passing automation is
producer evidence; it is not a substitute for an independent release verdict.

</details>

<details>
<summary><strong>What the initializer generates</strong></summary>

<br>

- the canonical 13-role registry with distinct default actors;
- governance, ownership, routing, and communication contracts;
- a shared task board and first owned discovery task;
- the canonical 23-tab CSV workbook;
- local public schemas for handoffs, evidence, approvals, development results, providers, and
  controlled writes;
- disabled Git, spreadsheet, development, and external-provider adapters;
- runtime stores for intake, approvals, receipts, metrics, and dashboard output;
- a configuration wizard, migration contract, and synthetic example project.

Forced regeneration preserves valid configuration and operational rows. It rejects path escapes,
links, unsafe replacement races, and ambiguous recovery states.

</details>

## Reading map

| If you want to… | Read… |
| --- | --- |
| Bootstrap a product | [Start here](START-HERE.md) |
| Understand ownership and separation | [Architecture overview](docs/architecture/overview.md) |
| Follow one event end to end | [Event lifecycle](docs/architecture/event-lifecycle.md) |
| Operate the dashboard and agents | [Runtime guide](docs/runtime/README.md) |
| Connect a development agent | [Development runner](docs/runtime/development-runner.md) |
| Initialize the complete engineering system | [Development OS](docs/development/README.md) |
| Understand Product/Development synchronization | [Dual OS architecture](docs/architecture/dual-operating-system.md) |
| Review the latest production-readiness security audit | [Security review](docs/verification/2026-08-02-production-readiness-security-review.md) |
| Connect external systems | [Provider adapters](docs/runtime/provider-adapters.md) |
| Work with the workbook | [Workbook operating model](docs/workbook/operating-model.md) |
| Evaluate publication readiness | [Public release gates](docs/publication-gates.md) |

## Contributing

The repository welcomes evidence-backed improvements. Begin with
[`CONTRIBUTING.md`](CONTRIBUTING.md), keep changes inside an explicit role and write boundary, and
never represent producer evidence as independent certification.

<div align="center">
  <br>
  <strong>Open Product Operations OS</strong><br>
  Clear ownership · durable decisions · reproducible evidence
  <br><br>
  Apache License 2.0
</div>
