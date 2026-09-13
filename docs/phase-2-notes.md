# Phase-2 notes: usable CLI and independent-agent integration

Date: 2026-09-12. Packages: `@browser-bridge/protocol` 0.3.0,
`@browser-bridge/core` 0.3.0, `@browser-bridge/cli` 0.1.0 (new).
Wire version stays `"1.0"` (additive: `create` op, `capabilities`
result field, envelope helper).

## What landed

- `bridge serve --stdio`: one request per stdin line, one response per
  stdout line, sequential dispatch through the shared `Router`.
  Pino logs to stderr only; `tests/interoperability/stdio.test.ts`
  fails the build if any stdout line is not a schema-valid envelope.
- `bridge daemon start/stop/status`: loopback-only Fastify service
  (127.0.0.1, ephemeral port, 1 MB body limit) with a Bearer token
  rendezvous file (`$TMP/browser-bridge/daemon.json`, 0700/0600 best
  effort). All routes require the token, including health; Host must be
  loopback; CORS is never enabled, so webpages cannot call it.
  `stop` is synchronous: browser closed, port freed, file removed
  before the reply (a crash mid-stop leaves a stale file, which `start`
  detects via authenticated health probe and replaces).
- `bridge call [--stdin]`: one request to the daemon from any fresh
  shell process; exit 0 completed, 1 protocol error, 2 transport/daemon
  problem. `--stdin` avoids Windows quoting pitfalls.
- `bridge capabilities` (static, no browser), `bridge doctor`
  (runtime + Chromium executable + launch smoke; exit 0/1),
  `bridge status` (exit 0 with `{"running":false}` when stopped).
- Router: version negotiation precedes validation (`VERSION_UNSUPPORTED`
  echoes requestId); unknown ops and missing sessionIds are
  `INVALID_REQUEST`; engine codes map to stable
  `{outcomeUnknown, retryable}` via `ERROR_CONTRACT`. `create` has
  router-level requestId dedupe (5 min window); `capabilities`/`sessions`
  are read-only and safely repeatable.
- Daemon artifact delivery: `GET /v1/artifacts/:session/:id` serves
  session-owned PNG bytes after token auth (`core.artifactBytes`
  enforces session ownership, id shape, and directory containment).

## Gate evidence

- Two independently implemented clients complete the same fixture
  workflow live: `examples/node-stdio/workflow.mjs` (Node builtins,
  JSONL) and `examples/powershell/workflow.ps1` (PS 5.1 built-ins,
  daemon HTTP) — plus `examples/typescript/workflow.ts` (fetch).
  `tests/interoperability/examples.test.ts` runs each as a real child
  process against a `bridge`-on-PATH shim.
- Fresh-process session reuse: `daemon.test.ts` drives one session from
  in-test HTTP calls *and* a separate `bridge call` child process.
- `pnpm typecheck`, `test` (9), `test:contract` (7), `test:integration`
  (13), `test:interop` (9 run, 2 skipped), `pnpm build` — all exit 0.
  No orphan browser/daemon processes; shadow-guard clean.

## Client capability limits (honest report)

- Text-only callers get full semantic observations; screenshots arrive
  as filesystem paths (stdio, shared fs) or authenticated HTTP bytes
  (daemon). No caller is asked to "inspect" an image it cannot fetch —
  each response advertises only the delivery method that fits.
- `examples/python/workflow.py` (stdlib only) is published but
  **not executed here** — no Python on this Windows machine. It mirrors
  the proven Node client line-for-line; CI must run it where Python
  exists (test auto-runs when an interpreter is found).
- `examples/shell/workflow.sh` (POSIX + jq) is published but skipped on
  Windows; same CI requirement.
- Image-capable vs text-only MCP delivery is Phase 3; the daemon bytes
  endpoint is the interim path.

## Deferred

`--detach` for the daemon (foreground + `stop` cover scripts and tests),
per-command CLI conveniences beyond `call` (thin by design for agents),
MCP adapter (Phase 3), viewer (Phase 4).
