import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import { percentileTable, writeResult, type Samples } from "./stats.js";

const fixture = pathToFileURL(
  join(process.cwd(), "tests", "fixtures", "index.html"),
).href;
const ITERATIONS = 12;
const WARMUP = 2;

/** Raw Playwright baseline on the identical fixture path (integration overhead). */
describe("benchmark baseline", () => {
  let browser: Browser | undefined;
  const samples: Samples = {
    open: [],
    read: [],
    fill: [],
    click: [],
    screenshot: [],
  };

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  }, 60_000);

  afterAll(async () => {
    await browser?.close().catch(() => undefined);
    writeResult("baseline", {
      iterations: ITERATIONS,
      ops: percentileTable(samples),
    });
  });

  async function timed<T>(
    op: string,
    record: boolean,
    fn: () => Promise<T>,
  ): Promise<T> {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      if (record)
        samples[op]?.push(Math.round((performance.now() - start) * 10) / 10);
    }
  }

  it("runs the raw script", async () => {
    const page = await (browser as Browser).newPage();
    try {
      const navStart = performance.now();
      await page.goto(fixture, { waitUntil: "domcontentloaded" });
      samples["open"]?.push(
        Math.round((performance.now() - navStart) * 10) / 10,
      );
      for (let i = 0; i < WARMUP + ITERATIONS; i++) {
        const record = i >= WARMUP;
        const text = await timed("read", record, () =>
          page.locator("body").innerText(),
        );
        void text;
        await timed("fill", record, () =>
          page.locator("#item").fill(`item-${i}`),
        );
        await timed("click", record, () => page.locator("#add").click());
        const result = await page.locator("#result").innerText();
        expect(result).toContain(`Item added: item-${i}`);
        if (i % 4 === 0) {
          await timed("screenshot", record, () =>
            page.screenshot({ type: "png" }),
          );
        }
      }
    } finally {
      await page.close().catch(() => undefined);
    }
  }, 180_000);
});
