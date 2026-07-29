# Agent continuation contract

This repository is designed to be continued by Codex, Claude, or another capable LLM host without
replaying chat history.

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
