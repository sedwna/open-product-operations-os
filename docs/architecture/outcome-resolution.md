# Ready to resolved

Implementation, release readiness, release, and problem resolution are different claims. The OS
keeps them separate so an agent cannot turn delivery activity into a claim about user value.

## The four states

| State | Minimum proof | Canonical home |
| --- | --- | --- |
| `implemented` | Bounded engineering result and technical evidence returned | Development result and Delivery Ticket |
| `release_ready` | Product gates, rollback, risk, human authority, and independent verification pass | Readiness |
| `released` | Authorized release and health checks complete | Release and Delivery Ticket |
| `resolved` | Declared post-release outcome occurred inside the observation window | Issue closure plus linked Observation, Evidence, Result, and QC |

The first three say what the organization delivered. Only `resolved` says what changed for the user
or operation.

## Four lenses for a resolution claim

### 1. User outcome

- The original need and expected next behavior are stated before build.
- Post-release evidence shows the intended user or operational outcome, not merely clicks or output.
- A user need not return when successful use naturally ends the need; use the expected next behavior
  appropriate to the product.
- Leaving the product is acceptable only for a necessary final step declared in the contract.
- First-use comprehension is tested with intended users and accessibility requirements, not an
  undefined claim that the feature is "for everyone."

### 2. Engineering envelope

- The delivery contract declares workload dimensions that can break the feature: concurrency,
  request rate, records per run, job frequency, storage growth, latency, error rate, or recovery.
- Validation tests that envelope and records the known ceiling and expansion trigger.
- Abuse and smart-user gaming scenarios cover the actual trust and incentive boundaries.
- `5,000 users` may be useful for a particular product, but it is never a universal proxy for load.

### 3. Complete critical product logic

- Every critical in-scope rule maps to an acceptance claim and is implemented.
- Non-critical deferrals are explicit and name an owner, known ceiling, and observable reopen trigger.
- A percentage such as 90% is not evidence: it hides which 10% is missing and encourages false
  precision. The rule is 100% of critical in-scope logic, with non-critical deferrals visible.
- Future ideas and decorative enhancements do not block resolution.

### 4. Human–AI decision authority

- One project-level matrix assigns each decision class to human-only, AI recommendation, bounded AI
  action, or mechanical autonomy.
- At onboarding or a material governance change, the AI proposes 20 product-specific decision
  statements. The owner scores each from 1–20 for alignment and the matrix is updated.
- The exercise is not repeated per feature. A material disagreement or authority-boundary change
  returns to the human; ordinary work follows the recorded matrix.

## Resolution rule

An Issue may close with `closure_disposition=resolved` only when all applicable evidence exists:

1. every linked Delivery Ticket is `released`;
2. a completed Release links the issue's delivered ticket set;
3. linked Validation Results pass;
4. an accepted post-release Human Observation records expected and observed behavior;
5. evidence references are present;
6. the observation's independent QC disposition passes.

If the window ends without enough evidence, use `unresolved` or `inconclusive` in the outcome record
and open a bounded corrective event when action is justified. An administrative close such as
duplicate, superseded, or not pursued remains allowed, but it is not resolution.

## Why this does not add another operating layer

The model reuses Issue, Delivery Ticket, Validation Plan, Result, Observation, Evidence, QC,
Readiness, and Release. No new role, workbook tab, service, or universal gate is required. Add more
instrumentation only when the approved outcome cannot be observed with current evidence and the
cost is justified by the decision it enables.
