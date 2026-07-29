# Start here

This document is the entry point for a new product owner or a new LLM host.

## The operating model

The system uses three layers:

1. **Product specialists** author meaning: discovery, topology, issues, delivery contracts,
   validation plans, QA results, and readiness.
2. **The control plane** converts events into owned tasks, resolves dependencies, and produces one
   consolidated report.
3. **Independent controls** verify that claimed outputs, evidence, workbook state, and live state
   agree.

Specialists do not coordinate through private chat messages. The task board and versioned
artifacts are the coordination bus.

## A product starts with five inputs

Prepare:

```text
Product name
Product vision
Target users and roles
Deployment environments
Development adapter
```

Optional inputs include an existing application, issue tracker, spreadsheet, design system,
analytics source, and release process.

## Bootstrap sequence

The stable initializer will perform this sequence:

```text
1. Validate the target folder and security boundary
2. Collect product context
3. Select or customize the role registry
4. Generate governance and ownership contracts
5. Generate the task board
6. Generate the product workbook
7. Configure Git and live-spreadsheet adapters
8. Configure the development-agent adapter
9. Run integrity and portability checks
10. Create the first discovery event
```

Until the initializer is released, use the repository templates directly and keep all identifiers,
statuses, roles, and tab names in one configuration source.

## The first event

A raw idea does not become a development ticket immediately.

```text
Idea
→ structured discovery note
→ decision brief
→ explicit human decision
→ impact analysis
→ product topology and journey updates
→ issue or delivery contract
→ validation design
→ development handoff
→ QA execution and evidence
→ controlled operational update
→ independent verification
→ human acceptance when required
→ readiness and release
```

Steps that are not applicable must be recorded as such; they must not simply disappear.

## Human authority

A human decision is required for:

- product direction and priority;
- risk acceptance;
- real-money or provider-backed operations;
- credentials and sensitive access;
- destructive or irreversible actions;
- governance and role-lifecycle changes;
- final human acceptance where the product behavior is user-visible.

Everything else should be automated or prepared as an exact, reviewable artifact.

## Development integration

The core system treats development as an adapter. A development agent or engineering team receives:

```text
approved delivery contract
acceptance criteria
dependencies
evidence
validation recipe
write boundary
expected completion signal
```

It returns:

```text
implementation reference
verification evidence
deployment or environment state
known risks
updated development-owned fields
```

Product Operations roles do not invent development completion or write development-owned notes.

## Completion rule

An event closes only when:

- all required outputs have owners;
- canonical artifacts are committed;
- operational state is updated through an authorized writer;
- live state is read back completely;
- evidence is reproducible;
- an independent role has verified the claims;
- required human acceptance is recorded;
- downstream readiness is recalculated.

