# BRD-0-149 Windows clean-clone producer correction status

## Scope and authority

- Public pull request: `sedwna/open-product-operations-os#1`
- Branch: `codex/brd-0-121-foundation`
- Independent audit head: `e224428b6fb70a288a0ba73e477a6e0f81664266`
- Independent finding: an ordinary clean Windows clone inheriting
  `core.autocrlf=true` failed package creation because the prepack guard treated legitimate CRLF
  checkout bytes as worktree tamper.
- Producer status: corrective implementation and Windows regression suite prepared
- Independent status: fresh exact-head verification required

This artifact accepts BRD-0-149 as a real remaining blocker and supersedes the clean-clone
portability claim in the BRD-0-141 producer status. It does not rewrite or delete that earlier
evidence, issue an independent `PASS`, modify an owner-controlled taskboard row, authorize merge,
create a tag, or authorize a release.

## Root correction

The package source guard now distinguishes three byte representations:

1. the canonical blob stored in the Git index;
2. the exact bytes Git's current checkout/smudge filter produces for that blob and path;
3. the actual worktree bytes.

Raw worktree bytes are accepted as a platform checkout conversion only when they exactly equal
Git's current checkout-filter output and differ from the canonical blob by EOL conversion alone.
Before npm creates the package, those accepted files are temporarily replaced with their exact Git
blob bytes. A private state file under the Git directory preserves the original checkout bytes.
Postpack restores a file only if it still equals the canonical blob; concurrent or unexpected
changes leave recovery state visible and fail closed.

The guard still rejects:

- content whose bytes do not match the canonical blob or current Git checkout filter;
- stale CRLF retained after an `eol=lf` attributes transition;
- non-EOL smudge/filter transformations;
- concurrent or ambiguous pack normalization;
- postpack restoration over bytes changed during package creation.

## Regression contract

- Unit regressions prove legitimate Git-declared CRLF checkout normalization and exact restoration.
- Existing attributes-transition drift remains rejected.
- A new true-content-tamper regression remains rejected even from a CRLF checkout.
- `scripts/check-clean-clone-pack.mjs` creates a real clean clone using a separate global Git
  configuration with `core.autocrlf=true`, without a per-clone override.
- That regression asserts the clone is Git-clean and that `README.md` is actually CRLF-backed,
  installs locked dependencies, and runs the real `npm run packed:check` path.
- The packed-artifact path creates the npm tarball, checks the repository-controlled SHA-256,
  installs it as a consumer, and exercises help, dry-run, init, validate, force, and final validate.
- The regression finally proves postpack returned the clone to a clean state.

## Producer verification recorded before exact-head CI

- Windows Node.js `v25.9.0`: `npm run check` passed `71/71`.
- Targeted pack-source and package tests passed `9/9`.
- `npm run smoke` passed with 13 roles and 23 tabs.
- `npm run supply-chain` passed with zero audit vulnerabilities, seven licensed packages, seven
  SBOM components, and zero excluded source-identity findings.

These are producer checks on the staged corrective tree. Exact committed-head clean-clone,
clean-Linux, installed-package, cross-host hash, and CI results remain required after this artifact
is committed. They are execution signals, not an independent release disposition.

## Remaining gate

Control Tower/Agent 12 must create fresh proof from the final exact public head and issue the
independent disposition. Until then the repository remains `Foundation / Evaluation`; merge, tag,
release, self-approval, and status promotion remain prohibited.
