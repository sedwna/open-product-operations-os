# Validation plan

> Catalog: `../config/operating-model.yaml`

- Plan ID: `<identifier_patterns.validation_plan>`
- Event / decision / issue / ticket IDs:
- Design owner role / actor: `RB-07 / <ACTOR_ID>`
- Execution owner role / actor: `RB-09 / <ACTOR_ID>`
- Independent verifier role / actor: `RB-12 / <DISTINCT_ACTOR_ID>`
- Status: `<statuses.validation_plan>`
- Risk:

## Objective

- Claims under test:
- Out of scope:
- Entry criteria:
- Exit criteria:
- Stop conditions:
- Risk-proportional depth: `<focused|cross-boundary|high-assurance>`
- Smallest runnable check for non-trivial changed logic:
- Quality-floor checks: `<trust boundary; data loss; security; accessibility; explicit acceptance>`
- Checks deliberately omitted because they cannot change the disposition:

## Coverage

| Scenario ID | Claim / AC IDs | Test level | Environment alias | Data set | Human observation |
| --- | --- | --- | --- | --- | --- |
| `<identifier_patterns.validation_scenario>` | `<ID_LIST>` | `<unit|integration|system|journey|control>` | `<NON_SECRET_ALIAS>` | `<SYNTHETIC_DATASET>` | `<required/not_required>` |

## Data and environment readiness

- Synthetic fixture definition:
- Reset and cleanup:
- Non-production proof:
- Secret-store alias, if unavoidable: `<store://approved-store/alias OR none>`
- Refusal conditions:

## Evidence contract

- Required evidence types:
- Decisive artifacts:
- Capture method:
- Integrity method:
- Retention:
- Redaction:

## Independence and gates

- Producer actor ID:
- Verifier actor ID: `<must differ>`
- Human authorization required:
- Risk acceptance required:

## Run readiness

- [ ] Expected outcomes are fixed before execution.
- [ ] Scenarios map to claims or acceptance criteria.
- [ ] Fixture is synthetic and environment is unambiguously non-production.
- [ ] Runtime secret values are absent from committed records.
- [ ] Evidence capture and cleanup are reproducible.
- [ ] Independent verifier is not the producer.
