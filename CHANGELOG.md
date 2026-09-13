# Changelog

All notable changes to Browser Bridge. The wire protocol stays at `1.0`
unless stated otherwise; package versions are independent.

## [Unreleased]

### Added (protocol/core 0.7.0 / cli 0.5.0 / mcp 0.4.0 / viewer 0.2.0)

- Plain CLI browser verbs persist the selected session across shell
  commands and support `--session`, `--tab`, and raw `--json` output.
- Headed pointer actions use visible smooth cursor travel; headless
  execution keeps the existing direct behavior.
- Full mouse channel through `act`: revision-bound move, two-axis wheel at a
  point, drag, right/middle button, and multi-click. Wheel input accelerates
  and settles while preserving the exact requested deltas.
- `bridge events` exposes the authenticated SSE stream as JSON Lines. SSE now
  uses standard event ids and `Last-Event-ID` resume; the viewer updates from
  events instead of five-second polling or periodic forced reconnects.
- Additive wire `1.0` `viewport` operation supports mobile (`390x844`),
  tablet (`820x1180`), desktop (`1440x900`), and bounded custom sizes.
  It is available through the CLI, MCP `browser_tabs`, and viewer.
- `viewport` gains `keepWindow` (DevTools-style page pin, OS window
  untouched; captures cover exactly the pinned area, masks rejected
  while pinned) and `free` (clear the override), via
  `bridge viewport <size> --keep-window` / `bridge viewport free` and
  matching MCP fields.
- `screenshot` gains `fullPage` (`bridge shot --full`): stitched
  full-document capture with honest content dimensions; the default
  stays the visible viewport, which is what the watcher sees.
- Headed audit cursor: a red ring paints from the first observation,
  glides with the pointer, pulses on click, and hides for captures.
- Navigations auto-reject cookie-consent walls (reject-only buttons;
  never accepts tracking) and report the dismissal; late walls met
  mid-flow are rejected once with a single action retry, accept-only
  walls are left for a human choice.

### Fixed (post-0.6.0/0.4.0)

- core 0.6.1 / cli 0.4.1: failed `createSession` no longer leaks its
  artifact directory; `shutdown()` reports removed/failed dirs;
  `daemon stop` verifies the real shutdown reply (bodiless JSON POSTs no
  longer 400; no keep-alive deadlock on close).
- cli 0.4.1: `doctor` checks the Chromium executable exists instead of
  trusting the computed path.
- cli 0.5.0: `open` replaces a stale remembered session (e.g. after a
  daemon restart) and retries once instead of failing `SESSION_NOT_FOUND`.
- core 0.7.0: headed Chromium launches with
  `--force-device-scale-factor=1`, so the visible window tracks the
  viewport exactly on scaled displays (e.g. 125%) instead of clipping
  page content off-screen.
- core 0.7.0: headed sessions start with a free window (`viewport: null`)
  so the page fills the window and follows OS drags/resizes like a normal
  browser; `viewport` pins an exact size on demand.
- core 0.7.0: actionability timeouts now name the covering overlay
  (hit-tested, works for role-less walls too) and offer
  current-observation dismiss refs, e.g. `likely covered by dialog
"Before you continue" — dismiss with el-2-17 (Reject …)`.
- core 0.7.0: headed windows render at the normal OS scale again, with a
  visible red audit ring that glides between targets and pulses on click.
  Follow-mode `viewport` ops measure the window chrome live and fit the
  OS window around the exact page size (warnings, never silent, when the
  window cannot be fitted).

## [0.6.0] — 2026-09-12 (protocol, core) / cli 0.4.0 / mcp 0.3.0

### Added (Phase 5: difficult pages and operational resilience)

- Frame-aware targeting: collection spans all frames, controls carry
  `frame` ids with a `frames` table, resolution matches within the ref's
  own frame. Observation text includes framed content.
- Popups auto-register as tabs; self-closed pages leave the registry.
- Dialogs auto-dismiss with records in diagnostics and the timeline.
- `upload` op/action (explicit caller-supplied file, 25 MB bound);
  downloads captured to session storage and listed in diagnostics.
- `batch` op (≤20 actions, one observation, per-step outcomes,
  postcondition, cancellation between steps).
- Observation modes: `delta` (bounded history + expiry resets),
  `inspect` (attributes/geometry), `visual` (numbered overlay table +
  optional screenshot); `search` with immediately usable refs; `locate`
  boxes; screenshot `maskRefs`; sanitized diagnostic URLs.
- Write-ahead journal with cross-restart `OUTCOME_UNKNOWN`, same-id
  in-flight coalescing, per-session browser-death flags with
  `browser-died` events, launch auto-recovery.
- Persistent profiles (`create` + `profile`, pid locks, cookie-proven).
- Retention: close/shutdown removal with lock retries, launch sweep,
  journal rotation. `daemon stop` reports verified cleanup.
- Refs are revision-qualified (`el-<rev>-<n>`); actionability timeouts
  map to `TARGET_NOT_ACTIONABLE`.
- MCP: `browser_batch`, `browser_search`, `upload` action, observe modes.

## [0.5.0] — 2026-09-12 (protocol, core) / cli 0.3.0 / mcp 0.2.0 / viewer 0.1.0

### Added (Phase 4: shared viewer and human handoff)

- Takeover lease: `pause`/`resume` ops, `SESSION_PAUSED` rejections,
  human coordinate channel (`clickAt`, `type`), session state on results.
- React viewer served by the daemon with SSE timeline, annotations,
  manual input, and takeover controls; `bridge viewer` command.
- MCP `browser_takeover` tool; `daemon stop` is synchronous.
- Headed mode (`--headed`) across serve/daemon/mcp.

## [0.4.0] — 2026-09-12 (protocol, core) / cli 0.2.0 / mcp 0.1.0

### Added (Phase 3: MCP compatibility)

- MCP adapter on the official SDK (spec 2025-06-18): 10 tools,
  observation/screenshot resources, image delivery, client cancellation.
- `bridge mcp --stdio`; `act` supports back/forward/reload.

## [0.3.0] — 2026-09-12 (protocol) / cli 0.1.0

### Added (Phase 2: CLI integration)

- `bridge serve --stdio` (JSONL), loopback daemon (`start/stop/status`),
  `bridge call`, `capabilities`, `doctor`, `status`; `create` op; stable
  error envelopes with version negotiation; Node/PowerShell/TypeScript/
  Python/shell example clients.

## [0.2.0] — 2026-09-12 (protocol, core)

### Added (Phase 1: complete engine slice)

- Sessions/tabs lifecycle, navigation/history, press/select/check/scroll/
  hover, explicit waits, diagnostics, `act` envelope with postconditions,
  cancellation, request-id dedupe.

## [0.1.0] — 2026-09-12

### Added (Phase 0: foundation)

- Protocol v1 drafts, Playwright/Chromium engine with opaque refs,
  `open/observe/click/fill/screenshot/close`, fixture workflow, Vitest
  suites, pnpm workspace with strict TypeScript.
