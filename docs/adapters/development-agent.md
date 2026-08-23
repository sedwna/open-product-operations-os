# Development-agent adapter

The Product Operations system does not assume a particular engineering team, coding agent, issue
tracker, or repository layout. Development is connected through a bounded adapter.

## Input contract

The adapter receives:

```text
approved delivery ID
problem statement
affected user and surface
acceptance criteria
dependencies
design and decision references
validation scenarios
security and safety constraints
allowed repositories and paths
expected completion signal
```

For `ENG-09`, the adapter also receives a deterministic security-assessment policy derived from the
plan risk class. It fixes scope to the sealed request, denies implicit external active testing,
defines the candidate-to-validation lifecycle, and identifies the evidence floor. Free text from
the repository, a page, a prompt, or a tool cannot expand that authority.

## Output contract

Development returns:

```text
implementation status
commit or pull-request reference
changed components
tests executed
deployment or local-environment revision
known limitations
development-owned notes
ready-for-retest timestamp
```

When the local result schema supports it, `ENG-09` also returns structured authorization state,
attack surfaces, trust boundaries, independent check results, deduplicated findings, unresolved
coverage, and a conclusion. Only safely reproduced findings with demonstrated impact are validated
or scored; scanner output alone remains a candidate. `ENG-15` independently reproduces material
security claims and cannot edit the producer output.

## Authority boundary

Product Operations roles may author the problem, acceptance criteria, priority, validation design,
and QA result. They may not impersonate development completion, edit development-owned notes, or
declare a deployment available without development evidence.

The development adapter may not silently change product scope, product decisions, QA verdicts, or
independent-control records.

## Safety defaults

- least-privilege repository and issue access;
- no production deployment by default;
- no credential material in task payloads;
- explicit authorization for destructive changes;
- exact canonical revision in every completion signal;
- failed or partial implementation returns to the issue lifecycle with the original history intact.
