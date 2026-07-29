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

The included initializer performs this sequence:

```text
1. Validate lexical and resolved target paths before each write
2. Create project placeholders from the canonical catalog
3. Generate all 13 role packages with distinct default actor assignments
4. Generate governance ownership routing and communication contracts
5. Generate the task board and first owned task
6. Generate all 23 workbook tabs
7. Generate disabled Git spreadsheet and development adapter placeholders
8. Copy the public schemas into the project
9. Create the first draft discovery event idea and discovery record
10. Leave validation as an explicit read-only command
```

From the repository root, preview and create a project with:

```text
node ./src/cli.js init ./my-product --dry-run
node ./src/cli.js init ./my-product
node ./src/cli.js validate ./my-product
```

Regenerate only the workbook templates with:

```text
node ./src/cli.js generate-workbook ./my-product
```

The initializer is available now, but the package remains a foundation release. The packaged
`templates/config/operating-model.yaml` catalog is canonical; generated project configuration may
assign actors and product context and may add bounded extension tabs, but it cannot remove or
redefine the canonical 13 roles, 23 tabs, protected fields, or separation controls.

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
