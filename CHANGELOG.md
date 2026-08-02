# Changelog

All notable changes to this project will be documented here.

## Unreleased

- Added Claude Code as a first-class automation provider alongside Codex for product analysis,
  all 15 engineering boundaries, independent verification, and the continuous local cycle.
- Added provider-native installation, executable-health and authentication checks, explicit
  Codex/Claude selection, and deterministic automatic fallback to an already authenticated CLI.
- Added schema-bound, non-persistent Claude Code execution with role-specific tool permissions,
  shell-free Windows launcher resolution, bounded output, and credential-free persisted status.
- Updated one-click onboarding and the RTL Automation Center to show both providers and the actual
  provider linked to product and engineering agents.
- Added integration and package tests covering Claude readiness, provider fallback, structured
  output extraction, verifier restrictions, Product/Development linking, and public artifacts.

## 0.8.0 - 2026-08-02

- Implemented the complete resumable idea-to-product-to-engineering-to-product loop with an
  exclusive renewable lease, durable events, bounded retries, cooperative pause/resume, and safe
  recovery of interrupted tasks.
- Added schema-bound, read-only Codex product agents for every product role outside the development
  boundary, plus concise cross-cycle context for feedback and correction loops.
- Added automatic hashed Product-to-Development export, dependency-ordered execution across all 15
  engineering boundaries, final write-boundary enforcement, an `ENG-15` read-only verifier, sealed
  workstream results, separate Git branches, and automatic commits.
- Added content-addressed engineering evidence synchronization back into Product Operations so QA,
  verification, readiness, and reporting roles can inspect the returned proof.
- Added safe canonical-row insertion to the controlled local workbook writer and automatic cycle
  materialization across events, ideas, discovery, issues, delivery, validation, evidence, quality,
  readiness, and lineage tabs with dry-run hashes, read-back receipts, replay safety, and rollback
  backups.
- Added a live Automation Center with the active phase, role, task, retry/error state, event history,
  local start, pause, resume, and retry controls, plus the durable final report in the dashboard.
- Removed Windows command-interpreter exposure from Codex execution, rejected custom batch
  executors, kept read-only dashboards non-mutating, and prevented concurrent manual/continuous
  routing of the same task board.
- Made one-click Codex onboarding create the Product/Development automation link, authorize only the
  submitted local cycle, start the continuous coordinator, and keep production, destructive data,
  spending, credentials, and external publication behind separate human gates.
- Added end-to-end tests proving the autonomous cycle, workbook trail, Git history, durable report,
  exclusive/stale lease behavior, schema validity, and generated-project validation.

## 0.7.0 - 2026-08-02

- Added a multi-state Codex readiness probe that distinguishes installation, executable health,
  authentication, and actual automation readiness without persisting credentials.
- Added explicit one-click Codex automation controls with official CLI installation, browser login,
  and activation of all 15 bounded engineering executors only after readiness passes.
- Added a credential-free automation status record and an RTL Automation Center that tells users
  exactly what is configured, what can execute, and whether continuous task claiming is active.
- Forwarded only the profile-location environment names required for Codex to reuse its external
  authenticated session while retaining the external-isolation contract.
- Documented the Autonomous Product Factory architecture, durable queue and lease model, automatic
  Product-to-Development bridge, safety boundaries, and staged delivery plan.
- Added regression coverage for unusable desktop aliases, missing login, authenticated providers,
  guarded executor activation, and dashboard-visible orchestration boundaries.

## 0.6.2 - 2026-08-02

- Returned safe, actionable validation errors from the graphical onboarding API instead of hiding
  them behind a generic stop message.
- Kept the wizard answers available when submission is rejected and added an in-page recovery path
  for correcting and retrying failed setup runs.
- Added regression coverage proving invalid answers do not start or poison an onboarding session.

## 0.6.1 - 2026-08-02

- Fixed downloaded one-click bundles closing immediately because runtime dependencies were absent.
- Bundled the exact locked production dependencies in Windows, macOS, and Linux releases and added
  a lockfile-bound first-launch repair path when dependencies are missing or stale.
- Added clean-bundle launcher checks that start and close the onboarding server before publication.
- Kept Windows launcher failures visible through a persistent diagnostic message and fixed direct
  local compilation of the Windows executable.

## 0.6.0 - 2026-08-02

- Added dry-run-first Codex and custom-command executor setup for all 15 engineering roles, with a
  read-only doctor, schema-bound output, minimal environment forwarding, disabled defaults, and
  mandatory external isolation guidance.
- Made Development OS plans deterministically tamper-evident across roles, gates, workstreams, and
  dependencies, including bilingual inference for database, security, frontend, backend, network,
  SEO, reliability, accessibility, and other engineering impacts.
- Bound completed engineering results to the canonical plan, every attributed workstream run,
  content-addressed evidence, implementation revision, quality gates, and independent verification.
- Required canonical human approval before Product-to-Development export and a matching transfer
  receipt before Development-to-Product import.
- Hardened command execution with bounded output, deterministic timeout settlement, exact result
  attribution, and schema-validated dependency results.
- Hardened graphical onboarding against link traversal, forged resume markers, and destination
  replacement while preserving existing repositories and initializing Development OS only under
  the documented rules.
- Upgraded immutable official GitHub Action pins and added a tag/version/package/changelog release
  gate before cross-platform launcher publication.
- Added a repository-wide production-readiness security review and expanded focused regression
  coverage for executor activation, plan integrity, evidence containment, synchronization, and
  onboarding safety.

## 0.5.0 - 2026-08-01

- Added an independently initializable Open Development Operations OS with 15 engineering role
  boundaries spanning architecture, frontend, backend, clients, database and storage, data and AI,
  platform and network, security and privacy, QA, SRE, delivery, SEO, documentation, and independent
  verification.
- Added versioned Product-to-Development and Development-to-Product contracts, SHA-256 source
  digests, durable synchronization receipts, deterministic multi-discipline planning, explicit
  write boundaries, risk classification, and fail-closed independent-result validation.
- Added 15 engineering quality gates covering architecture, review, automated tests, security,
  supply chain, database, API compatibility, infrastructure/network, privacy/compliance,
  accessibility, performance, reliability, SEO, documentation, and independent verification.

- Added a five-step Persian RTL graphical onboarding wizard that creates or connects the product
  repositories, captures the product definition and first idea, runs the initial cycle, validates
  the workspace, and opens the live dashboard.
- Added one-click Windows, macOS, and Linux launchers with a no-admin portable Node.js fallback,
  official SHA-256 verification, safe resume rules, independent Git initialization, and automated
  cross-platform launcher bundles.
- Replaced the static dashboard with a responsive interactive RTL product-owner control tower for
  tasks, approvals, intake, risks, evidence, readiness, roles, search, filters, details, theme, and
  local export.
- Added a loopback-only live dashboard server with read-only defaults, explicit write enablement,
  per-session request authorization, bounded JSON input, and safe intake, decision, and control-
  plane actions.
- Added a fictional public dashboard demonstration, bespoke social-preview artwork, animated
  workflow graphic, and a complete readability-focused redesign of the primary project guides.
- Added an executable control-plane cycle that evaluates dependencies, human gates, intake routes,
  and development dispatches while retaining dry-run defaults.
- Added the RB-13 command-agent runner with structured inputs, schema-validated returns, optional
  clean Git branch preparation, bounded environment forwarding, and durable local receipts.
- Added durable human approvals, normalized deduplicating intake, operational metrics, a local RTL
  dashboard, and a browser-based configuration-answer wizard.
- Added disabled-by-default provider catalogs and a generic HTTPS outbox for GitHub, GitLab, Jira,
  Linear, Azure DevOps, Google Sheets, Microsoft Graph workbooks, and Airtable.
- Added model-version migrations with pre-migration snapshots and forced-scaffold refresh that
  preserves operational CSV rows.
- Added five runtime schemas and end-to-end runtime regression coverage.

- Made npm packing deterministic from ordinary `core.autocrlf=true` clean clones while preserving
  fail-closed content-tamper and attributes-transition detection.
- Canonicalized promised text payloads from no-Git source archives with fail-closed concurrent
  recovery and exact Windows-clone/Linux-archive byte-parity regressions.
- Unified initialization around the canonical 13-role and 23-tab catalog.
- Added resolved-path link and junction containment before every write.
- Made forced workbook refresh preserve operational rows and bounded schema extensions.
- Preserved valid operational configuration during forced initialization.
- Rejected hard-linked write targets and made local write/receipt handling rollback-safe.
- Added full workbook record validation, duplicate-key controls, and UTF-16 secret scanning.
- Enforced runtime schemas, actor separation, field authority, manifest controls, and date formats.
- Added whole-target text, binary, secret, personal-data, and private-path validation.
- Added a dry-run-gated local CSV writer with read-back, replay receipts, and guarded rollback.
- Added portable evidence hashing, locked dependencies, macOS and Windows CI, SBOM, audit, and
  license checks.
- Completed the generalized clean-room extraction ledger and npm package payload metadata.
- Pinned CI actions to immutable commits and added checks executed from the installed npm tarball.
- Established the public foundation and security boundary.
- Added initial architecture and lifecycle documentation.
- Added release gates and clean-room extraction policy.
- Began the configurable initializer, schemas, templates, example, tests, and continuous checks.
