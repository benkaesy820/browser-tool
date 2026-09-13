# Phase-4 notes: shared viewer and human handoff

Date: 2026-09-12. Packages: `@browser-bridge/protocol` 0.5.0,
`@browser-bridge/core` 0.5.0, `@browser-bridge/cli` 0.3.0,
`@browser-bridge/mcp` 0.2.0, `@browser-bridge/viewer` 0.1.0 (new).
Wire version stays `"1.0"` (additive only).

## Takeover model

- Sessions carry `{paused, owner: agent|human, ownerSince}`. `pause`
  (optional `timeoutMs` auto-resume, 5 s–10 min) rejects agent mutations
  with `SESSION_PAUSED` (retryable); reads (`observe`, `screenshot`,
  `diagnostics`, lists) stay available so the agent can watch.
  `resume` refreshes the tab and returns the human's final state.
- The human coordinate channel (`clickAt` with screenshot revision,
  `type`, ref-less `press`) is allowed during a hold; everything else
  serializes on the same per-session queue, so human and agent input
  can never bypass each other — only take turns.
- Refs are now revision-qualified (`el-<rev>-<n>`, plan §5 rule 3). A
  refresh retires every previously issued string, which closes the
  positional-shift wrong-target hole (row deleted above → old `el-2`
  can no longer silently address a new occupant). Agents chain the refs
  from the latest result; violations get `STALE_OBSERVATION` with a
  retry hint. One pre-existing test chained across a refresh and was
  fixed to the new contract.

## Viewer (`bridge viewer`, served by the daemon)

- React 18 + Vite, dark ops console (agent-blue / human-amber ownership
  language), system type only. Left rail sessions/tabs, center
  screenshot preview (focal point) with freshness/stale banners and
  takeover banner, right rail timeline/observation/diagnostics/annotations.
- Same-origin API with an in-memory token (fragment-supplied, never
  stored); static shell loads unauthenticated on loopback, every data
  route needs Bearer. Screenshots render from fetched artifact bytes
  (never an embedded third-party iframe).
- Click-to-act, drag-to-annotate (revision-pinned notes agents read via
  the `annotations` op), type/key senders with automatic screenshot
  refresh on stale geometry. Annotations capped at 100/session.
- `bridge daemon start --headed` drives a visible Chromium (proven live
  on Windows; `BRIDGE_TEST_HEADED=1` runs the headed integration test,
  skipped headless). Screenshots capture at CSS scale so viewer pixels
  map 1:1 to `clickAt` coordinates.
- Live timeline over `GET /v1/events` (fetch stream; EventSource cannot
  send auth headers): ordered `seq`, cursor replay, `gap` on retention
  overflow (500, configurable via `eventCap`), 15 s heartbeats.

## Gate evidence

Pause → human types + submits through the same queue → agent mutation
rejected → resume → agent observes the human's result on the same tab —
proven at contract level, over viewer HTTP, and by driving the real
React UI (new session → takeover → resume → timeline) with Playwright.
`typecheck`, `test` (9), `test:contract` (25), `test:integration` (14
incl. headed), `test:interop` (18 run, 2 skipped), `pnpm build`
(viewer bundle included) — all exit 0. No orphans, no stale files.

## MCP parity and limits

- New `browser_takeover` tool (pause/resume/status); `browser_act`
  accepts `clickAt`/`type`; `browser_observe` reports lease state.
  Annotation *writing* stays viewer/JSONL-side for now; MCP agents see
  paused-lease errors (retryable) and poll `observe` until resume.
- Coordinated multi-client sharing of one browser process across MCP +
  daemon transports is deployment-defined (each server owns its engine);
  the contract is transport-independent either way.
- Deferred to Phase 5: frames/popups as tabs, delta/visual/inspect
  modes, uploads/downloads, screencast (snapshots suffice per measured
  need), annotation deletion.
