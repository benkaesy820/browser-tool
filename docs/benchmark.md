# Benchmarks: methodology and reproduction

Numbers below are from the maintainer's Windows desktop (2026-09-12);
treat them as order-of-magnitude evidence, not promises — rerun on your
hardware with `pnpm benchmark`. No numerical latency SLA is claimed
(plan: measure first, promise later).

## What is measured (`tests/benchmarks/`)

- **Latency** (`latency.test.ts`): 15 timed iterations (3 warmup) of
  open/fill/click/observe/screenshot on local fixtures; reports
  mean/p50/p95/max per op. Asserts completion and output bounds only.
- **Baseline overhead** (`baseline.test.ts`): a raw Playwright script
  performs the identical fixture path (goto/fill/click/read/screenshot);
  overhead ratio = bridge p50 / raw p50 per op.
- **Stress** (`stress.test.ts`): 100 open/close cycles; asserts zero
  owned sessions remain and no orphan browser processes appear.
- **Efficiency** (`efficiency.test.ts`): serialized bytes per result
  kind against the protocol caps.
- `pnpm benchmark` regenerates `tests/benchmarks/results/*.json` plus
  `tests/benchmarks/REPORT.md` (both gitignored); this file records one
  witnessed run for orientation.

## Witnessed run (Windows x64, Node 24, Chromium 131, headless)

Shared runner (4 benchmark files in parallel browsers), 12 timed
iterations after warmup. Bridge ops include validation, ref registry,
and a fresh observation per call; raw ops are single Playwright calls —
so this table prices the agent contract, not the same work.

| Op | bridge p50 (ms) | raw p50 (ms) | overhead | bridge p95 (ms) |
|----|---------------:|-------------:|---------:|----------------:|
| observe | 230.5 | 5.5 | 39.7× | 241.0 |
| fill | 415.0 | 18.0 | 23.1× | 481.8 |
| click | 431.2 | 56.3 | 7.7× | 506.8 |
| screenshot | 82.7 | 93.9 | 0.9× | 89.9 |

Screenshot is near-parity (same capture path). Observe/fill/click pay
for full-page collection and target revalidation on every call — that
is the integration overhead, and it is where future optimization
(targeted re-collection, collection caching) would go. No latency SLA
is claimed; rerun with `pnpm benchmark` for your hardware.

Stress: 100 open/close cycles at ~386 ms/cycle, zero owned sessions
left; OS process counts reported, not gated, under shared runners.
Largest single observation seen: well under the 512 KB cap.

## Release acceptance (provisional)

Zero wrong-target actions and zero duplicate writes in the adversarial
fixture suite; all deterministic workflows pass; 100 open/close cycles
clean; output/artifact bounds enforced in stress. Timing thresholds
stay out of the gate until multi-machine data exists.
