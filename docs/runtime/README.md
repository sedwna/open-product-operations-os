<div align="center">

# Runtime & control tower

### One bounded cycle at a time—from intake to evidence-backed readiness.

[Dashboard](#interactive-dashboard) · [Typical cycle](#a-typical-cycle) ·
[Safety contract](#safety-contract) · [Development](development-runner.md) ·
[Providers](provider-adapters.md)

</div>

---

The runtime turns durable operating contracts into an executable, dry-run-first cycle. It does not
replace Git canonical state, semantic ownership, independent verification, or human authority.

## Runtime map

| Component | Responsibility | Default posture |
| --- | --- | --- |
| **Control plane** | Select ready work, resolve dependencies, route intake, and prepare dispatches | Plan only |
| **Approval center** | Persist context, options, recommendation, risks, actor, rationale, and disposition | Human-owned |
| **Unified intake** | Normalize and deduplicate ideas, findings, incidents, feedback, and requests | Plan only |
| **Development runner** | Dispatch one eligible development task through a command contract | Disabled |
| **Provider outbox** | Apply bounded HTTPS operations and retain projected, hash-backed receipts | Disabled |
| **Control tower** | Show tasks, decisions, intake, risks, roles, evidence, and readiness | Read-only |
| **Setup and migration** | Configure a generated project and upgrade the operating contract safely | Plan only |
| **Autonomous coordinator** | Claim dependency-ready product and engineering work, recover retries, return evidence, and write the cycle report | Enabled only by a verified one-click Codex or Claude Code automation link |

Runtime state is stored under:

```text
.product-ops/runtime/
```

Migration snapshots remain under:

```text
.product-ops/migrations/
```

Both locations stay inside the bounded project tree and are scanned by validation.

## Interactive dashboard

### Read-only live mode

```text
product-ops dashboard ./product --serve
```

Use search, task filters, detailed task and decision drawers, role activity, risk review, evidence
coverage, and release gates without changing project state.

### Explicitly writable live mode

```text
product-ops dashboard ./product --serve --apply
```

This additionally permits:

- normalized intake creation;
- attributed approval or rejection by the configured human authority actor;
- one bounded control-plane scheduling cycle;
- start, cooperative pause, resume, and retry of the linked local autonomous cycle.

When the workspace contains a verified one-click automation link, the dashboard process also runs
the continuous coordinator and can execute bounded development work in the separate application
repository. It does **not** authorize provider calls, production deployment, destructive actions,
production data, credentials, spending, or external publication.
The server accepts local loopback traffic only, rejects oversized or non-JSON writes, and requires a
random authorization token from the active dashboard session.

### Portable snapshot

```text
product-ops dashboard ./product --apply
```

This writes a self-contained HTML snapshot. Its filters, search, navigation, theme, export, and
detail views work locally, but mutation controls remain disabled because no runtime server is
connected.

## A typical cycle

With one-click Codex or Claude Code automation, the normal path is simply:

```text
1. Open the local dashboard.
2. Submit an idea or feedback.
3. Watch the active product or engineering role in Automation Center.
4. Read the generated report and inspect the workbook/evidence links.
5. Submit a correction to begin the next linked cycle.
```

The coordinator stores state, events, role results, manifests, evidence, and reports under
`.product-ops/runtime/autopilot/`. It retries a failed active task up to three times, resumes only
from schema-valid immutable results, and requires a manual retry after the bounded limit.

The lower-level manual path remains available:

```text
# 1. Normalize a signal
product-ops intake ./product --file ./idea.json --apply

# 2. Inspect, then execute one scheduler cycle
product-ops operate ./product
product-ops operate ./product --apply

# 3. Review any durable human gate
product-ops approvals ./product
product-ops decide ./product --request APR-... --decision approved \
  --actor human-product-owner --rationale "Approved for the bounded pilot." --apply

# 4. Dispatch eligible development work
product-ops development ./product --task TASK-RB-13-... --apply

# 5. Refresh visibility and validate the project
product-ops metrics ./product --apply
product-ops dashboard ./product --apply
product-ops validate ./product
```

## Safety contract

1. Runtime mutation and provider commands plan by default.
2. Explicit execution cannot be combined with dry-run mode.
3. Human gates require a durable disposition attributed to the configured authority actor.
4. Credentials are read only from named environment variables and never written to plans or
   receipts.
5. Provider receipts keep response hashes and allowlisted fields—not raw response bodies.
6. A receipt is persisted before a completed outbox item is acknowledged, preventing silent replay
   after partial local failure.
7. External destructive HTTP methods are refused.
8. A command adapter handling untrusted code must run inside a separately constrained environment.

> [!WARNING]
> A successful runtime receipt proves only that the bounded operation ran. It does not prove a
> product claim, a live deployment, or independent acceptance.
