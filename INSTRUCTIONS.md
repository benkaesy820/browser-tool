# Browser Tool Instructions

Use this tool to give agents a small, reliable browser interface. Prefer semantic observations and stable references over raw HTML, screenshots, or arbitrary selectors.

## Setup check

Run `npm ci`, then `npm run doctor`. If no candidate is available, run `npm run browsers:install` or provide a managed Chromium executable with `--executable`. The normal selection order is bundled Playwright Chromium, installed Chrome, installed Edge, then an explicit executable. `doctor` reports every attempted candidate so a missing browser is diagnosable instead of looking like an application failure.

The supported automatic path is Chromium-compatible. The tool uses Chromium CDP for network emulation and related diagnostics; Firefox and WebKit are not silently substituted because their behavior and feature support are not identical.

## Default agent loop

1. Start `browser-tool serve` once.
2. Send `open` with a URL.
3. Read the bounded observation and choose a control by its `ref`.
4. Send one `act` operation.
5. Observe again because references are invalidated after actions.
6. Close the session when finished.

Example:

```text
{"op":"open","sessionId":"app","url":"http://localhost:5173","maxItems":30,"maxText":500}
{"op":"act","sessionId":"app","action":"fill","ref":"e2","text":"hello"}
{"op":"act","sessionId":"app","action":"click","ref":"e3"}
{"op":"observe","sessionId":"app"}
{"op":"close","sessionId":"app"}
```

The observation is intentionally bounded. It includes page identity, headings, landmarks, visible text, control names/state, selectors as a fallback, semantic locator hints, and lightweight console/network diagnostics. Do not request raw page HTML unless a workflow explicitly needs evaluation. Every JSONL response echoes `requestId` and errors include a machine-readable `code`. Send `capabilities` first when the protocol is unknown; it exposes exact session/workflow actions, event names, safety modes, and default/maximum limits. After the first observation, use `mode:"delta"` and `since` to receive only changes; a stale baseline safely returns a full observation.

For asynchronous behavior, use `subscribe` and `watch` instead of repeatedly asking for the same state:

```text
{"requestId":"6","op":"subscribe","sessionId":"app","subscriptionId":"status-events","events":["navigation","watch.matched","network.error"]}
{"requestId":"7","op":"watch","sessionId":"app","watcherId":"saved","selector":"#status","containsText":"Saved","timeout":30000}
```

Event lines have `type:"event"` and an `eventId`; responses have `requestId`. The local transport intentionally remains JSONL over stdin/stdout. WebSocket/SSE is only appropriate when the browser is moved to a remote service. Watchers are mutation-event driven; their timeout prevents an infinite wait but is not the synchronization mechanism. A session accepts at most 32 subscriptions and 32 watchers.

## Command choice

- `capabilities`: browser-free protocol/action/event/limit discovery; use it before hard-coding a client.
- `doctor`: verify the available browser before a run.
- `serve` / `session`: persistent interactive browser work.
- `map`: one-shot semantic observation.
- `probe`: health, console, network, request-failure, broken-image, and accessibility checks.
- `qa`: probe plus responsive captures, optional mobile layout checks, and an optional workflow. Smoke is desktop-only unless a mobile preset is explicitly selected.
- `interact`: repeatable multi-step behavior with step-level evidence, downloads, dialogs, and permissions.
- `screenshot`: visual evidence for selected presets, elements, regions, hover states, or themes.
- `diff`: decoded PNG pixel comparison against a baseline.
- `layout`: mobile overflow and small tap-target check.
- `clean`: remove recognized screenshot, video, and trace artifacts; use `--all` only when the folder is disposable.

Use `--json` for agent consumption. Bound observations with `--max-items` and `--max-text`, and cap each response with `--max-output-chars` (20,000 by default). The CLI keeps non-boolean values as strings, which preserves numeric-looking tokens, cookies, paths, and selectors. Use `--ready=<css>` for an application-owned ready signal; fixed delays are optional and default to zero. Use `--ignore-urls=<patterns>` for known third-party diagnostic noise. Visual output, video, HTML reports, traces, and chaos testing are opt-in. For `qa`, use `--mode=smoke` for a fast desktop check, `standard` for desktop+mobile, or `release` for every viewport. QA reuses one browser process while preserving isolated contexts. Mobile tap-target findings are reported but do not fail QA unless `--max-small-tap-targets=<n>` is supplied.

Persistent sessions are limited to 8 and expire after 30 minutes of inactivity by default. Use `capabilities` to discover protocol limits before sending work.

## Authentication and privacy

Prefer `--auth=state.json` for saved cookies and local storage. `--token` and `--cookie` require a target URL and are scoped to that URL's origin. Never place long-lived secrets in workflows or logs when an auth state file is available. Use `--redact` before recording or taking screenshots of authenticated pages. Trace archives can include DOM snapshots and network details even when screenshots are redacted, so treat traces as sensitive evidence.

## Workflow rules

Workflows must contain at least one step. Use explicit actions instead of automatic form fuzzing:

- Navigation: `navigate` / `goto`
- Interaction: `click`, `fill` / `type`, `check`, `uncheck`, `select`, `press`, `hover`, `scroll`
- Synchronization: `wait`
- Verification: `assert`, `scrape` / `getText`
- Advanced flows: `upload` / `setInputFiles`, `dragAndDrop` / `drag`, `switchTab`, `mockRoute` / `mockApi`, `saveState`, `evaluate`, `download`, `dialog`, `permissions`, `screenshot`

Workflow input is validated before launch, capped at 200 steps and 2 MB, and rejects unknown actions or missing required fields.

Use `frame` when a target is inside an iframe. A `press` step with `selector` targets that element; a bare `scroll` moves to the bottom of the document. Use `soft` or `optional` only for non-critical assertions. Keep screenshots and recordings as explicit steps so normal agent runs remain cheap. The runner does not retry side-effecting actions unless explicitly configured with `retrySideEffects: true` or `--retry-side-effects`. Use `safetyMode:"safe"` or `--safe` for untrusted browser runs; add `allowedHosts` for approved cross-origin navigation. Safe mode applies to one-shot navigation and workflow runs, blocks unsafe file navigation, and validates generated artifact paths against the real workspace, including symlink/junction targets.

Use a `dialog` step immediately before the action that should open a JavaScript dialog. The runner fails if the expected dialog does not appear, including when the workflow ends after the dialog step. Use `download` with the selector that starts a download; it returns the saved path. Use `permissions` with an explicit HTTP origin, or `{ "clear": true }` to remove grants. Visual screenshots freeze animations and wait briefly for fonts/images unless `--no-freeze` is requested.

For local fixture navigation, use `file://{{cwd}}/fixtures/browser-playground.html`; do not hardcode a machine-specific checkout path.

## Failure handling

Treat a failed action or assertion as evidence, not as a successful flow. Inspect returned `stepResults`, `error`, `behavioralWarnings`, and live diagnostics before retrying. `--trace=on-failure` is the preferred debugging mode when a failure needs replayable evidence. Use `npx playwright show-trace <trace.zip>` to inspect it.

The public surface is intentionally narrow. Link crawling, API harvesting, PDF export, design-token extraction, component ripping, DOM search, workflow code generation, and generic auto-fill are not part of this tool. They produce broad or fragile output and distract from the agent loop; use the application's source tools or explicit workflow actions for those tasks.
