# Delivery ticket contract

> Catalog: `../config/operating-model.yaml`

- Ticket ID: `<identifier_patterns.ticket>`
- Event / issue / decision IDs:
- Product owner role / actor: `RB-06 / <ACTOR_ID>`
- Development adapter role / actor: `RB-13 / <ACTOR_ID>`
- Status: `<statuses.ticket>`
- Priority / risk:

## Approved outcome

- User-visible or operational outcome:
- Scope:
- Non-goals:
- Dependencies:
- Constraints:

## Acceptance criteria

| AC ID | Given | When | Then | Evidence required |
| --- | --- | --- | --- | --- |
| AC-01 | | | | |

## Delivery boundary

- Allowed code or system areas:
- Prohibited areas:
- Data migration expectations:
- Compatibility expectations:
- Rollback expectation:
- Runtime access alias, if required: `<store://approved-store/alias OR none>`

## Validation recipe

- Validation plan ID:
- Scenario IDs:
- Required environments:
- Required fixtures:
- Human observation required:

## Development return contract

Development owns and returns these factual fields:

- implementation reference;
- development status;
- development-authored notes;
- verification evidence;
- deployment or environment state;
- known implementation risks.

Product Operations must not invent or overwrite those fields.

## Completion gates

- [ ] Development return is present.
- [ ] QA results are linked.
- [ ] Independent QC is linked and not performed by the producer.
- [ ] Human observation is accepted when required.
- [ ] Readiness is recalculated.
- [ ] No secret value or proprietary payload is committed.
