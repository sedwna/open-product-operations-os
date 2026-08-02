# One-click onboarding

The graphical onboarding path turns a fresh clone into a ready Product Operations and Development
Operations workspace without asking a new contributor to learn the command line first. It stays
local, refuses unsafe destination paths, and opens the live product dashboard when setup completes.

## Start on your platform

Download the complete archive for your platform and extract all of it before opening a launcher.
Do not run a launcher from inside the ZIP viewer, and do not copy `OpenProductOS.exe` away from the
adjacent PowerShell script, package lock, source, and schemas.

| Platform | Open this file | What happens |
| --- | --- | --- |
| Windows | [`launchers/windows/OpenProductOS.exe`](../../launchers/windows/OpenProductOS.exe) | A small window starts the local graphical wizard. No administrator access is requested. |
| macOS | [`launchers/macos/OpenProductOS.command`](../../launchers/macos/OpenProductOS.command) | Terminal starts the verified local runtime and opens the wizard in your browser. |
| Linux | [`launchers/linux/OpenProductOS.desktop`](../../launchers/linux/OpenProductOS.desktop) | The desktop launcher starts a terminal-backed setup session and opens the wizard. |

Command-line fallback on every platform:

```text
npm run onboard
```

### First-open notes

- The Windows executable is built from the adjacent reviewable C# source, but the repository
  does not currently have a commercial code-signing certificate. Windows SmartScreen may therefore
  ask you to confirm the first launch. The executable checksum is recorded beside it.
- On macOS, use **Control-click → Open** if Gatekeeper asks for confirmation. A clone normally keeps
  the executable bit; after a plain ZIP download you may need `chmod +x` once.
- On Linux, mark the desktop file as trusted if your desktop environment requests it. You can always
  run the adjacent shell launcher instead.

## What the wizard asks

The flow has five short screens:

1. Choose the parent folder and names for the operations and application repositories.
2. Describe the product, vision, target users, environments, and human product owner.
3. Optionally record the first idea, its problem statement, source, and initial priority.
4. Review Development Operations OS, Codex automation, dependency, Git, initial-commit, and
   writable-local-dashboard options.
5. Review the complete plan and start the bounded setup.

Defaults are already selected for the common case. The user can create a new application folder,
connect an existing application folder, or postpone the code repository entirely.

A new application always receives the namespaced Development Operations OS files and is validated
before onboarding completes. An existing application remains untouched unless the user explicitly
selects Development Operations OS initialization. This opt-in adds only the namespaced engineering
files; it does not stage or commit the existing repository. Specialist executors remain disabled
unless the user explicitly selects Codex automation and the readiness checks pass.
The wizard selects writable local mode for the common autonomous case. It remains loopback-only,
uses a per-session request token, and is shown explicitly in the final review. The user can turn it
off for an observation-only workspace.

## What happens after confirmation

The setup engine performs and reports each bounded step:

```text
verify or install a local runtime
→ install locked project dependencies
→ verify the Codex CLI and login; install or open login when explicitly selected
→ preview and create the operations repository
→ apply product configuration
→ create or connect the application repository
→ initialize and validate Development Operations OS when selected
→ record the first idea
→ run the first product-operations cycle
→ initialize independent Git histories
→ validate the generated workspace
→ persist the Product/Development automation link
→ open the live RTL product dashboard and start the resumable cycle
```

Development Operations OS is initialized for a new application. In manual mode every specialist
executor remains disabled. In Codex automation mode, the wizard distinguishes installation,
executable health, and login status before configuring and enabling the bounded engineering
executors. When the first idea was submitted with Codex automation selected, the dashboard starts
the durable coordinator: product roles analyze it, engineering roles implement dependency-ready
work, independent verifiers inspect the result, evidence returns to product, the workbook is
updated through controlled receipts, and a Persian cycle report is produced. Creating a task board
never authorizes deployment, production credentials, destructive data work, spending, external
publication, or writes outside the chosen folders.

## Runtime and privacy contract

- If Node.js 20 or newer already exists, the launcher uses it.
- Otherwise, it downloads the maintained Node.js 22 portable archive directly from `nodejs.org`,
  verifies the official SHA-256 checksum, and extracts it under `.product-ops-tools/` in this clone.
- Release archives contain the exact production dependencies resolved from the published lockfile.
  The launcher binds them to the lockfile hash and automatically performs a locked, lifecycle-script-
  free repair if the dependency directory is absent, incomplete, or stale.
- It does not modify the system-wide Node.js runtime or request administrator access. If Codex
  automation is explicitly selected and no usable CLI exists, it may install the official
  `@openai/codex` package with npm at user scope; the review screen discloses this before execution.
- The onboarding and dashboard servers bind only to a loopback address.
- The session rejects credentials and private material in form values.
- Existing non-empty folders are never overwritten. Only folders containing the resumable
  onboarding marker can continue a previously interrupted setup.

## Recovery

If setup stops, the page shows the exact safe validation or execution error. Use **Back, correct,
and try again** to return to the review screen without losing the answers. A partially generated
operations folder can resume only when its local onboarding marker proves that this wizard created
it. User-created non-empty folders fail closed.

On Windows, run the adjacent `OpenProductOS.cmd` file when detailed diagnostics are needed; it keeps
the terminal open after a failure. The executable also shows a persistent message when its
PowerShell child exits unsuccessfully.

Portable runtimes can be removed safely by deleting `.product-ops-tools/` while the launcher is not
running; the next launch will verify or download the runtime again.

## Building distributable launcher bundles

The `One-click launcher bundles` GitHub Actions workflow creates integrity-stamped Windows, macOS,
and Linux archives from a tag or a manual run. The Windows job rebuilds the executable from the
checked-in C# source before packaging it. Every workflow action is pinned to an immutable commit.

Local launcher verification:

```text
npm run launchers:check
```
