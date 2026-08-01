# One-click onboarding

The graphical onboarding path turns a fresh clone into a ready product workspace without asking a
new contributor to learn the command line first. It stays local, refuses unsafe destination paths,
and opens the live product dashboard when setup completes.

## Start on your platform

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
4. Review dependency, Git, initial-commit, and writable-local-dashboard options.
5. Review the complete plan and start the bounded setup.

Defaults are already selected for the common case. The user can create a new application folder,
connect an existing application folder, or postpone the code repository entirely.

## What happens after confirmation

The setup engine performs and reports each bounded step:

```text
verify or install a local runtime
→ install locked project dependencies
→ preview and create the operations repository
→ apply product configuration
→ create or connect the application repository
→ record the first idea
→ run the first product-operations cycle
→ initialize independent Git histories
→ validate the generated workspace
→ open the live RTL product dashboard
```

The development adapter remains disabled. Creating a task board does not silently authorize a
coding agent, external provider, credential, deployment, or write outside the chosen folders.

## Runtime and privacy contract

- If Node.js 20 or newer already exists, the launcher uses it.
- Otherwise, it downloads the maintained Node.js 22 portable archive directly from `nodejs.org`,
  verifies the official SHA-256 checksum, and extracts it under `.product-ops-tools/` in this clone.
- It does not modify the system-wide runtime, request administrator access, or install a package
  manager globally.
- The onboarding and dashboard servers bind only to a loopback address.
- The session rejects credentials and private material in form values.
- Existing non-empty folders are never overwritten. Only folders containing the resumable
  onboarding marker can continue a previously interrupted setup.

## Recovery

If setup stops, read the final message in the launcher terminal. Fix the reported prerequisite and
open the launcher again. A partially generated operations folder can resume only when its local
onboarding marker proves that this wizard created it. User-created non-empty folders fail closed.

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
