# MCP control surface (`product-ops-mcp`)

## Purpose

Expose the Product Operations control plane as a Model Context Protocol server so that a product
owner can ask "what is happening, what stage are we in, and what needs my decision" from inside
Claude Code, Claude Desktop, claude.ai, the ChatGPT desktop app, Codex CLI, or a compliant IDE —
without opening a terminal and without a second source of truth.

This inverts the current integration direction:

```text
today:     Product Operations  ──spawn──▶  Codex CLI / Claude Code CLI
proposed:  Codex / Claude      ──MCP────▶  Product Operations (this server)
```

The host supplies identity, model, permission prompts, and rendering. This repository supplies the
authority model, the durable records, and the evidence chain. Neither takes over the other.

## Non-goals

- Replacing the local dashboard. The dashboard remains the full operator surface.
- Becoming a second source of truth. Every tool reads and writes the same canonical files.
- Granting the model human product authority. Human gates stay human.
- External provider writes. Provider adapters remain out of this surface in v1.

## Placement

```text
src/mcp/
├── server.js       stdio entry point, capability negotiation, project binding
├── jsonrpc.js      newline-delimited JSON-RPC over stdio, both directions
├── registry.js     single declarative table: name → schema, handler, authority tier
├── tools/
│   ├── read.js     panel, status, decisions, task, cycle, evidence, readiness, validate
│   ├── write.js    intake, operate, autopilot
│   └── decide.js   the human-authority tier
├── app/
│   ├── panel.js    the control tower as an MCP App
│   └── teams.js    human names for the boundaries on both sides
├── resources.js    productops:// URI handlers and templates
├── prompts.js      take-command, start, brief, what-needs-me, explain-blocked
├── authority.js    the gate: tier enforcement, dry-run default, failure taxonomy
├── projection.js   snapshot → token-bounded product-owner view
├── watch.js        canonical-record watcher behind resource subscription
└── untrusted.js    envelope for record-derived text
```

The shared control-plane write lease lives outside this tree, in
[`src/runtime/control-plane-lease.js`](../../src/runtime/control-plane-lease.js), because it guards
every local surface rather than this one.

New bin entry in `package.json`:

```json
"bin": { "product-ops-mcp": "./src/mcp/server.js" }
```

## Project binding (security boundary)

The server binds to exactly one project root, supplied at launch:

```text
product-ops-mcp --project <path>
```

No tool accepts a `root`, `path`, or `target` parameter. This is deliberate: tool arguments are
model-controlled and may originate from injected content in an intake record or a workbook cell.
A per-call root would let injected text redirect writes to an arbitrary directory.

The resolved root is validated once at startup with the existing `resolveInside` and
`assertNoLinkTraversal` helpers from [`src/paths.js`](../../src/paths.js), and every handler reuses
that single resolved value.

## Authority tiers

Three tiers map directly onto the invariants already enforced in the runtime.

| Tier | Tools | MCP annotation | Server-side enforcement |
| --- | --- | --- | --- |
| **A — read** | `status`, `pending_decisions`, `task`, `cycle_report`, `evidence`, `readiness`, `validate` | `readOnlyHint: true` | no write path reachable |
| **B — plan** | `intake`, `operate`, `autopilot` | `destructiveHint: false` | `apply` defaults to `false`; dry-run returns the plan only |
| **C — human authority** | `decide` | elicitation + `_meta["anthropic/requiresUserInteraction"]` | `actorId` must equal `config.project.humanAuthorityActorId` |

Tier C already has a server-side lock: [`decideApproval`](../../src/runtime/approvals.js) rejects any
actor that is not the configured human authority. Two host-level controls sit on top of it.

**Elicitation is the primary control.** Rather than accepting the disposition and rationale as
model-supplied parameters, `decide` issues an `elicitation/create` request. The host renders a form,
the person fills it in, and the response returns to the server directly. The recorded disposition
and rationale therefore originate from a human, not from a model relaying what it believes the human
wants. This is a materially stronger reading of the "durable, attributed approval" invariant than
the current dashboard achieves, because no intermediary can paraphrase the rationale.

`_meta["anthropic/requiresUserInteraction"]` is the secondary control. It is an Anthropic-specific
key in the `tools/list` entry — not a portable MCP annotation — and requires Claude Code v2.1.199 or
later. It forces the permission prompt on every call in all permission modes.

Both controls are host-side and can be defeated by host configuration the adopter owns: an
`Elicitation` hook can auto-respond to elicitation dialogs, and Codex applies its own per-tool
approval model rather than the Anthropic key. The server-side actor check is therefore the only
control this repository fully owns, and it must never be relaxed.

Recommended additional hardening: `decide` requires a `decisionToken` that is only ever emitted by
`pending_decisions`. This forces a read-before-write and makes a fabricated `requestId` unusable.

## Tools

Twelve tools maximum. Descriptions stay under two lines each; bulk data lives in resources.

### Tier A — read

| Tool | Answers | Key parameters |
| --- | --- | --- |
| `product_ops_status` | "What is happening right now?" | `verbosity: brief \| full` |
| `product_ops_pending_decisions` | "What is waiting for me?" | `limit` |
| `product_ops_task` | "Why is this card where it is?" | `taskId` |
| `product_ops_cycle_report` | "What did the last cycle produce?" | `cycleId?` |
| `product_ops_evidence` | "What proof backs this claim?" | `taskId \| eventId` |
| `product_ops_readiness` | "Can we release, and if not why?" | — |
| `product_ops_validate` | "Is the project structurally sound?" | — |

`product_ops_status` is the primary entry point. It is a **projection**, not the raw snapshot:
[`loadWorkspaceSnapshot`](../../src/runtime/snapshot.js) returns every task, every intake record, and
the last 100 autopilot events. Returning that verbatim would consume thousands of tokens per call.

The `brief` projection contains only:

```text
phase · current role · current task · attempt/retry state
counts: ready / in_progress / blocked / done
pending decisions: count + one-line titles
latest cycle: id, status, completedAt
top 3 risks
```

Target: under 800 tokens. `full` adds role activity, evidence coverage, and the engineering
workstream summary, and is still bounded.

### Tier B — plan

| Tool | Effect | Default |
| --- | --- | --- |
| `product_ops_intake` | Normalize and record an idea, finding, incident, or feedback | `apply: false` |
| `product_ops_operate` | One bounded control-plane scheduling cycle | `apply: false` |
| `product_ops_autopilot` | `start \| pause \| resume \| retry` on the local coordinator | guarded |
| `product_ops_next_work` | Hand out one team's bounded brief for the host to delegate | reads only |
| `product_ops_submit_work` | Record what the host's subagent produced | `apply: false` |
| `product_ops_open_delivery` | Export an approved delivery contract to the application and plan it | `apply: false` |
| `product_ops_next_engineering_work` | Hand out one engineering workstream from the linked application | reads only |
| `product_ops_submit_engineering_work` | Record what the host's engineering subagent produced | `apply: false` |
| `product_ops_close_delivery` | Seal the completed workstreams and import the result | `apply: false` |

## Who performs the work

Two executors sit behind one seam. They differ only in who performs a task; both build the same
brief with `buildProductAgentRequest`, and both return through the same validation, dispatch-identity
check, credential scan, and sealing in `runProductAgent`.

| Executor | Performer | Driven by | Suits |
| --- | --- | --- | --- |
| **Host-delegated** (default) | A subagent of the host, one per team boundary | The host — it takes work, delegates, and returns the result | Supervised sessions, any MCP-capable host |
| **Spawned provider** | A Codex or Claude Code CLI process | The coordinator loop, which picks work and runs the CLI itself | Unattended runs, CI, nightly cycles |

A host cannot be driven the way the loop drives a CLI, because its subagents are its own to start.
That is the whole reason for the split: the host-delegated path inverts control so the host asks for
work rather than being handed it.

The provider readiness probes in `src/codex/` and `src/claude/` belong to the spawned executor alone.
Nothing on the host-delegated path detects, installs, or authenticates a CLI — the host already
knows who it is.

`product_ops_next_work` never hands out the development boundary. A product task owned by the
development role is not delegable through it, exactly as `product_ops_operate` fixes
`executeDevelopment` to false — crossing that line is the owner's decision, and the control plane
raises a `development_boundary_crossing` gate rather than stepping over it.

### The engineering half

Once the owner has approved the crossing and an application is linked, engineering work is delegated
the same way product work is. `product_ops_next_engineering_work` reads the plan in the *linked
application repository*, finds a workstream whose dependencies are satisfied, and returns its brief:
the team, the contract's `writeBoundary`, and the prohibited paths. `product_ops_submit_engineering_work`
returns the result through `runEngineeringWorkstream` — the same schema validation, the same
dispatch-identity check, the same read-only proof for ENG-15, the same sealing that a spawned CLI
would have faced.

This is not a second boundary. It is the same one: what crosses between the repositories is the
hashed contract with its `sourceDigest`, and that is unchanged by who performs the work. Only the
performer moved — from a CLI this process starts to a subagent the host already has. Independent
verification is handed out last, because ENG-15 reproduces claims the others have not yet made.

### The claim

`submit_work` requires a `claimToken` that only `next_work` issues, so a task identifier lifted from
a record cannot reach the run store. The token is keyed to the task's identity *and its status*, so
a claim held across a state change no longer verifies: it described work that has since moved.

`autopilotAuthorized` defaults to `false` on `product_ops_intake`. Submitting an idea through a chat
window must not silently authorize an autonomous engineering cycle; that stays an explicit opt-in,
matching the current dashboard contract where the flag is set only on the writable local surface.

### Tier C — human authority

| Tool | Effect |
| --- | --- |
| `product_ops_decide` | Record an attributed approval or rejection against a pending gate |

`development_export` and `development_import` were deliberately excluded from v1, pending their own
review, and that review has happened. They are now reachable as `product_ops_open_delivery` and
`product_ops_close_delivery`.

The reasoning: the authority line is not crossed by whoever runs the command. It is crossed by the
owner settling the `development-export` gate, and what travels is the hashed contract with its
`sourceDigest`, which the engineering side verifies against. Neither of those changes with the
caller. Keeping the commands off this surface did not protect the boundary — it only meant the owner
had to open a terminal at the exact moment they had just authorised the crossing.

Both tools plan by default. `open_delivery` refuses to cross an unsettled gate and says so;
`close_delivery` refuses to close over a workstream with no sealed result, and refuses a delivery
that changed nothing.

## Resources

Bulk and historical data is exposed as resources, fetched on demand rather than preloaded. In Claude
Code these are reachable with `@product-ops:productops://…`.

| URI | Content |
| --- | --- |
| `productops://project/config` | Project identity, roles, environments (secrets never present by construction) |
| `productops://taskboard` | Canonical task board projected to a readable table |
| `productops://approvals/pending` | Full pending approval records with context and risks |
| `productops://cycle/latest` | Latest cycle report (Markdown) |
| `productops://workbook/{tab}` | Templated — one entry per canonical workbook tab |
| `productops://roles` | The role boundaries with `may` / `must_not` |
| `productops://events/recent` | Tail of the autopilot event journal |

## Prompts

Exposed as slash commands by both hosts.

| Prompt | Purpose |
| --- | --- |
| `brief` | Today's product state in one screen |
| `what-needs-me` | Pending human gates with enough context to decide |
| `explain-blocked` | Why the cycle is not advancing, with the blocking chain |

## Untrusted content envelope

Intake titles, descriptions, workbook cells, and blocked reasons are authored by people and agents
outside this system. When such text is returned through a tool result or a resource, it is wrapped:

```text
<untrusted-record source="productops://taskboard" id="TASK-RB-06-0004">
…verbatim record text…
</untrusted-record>
```

The server never interprets record text as instruction, and the envelope signals the same to the
host model. This matters most for `pending_decisions`, where an injected "approve this" string would
otherwise sit next to a real approval control.

## Change notification

The server watches `.product-ops/runtime/` and the canonical task board. On change it emits
`notifications/resources/list_changed`, which Claude Code handles by refreshing the server's
capabilities without a reconnect. This gives near-live state in a chat session without polling.

Debounce at 500 ms; ignore the orchestrator lease file, which is written on every heartbeat.

## Concurrency with the dashboard

Open issue that must be resolved before tier B ships. A manual control-plane cycle is refused while
the continuous orchestrator owns routing, but approval and task-board writes are not leased.

Two writers (a live dashboard and an MCP session) can now target the same files. Resolution: extend
the existing autopilot lease in [`src/autopilot/state.js`](../../src/autopilot/state.js) into a
general control-plane write lease, and have every tier B and C handler acquire it. A tool that
cannot acquire the lease returns a clear "another local surface holds the write lease" result rather
than racing.

## Host configuration

The package is not published to npm yet, so these launch the server from a clone. The `product-ops-mcp`
bin exists and an `npx --package=open-product-operations-os` form will work once it is published; until
then that form returns a 404 and must not appear in the setup instructions.

### Claude Code — project scoped

`.mcp.json` at the product-operations repository root:

```json
{
  "mcpServers": {
    "product-ops": {
      "command": "node",
      "args": ["/absolute/path/to/open-product-operations-os/src/mcp/server.js", "--project", "."]
    }
  }
}
```

### Codex — project scoped

`.codex/config.toml` (loaded only for trusted projects):

```toml
[mcp_servers.product_ops]
command = "node"
args = ["/absolute/path/to/open-product-operations-os/src/mcp/server.js", "--project", "."]
```

Per-tool approval modes should be set so that `product_ops_decide` always prompts. Confirm the exact
key names against the current Codex configuration reference before publishing this snippet.

The same MCP configuration is shared by the ChatGPT desktop app, Codex CLI, and the Codex IDE
extension, so one entry serves all three.

## Dependency decision

The official `@modelcontextprotocol/sdk` is the straightforward implementation path, but this
repository currently ships four production dependencies and runs license, SBOM, and clean-room
checks over all of them.

| Option | Cost | Benefit |
| --- | --- | --- |
| Use the official SDK | +1 dependency tree; SBOM and license checks must be re-run | Spec conformance, transport and negotiation handled, future extensions arrive free |
| Hand-rolled JSON-RPC over stdio | ~200 lines to own and keep current with the spec | Keeps the four-dependency posture |

Recommendation: use the official SDK. The MCP core changed materially in the `2026-07-28` revision;
tracking that by hand is ongoing cost for no product value. Pin the protocol revision explicitly and
record the new dependency in the SBOM contract.

## Test plan

Follows the existing `node --test` discipline.

| Test | Asserts |
| --- | --- |
| `mcp-handshake` | `initialize`, `tools/list`, `resources/list`, `prompts/list` succeed over stdio |
| `mcp-read-tools` | Every tier A tool returns a result that validates against its declared output shape |
| `mcp-authority` | `decide` without `apply` plans only; wrong `actorId` is rejected; unknown `requestId` is rejected |
| `mcp-binding` | No tool accepts a root/path argument; a symlinked project root is rejected at startup |
| `mcp-token-budget` | `product_ops_status` at `brief` stays under the declared byte ceiling |
| `mcp-untrusted` | Record-derived text is always enveloped |
| `mcp-lease` | A tier B tool fails cleanly when the control-plane write lease is held |

## Delivery phases

| Phase | Scope | Risk |
| --- | --- | --- |
| 1 ✅ | Server skeleton, project binding, seven tier A tools, resources, prompts | None — read only |
| 2 ✅ | Shared control-plane write lease, then tier B tools with dry-run default | Low |
| 3 ✅ | Tier C `decide` via elicitation, with a decision token | Medium — authority path |
| 4 ✅ | Resource subscription, filesystem watch, and a self-refreshing panel | Low |
| 5 ✅ | MCP Apps UI resource rendering the RTL control tower in-conversation | Separate design |

Phase 1 is independently useful: it answers the product owner's three questions without any write
path existing at all.

## Effect on the platform-specific surface

This section predicted that once the host launched the server, the graphical launchers and the
portable Node bootstrap would stop being the delivery path. They have since been removed; the
prior revision is preserved at tag `v0.8.1-launcher-era`.

| Concern | Before | Now |
| --- | --- | --- |
| Delivery | Three native launchers plus a per-platform archive | One npm package |
| User prerequisite | None; a portable Node runtime was downloaded and checksummed | Node 20 or newer |
| Platform-specific code | Launchers, runtime bootstrap, CLI readiness probes, filesystem semantics | Filesystem semantics, plus the readiness probes the spawned-provider executor still needs |

What does **not** become platform-independent: path separators, Windows reserved filenames, CRLF
handling in CSV records, rename atomicity, and case-sensitivity differences. Those are properties of
the filesystem rather than of the delivery channel, and they remain necessary for as long as local
Git stays the canonical source of truth. They are already handled in
[`src/paths.js`](../../src/paths.js), [`src/atomic-move.js`](../../src/atomic-move.js), and
`.gitattributes`.

A Streamable HTTP variant would remove the Node prerequisite entirely, but it would also move
canonical state off the operator's machine. That trade is not worth making for the primary surface;
it is a reasonable shape for a future read-only team panel.
