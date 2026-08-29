# Governance contract

## Authority

The human product owner retains product direction, priority, risk acceptance, sensitive access,
production, destructive action, role-lifecycle, and final user-visible acceptance authority.
Role boundaries may prepare exact proposals but may not imply human authorization.

## Sources of truth

- Git canonical state contains governance, tasks, semantic records, manifests, and evidence indexes.
- The live workbook or issue system contains operational state only after a controlled write.
- The development system owns code, deployment state, and development-authored fields.
- Human dispositions are explicit, attributed records.

A change in one source does not imply a change in another. Each transition requires a receipt.

## Separation of duties

1. A semantic owner defines meaning and acceptance.
2. A mechanical writer applies an authorized manifest without changing its meaning.
3. An independent verifier reproduces claims without editing the producer's record.
4. For the same material claim, `producer_actor_id` must differ from `verifier_actor_id`.
5. If staffing forces one actor to fill both role boundaries, an independent human must perform
   the verification and the exception must be recorded before closure.

No task, run, result, receipt, readiness decision, or release record may mark producer self-QC as
independent verification.

## Status and identifier control

`../config/operating-model.yaml` is the only status, identifier, role-key, and tab-name authority.
Templates use catalog paths rather than inventing values. Existing identifiers and historical
records are immutable; corrections point to the superseded record.

## Decision authority between the human and AI

Keep one project-level decision-authority matrix. Calibrate it at onboarding and revisit it only
after a material change in product risk or governance; never run a 20-question gate for every
feature.

| Level | Rule |
| --- | --- |
| Human-only | AI may prepare evidence but may not decide or act. |
| AI recommends; human decides | AI provides mutually exclusive options, consequences, and a recommendation. |
| AI acts within approved bounds | AI executes a reversible decision already bounded by an approved contract. |
| Mechanical autonomy | AI performs deterministic routing, formatting, validation, and read-back. |

Product direction, priority, material scope trade-offs, risk acceptance, production or destructive
action, sensitive access, and final user-visible acceptance never move out of human authority by
silence. At calibration, the AI proposes 20 product-specific decision statements and the owner
scores each from 1–20 for alignment. Low-alignment or boundary-changing statements remain human
decisions; the recorded matrix, not chat memory, governs later action.

## Work and communication

- The taskboard and committed handoffs are the coordination bus.
- Every task has one accountable role boundary and explicit dependencies.
- Blocked work states the dependency, next owner, and unblock condition.
- Private messages may alert an owner but never replace the durable task or handoff.
- Completion means the done conditions and required receipts exist, not that effort occurred.

## Proportional delivery

- Read canonical state before asking the owner. Ask only when the answer changes product direction,
  risk acceptance, irreversible action, sensitive access, or final acceptance.
- Stop discovery when remaining uncertainty cannot change the next decision. Record unknowns and
  reopening triggers instead of forcing completeness.
- Implement the smallest complete reversible change that meets current acceptance criteria, using
  existing paths and patterns first.
- Understand the affected flow, then stop at the first viable solution: no build, repository reuse,
  standard-library or native-platform capability, installed dependency, then minimum local code.
- For a defect, inspect all callers and fix the shared root cause once. Prefer deletion, boring code,
  and the fewest affected files.
- A new abstraction, service, dependency, store, queue, extension point, gate, or artifact requires
  a present need, a simpler rejected alternative, its ongoing cost, and a removal or expansion
  trigger. Hypothetical reuse is not evidence.
- A deliberate shortcut records its known ceiling and observable replacement trigger. Non-trivial
  logic leaves one focused runnable check; trust-boundary validation, data-loss handling, security,
  accessibility, and explicit acceptance criteria are never simplification targets.
- Assurance depth follows impact. Scope control, credential hygiene, material-claim evidence,
  independent verification, and human authority remain mandatory at every depth.

## Evidence and truthfulness

- Evidence identifies source, capture time, environment, method, integrity value, and limitations.
- A validation result is created only from an executed run.
- Missing evidence produces a gap or blocked state, never an invented pass.
- Historical claims are append-only; a later disposition supersedes rather than rewrites them.

## Controlled writes

The writer accepts only an authorized manifest, validates field authority and old-value
preconditions, writes the smallest range, reads back the full affected records, tests zero-write
replay, and emits a rollback-capable receipt. The writer does not author semantic changes.

## Workspace and resource lifecycle

The generated `governance/workspace-resource-lifecycle.md` is the lifecycle contract for Git
worktrees, Docker resources, temporary folders, mounts, and leases. Every resource is attributable
from creation through terminal disposition in the suite-root `.workspace/resources.csv`.

- Managed worktrees stay under `.workspace/worktrees/<repo>/<card-or-purpose>`.
- Cleanup starts with a read-only inventory and exactly one of `KEEP_ACTIVE`, `REMOVE_PROVEN`,
  `QUARANTINE`, or `HOLD_REVIEW` for every candidate.
- Dirty, detached, unpushed, data-bearing, mounted, shared, locked, or authority-ambiguous resources
  are not removed.
- Registered worktrees use native Git removal with registration and ref read-back. Docker volumes
  are not removed for dangling status alone, and broad `docker system prune` is forbidden on shared
  hosts.
- Full access is technical capability, not deletion authority. Cleanup is bounded and each batch
  reads back disk, Git, Docker health, and protected paths.
- A task cannot close while a resource it created lacks an owner and terminal disposition.

## Security

Do not commit credentials, tokens, cookies, keys, recovery codes, personal data, private URLs,
provider identifiers, production-derived fixtures, or proprietary evidence. Record an approved
secret-store alias only when runtime access is required. Ambiguous environments default to no
write.

## Closure

An event closes only when required canonical artifacts, controlled-write receipts, reproducible
evidence, independent verification, human disposition where required, and downstream readiness
recalculation are complete.

Event or delivery closure does not prove the original problem is resolved. `implemented` proves a
technical return, `release_ready` proves release gates, `released` proves the authorized release,
and `resolved` proves the intended post-release outcome. An issue may use closure disposition
`resolved` only with linked completed release, passing result, accepted outcome observation,
evidence, and independent QC. Other closure dispositions remain explicitly non-resolution outcomes.
