# Corrective producer evidence — 2026-07-29

This is producer-run implementation evidence for corrective work after the independent review of
public revision `e49bdefc0fb13f9a3f2520e41b3cbf40a05a6a37`. It is not independent QC, cross-host proof,
a signed release, or release authorization.

## Scope completed in the public repository

- resolved-path link, junction, and redirected-ancestor rejection before planned and actual writes;
- hard-link rejection for existing scaffold and controlled-writer targets;
- operational CSV row preservation during forced scaffold refresh;
- byte-preservation of valid existing configuration during forced initialization;
- one canonical 13-role and 23-tab catalog used by blank initialization;
- generated role packages, governance, schemas, taskboard, and first discovery event;
- runtime schema and date-time validation plus protected-field, authorization, environment,
  precondition, dry-run, read-back, replay, rollback, and actor-separation enforcement;
- full workbook row-width, unique-key, identity, lifecycle, status, actor-attribution, and
  protected-value validation;
- rollback-safe target/receipt staging with receipt-bound replay proof;
- complete bounded-target text and binary inventory with explicit `.git` and `node_modules`
  exclusions and UTF-16LE/UTF-16BE canary decoding;
- LF and canonical evidence hash contract;
- complete npm payload metadata and contents;
- locked, advisory-free dependencies plus SBOM and license checks;
- Linux, Windows, and macOS CI configuration;
- immutable GitHub Action commit pins and installed-tarball checks;
- generalized clean-room extraction ledger and aligned Foundation-stage documentation.

## Producer verification

Environment: Microsoft Windows NT 10.0.26200.0, Node.js 25.9.0, npm 11.12.1.

| Command or control | Result |
| --- | --- |
| `npm run check` | PASS: syntax, 32 tests, and portability |
| `npm run smoke` | PASS: clean init, validate, stable re-init, 13 roles, 23 tabs |
| `npm run supply-chain` | PASS: audit zero vulnerabilities, seven dependency licenses, CycloneDX SBOM with seven components |
| `node ./src/cli.js --help` | PASS |
| `npm pack --dry-run --json` | PASS: package includes source, seven schemas, templates, examples, docs, tests, `.gitattributes`, and publishable shrinkwrap |
| `npm run packed:check` | PASS: installed tarball passes tests, smoke, portability, license, and SBOM checks |
| `git diff --check` | PASS |
| focused negative controls | PASS: links/junctions/hard links, config and row preservation, malformed/duplicate records, inactive/extra roles, protected values, collapsed actors, unsafe manifest, UTF-16 and whole-tree canaries |
| controlled local writer | PASS: dry-run plan hash, exact-key/precondition checks, complete read-back, validated-receipt replay, post-mutation failure recovery, guarded rollback |

## Remaining external gates

- A fresh independent verifier must inspect the pushed revision and issue the release verdict.
- Two-host Git-only resume evidence is not produced here.
- No signed tag or release is created.
- No PR is merged and no package is published.
- Any upstream private task reconciliation remains outside this public-repository change.
