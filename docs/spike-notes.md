# Phase-0 spike notes (gate record)

Date: 2026-09-12. Clean-machine steps: `pnpm install`,
`pnpm --filter @browser-bridge/core exec playwright install chromium`,
`pnpm typecheck`, `pnpm test`, `pnpm test:integration`.

## Proven with Playwright 1.49.1 / Chromium 131

- Semantic refs: positional CSS-selector registry (`el-<revision>-<n>`,
  revision-qualified since Phase 4) + role/name revalidation before each
  action. Duplicate labels rejected with `TARGET_AMBIGUOUS`; detached
  targets and previous-revision strings rejected with
  `STALE_OBSERVATION`; disabled targets rejected with
  `TARGET_NOT_ACTIONABLE`. Covered by `tests/integration/workflow.test.ts`.
- Screenshot: `page.screenshot()` saved to owned `artifacts/<session>/`,
  8 MB bound enforced, path-traversal rejected.
- Popup: `context.waitForEvent("page")` registered before click captures the
  new page; popup DOM readable. Engine does NOT yet auto-register popup
  pages as tabs — Phase 5 work.
- Iframe: same-origin `frameLocator("#inner-frame")` reads inner text.
  Cross-origin, PDF, closed-shadow-root, and canvas targets untested.

## Unsupported snapshot assumptions (do not rely on these)

- Playwright ARIA snapshots do not hand out stable clickable refs; we do
  not parse snapshot strings for targeting.
- Browser-internal node IDs are not stable across navigation; refs are
  engine-issued per observation revision.
- Closed shadow roots and canvas pixels are not addressable. Visual
  coordinate fallback is deferred to Phase 5 and must carry screenshot
  revision + viewport geometry.
- `file://` fixtures prove the interaction loop only. Server-side write
  counting (duplicate-submit safety) needs an HTTP fixture — Phase 5 gate.
