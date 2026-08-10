# Connecting a host

The control surface is an ordinary MCP server over stdio, so any compliant host can run it. What
differs between hosts is not the server — it is where each one looks for configuration, and what it
does to that configuration afterwards. Those differences have cost real setup attempts, so they are
written down here rather than left to be rediscovered.

Everything below was verified against the hosts' own documentation and open issue trackers.

## The command, whichever host you use

```
node <path-to-this-clone>/src/mcp/server.js --project . --allow-writes
```

- Use an absolute path to the clone, with forward slashes even on Windows.
- `--project .` binds the server to the workspace the host opened.
- Without `--allow-writes` the server registers 8 read-only tools and there is no write path at all.
  With it, 19 — intake, cycles, taking and returning work on both sides, crossing into engineering
  and back, and recording the owner's decisions.

## Claude Code

Write `.mcp.json` in the product workspace:

```json
{
  "mcpServers": {
    "product-ops": {
      "command": "node",
      "args": ["<path-to-this-clone>/src/mcp/server.js", "--project", ".", "--allow-writes"]
    }
  }
}
```

Three things decide whether it connects:

1. **The workspace must be the session root.** `.mcp.json` is read from the root only. Opening the
   workspace as a second source folder inside another project will not load it.
2. **Project-scoped servers need approval.** The first time, Claude Code asks whether to trust the
   project's MCP servers. Until you answer yes, the server is configured and not connected. If you
   answered no by accident, `claude mcp reset-project-choices` puts the question back.
3. **`/mcp` tells you the truth.** It lists servers, their connection state, and their prompts. If
   `product-ops` is not there, nothing else in this document will help until it is.

## Codex

Add it through one of the supported paths — CLI, desktop Settings → MCP servers → Add server (then
restart), or the IDE gear menu. All three write the same configuration.

```bash
codex mcp add product-ops -- node <path-to-this-clone>/src/mcp/server.js --project . --allow-writes
```

**Do not hand-edit `~/.codex/config.toml` for the desktop app on Windows.** Startup rewrites the
file and deletes user-defined `[mcp_servers.*]` entries, keeping only app-managed ones
([openai/codex#24718](https://github.com/openai/codex/issues/24718)). An entry added by hand
disappears without a message, which reads exactly like the server failing to start.

Project-scoped `.codex/config.toml` MCP entries are not loaded by the desktop app either
([#13025](https://github.com/openai/codex/issues/13025)).

## Asking for the prompts

The server publishes three: `start`, `take-command`, and `what-needs-me`.

How you invoke them differs by surface. The Claude Code CLI documents
`/mcp__product-ops__take-command`; the desktop app's picker shows `product-ops:take-command (MCP)`.
Rather than memorising either, **type `/` and pick from the list** — if the server is connected, the
prompts are there.

If they are not, or your host does not do prompts at all, ask in words. The prompts are instructions
to the agent, not machinery:

> Take the coordinator seat for this workspace. Start with product_ops_status.

## When nothing connects

Work through these in order; each one rules out a whole class of cause.

1. **Run the command yourself in a terminal.** If it exits immediately, the path is wrong or Node is
   not on `PATH`. A healthy server prints nothing and waits — that is correct, not a hang.
2. **Check Node's version.** `node --version` must be 20 or later.
3. **Check the workspace is the session root**, not a folder added to another project.
4. **Check the host's own MCP listing** — `/mcp` in Claude Code, Settings → MCP servers in Codex. A
   server that the host does not list is a configuration problem, not a server problem.
5. **On Codex desktop for Windows, re-add through the UI.** If the entry vanished, it is the bug
   above.

## After changing the server's code

Restart the host. The server process reads the code when it starts, so a clone that was updated
while a session was running is still serving the old tools. This is the one case where "have you
tried restarting it" is the right answer rather than the lazy one.
