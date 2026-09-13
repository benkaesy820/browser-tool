import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chromium } from "playwright";
import { BrowserBridge } from "@browser-bridge/core";

const indexUrl = pathToFileURL(
  join(process.cwd(), "tests", "fixtures", "index.html"),
).href;

/**
 * Phase-0 feasibility spike (§10 gate): prove semantic-ref mapping, screenshot,
 * popup, and iframe work through supported Playwright APIs before committing
 * the engine to them. Raw driver use here is intentional — the engine itself
 * exposes no unrestricted JS-eval endpoint (§13).
 */
describe("phase-0 spike", () => {
  it("opens a popup and reads its content", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(indexUrl, { waitUntil: "domcontentloaded" });
      const [popup] = await Promise.all([
        context.waitForEvent("page", { timeout: 10_000 }),
        page.click("#popup-link"),
      ]);
      await popup.waitForLoadState("domcontentloaded");
      expect(await popup.locator("#popup-text").textContent()).toBe(
        "Hello from popup",
      );
      await context.close();
    } finally {
      await browser.close();
    }
  });

  it("reads inside a same-origin iframe", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(indexUrl, { waitUntil: "domcontentloaded" });
      expect(
        await page
          .frameLocator("#inner-frame")
          .locator("#inner-text")
          .textContent(),
      ).toBe("Inside iframe");
      await page.close();
    } finally {
      await browser.close();
    }
  });

  it("survives repeated open/close cycles without leaking sessions", async () => {
    const bridge = new BrowserBridge({ headless: true });
    try {
      await bridge.launch();
      for (let i = 0; i < 5; i++) {
        const { sessionId } = await bridge.createSession();
        const opened = await bridge.open(`r-cyc-${i}`, sessionId, indexUrl);
        expect(opened.status).toBe("completed");
        const closed = await bridge.closeSession(`r-cyc-close-${i}`, sessionId);
        expect(closed.status).toBe("completed");
      }
    } finally {
      await bridge.shutdown();
    }
  });
});
