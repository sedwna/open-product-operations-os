# Validation run

> Catalog: `../config/operating-model.yaml`

- Run ID: `<identifier_patterns.validation_run>`
- Plan / scenario / ticket IDs:
- Executor role / actor: `RB-09 / <ACTOR_ID>`
- Status: `<statuses.validation_run>`
- Started / ended:
- Environment alias:
- Build or implementation reference:
- Synthetic data set:

## Preflight

- [ ] Scenario was ready before execution.
- [ ] Environment is proven non-production or human authorization for production is linked.
- [ ] Expected outcomes were not changed for this run.
- [ ] Evidence capture is active.
- [ ] No secret value will enter logs, screenshots, manifests, or commits.

## Execution log

| Step | Started at | Actual observation | Evidence item ID | Step disposition |
| --- | --- | --- | --- | --- |
| 1 | `<ISO-8601>` | | `<EVIDENCE_ITEM_ID>` | `<pass|fail|blocked|not_run>` |

## Completion

- Exact interruption or blocker:
- Cleanup performed:
- Residual state:
- Result ID: `<created only when factual run disposition is available>`
- Evidence manifest ID:
- Known limitations:

An aborted, blocked, or partial execution stays explicit. Do not fabricate remaining steps or a
passing result to reconcile counts.
