# Phase-1 notes: complete engine slice

Date: 2026-09-12. Packages: `@browser-bridge/protocol` 0.2.0,
`@browser-bridge/core` 0.2.0. Protocol wire version stays `"1.0"`:
all changes are additive (new `op` members, optional result fields),
so Phase-0 clients still validate.

## What landed

- Lifecycle: `sessions` list, `tab-open` / `tabs` / `tab-select` /
  `tab-close`. Requests without `tabId` follow the selected tab
  (`currentTabId`, falls back to first tab). Opening a tab selects it.
- Navigation: `navigate`, `back`, `forward`, `reload`. Empty history
  returns a warning, not an error.
- Actions: `press` (with optional target ref; without ref it types into
  the focused element), `select`, `check`, `scroll` (ref or page pixels),
  `hover`.
- Waiting: `wait` with `textVisible` / `urlContains` / `elementVisible`
  conditions, polled every 100 ms. Missed conditions throw
  `POSTCONDITION_TIMEOUT`; never a fixed sleep.
- Diagnostics: per-tab bounded ring buffers (50 entries, 500 chars each)
  for console/page errors, failed requests, and HTTP 4xx/5xx responses,
  attached at tab creation. Read via `diagnostics` (does not bump the
  observation revision).
- `act` envelope: executes one action, then an optional postcondition.
  Completion and outcome are reported separately:
  `postcondition.status` is `satisfied` | `timeout` | `not-requested`.
  A missed postcondition is data, not an error. `expectedRevision`
  rejects with `STALE_OBSERVATION` before acting.
- Cancellation: `cancel` bumps a per-session generation immediately
  (not queued). Queued work refuses to start afterwards; in-flight
  `wait` loops abort with `CANCELLED`. In-flight clicks/fills already
  delivered to the page cannot be undone — the response says so.
- Naming: accessible-name chain is now
  aria-label > associated `<label>` > text > value > placeholder,
  so labelled inputs keep stable names across edits.

## Gate evidence

`pnpm typecheck`, `pnpm test` (9/9), `pnpm test:integration` (13/13:
Phase-0 workflow + spike + 7 Phase-1 tests), `pnpm test:interop`
(placeholder), `pnpm build` (protocol + core) — all exit 0.
No orphan `chrome/chromium/headless_shell` processes after runs.
Negative cases: stale refs, duplicate labels (`TARGET_AMBIGUOUS`),
disabled controls, wait timeouts, stale `expectedRevision`.

## Incident: stray tsc output shadowing sources

Mid-phase, new-protocol tests failed against a *stale* schema while
typecheck stayed green. Cause: stray compiled files
(`packages/protocol/src/*.js`, plus `.js.map`/`.d.ts`) sitting next to
sources. With NodeNext `.js`-suffix imports, an exact `schema.js` match
wins over the `.ts` substitution, so tests imported stale JS while
`tsc` read the fresh `.ts`. Fix: deleted the strays, added
`scripts/check-shadows.mjs` (runs before every test script), and
git-ignored `src/**/*.js{,.map}` / `src/**/*.d.ts`. Lesson: never emit
without an `outDir`; the root tsconfig intentionally has none and every
package build sets one.

## Deferred (per plan)

Delta/visual/inspect observation modes, scoped search, visual overlays,
frames/popups as first-class tabs, file up/downloads, batch commands,
HTTP fixture with server-side write counting — Phase 5. JSONL stdio +
daemon + request dedup across transports — Phase 2. MCP adapter —
Phase 3. Viewer — Phase 4.
