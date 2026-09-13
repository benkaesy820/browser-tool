# Browser Bridge

A standalone browser service that lets CLI agents — any program that can
launch a process and read JSON — inspect and operate real websites through
structured commands. The agent reasons; the service executes and observes.

- **No Codex, AI subscription, model, or account required.**
- Three transports, one engine: **JSONL stdio**, **loopback daemon**,
  **MCP** (official SDK, spec 2025-06-18).
- A human can watch and take over the same tab in the local **viewer**.
- Plain shell verbs remember the current session; headed browsers show
  smooth pointer movement and support preset or custom viewports.
- Low-level agents can move, click, multi-click, wheel at a point, and drag;
  `bridge events` streams state changes over SSE without polling.

## Install (from a release tarball)

```sh
npm install -g @browser-bridge/cli-<version>.tgz
bridge doctor   # runtime + Chromium check
```

Requires Node.js ≥ 22 and a Playwright Chromium (`bridge doctor` tells
you exactly what's missing; `npx playwright install chromium` fetches it).

## Sixty-second tour

```sh
# 1. Start the persistent browser service and optional viewer.
bridge daemon start --detach   # background; plain `start` blocks the shell
bridge viewer   # opens the session viewer in your browser

# 2. Browse in separate shell commands. `open` remembers the session.
bridge open http://localhost:3000
bridge state
bridge viewport mobile       # 390x844
bridge fill el-3-1 "pears"  # use refs from the latest result
bridge shot
```

Every response carries the observation revision; refs like `el-4-2` work
only for the revision that issued them. Actions return a fresh
observation — chain those refs, never old ones.

Every verb accepts `--session`, `--tab`, and `--json`. Integrations can
also use raw JSONL (`bridge serve --stdio`) or `bridge call`; see the CLI
and protocol docs.

MCP clients use `bridge mcp --stdio`; see
`examples/mcp-client/config.json`. Ready-made clients live in
`examples/` (Node, PowerShell, TypeScript, Python, shell).

## Docs

- `docs/architecture.md` — components, transports, lifecycle
- `docs/protocol.md` — wire contract, ops, errors
- `docs/cli.md` — commands, exit codes, daemon auth
- `docs/mcp.md` — tools, resources, images, cancellation
- `docs/troubleshooting.md` — common failures and fixes
- `docs/privacy-and-storage.md` — profiles, artifacts, retention
- `docs/benchmark.md` — methodology and how to reproduce numbers
- `docs/release-checklist.md` — what "ready to publish" means
- `docs/phase-*.md` — per-phase build notes
- `CHANGELOG.md`, `THIRD_PARTY.md`, `LICENSE` (MIT, provisional)

## Verify a checkout

```sh
pnpm install
pnpm typecheck && pnpm lint && pnpm format:check
pnpm test && pnpm test:contract && pnpm test:integration
pnpm build && pnpm test:package && pnpm benchmark && pnpm test:interop
```

## Safety in one paragraph

Loopback-only daemon with a per-user token; temporary browser profiles
by default; named persistent profiles are explicit and pid-locked;
screenshots/artifacts stay in owned directories with retention;
redirects re-validated; page text is untrusted data; destructive and
consequential actions surface explicit error codes instead of silent
guesses. See `docs/privacy-and-storage.md`.
