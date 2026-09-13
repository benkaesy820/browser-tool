import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Samples {
  [op: string]: number[];
}

export function stats(values: number[]): {
  n: number;
  mean: number;
  p50: number;
  p95: number;
  max: number;
} {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const at = (p: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  return {
    n: sorted.length,
    mean: sorted.length > 0 ? Math.round((sum / sorted.length) * 10) / 10 : 0,
    p50: at(0.5),
    p95: at(0.95),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

export function percentileTable(
  samples: Samples,
): Record<string, ReturnType<typeof stats>> {
  return Object.fromEntries(
    Object.entries(samples).map(([op, values]) => [op, stats(values)]),
  );
}

export function writeResult(
  name: string,
  payload: Record<string, unknown>,
): void {
  const dir = join(process.cwd(), "tests", "benchmarks", "results");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.json`),
    JSON.stringify(
      {
        name,
        at: new Date().toISOString(),
        node: process.version,
        platform: process.platform,
        ...payload,
      },
      null,
      2,
    ),
  );
}
