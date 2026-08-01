<div align="center">

# Starter kit templates

### The canonical, vendor-neutral contracts behind every generated project.

</div>

---

## Build order

| Step | Surface | Outcome |
| ---: | --- | --- |
| **01** | [`config/operating-model.yaml`](config/operating-model.yaml) | Confirm identifiers, statuses, roles, workbook tabs, and protected fields |
| **02** | [`governance/`](governance/) | Assign actors without collapsing producer, writer, development, and verifier boundaries |
| **03** | [`operations/`](operations/) | Create the first event, impact analysis, task chain, and durable handoffs |
| **04** | [`product/`](product/) | Capture ideas, discovery, decisions, issues, and delivery contracts |
| **05** | [`validation/`](validation/) | Fix expected behavior before execution and retain reproducible evidence |
| **06** | [`writers/`](writers/) | Apply bounded operational updates with complete read-back |
| **07** | [`release/`](release/) | Calculate readiness and coordinate human authorization and release |

Import the portable CSV files under [`workbook/tabs/`](workbook/tabs/) by following the
[workbook guide](workbook/README.md).

## Non-negotiable invariants

> [!CAUTION]
> Never place credentials, tokens, cookies, private keys, personal data, private URLs,
> production-derived fixtures, or raw provider responses in a template or committed record.

- Store only an approved secret-store alias when execution needs runtime access.
- A producer never certifies its own material claim.
- A commit or pull request is not evidence that a live write, deployment, test, or observation
  happened.
- A result exists only for an executed run; blocked and not-run states remain explicit.
- Every cross-system write requires an authorized manifest and complete read-back receipt.
- Historical records are append-only; corrections supersede rather than erase.

## Directory map

```text
config/       central operating-model authority
governance/   roles, ownership, routing, and communication
operations/   events, task board, task cards, and handoffs
product/      ideas, discovery, decisions, issues, and delivery
validation/   plans, scenarios, runs, results, evidence, and QC
writers/      controlled-write authorization and receipts
release/      readiness assessment and release records
workbook/     portable tab templates and setup maps
adapters/     disabled provider and execution boundaries
```

Generated projects also receive public schemas and runtime stores under `.product-ops/runtime/`.
Runtime state improves visibility; it never replaces the canonical workbook or Git history.
