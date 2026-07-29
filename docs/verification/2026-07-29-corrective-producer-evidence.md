# Corrective producer evidence — 2026-07-29

This is producer-run implementation evidence for corrective work after the independent review of
public revision `e49bdefc0fb13f9a3f2520e41b3cbf40a05a6a37`. It is not independent QC, cross-host proof,
a signed release, or release authorization.

## Scope completed in the public repository

- resolved-path link, junction, and redirected-ancestor rejection before planned and actual writes;
- operational CSV row preservation during forced scaffold refresh;
- one canonical 13-role and 23-tab catalog used by blank initialization;
- generated role packages, governance, schemas, taskboard, and first discovery event;
- runtime schema and date-time validation plus protected-field, authorization, environment,
  precondition, dry-run, read-back, replay, rollback, and actor-separation enforcement;
- complete bounded-target text and binary inventory with explicit `.git` and `node_modules`
  exclusions;
- LF and canonical evidence hash contract;
- complete npm payload metadata and contents;
- locked, advisory-free dependencies plus SBOM and license checks;
- Linux, Windows, and macOS CI configuration;
- generalized clean-room extraction ledger and aligned Foundation-stage documentation.

## Producer verification

Environment: Microsoft Windows NT 10.0.26200.0, Node.js 25.9.0, npm 11.12.1.

| Command or control | Result |
| --- | --- |
| `npm run check` | PASS: syntax, full test suite, and portability |
| `npm run smoke` | PASS: clean init, validate, stable re-init, 13 roles, 23 tabs |
| `npm run supply-chain` | PASS: audit zero vulnerabilities, seven dependency licenses, CycloneDX SBOM with seven components |
| `node ./src/cli.js --help` | PASS |
| `npm pack --dry-run --json` | PASS: package includes source, seven schemas, templates, examples, and docs |
| `git diff --check` | PASS |
| focused negative controls | PASS: linked child and linked ancestor, row preservation, protected field, collapsed actors, unsafe manifest, whole-tree text/binary canaries |
| controlled local writer | PASS: dry-run plan hash, owner/precondition checks, complete read-back, zero-write replay, guarded rollback |

## Remaining external gates

- A fresh independent verifier must inspect the pushed revision and issue the release verdict.
- Two-host Git-only resume evidence is not produced here.
- No signed tag or release is created.
- No PR is merged and no package is published.
- Any upstream private task reconciliation remains outside this public-repository change.
