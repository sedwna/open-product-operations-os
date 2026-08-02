# Workbook operating model

The workbook is a linked operational model, not a collection of independent sheets. Every tab has:

```text
semantic owner
allowed writers
status vocabulary
row identity
upstream sources
downstream consumers
completion rule
evidence requirement
human gates
```

## Recommended default domains

A default product profile may include:

- product map and capability inventory;
- user journeys and page audits;
- feedback intake, findings, and issues;
- delivery tickets;
- validation plans, scenarios, runs, and results;
- evidence and human observations;
- decisions and roadmap;
- readiness and handoff summaries;
- task log, change history, status guide, and ownership controls.

Names and counts are configurable. The integrity contracts are not.

## Row-change procedure

For every semantic row change:

1. identify the source event and current canonical revision;
2. validate row identity and status transition;
3. calculate affected downstream rows and rollups;
4. obtain any required human authorization;
5. produce one bounded mutation manifest;
6. update canonical state;
7. apply the authorized live change;
8. read back the complete affected record or tab;
9. verify downstream links and rollups;
10. request independent control.

The autonomous cycle materializes its final trail through the same controlled writer. It does not
append CSV text directly. New canonical rows require an absent-record precondition; existing rows
retain field-level old-value preconditions. Both paths produce a dry-run hash, full read-back,
replay-safe receipt, and rollback backup.

`taskboard/tasks.csv` is the sole execution source for task state. `workbook/06-taskboard.csv` is a
synchronous projection written in the same file transaction whenever the canonical taskboard
changes. Project validation rejects any missing task or field-level drift. The workbook projection
is never a second task queue.

Every domain write is also projected into `21-writer-manifests.csv` before execution and into
`22-writer-receipts.csv` after verified read-back. Failure to register the receipt fails the cycle
closed and triggers the controlled rollback path. The audit tabs are semantically owned by the
independent control role; the mechanical writer does not own its own audit history.

`ready` is a hard release state. It requires a real linked release record, an attributed human risk
acceptance, a rollback reference, satisfied gates, and independent verification. Incomplete local
cycles use `conditionally_ready` or `not_ready`; completion of implementation alone is not release
readiness.

## QA atomic record

A completed retest normally requires:

```text
delivery ticket
validation scenario
execution run
validation result
evidence manifest
decisive artifacts
human reproduction guide
ticket status update
related IDs
live read-back receipt
independent verdict
```

A blocked attempt still records its scenario, attempted steps, exact missing precondition, owner,
and safe next action. It does not fabricate a PASS, FAIL, run, or result.

## Development-owned fields

Fields that represent implementation work remain writable only by the configured development
owner. Product Operations records QA observations and related IDs in their own authorized fields or
artifacts. It does not overwrite the development narrative.
