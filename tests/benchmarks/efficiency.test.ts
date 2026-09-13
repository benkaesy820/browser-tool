import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { BrowserBridge } from "@browser-bridge/core";
import { getCapabilities } from "@browser-bridge/protocol";
import { writeResult } from "./stats.js";

const fixture = pathToFileURL(
  join(process.cwd(), "tests", "fixtures", "index.html"),
).href;

/** Output efficiency: every result kind stays within protocol bounds. */
describe("benchmark efficiency", () => {
  const bridge = new BrowserBridge({ headless: true });
  const sizes: Record<string, number> = {};

  beforeAll(async () => {
    await bridge.launch();
  }, 60_000);

  afterAll(async () => {
    await bridge.shutdown();
    writeResult("efficiency", { bytes: sizes });
  });

  it("measures serialized result sizes", async () => {
    const caps = getCapabilities();
    const { sessionId } = await bridge.createSession();
    try {
      const opened = await bridge.open("bench-eff-open", sessionId, fixture);
      sizes["open"] = JSON.stringify(opened).length;
      const input = opened.observation?.controls.find(
        (c) => c.role === "textbox",
      )?.ref as string;
      const filled = await bridge.fill(
        "bench-eff-fill",
        sessionId,
        input,
        "x".repeat(500),
      );
      sizes["fill"] = JSON.stringify(filled).length;
      const shot = await bridge.screenshot("bench-eff-shot", sessionId);
      sizes["screenshot-result"] = JSON.stringify({
        ...shot,
        artifacts: [],
      }).length;
      const delta = await bridge.observe(
        "bench-eff-delta",
        sessionId,
        undefined,
        { mode: "delta", baseRevision: 1 },
      );
      sizes["delta"] = JSON.stringify(delta).length;
      const visual = await bridge.observe(
        "bench-eff-visual",
        sessionId,
        undefined,
        { mode: "visual" },
      );
      sizes["visual"] = JSON.stringify({ ...visual, artifacts: [] }).length;

      expect(sizes["open"] as number).toBeLessThan(
        caps.limits.maxResponseBytes,
      );
      expect(sizes["fill"] as number).toBeLessThan(
        caps.limits.maxResponseBytes,
      );
      expect(sizes["delta"] as number).toBeLessThan(
        caps.limits.maxResponseBytes,
      );
      expect(sizes["visual"] as number).toBeLessThan(
        caps.limits.maxResponseBytes,
      );
      expect(opened.observation?.controls.length ?? 0).toBeLessThanOrEqual(
        caps.limits.maxControls,
      );
      expect(opened.observation?.text.length ?? 0).toBeLessThanOrEqual(
        caps.limits.maxTextChars,
      );
    } finally {
      await bridge.closeSession("bench-eff-close", sessionId);
    }
  }, 120_000);
});
