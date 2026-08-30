# Agent Improvement Roadmap — browser-tool.next (planning only, no code changes yet)

Companion to `AUDIT.md`. This captures the next round of improvements designed to make
agents work even better with the tool. **Nothing here is implemented yet** — the working
copy `browser-tool.next.mjs` still contains only the three audited fixes (F1–F3).

Guiding constraints carried over from the audit: bounded output, machine-readable errors,
honest contracts (`requiresObserve`), no silent guessing, and the existing "no feature
creep" refusal list stays intact.

---

## Tier 1 — Fewer agent turns per task (highest impact)

### R1. Stale-ref auto-recovery with unambiguous semantic re-match  ⭐ top pick
- **Today:** act → `STALE_REF` → observe → act. Two wasted round trips per stale element,
  and stale refs are common on SPAs because every act invalidates refs.
- **Proposed:** when a ref is stale, attempt re-match using the recorded identity
  (`locator.role` + `name` + `nth` from `session.refs`):
  - Exactly one semantic match → act on it and return `refRecovered: { old, new }`.
  - Zero or multiple matches → fail with the existing `STALE_REF` evidence (never guess).
- **Not blindsiding:** the agent is always told the ref changed; recovery only fires when
  provably unambiguous; worst case equals today's behavior.
- **Effort/risk:** medium / low (guarded).

### R2. Document compound `act` with `observe: true`  (documentation only)
- **Finding:** `actAgentSession` already supports `{"op":"act", ..., "observe": true,
  "mode":"delta"}` and returns the fresh observation inline — but neither README nor
  INSTRUCTIONS mentions it.
- **Proposed:** document it as the default recommended loop ("act and re-observe in one
  round trip"), with a test proving delta mode works inline.
- **Effort/risk:** minimal / none. Instant ~2× fewer turns for every interaction.

### R3. `batch` session operation (multi-act, stop-on-error)
- **Today:** filling a 5-field form is 5 requests; refs invalidate after every act, forcing
  observe cycles between fields.
- **Proposed:** `{"op":"batch", "steps":[{action, selector, ...}, ...], "stopOnError": true,
  "observeAfter": "delta"}` — selector-based (selectors do not invalidate like refs).
  Per-step evidence, identical in spirit to the existing workflow `stepResults`.
- **Not blindsiding:** stop-on-first-error default; bounded per-step output; the response
  carries each step's status so the agent sees exactly where a batch stopped.
- **Effort/risk:** medium / low-medium.

## Tier 2 — Token reduction (cheaper observations)

### R4. Observation views (`view: 'controls' | 'standard' | 'full'`)
- **Today:** every observation computes headings, landmarks, page text, and controls.
  Mid-form agents mostly need controls + one status string.
- **Proposed:** `view:'controls'` skips `headings`/`landmarks`/`text` blocks in the
  snapshot builder (they are already computed as separate blocks). Cuts typical response
  size 50–80% for interaction-heavy loops. Default remains `standard` (today's shape).
- **Effort/risk:** medium / low. Additive; `capabilities` should advertise the views.

### R5. Coalesced diagnostics (counts instead of repetition)
- **Today:** up to 500 entries per diagnostic category; React apps can repeat one console
  error dozens of times.
- **Proposed:** coalesce identical messages into `{ text, count }` (first/last timestamps
  optional). Additive field; keeps evidence while shrinking responses.
- **Effort/risk:** small / low.

## Tier 3 — Capability gaps vs. the workflow engine

### R6. `tabs` session operation (list / switch / close) + `page.opened` event
- **Today:** workflows have `switchTab`, but live sessions **silently** adopt any new page
  (`context.on('page')` reassigns `session.page`). A popup can retarget the agent's next
  act to a page it never chose — a current blindsiding risk.
- **Proposed:** `tabs` op returning page list (url/title), switch by index, close by index;
  emit `page.opened` instead of silently switching, or switch but say so in the response.
- **Effort/risk:** medium / medium (changes popup behavior — needs a `protocolVersion`
  review; safest is keep auto-switch but add the event + op).

### R7. Gated session `evaluate`
- **Today:** `evaluate` is workflow-only (correctly blocked by default).
- **Proposed:** allow it in sessions only when the session was opened with an explicit
  `allowEvaluate: true` flag (or `safetyMode:'unsafe'`); keep it out of default
  `AGENT_ACTIONS` so `capabilities` stays honest.
- **Effort/risk:** small / low (strictly opt-in).

### R8. Idempotent `close` (audit finding F5)
- **Today:** cleanup `close` after `SESSION_EXPIRED` fails with `SESSION_NOT_FOUND`.
- **Proposed:** return `{ status: 'closed', alreadyClosed: true }` for already-disposed
  sessions; keep `SESSION_NOT_FOUND` for never-existed ids.
- **Effort/risk:** small / very low.

## Explicitly NOT recommended
- Raw HTML dumps (snapshot + gated `evaluate` already cover the need; raw HTML burns context).
- Auto form-filling / heuristic guessing (unverifiable submissions; README refusal list is right).
- Parallel ops on one session (serial execution is the determinism guarantee; use multiple sessions).

## Suggested implementation order (when approved)

| Order | Item | Effort | Risk |
|---|---|---|---|
| 1 | R2 Document `observe:true` | ~30 min | None |
| 2 | R8 Idempotent close | Small | Very low |
| 3 | R1 Stale-ref auto-recovery | Medium | Low (guarded) |
| 4 | R4 Observation views | Medium | Low |
| 5 | R3 Batch op | Medium | Low-medium |
| 6 | R6 Tabs op | Medium | Medium |

Each item lands in `browser-tool.next.mjs` with its own tests first; the original
`browser-tool.mjs` stays untouched until the merge gate.
