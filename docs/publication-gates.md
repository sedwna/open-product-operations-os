# Public release gates

Open Product Operations OS remains an evaluation package until every applicable gate is evidenced.
A green build alone is not a release decision.

## Beta gates

| Gate | Required proof |
| --- | --- |
| Legal | License and third-party attribution approved |
| Clean room | Source-to-target extraction ledger complete |
| Privacy | Secret, personal-data, path, URL, and image scan reports zero source-product leakage |
| Portability | Product names, IDs, roles, tabs, statuses, locales, and repositories are configurable |
| Contracts | Configuration and artifact schemas validate |
| Bootstrap | Blank-project initialization and repeat execution are idempotent |
| Safety | Writers default to dry-run and prove scope, read-back, replay, and rollback |
| Ownership | Development-owned and human-owned fields cannot be written by Product Operations roles |
| Example | A synthetic product completes the full lifecycle |
| Platforms | Windows, Linux, and macOS checks pass |
| Hosts | At least two LLM hosts can resume from repository state without chat replay |
| Documentation | Internal links, examples, and start instructions pass |
| Supply chain | Dependency, license, and software-bill-of-materials checks pass |
| Independent QC | A verifier who did not produce the package returns PASS |
| Release | Signed beta tag and release notes are published |

## Stable release gates

Stable version 1.0 additionally requires:

- two independent pilot products;
- documented configuration migration and rollback;
- no critical security, ownership, or data-integrity gaps;
- compatibility policy and upgrade guide;
- a private security-reporting channel;
- signed release artifacts.

## Verdict vocabulary

```text
FOUNDATION
BETA CANDIDATE
BETA
STABLE CANDIDATE
STABLE
BLOCKED
```

Only an independent release-control role may promote a candidate after inspecting the required
proof. Producers may report readiness but may not certify their own output.

## Current evidence

- BRD-0-149 cross-host packed-artifact follow-up:
  [current branch](verification/2026-07-30-brd-0-149-cross-host-follow-up-status.md)
- BRD-0-149 Windows clean-clone producer correction status:
  [historical / cross-host hash claim superseded](verification/2026-07-30-brd-0-149-producer-correction-status.md)
- BRD-0-141 producer correction status:
  [historical / portability claim superseded](verification/2026-07-30-brd-0-141-producer-correction-status.md)
- Latest completed two-host installed-package producer proof:
  [fd5b620 / 56 tests](verification/2026-07-30-final-fd5b620-two-host-proof.md)
- Corrective producer evidence:
  [2026-07-29](verification/2026-07-29-corrective-producer-evidence.md)
- Evidence supersession and public redaction policy:
  [current chain](verification/evidence-supersession-and-redaction.md)

The 39-test and 46-test proofs remain historical and superseded; the 56-test proof is the latest
completed producer proof for its exact prior implementation. Independent BRD-0-149 evidence
supersedes the clean-clone portability claim made by the BRD-0-141 producer status at `e224428`.
The first BRD-0-149 producer correction at `cc391dc` then exposed a Windows/Linux packed-artifact
SHA mismatch; the cross-host follow-up supersedes that producer hash claim. The current corrective
branch requires fresh exact-head proof. These links do not mark Independent QC, Release, or Stable
gates as passed.

Repository CI can generate and validate a CycloneDX SBOM, audit locked dependencies, and enforce a
dependency-license allowlist without publishing. The SBOM check normalizes the root component from
package metadata, so its identity is independent of the clone or extracted archive directory name.
Those producer checks are necessary evidence, not an independent release verdict or signed-release
proof.
