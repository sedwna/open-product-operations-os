# Working in this repository

This is Open Product Operations OS: an operating model a coding agent adopts, not an application a
person installs.

**If the person asks you to set them up, start a product, or get them going — do not explain the
system to them and do not hand them a list of commands to run. Follow the setup runbook in
[`AGENTS.md`](AGENTS.md) and do it for them.** They should have a working product workspace at the
end of the conversation, having answered three or four questions about their product and nothing
about mechanics.

If they are contributing to this repository rather than using it, read
[`CONTRIBUTING.md`](CONTRIBUTING.md) and the continuation contract in `AGENTS.md`.

## Verifying a change

```bash
npm ci
npm run check
```

`npm run packed:check` fails locally on purpose whenever source changes; regenerating its hash from a
single platform has produced a false agreement before, so it belongs to CI.
