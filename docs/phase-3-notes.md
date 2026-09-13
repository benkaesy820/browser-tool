# Phase-3 notes: MCP compatibility

Date: 2026-09-12. Packages: `@browser-bridge/protocol` 0.4.0,
`@browser-bridge/core` 0.4.0, `@browser-bridge/mcp` 0.1.0 (new),
`@browser-bridge/cli` 0.2.0 (`mcp --stdio`). Wire version stays `"1.0"`.
MCP SDK 1.20.1; negotiated spec revision `2025-06-18`
(SDK `LATEST_PROTOCOL_VERSION`, asserted live in the framing test).

## Tool surface (7 tools, one engine)

| Tool | Purpose | Notes |
| ---- | ------- | ----- |
| `browser_start` | Create session, optionally open URL | Returns ids + observation + resource links |
| `browser_act` | Any of 11 actions + optional postcondition | Missed postcondition is `timeout` data, not an error |
| `browser_observe` | Fresh observation, optional screenshot | `includeScreenshot` opts vision clients in; text path identical for all |
| `browser_wait` | Explicit condition wait | `POSTCONDITION_TIMEOUT` on miss |
| `browser_diagnostics` | Console errors, failed requests, bad responses | Read-only |
| `browser_tabs` | list/open/select/close; list without sessionId inventories all sessions | - |
| `browser_close` | Release session | - |

Annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
`openWorldHint`) are set on every tool and asserted in contract tests.
Error text leads with the stable protocol code (`TARGET_AMBIGUOUS: …`),
identical to the JSONL/daemon envelopes for the same failure.

## Resources and image delivery

- `browser://sessions/{id}/tabs/{tab}/observation` — latest observation
  as JSON (pure read via `engine.peekObservation`; never refreshes).
- `browser://sessions/{id}/tabs/{tab}/screenshot` — captures on read,
  returns PNG bytes (`engine.artifactBytes` enforces session ownership
  and directory containment).
- Tool responses embed both URIs, so templates need no separate listing
  call. Text-only clients ignore the image blocks and lose nothing.

## Cancellation

Tool handlers race engine work against the SDK abort signal. On abort
the adapter best-effort cancels the session generation (releasing `wait`
loops and queued work, mirroring `bridge cancel`) and ends the handler;
in-flight page actions cannot be undone. Proven live: abort a 20 s wait
after 0.5 s over real stdio, then reuse the session immediately.

## Setup (no model or vendor assumptions)

Any MCP client that spawns a command works — see
`examples/mcp-client/config.json`:

```json
{ "mcpServers": { "browser-bridge": { "command": "bridge", "args": ["mcp", "--stdio"] } } }
```

Use the installed binary name on PATH, or `node <dist>/cli.js` from a
source checkout. Logs go to stderr (`BRIDGE_LOG_LEVEL=warn` to quiet);
stdout is pure MCP framing (asserted line-by-line in interop).
The subprocess exits when its stdin closes and on SIGINT/SIGTERM, after
shutting the browser down — no orphan Chromium.

## Gate evidence

`typecheck`, `test` (9), `test:contract` (14: router 7 + MCP 7),
`test:integration` (13), `test:interop` (14 run, 2 skipped),
`pnpm build` — all exit 0. An independent SDK `Client` over spawned
stdio completes the fixture workflow with consistent observations and
error codes; text-only and image paths both asserted with real PNG
bytes. Zod bumped 3.23.8 → 3.25.76 to satisfy the SDK's
`zod-to-json-schema` peer range; one zod copy serves protocol, adapter,
and SDK conversion.

## Deferred

Remote/streaming MCP transport (Streamable HTTP), progress tokens for
long waits, delta/visual/inspect observation modes (Phase 5), viewer
(Phase 4). The adapter owns a private engine per server instance;
sharing one browser across MCP + daemon transports is a deployment
question for later, not a contract change.
