# VPL-20260729-001 — Weekly summary day validation

- Status: `complete`
- Design owner: `RB-07 / actor.validation`
- Executor: `RB-09 / actor.qa`
- Independent verifier: `RB-12 / actor.verifier`
- Event / ticket: `EVT-20260729-001` / `TKT-20260729-001`

Objective: Reproduce all three acceptance criteria in the `local-demo` environment using synthetic
workspace `pine-demo-01`.

Entry criteria: fictional implementation reference `dev-ref/fictional-42` is returned; expected
outcomes are fixed; local-demo reset is available.

Exit criteria: all steps execute, evidence is captured, the human observes Friday after save, and
independent QC reproduces the decisive claims.

Stop conditions: any non-local environment, ambiguous data source, missing reset, or request for a
credential.

Scenario: `VSC-20260729-001`. No secret-store alias is required.
