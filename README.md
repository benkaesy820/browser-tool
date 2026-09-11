# Browser Tool

An agent-first Playwright utility for persistent browser sessions, bounded semantic observations, health probes, responsive evidence, behavioral workflows, and visual diffs.

## Installation and browser policy

```bash
npm ci
npm run browsers:install
npm run doctor
```

The tool always uses Playwright's bundled Chromium — no channels, no fallback chain, no browser flags. `npm ci` installs the library while `npm run browsers:install` downloads the tested Chromium binary; `doctor --json` verifies it launches and reports `bundled-chromium`.

Several features use Chromium's CDP protocol, including network emulation, so Firefox and Safari/WebKit are not supported. The Playwright package is pinned to `1.62.1` in `package.json` and `package-lock.json` so the JavaScript API and browser expectations are repeatable.

## Start with a persistent session

```bash
browser-tool serve
```

Send one JSON object per line:

```json
{"requestId":"1","op":"open","sessionId":"app","url":"http://localhost:5173","maxItems":30}
{"requestId":"2","op":"act","sessionId":"app","action":"click","ref":"e3","observe":true,"mode":"delta"}
{"requestId":"2b","op":"batch","sessionId":"app","steps":[{"action":"fill","selector":"#email","text":"test@example.com"},{"action":"click","selector":"button[type=submit]"}],"observeAfter":"delta"}
{"requestId":"3","op":"observe","sessionId":"app","mode":"delta","maxText":500}
{"requestId":"4","op":"close","sessionId":"app"}
{"requestId":"5","op":"quit"}
```

Every response echoes `requestId`; errors include a machine-readable `code`. `open` and `observe` return page identity, headings, landmarks, bounded visible text, diagnostics, and interactive controls with stable references such as `e1`. References are invalidated after actions, but stale refs are auto-recovered when the element is unambiguous (identity re-match with element-id fingerprint verification, reported as `refRecovered`; every act also reports `actedOn`), and ambiguous or missing elements fail fast with an evidenced `STALE_REF` error. Use `--max-items` and `--max-text` to control token use.

Send `{"op":"capabilities"}` first when an agent needs the protocol version, supported session/workflow actions, observation modes, event names, safety modes, or limits. The response includes default limits and maximum guardrails so an agent can plan bounded requests without trial and error.

Use `mode:"delta"` on later session observations to receive only changed page fields and controls. `since` refers to the last observation generation; if it is stale, the tool safely falls back to a full observation.

Supported session actions include `click`, `fill`, `type`, `check`, `uncheck`, `select`, `selectOption`, `hover`, `press`, `scroll`, `navigate`, `goto`, `wait`, `assert`, `dialog`, `download`, `permissions`, and `screenshot`. Workflow-only actions additionally include `upload`, `setInputFiles`, `dragAndDrop`, `drag`, `switchTab`, `mockRoute`, `mockApi`, `saveState`, `scrape`, `getText`, and `evaluate`.

## Agent-loop efficiency features

These capabilities are part of the tool; `capabilities` advertises all of them.

**One round-trip act + observe (recommended default loop).** `act` accepts
`observe: true` and `mode: "delta"`:

```json
{"requestId":"7","op":"act","sessionId":"app","action":"click","ref":"e3","observe":true,"mode":"delta"}
```

The response carries `observation`, so the act → re-observe pair becomes one request.
This option existed but was undocumented; agents should use it after every action.

**Stale-ref auto-recovery.** Refs are invalidated after every act. When an act uses a
ref that is no longer current, the tool re-matches the element using the semantic
identity recorded at observation time (`role` + `name` + `nth` + group size). Recovery
only succeeds when the group size is unchanged, so a re-render can never silently
redirect an action. Recovered acts include `refRecovered`; everything else fails with
the evidenced `STALE_REF` error as before. Disable per request with `recoverRef: false`
or per session with `autoRecoverRefs: false` on `open`.

**`batch` — several acts in one request.** Sequential steps with per-step evidence and
stop-on-first-error by default:

```json
{"requestId":"8","op":"batch","sessionId":"app","steps":[
  {"action":"fill","selector":"#email","text":"test@example.com"},
  {"action":"click","selector":"button[type=submit]"},
  {"action":"assert","selector":"h1","containsText":"Dashboard"}
],"observeAfter":"delta"}
```

Selectors are the reliable addressing mode inside a batch because refs invalidate
after every act. Response: `status` (`ok`/`partial`/`error`), `steps[]`, `failedStep`,
`passedSteps`, optional inline `observation`. Maximum 25 steps.

**Observation views.** `observe` and `open` accept `view: "controls"` to skip text,
headings, and landmarks — roughly half the tokens for interaction-heavy loops.
`view: "standard"` (default) is unchanged.

**`tabs` — visible, controllable popups.** Sites that open popups already switch the
active page; now the tool also emits a `page.opened` event and provides
`{"op":"tabs","action":"list"|"switch"|"close","index":n}`. Closing the active tab is
rejected; switch first. Switching increments `generation` and clears refs.

**Coalesced diagnostics.** Repeated identical console/network diagnostics collapse into
one entry with a `count` field, so a page that logs the same error 50 times costs one
bounded entry.

**Gated session `evaluate`.** Open a session with `allowEvaluate: true` to use
`{"op":"act","action":"evaluate","fn":"(arg) => document.title","arg":42}` for debugging.
Still blocked in safe mode; `capabilities.optionalSessionActions` documents the gate.

**Idempotent close.** Closing an already-disposed (expired or double-closed) session
returns `{status:"closed","alreadyClosed":true}` instead of `SESSION_NOT_FOUND`, so
agent cleanup paths never need special cases. Never-existing ids still error.

**`sessions` discovery.** `{"op":"sessions"}` lists active sessions (id, url,
safetyMode, generation, expiry countdown, watcher counts) so an agent can recover after
a crash without guessing.

## Event-driven sessions

The local `serve` protocol is JSONL over stdin/stdout, so it does not need a socket, port, or polling loop. Subscribe to compact browser events and watch DOM conditions when the agent needs asynchronous updates:

```json
{"requestId":"6","op":"subscribe","sessionId":"app","subscriptionId":"errors","events":["navigation","console.error","network.error"]}
{"requestId":"7","op":"watch","sessionId":"app","watcherId":"saved","selector":"#status","containsText":"Saved","timeout":30000}
```

The tool can emit an interleaved event without a request ID:

```json
{"type":"event","eventId":"12","sessionId":"app","event":"watch.matched","generation":4,"data":{"watcherId":"saved","text":"Saved"}}
```

Event names are `navigation`, `navigation.blocked`, `console.error`, `console.warning`, `network.error`, `request.failed`, `page.crash`, `page.closed`, `dialog`, `download`, `watch.matched`, `watch.timeout`, and `watch.error`. A session is bounded to 32 subscriptions and 32 watchers.

Use `unsubscribe` and `unwatch` when the condition is no longer needed. Watchers use browser mutation events and have a timeout only as a safety ceiling. Do not stream raw DOM mutations by default; subscribe to semantic events or use a delta observation. If the browser is hosted remotely in the future, these same envelopes can be carried over WebSocket for two-way control or SSE for server-to-agent events.

## Lean one-shot surface

```bash
browser-tool doctor --json
browser-tool capabilities --json
browser-tool map http://localhost:5173 --json
browser-tool probe http://localhost:5173 --json
browser-tool qa http://localhost:5173 --json
browser-tool interact workflows/example.json --json
browser-tool screenshot http://localhost:5173 --preset=mobile --json
browser-tool diff http://localhost:5173 --baseline=baseline.png --preset=mobile --json
browser-tool layout http://localhost:5173 --preset=mobile --json
browser-tool clean --json
```

`capabilities --json` is browser-free and is the cheapest way to discover the
current protocol, exact actions/events, safety modes, and limits before choosing
between one-shot commands and a persistent session. The JSONL
`{"op":"capabilities"}` operation provides the same discovery for a running
`serve` process.

Useful reliability controls:

- `--ready='.app-loaded'` waits for an application-owned readiness signal.
- `--delay=250` adds an explicit post-readiness delay only when an animation needs it; the default is zero.
- `--max-concurrency=2` bounds simultaneous screenshot contexts.
- `--mode=smoke|standard|release` selects one desktop view, desktop+mobile, or all supported viewports for `qa` (standard is the default). Smoke skips mobile layout unless a mobile preset is explicitly selected.
- `--max-small-tap-targets=<n>` makes reported mobile tap-target findings a QA gate; without it, QA reports them without failing the run.
- `--no-freeze` keeps animations running; captures freeze transitions and wait for fonts/images by default to reduce flaky diffs.
- `--trace=on-failure` keeps a Playwright trace only when a workflow fails or has a warning.
- `--allow-warnings` keeps a soft workflow warning from becoming a failing CLI exit code.
- `--max-output-chars` caps one JSON response at a valid structured boundary (default: 20,000 characters).
- `--safe` disables workflow evaluation, blocks unapproved cross-origin and unsafe file navigation, and keeps one-shot/workflow artifacts, uploads, and downloads inside the workspace. Add `--allowed-hosts=host1,host2` for approved extra hosts.
- `--ignore-urls=pattern1,pattern2` filters known third-party diagnostic noise without hiding application errors by default.
- Persistent sessions are capped at 8 and expire after 30 minutes of inactivity by default; use `--max-sessions` and `--idle-timeout` when needed.

Use `--auth=state.json` for saved cookies/local storage. `--token` and `--cookie` require a target URL and are scoped to that URL's origin. Use `--redact` before screenshots or recordings of authenticated pages. Artifacts go into `screenshots/`, `recordings/`, and `traces/`; those paths are ignored by Git.

## Traces are optional debugging evidence

Normal browser operation does not require tracing. Enable it only while diagnosing a workflow:

```bash
browser-tool interact workflows/example.json --trace=on-failure --json
npx playwright show-trace traces/workflow-<timestamp>.zip
```

The trace viewer is provided by the pinned Playwright package; it is not a second browser engine and it is not needed for routine checks. Traces can contain DOM snapshots and network details. When `--redact` is enabled, tracing is blocked unless `--allow-sensitive-trace` is explicitly supplied; redaction does not rewrite trace archives.

## Workflow example

```json
{
  "preset": "desktop",
  "steps": [
    {"action":"navigate","url":"http://localhost:5173/login"},
    {"action":"fill","selector":"#email","text":"test@example.com"},
    {"action":"click","selector":"button[type=submit]"},
    {"action":"assert","selector":"h1","containsText":"Dashboard"}
  ]
}
```

Workflows support the action identifiers above, including iframes through `frame`. A `press` step with `selector` targets that element; a bare `scroll` moves to the bottom of the document. Put a `dialog` step immediately before the action that opens the dialog; it accepts or dismisses the next dialog and fails if none appears, including when the workflow ends early. Retry counts must be integers from 0 to 10. Non-idempotent actions are not retried unless `retrySideEffects` or `--retry-side-effects` is explicitly enabled. Use `safetyMode:"safe"` for untrusted workflows.

Workflow files are validated before browser launch, limited to 200 steps and 2 MB, and reject unknown actions or malformed required fields.

Safe workflow mode also validates the real filesystem path of generated videos, traces, failure snapshots, and saved state, including symlink/junction targets, before writing them. The CLI preserves non-boolean values as strings so numeric-looking tokens, cookies, paths, and selectors are not silently changed.

Example of browser-controlled side effects:

```json
[
  {"action":"dialog","type":"accept","promptText":"yes"},
  {"action":"click","selector":"#confirm"},
  {"action":"download","selector":"#export","dir":"./downloads"},
  {"action":"permissions","permissions":["geolocation"],"origin":"http://localhost:5173"}
]
```

`qa` launches one browser process and reuses it across probe, responsive, layout, and workflow checks. Each check still gets an isolated context, so the speedup does not merge cookies or page state between checks.

Local fixture workflows can use `file://{{cwd}}/fixtures/...`; the placeholder resolves to the current checkout, so the examples work on Linux, macOS, Windows, and PowerShell without editing a hardcoded path.

For visual regression, keep committed baselines under `tests/visual-baselines/`; runtime captures remain ignored. Use the same `--preset` or `--size` when creating and comparing a baseline.

## Development

```bash
npm ci
npm run test:cli
npm test
node --check browser-tool.mjs
```

The package intentionally does not include broad crawlers, API harvesters, PDF export, token extraction, component ripping, DOM search, workflow code generation, or automatic public form-filling. Those features create output and maintenance cost without improving the core agent loop; workflows can still perform explicit form actions safely.

Official Playwright references: [browser installation](https://playwright.dev/docs/browsers), [trace viewer](https://playwright.dev/docs/trace-viewer), and [tracing API](https://playwright.dev/docs/api/class-tracing).
