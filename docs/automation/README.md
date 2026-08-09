# Autonomous Product Factory

The Autonomous Product Factory is the governed execution layer that turns a submitted idea into
observable product and engineering work. It does not merge Product Operations OS and Development
Operations OS. Each keeps its own authority, records, roles, and Git history. Automation connects
them through validated, content-addressed contracts.

## Product promise

After setup, the control panel must answer five questions without requiring the user to inspect
files or terminals:

1. What is happening now?
2. Which role created each task?
3. Which executable agent, if any, claimed it?
4. What evidence has been produced?
5. What is waiting for human authority?

"Configured", "authenticated", "executing", and "completed" are separate states. The interface must
never describe an installed provider as a running agent.

## Architecture

```mermaid
flowchart LR
    U["Idea and human authority"] --> P["Product control plane"]
    P --> C["Validated product-to-development contract"]
    C --> Q["Local durable queue and lease manager"]
    Q --> E["Isolated engineering executors"]
    E --> V["Independent verification"]
    V --> R["Validated development-to-product result"]
    R --> P
    P --> D["Control tower panel in the conversation"]
    Q --> D
    E --> D
    V --> D
```

The runtime has four layers:

- **Canonical control plane:** versioned configuration, task boards, approvals, contracts, evidence,
  receipts, and Git history remain the durable source of truth.
- **Local orchestration journal:** schema-validated state, an exclusive renewable lease, JSONL
  events, immutable role outputs, retry counters, and reports live under `.product-ops/runtime/`.
  The journal is reconstructable and does not replace the canonical task board or workbook.
- **Execution plane:** the host takes each bounded brief and delegates it to a subagent scoped to
  that boundary; the result returns through one contract regardless of who performed it. Every
  product and engineering role has a bounded workstream and attributed actor identity.
- **Observation plane:** the control tower panel in the conversation shows both teams, contract
  transfer, task claims, blockages, evidence, failures, retries, and human gates.

## Who performs the work

The host performs the work. The agent the owner is already talking to takes each bounded brief
through `product_ops_next_work`, delegates it to a subagent scoped to that boundary, and returns
the result through `product_ops_submit_work`, where it passes the same validation, dispatch-identity
check, credential scan, and sealing regardless of who produced it.

There is no provider detection, no CLI installation flow, and no authentication probe: the host
already knows who it is, and its identity and entitlements are its own concern. Capability is still
proven the only way it can be — by the first real bounded workstream completing. No credential is
ever stored inside either project.

## Task ownership and claiming

The continuous orchestrator uses an atomic lease rather than "first process to read a CSV".
A claim contains the task or workstream identifier, actor identifier, run identifier, lease expiry,
heartbeat time, attempt number, and canonical revision. Only dependency-ready work can be claimed.
An expired lease is recoverable; a completed workstream is immutable and cannot be executed twice
without an explicit superseding contract.

The default execution sequence is:

1. Product intake is normalized and deduplicated.
2. Product roles produce evidence and decisions through the deterministic control tower.
3. Human gates are requested when policy requires them.
4. The development boundary exports a schema-validated, hashed request.
5. Development planning creates dependency-aware workstreams.
6. Specialist executors claim ready workstreams with bounded concurrency.
7. Independent verification evaluates evidence and quality gates.
8. A sealed result returns to Product Operations OS.
9. Product state is refreshed and the panel shows the result.

## Non-negotiable safety boundaries

- No credential material is written to Git, contracts, task boards, logs, or the local index.
- Production deployment, destructive database changes, spending, and external publication require
  an explicit human gate unless a future policy deliberately and visibly narrows that rule.
- Executors receive the smallest practical write boundary and run in a dedicated container, virtual
  machine, or isolated hosted worker for untrusted work.
- A producer cannot independently certify its own material result.
- Every external mutation needs an idempotency key, a receipt, and read-back verification.
- Local execution is controlled only through the MCP surface, which registers no mutation path
  without explicit write authorisation.

## Delivery stages

### Stage 1 — truthful connection status (superseded)

Stage 1 detected, installed, and authenticated provider CLIs so a spawned process could do the
work. The host-delegated model made that machinery redundant — the host is already installed,
already authenticated, and already talking to the owner — and it was removed with the platform
launchers. What survives is the principle: "configured", "executing", and "completed" stay separate
states, and no surface describes an available agent as a running one.

### Stage 2 — durable continuous orchestrator (implemented)

- Renewable exclusive lease, task claiming, separately bounded logical and transient retries,
  exponential infrastructure backoff, stale-lease recovery, and resume from
  immutable role/workstream outputs.
- Local start, pause, resume, and retry controls. Pause is cooperative and takes effect after the
  active bounded agent returns.
- Factual phase, role, task, error, attempt, and event visibility in the panel.

### Stage 3 — automatic Product-to-Development bridge (implemented)

- Schema-bound read-only product agents analyze the intake in dependency order.
- Eligible `RB-13` work creates an approved hashed request, transfers it, generates a deterministic
  engineering plan, and updates both task boards.
- Completed engineering results and content-addressed evidence return without manual copying; later
  product QA, verification, readiness, and report roles inspect the returned proof.

### Stage 4 — complete local engineering loop (implemented)

- All 15 engineering boundaries are selected from declared impact; full-coverage requests
  activate architecture, frontend, backend, clients, database, data/AI, platform/network, security,
  QA, SRE, delivery, SEO, documentation, and independent verification.
- Work runs in dependency order on a dedicated cycle branch. Final changes are rejected outside the
  configured write boundary. `ENG-15` is read-only, and the coordinator seals accepted run records
  to the final content digest before committing.
- Product workbook records are inserted through dry-run hashes, absent-record preconditions,
  complete read-back, replay-safe receipts, and rollback backups.
- Production release, external publication, spending, credentials, destructive database work, and
  production data remain behind separate human authority.

### Stage 5 — reliability and scale (future)

- Add resource budgets, rate and quota backoff, provider failover, audit export, signed provenance,
  multi-user coordination, and disaster-recovery drills.

## Current boundary

The local single-owner cycle is implemented and reports `continuousOrchestrator: true` only when
product agents, engineering executors, and the Product/Development link are ready. The submitted local idea authorizes that bounded cycle; it does not authorize production.
Multi-user distributed queues, remote worker pools, signed provenance, provider failover, hosted
deployment, and unattended production changes are outside the current boundary.
