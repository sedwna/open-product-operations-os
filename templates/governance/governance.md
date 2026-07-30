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

## Work and communication

- The taskboard and committed handoffs are the coordination bus.
- Every task has one accountable role boundary and explicit dependencies.
- Blocked work states the dependency, next owner, and unblock condition.
- Private messages may alert an owner but never replace the durable task or handoff.
- Completion means the done conditions and required receipts exist, not that effort occurred.

## Evidence and truthfulness

- Evidence identifies source, capture time, environment, method, integrity value, and limitations.
- A validation result is created only from an executed run.
- Missing evidence produces a gap or blocked state, never an invented pass.
- Historical claims are append-only; a later disposition supersedes rather than rewrites them.

## Controlled writes

The writer accepts only an authorized manifest, validates field authority and old-value
preconditions, writes the smallest range, reads back the full affected records, tests zero-write
replay, and emits a rollback-capable receipt. The writer does not author semantic changes.

## Security

Do not commit credentials, tokens, cookies, keys, recovery codes, personal data, private URLs,
provider identifiers, production-derived fixtures, or proprietary evidence. Record an approved
secret-store alias only when runtime access is required. Ambiguous environments default to no
write.

## Closure

An event closes only when required canonical artifacts, controlled-write receipts, reproducible
evidence, independent verification, human disposition where required, and downstream readiness
recalculation are complete.
