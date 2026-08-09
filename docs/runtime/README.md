<div align="center">

# Runtime & control tower

### One bounded cycle at a time—from intake to evidence-backed readiness.

[Control tower](#the-control-tower-panel) · [Typical cycle](#a-typical-cycle) ·
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
| **Control tower panel** | Show both teams, the hand-off chain, blockages, risks, and pending decisions inside the conversation | Read-only |
| **Configuration and migration** | Apply a validated answers file and upgrade the operating contract safely | Plan only |
| **Autonomous coordinator** | Claim dependency-ready product and engineering work, recover retries, return evidence, and write the cycle report | Enabled only by a verified Codex or Claude Code automation link |

Runtime state is stored under:

```text
.product-ops/runtime/
```

Migration snapshots remain under:

```text
.product-ops/migrations/
```

Both locations stay inside the bounded project tree and are scanned by validation.

## The control tower panel

The panel renders inside your conversation whenever the MCP server is connected for the workspace.
Ask for `product_ops_panel`.

It shows both organisations as named teams, the hand-off chain for the cycle in flight, where the
work is stuck and whose it is to clear, open risks, and a composer for every gate waiting on the
product owner. It reads the same canonical records as every other surface and is never a second
source of truth.

Deciding stays with the person. The composer collects the owner's own reasoning and choice; where
the host supports dialogs, the disposition is collected through the host's own dialog, and a model
attempting to steer the outcome through tool arguments has no effect on what is recorded. On a
read-only server the panel still renders — the decision tools are simply not registered.

## A typical cycle

With Codex or Claude Code automation configured, the normal path is simply:

```text
1. Open the control tower panel in your conversation.
2. Submit an idea or feedback.
3. Watch the teams carry it in the panel.
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
