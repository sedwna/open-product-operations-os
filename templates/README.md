# Starter kit templates

This directory is a vendor-neutral starter kit for operating product work from idea to release.
Copy the directory into a new private project, customize the catalog, and keep the resulting
artifacts in that project's canonical repository.

## Start here

1. Customize `config/operating-model.yaml`. It is the only authority for identifiers, statuses,
   role keys, and workbook tab names.
2. Confirm the 13 role boundaries in `governance/role-registry.yaml`. People, teams, or agents may
   fill them. Generated projects require distinct active actor IDs so producer, writer,
   development, and independent-verifier boundaries cannot collapse into one actor.
3. Tailor `governance/ownership-matrix.csv` and `governance/routing-rules.yaml`.
4. Import the CSV files under `workbook/tabs/` into one Google Sheets workbook by following
   `workbook/README.md`.
5. Create the first event with `operations/event-impact-analysis.md`, then open owner-scoped task
   cards.

## Invariants

- Never put credentials, tokens, cookies, private keys, personal data, private URLs, or
  production-derived fixtures in a template, commit, handoff, manifest, receipt, or evidence file.
- Store only an approved secret-store alias when an execution needs runtime access.
- A producer never certifies its own work. Use an independent verifier from a different role
  boundary and, for material claims, a different actor.
- A commit or pull request is not evidence that a live write, deployment, test, or human
  observation happened.
- A result exists only for an executed run. Record blocked, aborted, or not-run work honestly.
- Every cross-system write is bounded by an authorized manifest and a complete read-back receipt.
- Historical records are append-only. Corrections supersede; they do not erase.

## Directory map

| Directory | Purpose |
| --- | --- |
| `config/` | Central identifier, status, role, and tab catalog |
| `governance/` | Authority, role, routing, ownership, and communication contracts |
| `operations/` | Event, taskboard, task card, and handoff templates |
| `product/` | Idea, discovery, decision, issue, and delivery contracts |
| `validation/` | Plans, scenarios, runs, results, evidence, observation, and independent QC |
| `release/` | Readiness and release records |
| `writers/` | Controlled-write authorization and read-back receipts |
| `workbook/` | Google-Sheets-ready tab templates and setup maps |
