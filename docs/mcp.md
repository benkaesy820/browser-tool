# MCP (adapter v0.4.0, SDK 1.20.1, spec 2025-06-18)

`bridge mcp --stdio` serves one private engine through the official SDK.
Stdout is pure MCP framing; the process exits when stdin closes. There is
no daemon to manage over this transport — no `daemon start/stop/status`,
no rendezvous file, no stale-file class of failure. Client-side cancels
abort in-flight work (`cancel`); every `browser_act`/`browser_batch` result
carries the same `warnings` (including new page errors) as the CLI.

## Setup (any MCP client)

```json
{
  "mcpServers": {
    "browser-bridge": { "command": "bridge", "args": ["mcp", "--stdio"] }
  }
}
```

From source: `"command": "node"`, `"args": ["<repo>/packages/cli/dist/cli.js", "mcp", "--stdio"]`.
`BRIDGE_LOG_LEVEL=warn` quiets stderr. See `examples/mcp-client/config.json`.
Add `--headed` after `--stdio` for visible smooth pointer motion.

## Tools (10)

`browser_start` (create, optional open) · `browser_act` (typed actions,
including revision-bound click/drag coordinates, plus postcondition) · `browser_observe` (modes
controls/summary/delta/visual/inspect + optional screenshot) ·
`browser_wait` · `browser_diagnostics` · `browser_tabs`
(list/open/select/close/viewport; list without session inventories all) ·
`browser_batch` · `browser_search` · `browser_takeover`
(pause/resume/status) · `browser_close`. Every tool carries
`readOnly/destructive/idempotent/openWorld` annotations.

The `browser_tabs` viewport operation accepts `preset` (`mobile`,
`tablet`, or `desktop`) or custom `width` and `height`. Presets are
`390x844`, `820x1180`, and `1440x900`; custom bounds are `320..3840` by
`320..2160`. `keepWindow: true` pins the page without resizing the OS
window; `free: true` clears the override and takes no size.

## Resources

- `browser://sessions/{id}/tabs/{tab}/observation` — latest observation
  JSON (pure read, never refreshes).
- `browser://sessions/{id}/tabs/{tab}/screenshot` — captures on read,
  PNG bytes. Tool responses embed both URIs.

## Images and cancellation

`includeScreenshot` (or visual mode) appends `{type:"image",
mimeType:"image/png"}` with real PNG bytes; text-only clients get
identical semantic content without it. Client abort signals race engine
work: the adapter best-effort cancels the session generation (releasing
waits/queues; delivered page actions cannot be undone) and ends the
handler. In-flight page actions are never auto-retried.
Error text leads with the stable protocol code, identical to JSONL.
