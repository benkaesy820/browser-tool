# Architecture (v0.7.x)

One command router and one execution core serve every client. Adapters
translate framing; they never reimplement browser logic.

```text
CLI agent / shell / MCP client            Human viewer
        |                                        |
 CLI verbs/JSON / MCP adapter        HTTP + event stream (same origin)
        |                                        |
        +------------- Command router -----------+
                              |
             Validation, session ownership, policy, journal
                              |
                 Per-session command queue
                              |
                    Browser execution core
                     /         |          \
             Observation    Actions    Diagnostics
                     \         |          /
                      Playwright → Chromium
                              |
               Results, events, image artifacts
```

## Packages

| Package | Owns |
| ------- | ---- |
| `@browser-bridge/protocol` | Zod wire contracts, error taxonomy, capability discovery |
| `@browser-bridge/core` | Sessions, tabs, actions, observations, events, profiles |
| `@browser-bridge/server` paths live in `cli` | Daemon HTTP, ownership, artifacts, static viewer |
| `@browser-bridge/cli` | Plain verbs/current session, JSONL adapter, daemon client, doctor |
| `@browser-bridge/mcp` | Official-SDK adapter (tools, resources) |
| `@browser-bridge/viewer` (`apps/`) | React session viewer |

## Transports

- `serve --stdio`: persistent child, JSON Lines, stdout is protocol-only.
- `daemon`: loopback Fastify + Bearer token file; shares sessions across
  shell commands; also hosts the viewer shell, artifacts, and the SSE
  event stream. Foreground by design (`stop` is synchronous and verified).
- `mcp --stdio`: same core through the official SDK; owns a private engine.

Viewport changes from protocol, CLI, MCP, and viewer use the same router.
Headed engines animate click, hover, move, coordinate wheel, and drag pointer travel;
headless engines skip the added motion delay.

## Sessions and tabs

A session owns a browser context (or a persistent profile context), its
tabs, an action queue, observation history, annotations, diagnostics,
and an artifact directory. Contexts separate cookies/storage but are not
a hosted multi-tenant boundary. Refs (`el-<rev>-<n>`) belong to exactly
one observation revision; every action returns a fresh one.

## Failure model

Stable error codes with `outcomeUnknown`/`retryable` flags; in-flight
request ids deduplicated per process; a write-ahead journal turns
cross-restart retries into `OUTCOME_UNKNOWN` instead of duplicates;
browser death is reported fast with session identity preserved.
