# Agent contract

Two different jobs live here. The setup runbook is for getting a person started. The continuation
contract below it is for working inside a product suite that already exists.

---

# Setup runbook

Follow this when someone asks you to set them up, start a product, or get them going. **Do it for
them.** Do not explain the operating model first and do not hand them a list of commands — a person
who wanted to run twenty commands would not have asked you.

## How to behave while you do it

Say what you are about to do, do it, say what happened. One or two lines each. They should be able
to follow along without knowing any of the vocabulary.

Ask them only about **their product**. Never ask about mechanics — not folder layout, not
configuration fields, not which flag to pass. If a mechanical choice exists, make it and say which
way you went in one clause.

Ask in chat, one thing at a time, and wait. Do not batch four questions into a wall of text.

## Proportional work

Do not overqualify the person or overengineer the product. Read the repository and canonical state
before asking anything. Ask only when the answer changes a material product choice, risk acceptance,
irreversible action, sensitive access, or final acceptance; make mechanical choices yourself and
state them briefly. One decision at a time, with plain-language context, two or three mutually
exclusive options, consequences, a recommendation, and room for a free-form answer.

Build the smallest complete reversible change that satisfies current acceptance criteria. Reuse an
existing path before adding a layer. A new abstraction, service, dependency, store, queue, extension
point, gate, or artifact needs a present requirement or observed risk, a simpler alternative that is
insufficient now, and a removal or expansion trigger. Hypothetical future flexibility is not a
requirement. Reproduce a claimed gap before changing code; "no change needed" is a valid result.

Understand first, then stop at the earliest solution that works: no build, reuse code already here,
use the standard library or native platform, use an installed dependency, and only then write the
minimum local implementation. For defects, inspect every caller and fix the shared root cause once.
Prefer deletion, boring code, and the fewest files. A deliberate shortcut records its known ceiling
and observable upgrade trigger. Non-trivial logic leaves one focused runnable check; never trade
away trust-boundary validation, data-loss handling, security, accessibility, or explicit acceptance.

For external collection, add retries or resumable checkpoints only when measured run length or an
observed failure makes lost work material. A different path, schedule, query, or collection mode is
not an independent evidence source when the underlying authority or marketplace is the same; keep
run provenance separate without double-counting corroboration.

Assurance depth follows risk, but scope, credential hygiene, evidence for material claims,
independent verification, and human authority never weaken. The complete policy is
[`docs/architecture/proportional-delivery.md`](docs/architecture/proportional-delivery.md).

Do not collapse delivery states. `implemented` means Engineering has returned technical proof;
`release_ready` means Product release gates pass; `released` means the authorized release happened;
`resolved` means post-release evidence shows the original user or operational outcome occurred.
Only the last state may be described to the owner as "the problem is solved." Use the existing issue,
release, observation, evidence, and QC records; do not add a new gate or artifact unless the current
risk or acceptance criteria require one.

When something fails, say what broke and what you are doing about it. Do not paste raw stack traces
at them.

**Never leave them watching a spinner.** Setup has eight steps; say so at the start, and name the
step you are on as you reach it. Before anything that takes more than a few seconds, say roughly how
long and that it will print nothing while it works. Afterwards, say what it produced in a number
they can check — files created, roles configured, cards routed.

This is not politeness. This system's entire claim is that an operator should never have to guess
what it is doing, and the first person to follow this runbook reported that its own first step felt
like nothing was happening at all. A tool that leaves you guessing during setup has already broken
the promise it is being installed to keep.

## Step 1 — Check the ground

```bash
node -v
```

Node 20 or newer is the only prerequisite. If it is missing or older, say so plainly and stop; they
need to install it from nodejs.org and reopen the terminal.

## Step 2 — Install

```bash
npm ci --omit=dev
```

`--omit=dev` fetches 8 packages instead of 95 and changes nothing about what the system can do; the
rest is contributor tooling. Tell them it may sit on one spinning line for a while with no progress
bar, because it will, and that this is npm rather than anything here.

If it is slow enough to worry about, `npm ping` shows the round-trip to the registry.

## Step 3 — Ask what they are building

One question. Something like: *what are you building, in a sentence?*

From their answer, derive and then state:

- **the product name** — their words, capitalised sensibly;
- **the folder name** — lowercase, hyphenated, two words where natural.

The folder name is worth a moment of care and is not worth asking about. It becomes the task
identifier prefix permanently, and `configure` does not change it later:

| Folder | Task IDs |
| --- | --- |
| `dino-dash` | `DD-0001` |
| `dinodash` | `DINODASH-0001` |

Two hyphenated words give clean identifiers. Pick one and say what you picked.

Create the product suite **beside this repository**, never inside it. The suite is one GitHub-facing
repository with two mandatory authority roots:

```text
<folder>/
├── product/       # Product Operations roles, governance, decisions, task board, evidence
└── development/   # application code, Engineering roles, workstreams, gates, technical evidence
```

Never create a development-only product repository. Product and Development stay semantically and
operationally independent, but both folders must be present in the same Git history so a clone is a
complete, understandable product workspace.

## Step 4 — Create and verify the workspace

```bash
node ./src/cli.js init-suite <workspace> --dry-run
node ./src/cli.js init-suite <workspace> --provider <codex|claude>
node ./src/cli.js validate-suite <workspace>
```

Run the dry run yourself and read it; do not make them read the full file list. Say how many files
were created in each root once it is done. `validate-suite` must print `Suite validation passed`
before you go on.

`init-suite` creates `product/` and `development/`, installs their separate role registries and
task boards, links them through versioned contracts with executors disabled, and starts one Git
history at the suite root. That is not housekeeping:
exporting an approved delivery contract to the engineering side stamps it with the workspace
revision, and without one the export refuses at the moment the owner has just authorised crossing
into engineering. If it reports that it could not — no `git` on the machine, or a refused commit —
say so at the end of setup rather than letting them find out then. An existing repository is left
untouched.

## Step 5 — Ask the two product questions

Ask these separately, in their own words:

1. *Who is this for?*
2. *What does it need to do that nothing else does?* (this becomes the vision)

Then write the answer file and apply it. Write JSON with a tool, not with a shell heredoc.

```json
{
  "name": "<product name>",
  "vision": "<their answer to the second question>",
  "targetUsers": ["<their answer to the first>"],
  "environments": ["local", "staging", "production"],
  "humanAuthorityActorId": "human-product-owner"
}
```

```bash
node ./src/cli.js configure <workspace>/product --answers <answers.json> --apply
```

`humanAuthorityActorId` is them. Every product decision is attributed to it and the system refuses
any other actor. Say that once, in a sentence, when you set it.

## Step 6 — Ask for the first real thing

*What is the first thing you want to change or add?*

Push gently for a real origin — a support conversation, a review, something they watched a user do.
`source` is the field that explains the decision three months later, and "it seemed like a good
idea" is not one. If they genuinely have no origin yet, `"the owner's own idea at setup"` is honest
and fine.

```json
{
  "type": "new_idea",
  "title": "<short, in their words>",
  "description": "<what they said>",
  "source": "<where it came from>",
  "priority": "P1"
}
```

`type` is one of `new_idea`, `user_finding`, `incident`, `feedback`, `request`. `priority` runs
`P0`–`P3`.

```bash
node ./src/cli.js intake <workspace>/product --file <idea.json> --apply
node ./src/cli.js operate <workspace>/product --apply
```

Then read the board yourself and tell them what happened in their terms: how many cards, which team
holds the first one, and where the first decision of theirs is waiting.

## Step 7 — Connect the workspace to this host

Which host they are in decides how. Getting this wrong is the single most common reason a setup
looks finished and then nothing works. [`docs/setup/connecting-a-host.md`](docs/setup/connecting-a-host.md)
has the full detail; this is what you do.

**Claude Code.** Write `.mcp.json` **at the suite root**, with the absolute path to this repository's
server and the Product Operations root as its project:

```json
{
  "mcpServers": {
    "product-ops": {
      "command": "node",
      "args": ["<absolute path to this repo>/src/mcp/server.js", "--project", "./product", "--allow-writes"]
    }
  }
}
```

Forward slashes, even on Windows. Use the real absolute path — resolve it, do not leave a
placeholder.

**Codex.** Do not write a config file. Run `codex mcp add`:

```bash
codex mcp add product-ops -- node <absolute path to this repo>/src/mcp/server.js --project <absolute path to suite>/product --allow-writes
```

Before adding it, run `codex mcp list`. Codex stores this entry globally, so an existing
`product_ops` / `product-ops` entry may still point at a different suite's `product/` root. If it does,
remove the exact listed entry with `codex mcp remove <name>`, add the correct one, and run
`codex mcp list` again. Read back the server command and `--project` path; a successful add is not
proof that the host is targeting this workspace.

After any add, remove, or target change, fully restart Codex before continuing. A task that was
already open can retain the old MCP process and tool inventory. Its first call must be
`product_ops_status`; if the reported project id does not match this workspace, it must make no
writes and report the mismatch.

Hand-editing `~/.codex/config.toml` does not survive: the desktop app rewrites it at startup and
deletes user-defined entries. The entry vanishes silently, which reads exactly like a broken server.

Do not suggest the `npx --package=open-product-operations-os` form. The package is not published
yet and that form fails with a 404.

Tell them what `--allow-writes` opens: without it the server registers 8 read-only tools and no
write path exists at all; with it, 20, adding intake, cycles, taking and returning work on both
sides, crossing into engineering and back, and recording their decisions.

## Step 8 — Hand over

Tell them to reopen their agent **with the suite folder as the session root**, not with only
`product/` or only `development/` open. This makes both organisations visible while `.mcp.json`
still targets `./product` as the control-plane authority. Claude Code will also ask them once whether
to trust the project's MCP servers; until they answer, it is configured and not connected.

Then tell them their first move: type `/` and pick `take-command` from the list. Do not hand them a
literal slash string — the CLI and the desktop app spell it differently. If nothing appears under
`/`, the server has not connected, and they can say "take the coordinator seat, start with
product_ops_status" in plain words instead.

Then stop. Do not start doing product work in the setup conversation.

## Where this stops

Setup ends with a validated two-root suite, a routed Product board, an initialized Engineering
workstream board, and a decision waiting. It does not build their application. If they already have
an application repository, importing or relocating its code into `development/` is a separate,
explicit sequence after setup; never erase or rewrite its existing history implicitly.

---

# Continuation contract

For an agent picking up work inside a product suite that already exists. Product-side continuation
uses `product/` as its canonical root; implementation uses `development/` as its canonical root.

Before work:

1. Read `README.md` and `START-HERE.md`.
2. Read the generated project's governance, role registry, routing, and ownership contracts.
3. Validate the project configuration.
4. Read the shared task board and select only a card owned by your role.
5. Confirm the current canonical revision and any live-system freshness requirement.

During work:

- keep the feedback loop (below);
- apply the proportional-work policy: stop qualifying when the next safe action is clear and stop
  engineering when the approved outcome is met;
- stay inside the role's semantic and write authority;
- communicate through versioned cards and handoffs, not private agent-to-agent instructions;
- keep credentials outside Git;
- treat live writes as separately authorized actions;
- record evidence, commands, environment, blockers, and remaining risk;
- never certify your own material claim.

Before completion:

1. Commit canonical output and evidence.
2. Update only the card and fields your role owns.
3. Produce the required manifest for any live mutation.
4. Require complete read-back after a controlled write.
5. Route the claim to an independent verifier.
6. Return control to the Control Tower.

Chat memory is helpful context, never the source of truth.

# The feedback loop

Every workspace carries a `Feedback Loop.md`. It holds two things: what you learned while building
this product, and what the owner said back.

**After every card or two, write a note.** One or two sentences — what you learned, and what you
actually saw that led to it. Attach it to the card as `feedbackNote` and the system files it for you,
or call `product_ops_feedback` when the note came from somewhere other than a card.

A note is not a summary of what you did; the card already records that. It is what you did not know
before. What surprised you, what turned out to be wrong, what the work revealed about this product
that nobody had written down. If a card taught you nothing, say that instead of inventing a lesson —
a loop full of manufactured insight is worse than a short one.

**Then tell the owner, in the conversation, what the note says.** This is the half that makes it a
loop rather than a diary. They cannot answer a file they have not been shown, and the point of
writing it down is to get their answer.

**When they answer, record their words.** `product_ops_feedback` with `ownerFeedback` puts them in
the same file, in their own language. Never a summary in their place. Feedback you relay from a
conversation is recorded as relayed, because it is weaker evidence of what they meant than something
they typed themselves, and the record should not flatten the difference.

You do not have to remember any of this. Submitting a card without a note tells you when one is owed,
and keeps telling you until it is written. The count comes from the file itself, so it survives a
restarted process, a new conversation, and a different agent picking the work up.
