# Protocol v1 (wire `1.0`)

Every request carries `protocolVersion`, a client-chosen `requestId`
(retry-safe within documented windows), and usually `sessionId`/`tabId`.
Every success carries `status: "completed"` plus a fresh observation
where applicable; every failure is an `error` envelope with `code`,
`message`, `outcomeUnknown`, and `retryable`.

## Versioning

`protocolVersion` is negotiated before validation: anything but `"1.0"`
fails as `VERSION_UNSUPPORTED` with the request id echoed. All growth so
far is additive (new ops, optional fields); wire `1.0` has never broken.

## Operations

Sessions/tabs: `create` (+`profile`), `sessions`, `tabs`, `tab-open`,
`tab-close`, `tab-select`, `viewport`, `close`, `cancel`.
Navigation: `open`, `navigate`, `back`, `forward`, `reload`.
Actions: `click`, `fill`, `press`, `select`, `check`, `scroll`, `hover`,
`upload`, `clickAt`, `moveAt`, `scrollAt`, `dragAt`, `type` (the
coordinate/focused actions are via `act`). Clicks accept `button` (`left`,
`right`, `middle`) and `clickCount` (1..3), including direct `click` requests.
Verification: `observe` (`controls/summary/delta/visual/inspect`),
`wait`, `diagnostics`, `screenshot` (+`maskRefs`), `locate`, `search`,
`batch`, `act` (+postcondition, `expectedRevision`).
Handoff: `pause`, `resume`, `annotations`.

`capabilities` needs no session and lists ops, `actionTypes`, observation
modes, delivery methods, and limits. Agents can discover the complete input
vocabulary without vendor-specific assumptions.

## Observations, refs, and targeting

An observation carries revision, sanitized URL, title, bounded text,
controls (`ref`, `role`, accessible `name`, `frame`, state), a frames
table, truncation metadata, and the lease (`session`).
Refs are revision-qualified: valid only for the issuing revision.
Before acting, the engine re-resolves the target (unique, actionable,
same frame) and rejects detached/ambiguous/disabled/stale targets with
evidence and a fresh observation. Coordinate actions additionally bind the
screenshot revision and viewport; stale geometry is rejected. `moveAt` moves
without clicking, `scrollAt` wheels at a specific point with two-axis deltas,
and `dragAt` accepts `from` and `to` points and always releases the mouse
button.

## Viewports

`viewport` accepts either `preset: "mobile"|"tablet"|"desktop"` or a
custom `width` and `height` supplied together. Presets resolve to
`390x844`, `820x1180`, and `1440x900`; custom bounds are `320..3840` by
`320..2160`. `tabId` is optional and defaults to the selected tab. A
successful resize returns a fresh observation. This operation is an
additive wire `1.0` extension.

`keepWindow: true` pins the page to the size without resizing the OS
window (DevTools device-mode style: responsive layout only, no
user-agent, touch, or physical-device emulation). Captures then cover
exactly the pinned area, and `screenshot` rejects `maskRefs` while
pinned (masks need Playwright's own capture path). `free: true` clears
an override and takes no size: the page returns to the free window when
the tab never took a follow-size, else to the last follow-size. Headed
sessions start window-free, so the page fills the window and follows OS
drags/resizes until `viewport` pins a size.

`screenshot` captures the visible viewport by default; `fullPage: true`
stitches the full scrollable page (also under a pin, at the pinned
width). Bounds (8 MB) still apply.

## Errors (stable codes)

`INVALID_REQUEST`, `VERSION_UNSUPPORTED`, `SESSION_NOT_FOUND`,
`TAB_NOT_FOUND`, `STALE_OBSERVATION`, `TARGET_AMBIGUOUS`,
`TARGET_NOT_ACTIONABLE`, `TARGET_NOT_FOUND`, `POSTCONDITION_TIMEOUT`,
`POLICY_DENIED`, `SESSION_PAUSED`, `BROWSER_CRASHED`, `CANCELLED`,
`OUTCOME_UNKNOWN`. Retryable ones say how (`re-observe`, `verify
externally`, `wait for resume`). A missed postcondition is _data_
(`status: "timeout"`), not an error.
