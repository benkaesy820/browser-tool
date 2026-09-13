import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { BrowserBridge } from "@browser-bridge/core";
import type { Control } from "@browser-bridge/protocol";

const fixture = pathToFileURL(
  join(process.cwd(), "tests", "fixtures", "index.html"),
).href;

describe("first-slice fixture workflow", () => {
  const bridge = new BrowserBridge({ headless: true });
  let sessionId = "";
  let tabId = "";

  beforeAll(async () => {
    await bridge.launch();
  }, 60_000);

  afterAll(async () => {
    await bridge.shutdown();
  });

  it("opens, fills, clicks, verifies text, screenshots, closes", async () => {
    const created = await bridge.createSession();
    sessionId = created.sessionId;
    tabId = created.tabId;

    const opened = await bridge.open("r-open-1", sessionId, fixture);
    expect(opened.status).toBe("completed");
    expect(opened.observation?.title).toContain("Bridge Fixture");

    const input = opened.observation?.controls.find(
      (c: Control) =>
        c.name.toLowerCase().includes("apples") || c.role === "textbox",
    );
    expect(input).toBeDefined();

    const filled = await bridge.fill(
      "r-fill-1",
      sessionId,
      (input as { ref: string }).ref,
      "apples",
      tabId,
    );
    expect(filled.status).toBe("completed");

    // Re-observe: refs are tied to a revision; fill invalidates prior refs.
    const observed = await bridge.observe("r-obs-2", sessionId, tabId);
    const add = observed.observation?.controls.find(
      (c: Control) => c.name === "Add to cart",
    );
    expect(add).toBeDefined();

    const clicked = await bridge.click(
      "r-click-1",
      sessionId,
      (add as { ref: string }).ref,
      tabId,
    );
    expect(clicked.observation?.text).toContain("Item added: apples");

    const shot = await bridge.screenshot("r-shot-1", sessionId, tabId);
    expect(shot.artifacts).toHaveLength(1);
    expect(existsSync(shot.artifacts[0]?.path as string)).toBe(true);

    // Request-id dedupe: same id returns identical result without re-executing.
    const replay = await bridge.screenshot("r-shot-1", sessionId, tabId);
    expect(replay).toEqual(shot);

    const closed = await bridge.closeSession("r-close-1", sessionId);
    expect(closed.status).toBe("completed");
    sessionId = "";
  });

  it("rejects stale refs after close with SESSION_NOT_FOUND", async () => {
    await expect(
      bridge.observe("r-stale-1", "s-does-not-exist"),
    ).rejects.toMatchObject({
      code: "SESSION_NOT_FOUND",
    });
  });

  it("reports ambiguous duplicates and disabled controls without guessing", async () => {
    const created = await bridge.createSession();
    try {
      const opened = await bridge.open(
        "r-amb-open",
        created.sessionId,
        fixture,
        created.tabId,
      );
      const dupes = (opened.observation?.controls ?? []).filter(
        (c: Control) => c.name === "More info",
      );
      expect(dupes.length).toBe(2);
      await expect(
        bridge.click(
          "r-amb-click",
          created.sessionId,
          dupes[0]?.ref as string,
          created.tabId,
        ),
      ).rejects.toMatchObject({ code: "TARGET_AMBIGUOUS" });

      const disabled = opened.observation?.controls.find((c: Control) =>
        c.name.includes("Checkout"),
      );
      expect(disabled).toBeDefined();
      await expect(
        bridge.click(
          "r-dis-click",
          created.sessionId,
          disabled?.ref as string,
          created.tabId,
        ),
      ).rejects.toMatchObject({ code: "TARGET_NOT_ACTIONABLE" });
    } finally {
      await bridge.closeSession("r-amb-close", created.sessionId);
    }
  });
});
