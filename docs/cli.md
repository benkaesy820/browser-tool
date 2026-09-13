# CLI (v0.5.x)

Binary: `bridge` (also runnable as `node <dist>/cli.js` from source).

## Services

- `bridge serve --stdio [--headed]` — JSONL service: one request object
  per stdin line, one response per stdout line. Logs go to stderr only.
- `bridge daemon start [--port N] [--headed] [--viewer-dir DIR] [--detach]` —
  foreground loopback service (127.0.0.1, ephemeral port). Refuses a
  second instance per rendezvous dir; replaces stale files after a
  health probe. Use `--detach` from ephemeral/agent shells: it spawns a
  background daemon and returns immediately with `{ok, detached, port,
  pid}`. Plain `daemon start` blocks forever — running it as an ordinary
  command in a short-lived shell gets killed on shell exit and leaves a
  stale `daemon.json` (`daemon unreachable` on the next call).
- `bridge daemon stop` — synchronous: browsers closed, artifacts
  cleaned, port freed. Reports `{ok, cleaned, failed}`.
- `bridge daemon status` / `bridge status` — `{running, port, pid,
sessions, headed, viewerBuilt}`; exit 0 even when stopped.
- `bridge mcp --stdio [--headed]` — MCP server over stdio.
- `bridge viewer [--no-open]` — prints the viewer URL (token in the
  fragment, never sent to the server) and opens a browser.

## Persistent verbs

Start `bridge daemon start --detach`, then browse across ordinary shell commands:

```sh
bridge open <url>
bridge open <url> --profile NAME
bridge state
bridge inspect <ref>
bridge click <ref>
bridge fill <ref> <text>
bridge select <ref> <value...>
bridge check <ref> on|off
bridge upload <ref> <file>
bridge type <text>
bridge press <key>
bridge hover <ref>
bridge scroll [pixels]
bridge go <url>
bridge back | bridge forward | bridge reload
bridge wait <text>
bridge search <query> [--limit N]
bridge diagnostics
bridge shot [--full] [--out PATH]
bridge tabs | bridge sessions | bridge use <session-id>
bridge viewport <mobile|tablet|desktop|WIDTHxHEIGHT>
bridge events [--cursor N] [--session ID]
bridge close [session-id]
```

Chain a whole flow in one round trip (up to 20 actions, one queue
slot, one final observation) instead of one shell call per step:

```sh
echo '[{"type":"fill","ref":"el-1-3","text":"apples"},{"type":"click","ref":"el-1-9"}]' | bridge batch --stdin
```

`open` creates and remembers a session when needed; `use` changes the
remembered session. `--profile NAME` (`[A-Za-z0-9_-]`, max 64) pins the
new session to a persistent browser profile: logins and storage survive
daemon restarts, and the profile stays locked to one session at a time
(`close` releases it). `--profile` with `--session`, or on a reused
remembered session, warns instead of silently ignoring. Every verb accepts `--session`, `--tab`, and `--json`.
Every action (`open`, `click`, `fill`, `scroll`, …) prints the fresh
post-action observation (URL, `rN | title | N controls`, 800-char text,
40 controls) — chain the next ref straight from that output instead of
paying for an extra `state` call. Every action also reports the page
errors it caused as `!` lines (`page console error: …`, `page request
failed: …`, `page HTTP <status>: …`, capped at 5 with an overflow note):
treat them as the action's result — investigate or fix the page, don't
blind-retry. `diagnostics` still shows the full error history on demand. Refs are revision-scoped, so use refs
returned by the latest state or action. The current session file lives
in the selected daemon directory.
Navigations auto-reject cookie-consent walls (reject-only buttons; the
tool never accepts tracking) and report the dismissal as a warning;
walls that need a human choice are named in errors with dismiss refs.

Viewport presets are mobile `390x844`, tablet `820x1180`, and desktop
`1440x900`. Custom width and height bounds are `320..3840` and
`320..2160`. Headed mode shows smooth pointer travel for pointer actions;
headless execution has no added motion delay. Headed sessions start with
a free window: the page fills the window and follows OS drags/resizes
like a normal browser. `viewport` pins an exact size instead (the window
follows it) for deterministic responsive checks and captures.
`viewport <size> --keep-window` pins the page without moving the OS
window (DevTools-style override); `viewport free` clears the override.
The viewer uses this stable-window mode, refreshes its preview immediately
after a viewport change, and offers **Auto** to return to the free window.
`scroll` uses an accelerating-and-settling wheel curve with bounded jitter;
the integer deltas still sum exactly, so natural motion does not reduce
accuracy. Raw `act` requests additionally support `moveAt`, two-axis
`scrollAt`, `dragAt`, right/middle clicks, and multi-click.
The plain command also accepts `bridge click <ref> --button right --count 2`.
`shot` captures the visible viewport (what the watcher sees); `shot
--full` stitches the full scrollable page instead.

## Raw protocol calls

`bridge call '<json>'` or `... | bridge call --stdin` (avoids Windows
quoting pitfalls). Global `--daemon-dir` isolates concurrent daemons
(used by every test).

## Utilities

- `bridge capabilities` — static discovery document, no browser needed.
- `bridge doctor` — runtime, Chromium executable, launch smoke test;
  exit 0 healthy, 1 otherwise. Degrades gracefully (reports, never
  crashes) when browsers are absent.

## Exit codes

`0` completed · `1` protocol error (see `code`) · `2` usage/transport
problem (bad JSON, daemon unreachable, already running).

## Daemon auth and endpoints

Rendezvous file `$TMP/browser-bridge/daemon.json` (`{port, token, pid}`,
0700/0600 best effort). Every data route requires
`Authorization: Bearer <token>` from a loopback host; CORS is never
enabled. Routes: `POST /v1/request`, `GET /v1/health`,
`GET /v1/artifacts/:session/:id` (owned PNG bytes),
`GET /v1/events?cursor=` (SSE with standard `id`, `event`, and `data` fields,
`Last-Event-ID` resume, `: ping` heartbeats, and `gap` on overflow),
`POST /v1/shutdown`, plus the unauthenticated viewer shell
(`/`, `/assets/*`, loopback-only by design).

`bridge events` exposes that authenticated SSE stream as JSON Lines for any
CLI agent. The viewer consumes the same persistent stream and refreshes only
after relevant events; it does not inventory-poll the daemon.
