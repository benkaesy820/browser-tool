# Browser Tool Instructions (for agents)

`browser-tool` gives you a real Chromium-compatible browser through one CLI. Reach for it when eyes beat source: visual checks, tap targets, console/network evidence, and multi-step flows with assertions. For static facts (response shapes, API health without rendering), prefer `probe --json` or the repo's own checks first — do not open a browser to answer a non-visual question.

## 1. Setup (once per machine)

```bash
npm ci
npm run browsers:install
npm run doctor
```

The tool always uses Playwright's bundled Chromium — no channels, no fallback, no browser flags. `doctor --json` verifies the bundled browser launches and reports `bundled-chromium`; if it fails, re-run `npm run browsers:install`. Firefox/WebKit are not supported: network emulation and related diagnostics use Chromium CDP.

## 2. Discover before acting

Run `browser-tool capabilities --json` first when the protocol is unknown. It returns the exact session/workflow actions, event names, safety modes, and default/maximum limits — plan bounded requests from it instead of trial and error. The same discovery exists inside a running session as `{"op":"capabilities"}`.

## 3. The default loop (persistent session)

1. Start `browser-tool serve` once (JSONL over stdin/stdout — no ports, no polling).
2. Send `open` with a URL.
3. Read the bounded observation, pick a control by its `ref`.
4. Send `act` with `"observe": true, "mode": "delta"` — action plus fresh observation in one response.
5. Use `batch` (selectors, stop-on-error, per-step evidence) for multi-field forms.
6. `close` when finished. `close` is idempotent, and `{"op":"sessions"}` rediscovers live sessions after a crash.

```text
{"op":"open","sessionId":"app","url":"http://localhost:5173","maxItems":30,"maxText":500,"view":"controls"}
{"op":"act","sessionId":"app","action":"fill","ref":"e2","text":"hello"}
{"op":"act","sessionId":"app","action":"click","ref":"e3","observe":true,"mode":"delta"}
{"op":"close","sessionId":"app"}
```

Refs invalidate after every act. A stale ref is auto-recovered only when the element is provably unambiguous (same role + name + group size); recovery is reported as `refRecovered`, every act reports `actedOn`, and anything else fails fast with an evidenced `STALE_REF`. On `STALE_REF`, re-observe with `mode:"delta"` (cheap) — never retry the same dead ref. Disable recovery per act (`recoverRef:false`) or per session (`autoRecoverRefs:false`) only with a reason.

## 4. Command choice

- `capabilities`: browser-free protocol/limit discovery. Start here when unsure.
- `doctor`: verify a usable browser before a run.
- `serve`: persistent interactive work (the loop above).
- `map`: one-shot semantic observation of a URL.
- `probe`: health, console, network, request-failure, broken-image, and accessibility checks.
- `qa`: probe + responsive captures + optional mobile layout + optional workflow, sharing one browser process with isolated contexts. `--mode=smoke` (desktop only), `standard` (desktop+mobile, default), `release` (all viewports).
- `interact`: repeatable multi-step workflow file with step-level evidence. See `workflows/example.json` for the runnable shape (needs your app serving the referenced routes).
- `screenshot`: visual evidence for presets, elements, regions, hover states, themes.
- `diff`: pixel comparison against a committed baseline (keep baselines under `tests/visual-baselines/`, same `--preset`/`--size` for create and compare).
- `layout`: mobile overflow + small tap-target check for one preset.
- `presets`: list viewport presets, network profiles, QA modes.
- `clean`: remove recognized screenshot/video/trace artifacts (`--all` only when the folder is disposable).

Always pass `--json` for agent consumption.

## 5. Bounds (respect them, do not fight them)

- Observations: `--max-items` (default 40), `--max-text` (default 700); `view:"controls"` skips text/headings/landmarks (~half the tokens); `mode:"delta"` returns only changes after the first observation.
- One response is capped at `--max-output-chars` (default 20,000, cut at a structured boundary).
- `batch`: max 25 steps, stop-on-first-error by default, selectors inside batches (refs invalidate per act).
- Workflow files: validated before launch, max 200 steps and 2 MB, unknown actions rejected.
- Sessions: max 8 alive, 30-minute idle expiry (`--max-sessions`, `--idle-timeout` to adjust); max 32 subscriptions and 32 watchers per session.

## 6. Async without polling

For anything asynchronous, `subscribe` to semantic events (`navigation`, `console.error`, `network.error`, `request.failed`, `page.crash`, `page.closed`, `dialog`, `download`, `watch.matched`, `watch.timeout`, `watch.error`, …) and `watch` DOM conditions instead of re-asking for state. Watchers are mutation-event driven; the timeout is only a safety ceiling. `unsubscribe`/`unwatch` when done. Event lines carry `type:"event"` + `eventId`; responses echo `requestId`. Never stream raw DOM mutations. (WebSocket/SSE transports only matter if the browser ever moves remote.)

## 7. Reliability controls

- `--ready=<css>` waits for an app-owned readiness signal; `--delay=<ms>` only for animations that need it (default 0).
- `--ignore-urls=<patterns>` filters known third-party diagnostic noise.
- `--no-freeze` keeps animations running; by default captures freeze transitions and wait for fonts/images.
- `--max-concurrency=<n>` bounds simultaneous screenshot contexts.
- `--max-small-tap-targets=<n>` turns tap-target findings into a QA gate (report-only otherwise).
- `--trace=on-failure` keeps a Playwright trace only on failure/warning; inspect with `npx playwright show-trace <zip>`.
- `--allow-warnings` keeps a soft workflow warning from failing the exit code.

## 8. Auth, safety, privacy

- Prefer `--auth=state.json` (saved cookies/storage). `--token`/`--cookie` require a target URL and scope to its origin.
- `--safe` disables workflow evaluation, blocks unapproved cross-origin and unsafe file navigation, and confines artifacts/uploads/downloads to the workspace (+ `--allowed-hosts` for extras).
- `--redact` before screenshots/recordings of authenticated pages. Traces can contain DOM snapshots and network details even when redacted — treat them as sensitive, and note tracing stays blocked under `--redact` unless `--allow-sensitive-trace` is given.

## 9. Workflow rules

- At least one step; explicit actions only — no crawlers, fuzzing, or auto-fill.
- Navigation (`navigate`/`goto`), interaction (`click`, `fill`/`type`, `check`, `uncheck`, `select`, `press`, `hover`, `scroll`), sync (`wait`), verify (`assert`, `scrape`/`getText`), advanced (`upload`, `drag`/`dragDrop`… see `capabilities`; `frame` for iframes).
- Put a `dialog` step immediately before the action that opens the dialog; it fails if none appears.
- Non-idempotent actions never retry unless `retrySideEffects` is explicit. `soft`/`optional` only for non-critical assertions. Keep screenshots/recordings as explicit steps so normal runs stay cheap.
- Treat a failed step as evidence: read `stepResults`, `error`, `behavioralWarnings`, and live diagnostics before retrying (see circuit-breaker discipline in the repo `AGENTS.md`/skill set — no third blind retry).

## 10. What this tool refuses

Link crawling, API harvesting, PDF export, design-token extraction, component ripping, DOM search, workflow code generation, and generic form auto-fill are intentionally absent. They produce broad, fragile output; use application source tools or explicit workflow actions instead.
