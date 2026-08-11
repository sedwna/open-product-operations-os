# Changelog

All notable changes to this project will be documented here.

## Unreleased

- Removed every surface the old delivery model left behind: the local HTTP dashboard and its
  writable loopback mode, the HTML setup wizard, the engineering dashboard page, the Codex and
  Claude CLI readiness probes, and the spawned-provider product executors. One delivery model
  remains — the host adopts the operating model over MCP — and one window onto it, the control
  tower panel in the conversation.
- Required a performer for every product agent run. Work is done by whoever the host delegates it
  to; the run function owns the contract around the work, never the doing.
- Stopped routing every event as a queue of one. A route's steps each waited on the step written
  before them, whatever they actually needed, so the board never offered more than one card and
  validation design sat behind the implementation it was supposed to specify. A step now names what
  it waits on by key, and the delivery contract fans out to validation design, risk audit, and
  implementation at once, rejoining at QA. Risk and logic audit is asked on ordinary deliveries for
  the first time; it had only ever appeared on workbook and governance routes, so an idea could
  reach release with nobody having challenged its assumptions. Operating model version 3, with a
  migration that upgrades routes the owner has not touched and leaves edited ones exactly as
  written — see `docs/migration/operating-model-v3.md`.
- Gave a new workspace a Git history at `init`. Exporting an approved delivery contract stamps it
  with the workspace revision, so a workspace without a repository failed the export at the exact
  moment the owner had just authorised crossing into engineering — a prerequisite nobody would think
  to check, discovered at the worst possible point. An existing repository is never touched, a
  missing `git` never fails initialisation, and a machine with no configured Git identity gets a
  named workspace identity with the report saying so. `--no-git` opts out and states what it costs.
- Let a gate carry the decision the owner actually made. A gate holds two things and they were
  being flattened into one: the board needs a binary — does this proceed — but the owner usually has
  more to say than yes. A disposition now records which of the offered options they chose and any
  conditions they attached, in their own words, through the dialog, the panel composer, or the
  conversation. A gate that offered real options refuses a bare yes rather than guessing which one
  was meant. Those conditions then travel with the brief when the work is delegated, so the terms
  that authorised a task reach the team doing it instead of stopping at the approval record.
- Stopped sending the owner to a terminal to settle a gate. When a host cannot open a dialog, the
  refusal now points at the control tower panel's composer and the conversation, which is where the
  decision was always meant to happen.
- Stopped handing out Windows paths that cannot survive being read. A brief's application path is
  read by a subagent, pasted into a shell, and interpolated into tool calls, and a backslash is an
  escape character in almost all of those — `D:\Projects\app` arrives as `D:Projectsapp`. Paths
  reported to a performer now use forward slashes, which Node, Git and PowerShell all accept.
- Told the performer that a failed retrieval is not an absence. The first real product run recorded
  "no performance budget is documented" because one fetch returned a transient error and was never
  retried; the verifier found the budget by simply asking again. Every document downstream had been
  reasoning from a gap that was never there. The brief now carries the rule, and the coordinator's
  standing instructions say to check whether a subagent looked or merely failed to.
- Let a delivery narrow the boundary it may write in. The role that authors delivery contracts has
  always been chartered to `define_write_boundaries`, and there was no field to put one in, so every
  delivery inherited the application's whole policy: a browser game needing five directories was
  handed thirteen, including `database`, `migrations` and `infrastructure`. The coordinator's answer
  was to ask each subagent to stay inside five anyway, which is a request rather than a boundary —
  nothing enforced it and the closing check would have accepted all thirteen. A contract may now
  state its own `writeBoundary.allowedPaths`; it can only narrow the application's policy, and
  naming a path outside it is refused rather than quietly dropped.
- Connected the canonical record to the path owners actually use. When product work was inverted to
  host-delegated execution, closing a cycle stayed behind in the coordinator loop: the delegated
  path completed every card and then told the coordinator to run a scheduling pass to "close the
  cycle", which cannot close anything. So the workbook the whole model rests on — issues, delivery
  tickets, validation scenarios, evidence — was never written. The first real product finished eight
  cards with every content tab empty, and its agent hand-wrote a decision row because no path
  existed. The last card of an event now writes the cycle report and materialises the record.
- Fixed a filename in that record writer that would have taken the cycle down at the moment it
  closed. It looked for `<task>.json` where sealed runs are `<task>-result.json`, so an engineering
  card returning no product-side evidence reference failed with ENOENT after every card was done and
  there was nothing left to retry.
- Gave the coordination boundary its own written record. RB-01 owns events, taskboard and lineage,
  and every one but the taskboard was empty after a full product cycle, because the control plane
  *is* that boundary and was routing work without writing down that it had. Hand-offs are now
  recorded as the chain is laid, not reconstructed later from cards that may since have changed.
- Sent the delivery contract across the boundary instead of the history that produced it. The
  exported request flat-mapped every product card's acceptance criteria in board order and kept the
  first thirty, so on a real product the earliest cards — idea triage, discovery — filled every slot
  with criteria about reviewing documents, and the delivery contract's own criteria were cut off
  below them. It also declared all thirty impact domains unconditionally: the product's declared
  impacts were appended to a list that already contained everything, so they changed nothing. Since
  the planner turns impacts into workstreams, a browser game was dispatched to all fifteen
  engineering teams, including database and infrastructure, to satisfy acceptance criteria about
  document review. The contract now comes from the card that authored it.
- Made bypassing the decision dialog an explicit act rather than an impossible one. A host that
  declares elicitation and never renders a dialog was a dead end: the declaration sent every call
  down the dialog path, the dialog failed, and no second route existed — an owner in that host could
  not settle a gate at all. `dialogUnavailable` now records their relayed words with `model_relayed`
  attribution. It is deliberately explicit, because a silent fallback on any failed dialog would
  also fire when the owner pressed decline, and would record an approval against someone who had
  just refused one.
- Stopped the panel being announced as though it had appeared. Attaching a resource and rendering
  one are different events and only one of them happens where the server can see it; an agent
  reporting "the panel opened" was reporting the attachment. That sent an owner looking for a window
  that was never on their screen, twice.
- Made the crossing gate state its own decision rather than quote the history leading to it.
- Brought the crossing itself into the conversation. Exporting an approved delivery contract to the
  engineering repository and importing the result back were command-line only, held out of the
  model-reachable surface pending their own review. The review's answer: the authority line is not
  crossed by whoever runs the command. It is crossed by the owner settling the gate, and what
  travels is the hashed contract with its `sourceDigest`. Keeping the commands on the command line
  protected nothing — it only meant the owner had to open a terminal at the exact moment they had
  just authorised the crossing. `product_ops_open_delivery` and `product_ops_close_delivery` close
  the last gap between an idea in a chat window and code in a repository.
- Stopped a heartbeat from surrendering a lease nobody took. Under load a beat can fire after the
  term it was meant to extend has lapsed; one transient write failure at that moment condemned a
  lease whose file still named its holder. Displacement is now read from the file rather than
  inferred from our own clock, and renewal reads twice before concluding, the way the write fence
  already did.
- Gave engineering the same host-delegated path the product side already had. The two halves had
  been running on different execution models: a product could be driven all the way to an approved
  delivery contract and then stop dead, because the only way to perform engineering work was to
  spawn a CLI that most owners have not installed. `product_ops_next_engineering_work` and
  `product_ops_submit_engineering_work` hand out and take back a workstream through exactly the
  checks a spawned executor faced — schema, dispatch identity, ENG-15's read-only proof, sealing.
  The boundary between the repositories was never the executor; it is the hashed contract, and it
  is unchanged.
- Kept the Windows `claude.cmd` shim resolution and moved it into the development boundary that
  needs it: running a batch file means running the command interpreter, which stays out of a path
  that takes contract text.
- Renamed the workspace snapshot module to what it is, and dropped the `mode` and `writable`
  fields no reader used.
- Split the control-plane receipt into `advanced` and `awaitingPerformer`, and made both the CLI
  and the MCP surface say plainly when a cycle routed work and nothing performed it. The dashboard's
  cycle button used to report success forever against a board that never moved; the silence that
  allowed that is now impossible in the surfaces that remain.

- Added static analysis over the whole tree, which had none. Rules are listed explicitly rather than
  extended from a preset, so what counts as a defect here changes by decision rather than by
  upgrade. It immediately found six dead bindings and a duplicated import that had been read past
  for months.
- Held the dashboard's escaping with tests. It escaped record text in fourteen places and embedded
  the whole snapshot as JSON inside a script tag, and none of it was pinned — the one surface where
  injected text sits next to a real control had no test saying so.
- Scoped the licence gate to what actually ships. It walked every directory under `node_modules`,
  which was the same set only while the repository had no development dependencies; the first one
  added made it refuse a licence on tooling no consumer installs.
- Made the bill of materials name every shipped dependency and no others. Asking npm to omit the
  development tree silently dropped a production dependency that a development one also required,
  so the lockfile is now the authority for both gates and they are checked against each other.
- Corrected the portability gate, which claimed configurable locales. There is no locale mechanism
  and the interface is Persian throughout. The claim is withdrawn and recorded as an unmet gate: an
  unevidenced claim in the document that governs evidence is worse than the gap it describes.

- Made the panel say where the cycle is stuck, not only how much of it is. A count of blocked cards
  tells the product owner something is wrong without telling them whether it is theirs to fix, so the
  panel now reads the reason and the unblocking condition already recorded on each card, and names
  the team holding it — "who do I talk to" being the owner's usual next question.
- Separated a blockage waiting on the owner from one waiting on a dependency. Both belong on the
  panel, because the owner asked where work is stuck and not only where they are needed, but a
  dependency must not read as another thing demanding their attention.

- Adopted an existing repository completely rather than sampling it. `product_ops_adopt` accounts for
  every path found: each is either assigned to the boundary that must read it or excluded for a named
  reason, and `coverage.complete` goes false the moment that stops adding up. A survey that hit its
  ceiling reports itself as incomplete instead of passing for a full reading.
- Kept surveying and interpreting apart. The survey is mechanical and draws no conclusions; what the
  product is, who it serves, and what is wrong with it come from the teams, one bounded brief at a
  time. A machine's guess about a product and its owner's decision must not end up in the same record
  with nothing to tell them apart.
- Recorded what a repository admits about itself — in-code markers, churn, history, stacks — as
  located facts with their sources, never as graded findings. Grading them would be deciding product
  priority, which is not a survey's job.
- Refused to follow a symbolic link out of the repository while still counting it, so adoption cannot
  quietly pull files from elsewhere on the filesystem into the product record, and ran the whole
  survey through the credential scan before it can become canonical.

- Let the host perform the work. The coordinator loop could only drive a spawned provider CLI, so a
  host whose subagents are its own to start had no way to take part. `product_ops_next_work` hands
  out one team's bounded brief and `product_ops_submit_work` takes the result back, inverting control
  so the host asks for work rather than being handed it.
- Ran both performers through one contract. The submitted result passes the same schema validation,
  the same dispatch-identity check, the same credential scan, and the same sealing as anything a
  provider CLI produced, because it enters through the same function — a delegated subagent gains a
  performer, not an exemption.
- Required a claim issued by the work handout, keyed to the task's status as well as its identity, so
  a task identifier lifted from a record cannot reach the run store and a claim held across a state
  change no longer verifies.
- Kept the development boundary out of the handout. Dispatching engineering work crosses the
  Product/Development authority line, and a chat message is not where that should start.
- Retired the platform launcher delivery path: three graphical launchers with a committed Windows
  executable, the one-click onboarding wizard, the portable Node bootstrap, and the launcher
  integrity gate. The host launches the server now, which is what the architecture document said
  would make them redundant. The prior revision is preserved at tag `v0.8.1-launcher-era`.

- Made the control-plane write lease actually exclusive. It granted a fixed term and never extended
  it, so a holder whose work outlasted the term was judged abandoned while it was still writing and
  the surface that reclaimed it joined it inside the critical section. A healthy holder now keeps its
  term current, and expiry once again means the holder is gone or wedged.
- Stopped a lease being destroyed by the act of reading it. Creating it exclusively was not the same
  as creating it atomically: the file appeared before its contents did, and a contender reading in
  that window saw zero bytes, could not parse them, and reclaimed a live lease as corrupt. The lease
  is now linked into place already complete, and an observation that fails to parse is only believed
  when it survives a second look. A genuinely corrupt lease still does not wedge the control plane.
- Made a displaced holder fail its write rather than race the surface that replaced it. Every
  canonical write now confirms, against the file rather than a cached flag, that the lease is still
  ours; a holder that lost it reports the failure instead of returning a result nobody can vouch for.
- Kept a transient filesystem failure from masquerading as displacement, so a write that was never in
  danger is not refused: a replace or read that fails while the term still has time left is retried
  rather than treated as evidence that someone else owns the lease.

- Made engineering planning put its workstreams on the engineering board. The board is the
  canonical record of what engineering is carrying, and the documented planning path created
  workstreams inside a plan file while leaving the board empty, so work existed that no surface
  could show. Re-planning a request replaces its own rows rather than duplicating them, and rows
  belonging to other requests are preserved.
- Found the linked application through the automation link when no coordinator has run. The
  application root was read only from coordinator state, so a workspace that planned engineering
  work through the CLI reported no engineering side at all.

- Made the control surface live: the server watches the canonical records and notifies subscribers
  when a resource they hold goes stale, and the panel refreshes itself, faster while work is moving
  or a gate is waiting and slower when nothing is.
- Preserved an unsent rationale across a refresh, so a background update cannot discard reasoning
  the owner is halfway through writing.
- Declared resource subscription rather than list-change notification. The set of resources is
  fixed; what changes is their content, and only a resource a client actually subscribed to is
  announced.
- Ignored lease heartbeats and the temporary files an atomic replace leaves behind, and created the
  runtime directories up front, so a fresh project reports approval and cycle changes instead of
  silently watching nothing until the server restarts.

- Gave every product boundary a team name and a line describing what it does, so the panel shows an
  organisation a product owner can supervise rather than the role codes that identify contracts.
- Added the hand-off chain for the cycle in flight, both teams with what each is carrying, and task
  status in the reader's vocabulary rather than the storage vocabulary.
- Turned each gate card into a composer: the owner writes their reasoning and chooses, and a
  disposition without reasoning is refused. Decisions carry one of three distinct attributions —
  entered in the host dialog, composed in the panel, or relayed by a model — so provenance stays
  legible instead of being flattened into one claim.
- Added a coordinator brief and a setup walkthrough as prompts, so the agent running the workspace
  knows it is driving two teams for the product owner, reports diagnosed problems rather than
  status, and never adopts an existing application repository without being asked.

- Added the control tower as an MCP App: a self-contained interactive panel the host renders inside
  the conversation, showing the current phase, task counts, open risks, and the gates waiting on the
  product owner, with a control that puts a gate to them.
- Kept the panel a view rather than an authority. Its button opens the same human dialog the decide
  tool uses and supplies no disposition, actor, or rationale of its own, so a nicer surface cannot
  become a way for a model to decide.
- Made the panel self-contained with no external origin, script, or stylesheet, so a strict host
  sandbox can render it, and unwrapped the untrusted-record envelope for the reader while still
  escaping the record text underneath it.

- Added the human-authority tier to the MCP control surface. A pending gate is put to the product
  owner through the host's own dialog, and the disposition, deciding actor, and rationale are
  collected from the person rather than supplied by the model. Where a dialog is available, a model
  attempting to steer the outcome through tool arguments has no effect on what is recorded.
- Required a decision token issued by the pending-decisions listing, so a fabricated or guessed
  request identifier cannot reach the approval store, and kept the existing server-side check that
  rejects any actor other than the configured human authority.
- Made declining, cancelling, timing out, or answering a dialog incompletely leave the gate open
  with nothing recorded, and labelled the compatibility path for hosts without dialog support as
  model-relayed rather than presenting it as the owner's own words.
- Added server-to-client request support to the stdio transport, which the dialog path needs, with
  the disposition settled before any write lease is taken so a pending dialog cannot block the
  other local surfaces for as long as a person takes to answer.

- Added the planning tier to the MCP control surface: recording product intake, running one bounded
  control-plane cycle, and controlling the local autonomous coordinator. These tools are registered
  only under explicit write authorisation, so a read-only server still has no reachable mutation
  path, and they plan by default rather than writing.
- Kept autonomous-cycle authorisation an explicit opt-in on intake, so submitting an idea through a
  chat window cannot silently start engineering work, and excluded development dispatch from the
  surface entirely.
- Made the coordinator controls report whether a coordinator process is actually running, and state
  that pausing is cooperative, so a caller cannot mistake a durable state change for a stopped
  cycle.
- Brought intake deduplication under the write lease; it read the store, decided, and wrote it back
  without one, so a concurrent surface could record the same idea twice under different events.

- Added a shared control-plane write lease so the CLI, the local dashboard, the autonomous
  coordinator, and the MCP surface can no longer interleave writes to the canonical task board or
  the approval store. Guarding the two write chokepoints covers every surface at once and leaves no
  bypass for a future caller.
- Held the lease across the read-modify-write sequences that need it, so one scheduling cycle is a
  transaction and a single human gate can only ever receive one disposition.
- Made a refusal name the surface that holds the write authority, reclaim a lease whose holder
  process is gone, tolerate a corrupt lease file, and wait briefly before refusing so ordinary
  near-simultaneous writes do not fail spuriously.

- Added a read-only Model Context Protocol control surface (`product-ops-mcp`) so Claude Code,
  Claude Desktop, the ChatGPT desktop app, Codex CLI, and compliant IDEs can report product-cycle
  state, pending human gates, task detail, evidence, readiness, and validation findings directly
  from the project's canonical records.
- Bound the server to a single project root supplied at launch and refused any tool argument that
  names a filesystem path, so record-authored text cannot redirect the surface at another directory.
- Made read-only the default posture: the planning and human-authority tiers are not registered at
  all unless the operator passes an explicit write-authorisation flag.
- Wrapped every record-authored string returned by a tool or resource in a neutralised
  `<untrusted-record>` envelope that injected text cannot close early.
- Bounded the status projection to a guaranteed byte ceiling with a fixed degradation order, and
  moved bulk history to on-demand `productops://` resources.
- Implemented the newline-delimited JSON-RPC stdio transport in-repository rather than adding a
  seventeen-dependency SDK to a four-dependency package.
- Documented the control surface architecture and its implementation contract, including the
  elicitation-based design for the human-authority tier that follows in a later phase.

## 0.8.1 - 2026-08-02

- Made release readiness fail closed unless risk acceptance, rollback planning, and a real linked
  release record are present, and connected every advanced issue and delivery ticket to an
  attributed, approved product decision.
- Replaced inferred engineering verification with an explicit independent-verifier disposition and
  narrowed every quality-gate evidence package to its relevant owner workstream plus verification.
- Made the canonical task board and workbook projection update atomically, validated them
  field-for-field, and populated independent writer-manifest and writer-receipt audit projections.
- Separated transient infrastructure retries from logical execution attempts with bounded backoff,
  centralized shared automation helpers, and added regression coverage for all reported failures.
- Added real browser behavior tests and a single shared task-domain implementation to generated
  products, eliminating duplicated UI and service business logic.

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
