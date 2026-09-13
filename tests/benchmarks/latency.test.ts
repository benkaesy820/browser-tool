import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { BrowserBridge } from "@browser-bridge/core";
import { getCapabilities } from "@browser-bridge/protocol";
import { percentileTable, writeResult, type Samples } from "./stats.js";

const fixture = pathToFileURL(
  join(process.cwd(), "tests", "fixtures", "index.html"),
).href;
const ITERATIONS = 12;
const WARMUP = 2;

/** Warm action/observation timings on identical fixture paths. */
describe("benchmark latency", () => {
  const bridge = new BrowserBridge({ headless: true });
  const samples: Samples = {
    open: [],
    observe: [],
    fill: [],
    click: [],
    screenshot: [],
  };
  const bytes: Samples = { result: [] };
  let sessionId = "";

  beforeAll(async () => {
    await bridge.launch();
    sessionId = (await bridge.createSession()).sessionId;
    await bridge.open("bench-warm-open", sessionId, fixture);
  }, 60_000);

  afterAll(async () => {
    await bridge.closeSession("bench-close", sessionId).catch(() => undefined);
    await bridge.shutdown();
    writeResult("latency", {
      iterations: ITERATIONS,
      ops: percentileTable(samples),
      bytes: percentileTable(bytes),
    });
  });

  async function timed<T>(op: string, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      samples[op]?.push(Math.round((performance.now() - start) * 10) / 10);
    }
  }

  it("measures repeated fixture interactions", async () => {
    for (let i = 0; i < WARMUP + ITERATIONS; i++) {
      const record = i >= WARMUP;
      const mark = async <T>(op: string, fn: () => Promise<T>): Promise<T> => {
        if (!record) return fn();
        return timed(op, fn);
      };
      const opened = await mark("observe", () =>
        bridge.observe(`bench-o-${i}`, sessionId),
      );
      const input = opened.observation?.controls.find(
        (c) => c.role === "textbox",
      )?.ref as string;
      const filled = await mark("fill", () =>
        bridge.fill(`bench-f-${i}`, sessionId, input, `item-${i}`),
      );
      const add = filled.observation?.controls.find(
        (c) => c.name === "Add to cart",
      )?.ref as string;
      const clicked = await mark("click", () =>
        bridge.click(`bench-c-${i}`, sessionId, add),
      );
      expect(clicked.observation?.text ?? "").toContain(
        `Item added: item-${i}`,
      );
      bytes["result"]?.push(JSON.stringify(clicked).length);
      if (i % 4 === 0) {
        await mark("screenshot", () =>
          bridge.screenshot(`bench-s-${i}`, sessionId),
        );
      }
    }
    const caps = getCapabilities();
    expect(Math.max(...(bytes["result"] ?? [0]))).toBeLessThan(
      caps.limits.maxResponseBytes,
    );
  }, 180_000);
});
