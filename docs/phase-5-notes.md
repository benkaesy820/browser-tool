# Phase-5 notes: difficult pages and operational resilience

Date: 2026-09-12. Packages: `@browser-bridge/protocol` 0.6.0,
`@browser-bridge/core` 0.6.0, `@browser-bridge/cli` 0.4.0,
`@browser-bridge/mcp` 0.3.0. Wire version stays `"1.0"` (additive only).

## Difficult pages

- **Frames are first-class**: collection spans all frames; controls carry
  `frame` ids with a `frames` table (url/name/error); resolution matches
  within the ref's own frame, so identical controls in two frames are
  `TARGET_AMBIGUOUS`, never first-picked. Observation text includes framed
  content. Cross-origin frame collection degrades per-frame with an
  explicit error entry, never a silent drop.
- **Popups auto-register** as tabs via a deferred context listener (250 ms
  so `createTab`'s own pages are not double-adopted); self-closed pages
  leave the registry. Verified: click `target=_blank` → poll tabs →
  select → read popup.
- **Dialogs auto-dismiss** (alert/confirm/prompt) so an unhandled dialog
  can never deadlock a session; type/message recorded in diagnostics and
  the event timeline.
- **Shadow DOM**: open roots pierce (proved live); closed roots are
  absent from observations (disclosed, not advertised).
- **Overlays**: Playwright actionability timeouts map to
  `TARGET_NOT_ACTIONABLE` (not `BROWSER_CRASHED`); the observation still
  shows the covering modal as actionable evidence.
- **Virtualized lists**: `scroll` with a ref wheels over the element
  (container scroll), so windowed rows render on demand; proven by
  scrolling a 1000-row windowed feed to row 999 and clicking it.
- **Redirects**: post-navigation scheme validation covers HTTP,
  meta-refresh, and scripted hops (`POLICY_DENIED` on escape).

## Observation power tools

- `delta` (bounded 10-snapshot history; expiry returns a full snapshot
  with `resetReason`), `inspect` (role/attributes/geometry/visibility
  against the current registry — observe first), `visual` (numbered
  overlay table + optional screenshot; pixel-baking deferred, the table
  serves viewers and vision agents alike), `search` (refresh, then
  substring match with immediately usable refs), `locate` (CSS-pixel box).
- `batch` (≤20 actions, one observation, per-step outcomes, optional
  postcondition, cancellation between steps) and explicit `upload`
  (caller-supplied path, must exist, ≤25 MB) / download capture into
  the session artifact area with `diagnostics.downloads`.
- Screenshots accept `maskRefs` (Playwright-native redaction); logged
  request URLs are query-stripped (`sanitizeUrl`); screenshots capture
  at CSS scale so viewer pixels equal `clickAt` coordinates.

## Crash integrity (the gate)

- Write-ahead journal (`artifacts/journal.jsonl`, op + ids only, never
  values): begun-but-uncompleted ids answer `OUTCOME_UNKNOWN` after a
  restart instead of re-executing; pre-effect failures complete normally.
  Same-id concurrent dispatches coalesce onto one execution.
- Proven live: submit into a server-held request → kill the daemon →
  restart → retry same id → `OUTCOME_UNKNOWN`, fixture server counts
  exactly one write. The crash-safe submission pattern is documented:
  clicks settle on dispatch; `act` + postcondition (or `wait`) is what
  stays in flight and therefore what recovery can reason about.
- Browser death (not via shutdown) reports `BROWSER_CRASHED` fast via a
  per-session death flag + `browser-died` event (no `TAB_NOT_FOUND`
  masking, no hangs); `launch()` auto-relaunches for new sessions.
- Persistent profiles (`create` + `profile`, cookie-proven across
  close/reopen) live outside the repo with pid locks (live holder
  rejects, stale lock reclaimed); locks release on close/shutdown.
- Retention: session dirs are removed on close and shutdown (with
  Windows file-lock retries — scanners briefly lock fresh screenshots);
  `launch()` sweeps crash leftovers past the TTL; journal rotates to
  uncertain-only. Two transport bugs found by the residue hunt and fixed:
  the stop client sent `content-type: application/json` with an empty
  body (Fastify 400, shutdown never ran), and `app.close()` before
  `reply.send()` deadlocked on the client's own keep-alive connection.
  `daemon stop` now reports `{ok, cleaned, failed}` in under a second.

## Evidence

`typecheck`, `test` (9), `test:contract` (44: router 8, takeover 5,
MCP 9, resilience 22), `test:integration` (13), `test:interop` (19 run:
stdio 2, MCP 5, daemon 4, viewer 4, examples 3, recovery 1), `pnpm build` — all exit 0.
Every write assertion reads the fixture server's counters, never page
text. No orphans, no stale daemon files.

## Deferred

Baked-in overlay pixels (needs a native imaging dep; table suffices),
screencast (snapshots suffice per measured need), annotation deletion,
remote MCP transport, hosted multi-tenant isolation (contexts are not a
security boundary — stated since Phase 0).
