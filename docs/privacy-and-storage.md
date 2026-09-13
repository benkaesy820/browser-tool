# Privacy and storage (v0.7.x)

## What lives where

| Data | Location | Lifetime |
| ---- | -------- | -------- |
| Sessions (cookies, storage) | In-memory browser contexts | Until close/shutdown/crash |
| Named profiles | `$TMP/browser-bridge-profiles/<name>/` (never the repo) | Until deleted; pid-locked |
| Screenshots/downloads | `artifacts/<session>/` (daemon cwd) | Until close/shutdown; TTL sweep for leftovers (7 d) |
| Request journal | `artifacts/journal.jsonl` (op + ids only) | Rotated to uncertain-only; 30 min uncertainty TTL |
| Engine events | In-memory ring (500) | Process lifetime |
| Daemon token | `$TMP/browser-bridge/daemon.json` (0700/0600 best effort) | Until stop |
| Current CLI session | `$TMP/browser-bridge/current-session` (or selected daemon dir) | Cleared when that session closes |
| Viewer token | URL fragment + JS memory | Never localStorage, never logged |

## Minimization rules (enforced in code)

- Journal records op names and ids only — never URLs, text, refs, or files.
- The current-session file contains only a session id, never page data,
  cookies, credentials, or URLs.
- Navigation auto-clicks reject-only cookie buttons (never Accept or
  equivalent) and reports the dismissal; accept-only walls are left for
  a human choice.
- Logged request URLs are query/fragment-stripped; console text is
  page-authored evidence and stays verbatim in diagnostics.
- Screenshots accept `maskRefs` (best-effort redaction); masks are not a
  guarantee — assume captures may contain private content.
- Cookies, auth headers, passwords, and storage state are never
  returned as observations. Profile directories are never packed
  (`test:package` asserts their absence).
- Page text is untrusted data with provenance (URL + revision), never
  instructions. The tool preserves provenance and capability limits; it
  cannot make every calling model injection-proof.

## Operator duties

Keep the daemon on loopback (it binds 127.0.0.1 and refuses remote
hosts), treat token files like credentials, and review screenshots and
traces before sharing — they may show private sessions.
