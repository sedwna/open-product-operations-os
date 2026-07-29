# Readiness assessment

> Catalog: `../config/operating-model.yaml`

- Readiness ID: `<identifier_patterns.readiness>`
- Event / decision / issue / ticket IDs:
- Owner role / actor: `RB-11 / <ACTOR_ID>`
- Status: `<statuses.readiness>`
- Target environment:
- Assessed at:

## Gate matrix

| Gate | Required | Evidence / record IDs | Owner | State | Blocking reason |
| --- | --- | --- | --- | --- | --- |
| Human product decision | `<yes/no>` | | RB-02 | | |
| Delivery return | `<yes/no>` | | RB-13 | | |
| Validation result | `<yes/no>` | | RB-09 | | |
| Independent QC | `<yes/no>` | | RB-12 | | |
| Human observation | `<yes/no>` | | `<HUMAN>` | | |
| Controlled live write | `<yes/no>` | | RB-10 | | |
| Rollback readiness | `<yes/no>` | | RB-11 | | |
| Security / privacy | `<yes/no>` | | RB-08 | | |

## Risks

| Risk | Severity | Mitigation | Owner | Human acceptance reference |
| --- | --- | --- | --- | --- |
| | `<statuses.risk>` | | | |

## Readiness disposition

- Status: `<statuses.readiness>`
- Conditions:
- Blocking IDs:
- Release record ID:
- Producer actor ID:
- Independent verifier actor ID: `<must differ>`
- QC record ID:

Ready is not allowed while a required gate is absent, failed, self-certified, or supported only by
an unverified live-write claim.
