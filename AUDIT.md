# Browser Tool Audit — Agent Workload Review (v2.3.1)

Audited: `browser-tool.mjs` (4,017 lines), `README.md`, `INSTRUCTIONS.md`, both test suites, CI workflow.
Baseline: all 27 tests passed before any change. **The original file was NOT modified.**

All improvements live in the copy **`browser-tool.next.mjs`** with its own regression suites
(`test/next.browser-tool.test.mjs`, `test/next.cli.test.mjs`) and new tests
(`test/next.improvements.test.mjs`, or `npm run test:next`).

**Copy test status: 32/32 passing (19 API + 8 CLI + 5 new improvement tests).**

---

## 1. What the tool already does well (do not lose these)

These are genuinely agent-workload-reducing design choices. Any future change must preserve them:

- **Bounded observations** (`maxItems`/`maxText`/`maxOutputChars`) with hard truncation metadata — keeps a page observation from flooding the context window.
- **Machine-readable error codes** (`BrowserToolError.code`) on every JSONL error — an agent can branch on `STALE_REF` / `SESSION_EXPIRED` / `NAVIGATION_BLOCKED` without parsing prose.
- **`capabilities` op** — browser-free protocol discovery; no trial-and-error against limits, the agent reads defaults/maxima up front.
- **Delta observations** (`mode:"delta"` + `since`, safe fallback to full) — re-observing after each act costs a fraction of a full snapshot.
- **Event subscriptions + DOM watchers** instead of poll loops — removes the #1 source of wasted agent turns (repeated "is it done yet?" probes).
- **Refs invalidated after every act** (`requiresObserve:true`) — honest contract: stale refs are never silently mis-clicked.
- **Resilient browser fallback chain** (bundled Chromium → Chrome → Edge) + `doctor` — environment problems are diagnosable, not mysterious failures.
- **Safe mode** with real-path (symlink/junction) artifact validation, host allowlists, redaction — an agent can be let loose with bounded blast radius.
- **JSONL over stdio** — no ports, no sockets, no polling; trivially embeddable in any agent harness.
- **Intentionally narrow surface** (no crawlers/PDF/DOM-search creep) — low maintenance cost; docs match behavior.

---

## 2. Critical findings & inefficiencies found

### F1 (High, fixed in copy): stale refs burned the full action timeout with no evidence
`resolveAgentRef()` checked `locator.count() > 0` and, when both the selector and the
semantic candidate were dead, **returned the known-dead locator anyway**. The subsequent
Playwright action then waited the full `timeout` (8s default) before throwing a generic
`TimeoutError`. Cost per stale click: ~8s of wall time plus an uninformative error the
agent cannot branch on.

**Fix in copy:** bounded re-attachment wait (1s per candidate, tunable via `refWaitMs`),
then a fast `STALE_REF` failure carrying `details.tried` (each attempted locator + reason)
and a recovery hint ("observe again; delta mode is cheaper"). Worst case ~2s instead of 8s,
and the error is self-explanatory.


### F2 (Medium, fixed in copy): O(n²) DOM work inside every observation
In `collectAgentSnapshot()`, the semantic-disambiguation index was computed as
`candidates.slice(0, index).filter(c => roleFor(c) === role && accessibleName(c) === name).length`
— re-running `roleFor()` and `accessibleName()` (multiple DOM queries each) for **every
prior candidate of every element**. With the max of 200 items that is up to ~20k redundant
DOM-query rounds per observation — and agents observe constantly.

**Fix in copy:** single-pass running `Map` keyed on `role\0name`. Identical output
(`locator.nth` values verified unchanged by tests, including a 3-duplicate-controls case),
O(n) instead of O(n²).

### F3 (Medium, fixed in copy): no session discovery after a crash/reconnect
An agent that lost its bookkeeping could only discover active sessions by triggering
`SESSION_EXISTS` / `SESSION_NOT_FOUND` errors one guess at a time.

**Fix in copy:** new read-only `sessions` operation (also exported as `listAgentSessions()`),
returning per-session `sessionId`, `url` (sanitized), `safetyMode`, `generation`,
`idleTimeoutMs`, `msSinceLastActivity`, `expiresInMillis`, subscription/watcher counts.
Advertised automatically in `capabilities.sessionOperations` and flagged as the
`session-discovery` feature. Purely additive; nothing existing changes shape.

### F4 (Low, observed, not changed): truncated successful responses keep `ok:true`
`serializeOutput()` preserves `ok` in the metadata of a truncated response, alongside
`status:"output_truncated"`. An agent skimming `ok` could miss that it only got a `preview`.
Safe because `outputTruncated:true` is always present, but worth tightening in a future
protocol version — a breaking change, so it is documented here rather than done in the copy.

### F5 (Low, observed): expired-session `close` is not idempotent
When a session expires, the agent gets `SESSION_EXPIRED`; a subsequent cleanup `close`
then fails with `SESSION_NOT_FOUND`. Harmless, but a tolerant `close` returning
`{status:"closed", alreadyClosed:true}` would remove one awkward branch from every agent's
cleanup path. Deferred: changing close semantics could surprise existing clients.

### F6 (Low, observed): `sanitizeUrl` over-redacts
Any query parameter whose *name* matches `/token|secret|password|passwd|auth|session|cookie|key|code/i`
is replaced with `[redacted]`. Innocuous params like `?sort=key` get redacted too. False
positives only reduce agent information slightly; acceptable trade-off, worth knowing.

### F7 (Design note, correct as-is): `serve` processes requests serially
A long `goto` blocks subsequent ops on the same process. This is the *right* default for
agent determinism (one browser, ordered side effects) — do not "fix" with concurrency.
Agents needing parallelism should open multiple sessions.

### F8 (Design note, correct as-is): idle reaping
`serve` reaps idle sessions every 60s (`setInterval` + `unref`), so zombie browsers do not
accumulate in the normal server path. Library consumers manage their own lifecycle — that
is the documented contract for embedded use.

---

## 3. Recommendations (beyond what was changed)

> **Next-round improvement proposals (R1–R8: stale-ref auto-recovery, batch ops,
> observation views, tabs, etc.) are documented separately in `ROADMAP.md`.**

1. **Merge path for the copy:** run `npm run test:next`, then the full suites, then diff
   `browser-tool.next.mjs` against `browser-tool.mjs` — only three regions differ
   (`resolveAgentRef`, the snapshot semantic-index block, and the additive `sessions` op).
   On merge: copy `browser-tool.next.mjs` over `browser-tool.mjs`, delete the `test/next.*`
   duplicates (or keep `test/next.improvements.test.mjs` with its import repointed), and
   bump the minor version (protocol stays `1`; all changes are additive).
2. **Document the new op:** add `sessions` to the README/INSTRUCTIONS command tables after merge.
3. **Consider F4/F5** in a future minor release with a `protocolVersion: 2` announcement via
   `capabilities` — that mechanism already exists and is the right way to evolve the contract.
4. **Keep the "no feature creep" rule.** The README's refusal list (crawlers, PDF export,
   DOM search, codegen) is a strength, not a gap.
5. **CI:** `.github/workflows/ci.yml` already caches Playwright browsers and runs the suites;
   no change needed.

## 4. Verification performed

- `node --check` on both files.
- Copy suites: `test/next.browser-tool.test.mjs` 19/19, `test/next.cli.test.mjs` 8/8
  (identical suites as the originals, only the import path differs).
- New tests (`npm run test:next`) 5/5: fast+evidenced `STALE_REF`, live-ref non-regression,
  semantic `nth` correctness after the O(n) rewrite, `listAgentSessions()` metadata,
  JSONL `sessions` op + capabilities advertisement.
- Original `browser-tool.mjs` byte-untouched (only `LastWriteTime` from before the audit).
