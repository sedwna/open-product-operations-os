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

Repository CI can generate and validate a CycloneDX SBOM, audit locked dependencies, and enforce a
dependency-license allowlist without publishing. The SBOM check normalizes the root component from
package metadata, so its identity is independent of the clone or extracted archive directory name.
Those producer checks are necessary evidence, not an independent release verdict or signed-release
proof.
