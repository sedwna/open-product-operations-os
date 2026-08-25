# Event lifecycle

Every material change follows one governed lifecycle.

```text
Event
→ impact analysis
→ human authorization when required
→ owner tasks
→ owner-authored manifests
→ canonical integration
→ controlled live write
→ complete read-back
→ derived updates and rollups
→ independent verification
→ human observation when required
→ release decision
→ post-release outcome observation
→ resolved, unresolved, inconclusive, or corrective loop
```

## Event types

Typical events include:

- a new idea or product decision;
- a page, feature, role, or journey change;
- a user finding or feedback item;
- an issue becoming ready for delivery;
- a validation plan or QA retest;
- a workbook or status-model change;
- a release or readiness transition;
- an agent-registry or governance change.

## Impact analysis

Before writing, identify:

- affected canonical artifacts;
- affected live systems;
- semantic owners;
- mechanical writers;
- independent verifier;
- status transitions;
- downstream consumers;
- rollback boundary;
- human gates;
- evidence requirements.

## Atomic record sets

A QA retest, for example, is not only a screenshot folder. Its atomic set is:

```text
task
↔ delivery ticket
↔ validation scenario
↔ execution run
↔ result
↔ evidence manifest
↔ decisive artifacts
↔ live status
↔ read-back receipt
```

If an execution is incomplete, it is recorded as incomplete with the exact dependency and next
owner. A result must never be invented to make a batch count reconcile.

## Corrective loops

Independent verification can return:

```text
PASS
EVIDENCE GAP
CONTROL FAILURE
LIVE PROPAGATION FAILURE
HUMAN DECISION REQUIRED
```

A failed control creates an owner-scoped corrective task. Historical claims remain immutable; the
effective disposition is appended.

## Delivery state versus problem state

`implemented`, `release-ready`, and `released` are delivery claims. `resolved` is a later outcome
claim. The observation window and expected next behavior are declared before release; evidence is
captured after release. A user does not have to return when success naturally ends their need, and a
necessary external final step is allowed when it was declared in the contract. What matters is that
the intended user or operational outcome occurred and can be independently checked.

