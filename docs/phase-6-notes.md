# Phase-6 notes: benchmark, package, and release

Date: 2026-09-12. No product API changes beyond patch fixes
(core 0.6.1, cli 0.4.1); protocol stays at wire `1.0`.

## What landed

- **Verification commands all real**: `lint` (eslint flat config, zero
  errors), `format:check` (prettier, whole repo), `test:package`
  (pack → content assertions → clean-dir install → entrypoint probes),
  `benchmark` (harness + `REPORT.md` regeneration).
- **Packaging**: `files` whitelists, LICENSE copies + viewer bundle via
  `prepack`, `test:package` proves clean installs answer on `bridge`,
  `serve`, `mcp`, and `doctor` (graceful without browsers).
- **Benchmarks** (`tests/benchmarks/`): latency (mean/p50/p95/max),
  raw-Playwright baseline (overhead ratio), 100-cycle stress (zero owned
  sessions), efficiency (bytes vs caps). Numbers are witnessed, not
  promised; `docs/benchmark.md` records methodology + one run.
- **Release docs**: README, architecture/protocol/cli/mcp/
  troubleshooting/privacy-and-storage/benchmark/release-checklist,
  CHANGELOG, THIRD_PARTY (generated, no copyleft in closure),
  MIT LICENSE (**provisional — confirm before publication**),
  docs-consistency contract test, journal upgrade-compat test,
  three-OS CI matrix (windows proven live; linux/macos via CI).
- **Two transport bugs fixed** (found by residue forensics): bodiless
  JSON POSTs rejected by Fastify (shutdown never ran), and
  `app.close()`-before-reply deadlocking on keep-alive. `daemon stop`
  now reports verified cleanup in under a second.

## Gate evidence

Full gate green twice in a row: typecheck, lint, format:check, unit 9,
contract 49, integration 13, 5 builds, test:package ALL GREEN,
benchmark 4, interop 19 — with zero orphans, zero stale files, zero
leftover sessions afterward. `BRIDGE_TEST_HEADED=1` proven separately.
Python/shell examples auto-run wherever interpreters exist.

## What publication still needs (explicitly out of scope)

A license confirmation (MIT is provisional), a version-number decision,
`npm publish --dry-run` + access/provenance setup, and the first green
CI run on all three OSes. See `docs/release-checklist.md`.
