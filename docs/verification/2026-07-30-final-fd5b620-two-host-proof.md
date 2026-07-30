# Final two-host installed-package proof — revision fd5b620

This producer-collected portability proof evaluates the exact implementation
revision `fd5b620138c6be93721f5c1fe02f0709ff5b2d52`. It does not replace
independent quality control and does not authorize a merge, tag, release, or
stability claim.

Earlier receipts remain immutable historical evidence. They are superseded for
release evaluation because the implementation and regression suite changed
after those receipts were produced.

The public-tip source-identity wording in this file was generalized under the
[recorded redaction policy](evidence-supersession-and-redaction.md); no revision,
result, count, or isolation claim changed.

## Isolation contract

Both runs started from public Git history and received no private source-product
repository, Workbook, taskboard, local handoff, durable memory, or chat
transcript.

The Windows run used a fresh public clone. The Linux run used a complete Git
bundle created from the public pull-request head. The Linux container received
only that bundle and a generic read-only proof script.

Every workspace operation used the `product-ops` command installed from the
real npm tarball into a fresh consumer project.

## Results

| Host | Source revision | Tests | Installed command | Generated contract | Forced re-init | Operational preservation | Result |
| --- | --- | ---: | --- | ---: | --- | --- | --- |
| Windows 11 | `fd5b620138c6be93721f5c1fe02f0709ff5b2d52` | 56 passed, 0 failed | `product-ops.cmd` | 13 roles, 23 tabs | PASS | config and `IDEA-20260730-756` preserved exactly once | PASS |
| Docker Linux with Node.js 20 | `fd5b620138c6be93721f5c1fe02f0709ff5b2d52` | 56 passed, 0 failed | `product-ops` | 13 roles, 23 tabs | PASS | config and `IDEA-20260730-757` preserved exactly once | PASS |

The installed command completed help, dry-run initialization, initialization,
validation, forced re-initialization, and final validation on both hosts. The
packed-artifact, portability, and supply-chain checks also passed.

## Receipts

- [Windows final installed-command receipt](2026-07-30-final-fd5b620-windows-installed-cli-receipt.json)
- [Linux final installed-command receipt](2026-07-30-final-fd5b620-linux-installed-cli-receipt.json)

## Remaining gate

An independent verifier who did not produce the package must review this exact
evidence-bearing revision and reproduce the full claim set. Until that verdict
is `PASS`, the package remains at Foundation/Evaluation and must not be merged,
tagged, or released.
