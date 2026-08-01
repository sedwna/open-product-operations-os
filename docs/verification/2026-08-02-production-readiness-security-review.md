# Production-readiness and security review — 2026-08-02

## Scope

This review covered the Product Operations runtime, Development Operations runtime, one-click
onboarding, cross-system synchronization contracts, engineering executors, packaged artifacts, and
GitHub Actions release path. The review inspected 55 repository files and used focused regression
tests, the full project check, supply-chain checks, packed-artifact verification, and cross-host
verification.

The optional Codex Security hosted workbench was opened but could not start because its mandatory
interactive setup has not been completed in the UI. This document therefore records the completed
manual code audit and executable local verification; it does not claim a completed hosted scan.

## Closed findings

1. **Release workflow trust boundary.** Tag publication now passes a release gate that proves the
   tag, package, and changelog versions agree and runs the full, supply-chain, and packed-artifact
   checks before bundles or a permanent release can be published.
2. **Stale action runtimes.** Official GitHub actions are pinned to immutable current revisions,
   removing obsolete Node action-runtime warnings while preserving dependency immutability.
3. **Plan tampering.** Validation deterministically rebuilds each engineering plan from its stored
   request and canonical configuration, then rejects changed gates, workstreams, or dependencies.
4. **Incomplete result provenance.** Completed results now bind the plan digest, every planned
   workstream run digest, the implementation revision, and content-addressed evidence restricted to
   the managed evidence directory.
5. **Unproven cross-system synchronization.** Product export requires a canonical matching human
   approval. Product import requires the source receipt and rechecks the canonical request, plan,
   gate, workstream, revision, and digest relationships.
6. **Executor result confusion and output exhaustion.** Dependency and executor results are schema
   checked and attributed to the exact plan, workstream, role, actor, and status. Standard output
   and error are bounded to one MiB, timeout and limit breaches terminate the child, and settlement
   races are handled once.
7. **Unsafe real-executor activation.** Codex and custom command setup is disabled and dry-run-first.
   Activation requires a passing read-only doctor. Shell interpreters and credential material are
   rejected, environment forwarding is minimal, the Codex preset is ephemeral and schema-bound,
   and external container, VM, or hosted-worker isolation remains mandatory.
8. **Onboarding destination adoption.** New application directories reject links and redirected
   paths, validate a session-bound resume marker, retain a captured filesystem identity throughout
   the run, and stop if the destination is replaced. Existing Git repositories remain unstaged and
   uncommitted.

## Security properties verified

- Product and engineering authorities remain separate and communicate through versioned contracts.
- Dry-run remains the default for state-changing product, engineering, synchronization, and
  executor-configuration paths.
- Database work activates its specialist role and gate, requires migration, backup, rollback,
  recovery, query/index, capacity, security, reliability, testing, documentation, and independent
  verification evidence according to impact.
- Production changes, destructive database operations, credentials, and unresolved risk still
  require external human authorization; this project does not silently grant those capabilities.
- Generated evidence is integrity-protected, but receipts are not cryptographic signatures. A
  deployment that needs non-repudiation should add organization-managed signing and identity.
- Command executors are shell-free but are not an operating-system sandbox. They must run in a
  separately constrained execution environment with no production credentials.

## Verification commands

```text
npm run check
npm run supply-chain
npm run packed:check
npm run cross-host:check
git diff --check
```

The release is acceptable only when all commands above succeed and GitHub branch checks are green.

## External controls still owned by the adopter

- Configure protected branches, required reviewers, environment protection, and least-privilege
  repository tokens in the hosting organization.
- Provide a dedicated isolated executor host and an approved secret manager.
- Provide platform-specific code-signing and macOS notarization identities if trusted native
  launcher signatures are required.
- Provide real database, network, cloud, DNS, observability, privacy, and deployment credentials
  only to the relevant approved environment after human authorization.

