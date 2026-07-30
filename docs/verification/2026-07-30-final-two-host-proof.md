# Final two-host installed-package proof — 2026-07-30

This is producer-collected portability evidence for implementation revision
`06181988ca12035f3e8d8892af0f88a8143618a8`. It does not replace independent
quality control and does not authorize a merge, tag, release, or stability claim.

The receipts from 2026-07-29 remain immutable historical evidence, but they are
superseded for release evaluation because later concurrency and installed-command
regressions changed the implementation and expanded the test suite.

## Isolation contract

Both runs started from public Git history and received no private LinkUp repository,
Workbook, taskboard, local handoff, durable memory, or chat transcript.

The Windows run used a fresh public clone. The Linux run used a complete Git bundle
created from the public pull-request ref because direct GitHub TLS negotiation failed
inside the isolated container. The container received only that public Git bundle and
a generic read-only proof script.

Every workspace operation used the `product-ops` command installed from the real npm
tarball into a fresh consumer project.

## Results

| Host | Test suite | Installed command | Generated contract | Stable forced re-init | Operational preservation | Result |
| --- | ---: | --- | ---: | --- | --- | --- |
| Windows 11 | 46 passed, 0 failed | `product-ops.cmd` | 13 roles, 23 tabs | PASS | config and one synthetic Idea row preserved exactly once | PASS |
| Docker Linux with Node.js 20 | 46 passed, 0 failed | `product-ops` | 13 roles, 23 tabs | PASS | config and one synthetic Idea row preserved exactly once | PASS |

The installed command completed help, dry-run initialization, initialization,
validation, forced re-initialization, and final validation on both hosts. The packed
artifact and supply-chain checks also passed.

The Windows run preserved `IDEA-20260730-618`; the Linux run preserved
`IDEA-20260730-619`. Each identifier occurred exactly once after forced
re-initialization, and each host's configuration hash remained unchanged.

## Receipts

- [Windows installed-command receipt](2026-07-30-windows-installed-cli-receipt.json)
- [Linux installed-command receipt](2026-07-30-linux-installed-cli-receipt.json)

## Remaining gate

An independent verifier who did not produce the package must review the final
evidence-bearing revision and reproduce the complete claim set. Until that verdict
is `PASS`, the package remains at the Foundation/Evaluation stage and must not be
merged, tagged, or released.
