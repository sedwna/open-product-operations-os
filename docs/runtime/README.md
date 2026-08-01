# Runtime guide

The runtime turns the repository's durable operating contracts into a dry-run-first execution
cycle. It does not replace Git canonical state, semantic ownership, independent verification, or
human authority.

## Components

| Component | Responsibility |
| --- | --- |
| Control plane | Select ready tasks, check dependencies and human gates, route intake, and prepare dispatches |
| Approval store | Persist attributed approval requests and dispositions |
| Intake | Normalize and deduplicate ideas, findings, incidents, feedback, and requests |
| Development runner | Dispatch an eligible RB-13 task to an explicitly configured command agent |
| Provider outbox | Plan and apply bounded HTTPS operations through disabled-by-default providers |
| Dashboard and metrics | Produce local operational visibility without a hosted service |
| Setup and migration | Configure a generated project and upgrade its operating-model contract safely |

Runtime state is written under `.product-ops/runtime/`. Migration backups are written under
`.product-ops/migrations/`. Both locations remain inside the bounded project tree and are scanned
by `product-ops validate`.

## Safety contract

- Runtime mutation and provider commands default to dry-run.
- `--apply` is explicit and cannot be combined with `--dry-run`.
- Human gates require a durable disposition attributed to the configured human authority actor.
- Provider credentials are read only from the configured environment variable and never written
  to plans or receipts.
- Provider receipts retain response hashes and status codes, not response bodies.
- A receipt is persisted before a completed outbox item is acknowledged, preventing an already
  evidenced request from being silently replayed after a partial local failure.
- External destructive HTTP methods are refused.

## Typical cycle

```text
product-ops intake ./product --file ./idea.json --apply
product-ops operate ./product
product-ops operate ./product --apply
product-ops approvals ./product
product-ops decide ./product --request APR-... --decision approved --actor human-product-owner --apply
product-ops development ./product --task TASK-RB-13-... --apply
product-ops metrics ./product --apply
product-ops dashboard ./product --apply
product-ops validate ./product
```

The control-plane receipt is an execution signal. It is not an independent verification verdict
and does not change development-owned or human-owned workbook fields.
