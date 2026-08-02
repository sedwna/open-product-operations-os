# Autonomous Product Factory

The Autonomous Product Factory is the governed execution layer that turns a submitted idea into
observable product and engineering work. It does not merge Product Operations OS and Development
Operations OS. Each keeps its own authority, records, roles, and Git history. Automation connects
them through validated, content-addressed contracts.

## Product promise

After one-click onboarding, the dashboard must answer five questions without requiring the user to
inspect files or terminals:

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
    P --> D["Unified observable dashboard"]
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
- **Execution plane:** provider adapters invoke the selected local Codex or Claude Code CLI through
  one provider-neutral contract. Every product and engineering role has a bounded workstream and
  attributed actor identity.
- **Observation plane:** the local dashboard displays provider readiness, contract transfer, task
  claims, execution events, evidence, failures, retries, and human gates.

## Automation-provider readiness contract

One-click onboarding checks these states in order:

| State | Meaning | Allowed action |
| --- | --- | --- |
| Not installed | No CLI candidate was found for the selected provider | Offer installation of its official package |
| Installed but unusable | A desktop alias or binary exists but cannot execute | Install or select a usable CLI |
| Login required | The CLI executes but its provider-native auth status is not logged in | Open the official browser login flow |
| Provider ready | CLI version and login status both pass | Configure and enable bounded executors |
| Capability proven | A real workstream completes successfully | Permit the scheduler to continue |

The CLI can report the active authentication method. It does not provide a stable contract for
reading a user's exact ChatGPT subscription tier. Therefore the system records authentication and
proves practical entitlement through the first real bounded execution. It never stores credentials
inside either project.

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
9. Product state and the unified dashboard are refreshed.

## Non-negotiable safety boundaries

- No credential material is written to Git, contracts, task boards, logs, or the local index.
- Production deployment, destructive database changes, spending, and external publication require
  an explicit human gate unless a future policy deliberately and visibly narrows that rule.
- Executors receive the smallest practical write boundary and run in a dedicated container, virtual
  machine, or isolated hosted worker for untrusted work.
- A producer cannot independently certify its own material result.
- Every external mutation needs an idempotency key, a receipt, and read-back verification.
- The dashboard may control local execution only on loopback with session authorization and CSRF
  protection.

## Delivery stages

### Stage 1 — truthful connection status (implemented)

- Detect installed, executable, authenticated, and ready states for Codex and Claude Code separately.
- Offer only the selected official CLI installation and provider-native browser authentication during one-click onboarding.
- Support explicit Codex, explicit Claude Code, or deterministic automatic provider selection.
- Configure and enable all engineering role executors only after readiness passes.
- Persist a credential-free automation status record.
- Display the actual state and current limitation in the dashboard Automation Center.

### Stage 2 — durable continuous orchestrator (implemented)

- Renewable exclusive lease, task claiming, bounded retries, stale-lease recovery, and resume from
  immutable role/workstream outputs.
- Local start, pause, resume, and retry controls. Pause is cooperative and takes effect after the
  active bounded agent returns.
- Factual phase, role, task, error, attempt, and event visibility in the dashboard.

### Stage 3 — automatic Product-to-Development bridge (implemented)

- Schema-bound read-only product agents analyze the intake in dependency order.
- Eligible `RB-13` work creates an approved hashed request, transfers it, generates a deterministic
  engineering plan, and updates both task boards.
- Completed engineering results and content-addressed evidence return without manual copying; later
  product QA, verification, readiness, and report roles inspect the returned proof.

### Stage 4 — complete local engineering loop (implemented)

- All 15 engineering boundaries are selected from declared impact; one-click full-coverage requests
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

The local single-owner cycle is implemented and reports `continuousOrchestrator: true` only when the
selected Codex or Claude Code provider, product agents, engineering executors,
Product/Development link, and dashboard loop
are ready. The submitted local idea authorizes that bounded cycle; it does not authorize production.
Multi-user distributed queues, remote worker pools, signed provenance, provider failover, hosted
deployment, and unattended production changes are outside the current boundary.
