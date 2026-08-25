# End-to-end product flow

## 1. Idea and intake

A human or system submits a raw idea, observation, request, or incident. Intake preserves the
source, intent, affected users, urgency, and uncertainty.

Output:

```text
structured idea or feedback record
deduplication result
decision or discovery dependency
```

## 2. Discovery and product decision

The product role gathers context, alternatives, constraints, and expected outcomes. Decisions are
explicitly approved, deferred, rejected, or returned for more discovery.

Output:

```text
decision brief
decision record
scope and priority
measurable success criteria
```

## 3. Product topology and journeys

Approved changes update the map of surfaces, capabilities, actors, permissions, and user journeys.
Any changed row triggers impact analysis for audits, validation, issues, delivery, and readiness.

Output:

```text
updated product map
updated user journeys
audit coverage
downstream impact tasks
```

## 4. Findings, feedback, and issues

Audits and feedback produce traceable findings. A finding is deduplicated, dispositioned, and
promoted to an issue only when action is required.

Output:

```text
finding or feedback record
issue with owner and severity
source and downstream links
```

## 5. Delivery contract

An actionable issue becomes a delivery contract with acceptance criteria, dependencies, affected
surfaces, validation recipe, and ownership boundaries.

Output:

```text
development-ready ticket
implementation dependencies
validation linkage
development adapter payload
```

## 6. Development adapter

The adapter gives an engineering team or development agent only approved delivery work. Development
returns implementation references and changes only development-owned fields.

Output:

```text
implementation reference
development verification
environment availability
known risks
ready-for-retest signal
```

## 7. Validation design and risk preflight

Validation defines scenarios, oracles, device and locale coverage, fixtures, safety constraints, and
required evidence. Risk preflight confirms the environment can execute without unsafe side effects.

Output:

```text
validation plan
test scenarios
rerun manifest
environment and access preflight
```

## 8. QA execution and evidence

Each eligible ticket is executed against a fresh approved build. Every attempt records the exact
scenario, environment, result, decisive evidence, and a human reproduction guide.

Output:

```text
run
result
evidence manifest
screenshots or other decisive artifacts
human step-by-step reproduction guide
```

## 9. Controlled operational update

The semantic owner authorizes a bounded change. A mechanical writer applies it, reads it back, and
proves idempotent replay. Development-owned fields remain outside Product Operations authority.

Output:

```text
mutation manifest
canonical update
live read-back receipt
replay proof
rollback boundary
```

## 10. Independent control and human observation

An independent role reproduces material claims. User-visible QA claims can additionally be checked
by the human product owner using the supplied reproduction guide.

Output:

```text
independent verdict
human observation
corrective task or acceptance
```

## 11. Readiness and release

Rollups are recomputed only from verified upstream state. Release closes when product, development,
validation, live propagation, evidence, and human gates are all satisfied.

## 12. Post-release outcome resolution

After the delivery contract's observation window, the issue owner compares the original problem and
outcome hypothesis with real evidence. A completed release is required but is not itself outcome
evidence. The independent verifier reproduces the material resolution claim.

Output:

```text
resolved, unresolved, or inconclusive disposition
linked release, validation result, observation, evidence, and QC records
corrective event or explicit reopening trigger when the outcome is not resolved
```
