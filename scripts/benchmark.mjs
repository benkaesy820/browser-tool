// Benchmark reporter: aggregates tests/benchmarks/results/*.json into
// tests/benchmarks/REPORT.md and prints the summary table.
// Usage: pnpm benchmark (runs vitest first) — or node scripts/benchmark.mjs
// to re-render from existing results.
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const dir = join(process.cwd(), "tests", "benchmarks", "results");
if (!existsSync(dir)) {
  console.log(
    "No benchmark results yet — run: pnpm exec vitest run tests/benchmarks",
  );
  process.exit(2);
}

const results = {};
for (const file of readdirSync(dir)) {
  if (!file.endsWith(".json")) continue;
  const data = JSON.parse(readFileSync(join(dir, file), "utf8"));
  results[data.name ?? file] = data;
}

function ratio(a, b) {
  if (typeof a !== "number" || typeof b !== "number" || b <= 0) return "n/a";
  return `${Math.round((a / b) * 100) / 100}x`;
}

const latency = results["latency"]?.ops ?? {};
const baseline = results["baseline"]?.ops ?? {};
const pairs = [
  ["open", "open"],
  ["observe", "read"],
  ["fill", "fill"],
  ["click", "click"],
  ["screenshot", "screenshot"],
];

const lines = [];
lines.push("# Benchmark report", "");
lines.push(
  `Generated ${new Date().toISOString()} · node ${results["latency"]?.node ?? "?"} · ${results["latency"]?.platform ?? "?"}.`,
);
lines.push(
  "Warm iterations on local fixtures; see docs/benchmark.md for methodology.",
);
lines.push(
  "",
  "| Op | bridge p50 (ms) | raw p50 (ms) | overhead | bridge p95 (ms) |",
  "|----|---------------:|-------------:|---------:|----------------:|",
);
for (const [bridged, raw] of pairs) {
  const b = latency[bridged];
  const r = baseline[raw];
  if (!b || b.n === 0 || !r || r.n === 0) continue;
  lines.push(
    `| ${bridged} | ${b?.p50 ?? "?"} | ${r?.p50 ?? "?"} | ${ratio(b?.p50, r?.p50)} | ${b?.p95 ?? "?"} |`,
  );
}
lines.push(
  "",
  "Bridge ops include validation, ref registry, and a fresh observation; raw ops are single Playwright calls.",
  "Screenshot is near-parity (same capture path). Observe/fill/click pay for full-page collection and revalidation.",
);
const stress = results["stress"];
if (stress) {
  lines.push(
    "",
    `Stress: ${stress.cycles} open/close cycles in ${stress.ms} ms (${stress.perCycleMs} ms/cycle); chrome processes ${stress.chromeBefore} → ${stress.chromeAfter}.`,
  );
}
const efficiency = results["efficiency"]?.bytes;
if (efficiency) {
  lines.push("", "Serialized result bytes:", "");
  for (const [kind, bytes] of Object.entries(efficiency))
    lines.push(`- ${kind}: ${bytes}`);
}
lines.push("");
writeFileSync(join(dir, "..", "REPORT.md"), `${lines.join("\n")}\n`);

console.log("Op              bridge-p50   raw-p50  overhead   bridge-p95");
for (const [bridged, raw] of pairs) {
  const b = latency[bridged];
  const r = baseline[raw];
  if (!b || b.n === 0 || !r || r.n === 0) continue;
  console.log(
    `${bridged.padEnd(15)} ${String(b?.p50 ?? "?").padStart(10)} ${String(r?.p50 ?? "?").padStart(8)} ${ratio(b?.p50, r?.p50).padStart(9)} ${String(b?.p95 ?? "?").padStart(11)}`,
  );
}
if (stress)
  console.log(
    `stress: ${stress.cycles} cycles, ${stress.perCycleMs} ms/cycle, chrome ${stress.chromeBefore}->${stress.chromeAfter}`,
  );
console.log("REPORT.md written");
