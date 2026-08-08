# Agent contract

Two different jobs live here. The setup runbook is for getting a person started. The continuation
contract below it is for working inside a product workspace that already exists.

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

When something fails, say what broke and what you are doing about it. Do not paste raw stack traces
at them.

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

Create the workspace **beside this repository**, never inside it.

## Step 4 — Create and verify the workspace

```bash
node ./src/cli.js init <workspace> --dry-run
node ./src/cli.js init <workspace>
node ./src/cli.js validate <workspace>
```

Run the dry run yourself and read it; do not make them read 73 lines. Say how many files were
created once it is done. `validate` must print `Validation passed` before you go on.

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
node ./src/cli.js configure <workspace> --answers <answers.json> --apply
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
node ./src/cli.js intake <workspace> --file <idea.json> --apply
node ./src/cli.js operate <workspace> --apply
```

Then read the board yourself and tell them what happened in their terms: how many cards, which team
holds the first one, and where the first decision of theirs is waiting.

## Step 7 — Connect the workspace to this host

Write `.mcp.json` **in the workspace**, with the absolute path to this repository's server:

```json
{
  "mcpServers": {
    "product-ops": {
      "command": "node",
      "args": ["<absolute path to this repo>/src/mcp/server.js", "--project", ".", "--allow-writes"]
    }
  }
}
```

Forward slashes, even on Windows. Use the real absolute path — resolve it, do not leave a
placeholder.

Do not suggest the `npx --package=open-product-operations-os` form. The package is not published
yet and that form fails with a 404.

Tell them what `--allow-writes` opens: without it the server registers 8 read-only tools and no
write path exists at all; with it, 15, adding intake, cycles, taking and returning work, and
recording their decisions.

## Step 8 — Hand over

Tell them to reopen their agent in the workspace folder so the server loads, and that their first
move there is `/product-ops:take-command`, which puts you in the coordinator seat.

Then stop. Do not start doing product work in the setup conversation.

## Where this stops

Setup ends with a validated workspace, a routed board, and a decision waiting. It does not build
their application. If they already have a repository they want brought in, that is a separate
sequence — `development-os init` in that repository, then `product-ops link` — and it belongs after
they have seen one cycle, not during setup.

---

# Continuation contract

For an agent picking up work inside a product workspace that already exists.

Before work:

1. Read `README.md` and `START-HERE.md`.
2. Read the generated project's governance, role registry, routing, and ownership contracts.
3. Validate the project configuration.
4. Read the shared task board and select only a card owned by your role.
5. Confirm the current canonical revision and any live-system freshness requirement.

During work:

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
