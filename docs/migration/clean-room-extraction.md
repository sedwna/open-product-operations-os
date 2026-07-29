# Clean-room extraction policy

This project may reuse operating concepts, but it must not publish source-product data or history.

## Allowed

- generalized role responsibilities and authority boundaries;
- configurable workflow, lifecycle, ownership, and evidence contracts;
- newly written schemas and automation;
- synthetic examples using reserved domains and fictional identities;
- generic security and recovery patterns.

## Excluded

- source-product names, branding, IDs, cards, decisions, and backlog;
- private repository or spreadsheet URLs and identifiers;
- credentials, cookies, tokens, recovery material, or real test accounts;
- customer or production-derived data;
- product screenshots, evidence, receipts, and internal ledgers;
- local absolute paths, private commit hashes, branches, and pull requests;
- proprietary product rules or competitor research.

## Parameterization checklist

The generated project must control these values from configuration:

```text
product name
human authority roles
development owner
role registry
ID prefixes
workbook tabs and columns
status vocabulary and transitions
repository topology
spreadsheet provider and identifier
timezone and locale
evidence matrix
batch size
human acceptance rules
release and rollback policy
development-owned fields
```

## Required extraction ledger

Every imported concept records:

```text
source concept
public destination
treatment
reviewer
privacy result
license result
verification evidence
```

The ledger describes concepts, not private values. Any item that cannot be safely generalized is
omitted and replaced by a synthetic example.

## Publication rule

A public release is blocked until repository-wide text and binary scans confirm that no
source-product secret, personal data, absolute private path, live spreadsheet identifier, or
proprietary evidence remains.
