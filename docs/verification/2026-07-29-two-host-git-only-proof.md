# Two-host Git-only resume proof — 2026-07-29

This is producer-collected portability evidence for public revision
`11e1c0ef7d03d20c06c6e9bbb8ded871475af8a6`. It does not replace independent
quality control and does not authorize a release.

## Isolation contract

Both runs started from a fresh clone of the public repository. Neither run received a private
product repository, workbook, taskboard, local handoff, durable memory, or chat transcript.

## Results

| Host | Test suite | Generated contract | Stable re-init | Operational preservation | Result |
| --- | ---: | ---: | --- | --- | --- |
| Windows with Codex CLI | 39 passed, 0 failed | 13 roles, 23 tabs | PASS | config and synthetic Idea row preserved | PASS |
| Docker Linux with Node.js 20 | 39 passed, 0 failed | 13 roles, 23 tabs | PASS | config and synthetic Idea row preserved | PASS |

The configuration hash remained identical before and after forced re-initialization on both
hosts:

```text
bb05b2ef9d77f3c734aff07536c7584b5a9363508616dc611d476a256ca107ad
```

The Windows run preserved `IDEA-20260729-994`; the isolated Linux run preserved
`IDEA-20260729-993`. Each identifier occurred exactly once after re-initialization.

## Receipts

- [Windows Codex receipt](2026-07-29-codex-windows-git-only-receipt.json)
- [Docker Linux receipt](2026-07-29-docker-linux-git-only-receipt.json)

## Remaining gate

A verifier who did not produce the package must inspect this exact evidence-bearing revision and
return an independent verdict. Until that verdict and the remaining publication gates are
complete, the package remains at the Foundation stage.
