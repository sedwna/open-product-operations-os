# Event impact analysis

> Catalog: `../config/operating-model.yaml`

## Identity

- Event ID: `<identifier_patterns.event>`
- Event type: `<event_type from governance/routing-rules.yaml>`
- Status: `<statuses.event>`
- Triggered at: `<ISO-8601 timestamp>`
- Source reference: `<idea|finding|decision|issue|release|governance reference>`
- Coordinator role: `RB-01`
- Coordinator actor: `<ACTOR_ID>`

## Intent

- Change requested:
- User or operational outcome:
- Explicit non-goals:
- Priority: `<statuses.priority>`
- Risk: `<statuses.risk>`

## Impact map

| Item | Affected? | Owner role | Canonical path or system | Required action |
| --- | --- | --- | --- | --- |
| Product meaning | `<yes/no/unknown>` | `<ROLE_KEY>` | `<REFERENCE>` | |
| Live workbook | `<yes/no/unknown>` | `RB-10` | `<NON_SECRET_ALIAS>` | |
| Development state | `<yes/no/unknown>` | `RB-13` | `<REFERENCE>` | |
| Validation | `<yes/no/unknown>` | `RB-07` | `<REFERENCE>` | |
| QA evidence | `<yes/no/unknown>` | `RB-09` | `<REFERENCE>` | |
| Readiness/release | `<yes/no/unknown>` | `RB-11` | `<REFERENCE>` | |

## Control plan

- Semantic owners:
- Mechanical writer:
- Independent verifier: `RB-12`
- Producer actor ID:
- Verifier actor ID: `<must differ from producer>`
- Human gates from catalog:
- Old-value preconditions:
- Rollback boundary:
- Evidence required:
- Downstream consumers:

## Owner tasks

| Task ID | Owner role | Dependency IDs | Done condition | Status |
| --- | --- | --- | --- | --- |
| `<identifier_patterns.task>` | `<ROLE_KEY>` | `<ID_OR_NONE>` | `<observable condition>` | `<statuses.task>` |

## Closure conditions

- [ ] Required owner outputs exist in canonical state.
- [ ] Authorized manifests and controlled-write receipts are linked where applicable.
- [ ] Read-back covers complete affected records.
- [ ] Evidence is reproducible and contains no sensitive material.
- [ ] Independent verification is by an actor other than the producer.
- [ ] Required human dispositions are explicit and attributed.
- [ ] Downstream readiness is recalculated.
- [ ] No secret value is present in this record or its linked committed artifacts.
