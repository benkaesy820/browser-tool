# Browser Tool Instructions (for agents)

`browser-tool` gives you a real Chromium-compatible browser through one CLI. Reach for it when eyes beat source: visual checks, tap targets, browser console/network evidence, and multi-step flows with assertions. For API-only or source-level questions, prefer repository checks or an HTTP client; use `probe` when browser-originated evidence matters.

## 1. Setup (once per machine)

```bash
npm ci
npm run browsers:install
npm run doctor
```

The tool always uses Playwright's bundled Chromium — no channels, no fallback, no browser flags. `doctor --json` verifies the bundled browser launches and reports `bundled-chromium`; if it fails, re-run `npm run browsers:install`. Firefox/WebKit are not supported: network emulation and related diagnostics use Chromium CDP.

## 2. Discover before acting

Run `browser-tool capabilities --json` first when the protocol is unknown. It returns the exact session actions, event names, safety modes, and default/maximum limits — plan bounded requests from it instead of trial and error. The same discovery exists inside a running session as `{"op":"capabilities"}`.

## 3. The default loop (persistent session)

1. Start `browser-tool serve` once (JSONL over stdin/stdout — no ports, no polling).
2. Send `open` with a URL.
3. Read the bounded observation, pick a control by its `ref`.
4. Send `act` with `"observe": true, "mode": "delta"` — action plus fresh observation in one response.
5. Use `batch` (selectors, stop-on-error, per-step evidence) for multi-field forms.
6. `close` when finished. Closing an already-disposed session is idempotent; an unknown ID still fails so typos remain visible. `{"op":"sessions"}` rediscovers live sessions after a crash.

```text
{"op":"open","sessionId":"app","url":"http://localhost:5173","maxItems":30,"maxText":500,"view":"controls"}
{"op":"act","sessionId":"app","action":"fill","ref":"e2","text":"hello"}
{"op":"act","sessionId":"app","action":"click","ref":"e3","observe":true,"mode":"delta"}
{"op":"close","sessionId":"app"}
```

Refs invalidate after every act. A stale ref is auto-recovered only when the element is provably unambiguous (same role + name + group size); recovery is reported as `refRecovered`, every act reports `actedOn`, and anything else fails fast with an evidenced `STALE_REF`. On `STALE_REF`, re-observe with `mode:"delta"` (cheap) — never retry the same dead ref. Disable recovery per act (`recoverRef:false`) or per session (`autoRecoverRefs:false`) only with a reason.

## 4. Command choice

- `capabilities`: browser-free protocol/limit discovery. Start here when unsure.
- `doctor`: verify the bundled browser after setup, environment changes, or a launch failure. A successful check proves browser launch only.
- `serve`: persistent interactive work (the loop above).
- `map`: one-shot semantic observation of a URL.
- `probe`: health, console, network, request-failure, broken-image, and accessibility checks.
- `qa`: probe + responsive captures + optional mobile layout, sharing one browser process with isolated contexts. `--mode=smoke` (desktop only), `standard` (desktop+mobile, default), `release` (all viewports).
- `screenshot`: visual evidence for presets, elements, regions, hover states, themes.
- `diff`: pixel comparison against a trusted, versioned baseline for regression claims (use the same `--preset`/`--size`; label ad hoc comparisons accordingly).
- `layout`: mobile overflow + small tap-target check for one preset.
- `presets`: list viewport presets, network profiles, QA modes.
- `clean`: remove recognized screenshot artifacts (`--all` only when the folder is disposable).

Always pass `--json` for agent consumption.

Evidence has boundaries: `map` proves only the bounded semantic content returned; `probe` proves only its collected diagnostics; a session flow proves only its explicitly asserted path; and a screenshot is visual evidence only after the image is inspected. Record the command, exit status, URL, viewport, warnings/truncation, assertions, and artifact path. If output is truncated, narrow the request and rerun instead of claiming complete coverage.

## 5. Bounds (respect them, do not fight them)

- Observations: `--max-items` (default 40), `--max-text` (default 700); `view:"controls"` skips text/headings/landmarks (~half the tokens); `mode:"delta"` returns only changes after the first observation.
- One response is capped at `--max-output-chars` (default 20,000, cut at a structured boundary).
- `batch`: max 25 steps, stop-on-first-error by default, selectors inside batches (refs invalidate per act).
- Sessions: max 8 alive, 30-minute idle expiry (`--max-sessions`, `--idle-timeout` to adjust); max 32 subscriptions and 32 watchers per session.

## 6. Async without polling

For anything asynchronous, `subscribe` to semantic events (`navigation`, `console.error`, `network.error`, `request.failed`, `page.crash`, `page.closed`, `dialog`, `download`, `watch.matched`, `watch.timeout`, `watch.error`, …) and `watch` DOM conditions instead of re-asking for state. Watchers are mutation-event driven; the timeout is only a safety ceiling. `unsubscribe`/`unwatch` when done. Event lines carry `type:"event"` + `eventId`; responses echo `requestId`. Never stream raw DOM mutations. (WebSocket/SSE transports only matter if the browser ever moves remote.)

## 7. Reliability controls

- `--ready=<css>` waits for a reliable app-owned settled-state signal. Omit it when testing loading/error states. Screenshots already settle for 250 ms; increase `--delay` only when evidence shows late rendering needs longer.
- Screenshots default to full-page with a 250 ms settle delay. Use `--fullpage=false` / `fullPage:false` for sticky UI, overlays, clipping, responsive composition, and above-the-fold behavior; use `--delay=0` only when the page is already settled.
- `--ignore-urls=<patterns>` filters known third-party diagnostic noise.
- `--no-freeze` keeps animations running; by default captures freeze transitions and wait for fonts/images.
- `--max-concurrency=<n>` bounds simultaneous screenshot contexts.
- `--max-small-tap-targets=<n>` turns tap-target findings into a QA gate (report-only otherwise).

## 8. Auth, safety, privacy

- Prefer `--auth=state.json` (saved cookies/storage). `--token`/`--cookie` require a target URL and scope to its origin.
- Treat user-provided public URLs as untrusted. `--safe` disables session evaluation, blocks unapproved cross-origin and unsafe file navigation, and confines artifacts/downloads to the workspace; add only the smallest necessary `--allowed-hosts` list for approved extra origins.
- `--redact` before screenshots of authenticated pages.

## 9. Multi-step flow rules

- Keep one `serve` process alive; use sequential `act` requests or `batch` for bounded groups of actions instead of writing workflow files.
- Use selectors within a batch because refs invalidate after each action. Assert important outcomes and retain per-step responses as evidence.
- Use `watch`/`subscribe` for asynchronous transitions. Treat a failed action or assertion as evidence and inspect diagnostics before retrying.

## 10. What this tool refuses

File-based workflows, link crawling, API harvesting, PDF export, design-token extraction, component ripping, DOM search, code generation, and generic form auto-fill are intentionally absent. They produce broad, fragile output; use application source tools or explicit session actions instead.
