# Release checklist (gate for any publish action)

Publication itself is always a separate, explicit action. A release
candidate must clear every item; evidence is the command output, not a
feeling.

## Gates (run in order, all exit 0)

```sh
pnpm install
pnpm typecheck && pnpm lint && pnpm format:check
pnpm test && pnpm test:contract && pnpm test:integration
pnpm build && pnpm test:package && pnpm benchmark && pnpm test:interop
```

Plus `BRIDGE_TEST_HEADED=1 pnpm test:integration` on a machine with a
display, and the CI matrix (Ubuntu/Windows/macOS) fully green.

## Contents and hygiene

- `test:package` proves: tarballs install into clean dirs; `bridge`,
  `serve`, `mcp` entrypoints answer; package contents include
  `dist`, `package.json`, `LICENSE`, `README`-level docs — and exclude
  profiles, artifacts, journals, `.env`, private keys, screenshots.
- `THIRD_PARTY.md` regenerated; license deltas reviewed.
- `CHANGELOG.md` updated; docs state the release version.
- No credentials, cookies, tokens, or customer data in fixtures, logs,
  cassettes, or reports (benchmark results are timing + sizes only).

## Compatibility

- Wire `protocolVersion` unchanged, or a migration note + major bump.
- Journal upgrade test green (old entries without `op` still resolve).
- Daemon/CLI exit codes and envelope codes unchanged (see `docs/cli.md`,
  `docs/protocol.md`).

## Rollback

No hosted state exists, so rollback is reinstalling the previous
tarball and restarting daemons (sessions do not survive restarts by
design). Keep the previous tarballs until the new release is verified
in place. If a release must be pulled, republish is blocked on a fresh
full gate plus a note in `CHANGELOG.md`.
