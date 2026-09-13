# Troubleshooting

## `SESSION_NOT_FOUND` / `TAB_NOT_FOUND`

The session or tab is gone (closed, crashed worker, fresh daemon).
Create again; ids never transfer across restarts.

## `STALE_OBSERVATION` (or stale refs / stale coordinates)

You acted on an older observation. Take the refs (or screenshot
revision) from the *latest* result and retry — same revision string,
never an old one. After `resume`, always re-observe first.

## `TARGET_AMBIGUOUS`

Two controls share role+name (possibly across frames). This is a
refusal to guess: narrow the page (search, inspect, navigate) and use
the fresh unique ref.

## `TARGET_NOT_ACTIONABLE`

Present but covered/disabled/unready — check the observation (modals,
disabled flags) and diagnostics. Dismiss blockers first.

## `POSTCONDITION_TIMEOUT`

The click happened; the expected text/URL never did. Inspect the page
state — this is debugging information, not a retry blindly signal.

## `OUTCOME_UNKNOWN`

A restart interrupted this id. Do NOT resend it: verify the external
state (fixture counters, order pages) and continue with new ids.

## `SESSION_PAUSED`

A human holds the tab. Poll `observe` (reads are allowed) until the
lease clears, then re-observe and continue.

## `BROWSER_CRASHED`

The browser died. In-flight outcomes are unknown; new sessions work
(`launch()` auto-recovers). Check `doctor` and disk space.

## Daemon won't start / `already running`

A live daemon owns the rendezvous dir (`daemon status`). A stale file
from a crash is replaced automatically. Delete a corrupt
`daemon.json` only when no daemon is alive.

## `daemon unreachable` / `staleFile:true` right after `daemon start`

You ran the foreground `daemon start` in an ephemeral shell: it blocks
forever, so the shell teardown kills it and leaves a stale
`daemon.json` (dead pid). Fix: `bridge daemon stop` (or delete the
stale file), then `bridge daemon start --detach` — the supported
background path that survives shell exit. Do NOT use `Start-Job`
(dies with its shell) or `Start-Process bridge ...` (targets the
`.ps1` wrapper, never survives); `--detach` respawns `node <cli.js>
daemon start` detached instead.

## Viewer shows "disconnected" / event gap

The daemon went away or history overflowed (500 events). Reconnect;
the banner-triggered refresh restores state. Token lives in the URL
fragment — re-run `bridge viewer` if you lost it.

## `doctor` reports missing Chromium

Run `npx playwright install chromium` (or set `PLAYWRIGHT_BROWSERS_PATH`
to an existing install). Headed mode additionally needs a display.
