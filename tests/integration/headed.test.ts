import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { BrowserBridge } from "@browser-bridge/core";

const fixture = pathToFileURL(
  join(process.cwd(), "tests", "fixtures", "index.html"),
).href;

/**
 * Visible-window milestone: proves the engine drives a headed Chromium.
 * Requires a display; run explicitly with BRIDGE_TEST_HEADED=1.
 */
describe.skipIf(process.env["BRIDGE_TEST_HEADED"] !== "1")(
  "headed browser",
  () => {
    const bridge = new BrowserBridge({ headless: false });

    beforeAll(async () => {
      await bridge.launch();
    }, 60_000);

    afterAll(async () => {
      await bridge.shutdown();
    });

    it("resizes and acts through a visible window", async () => {
      const { sessionId } = await bridge.createSession();
      try {
        const opened = await bridge.open("r-headed-open", sessionId, fixture);
        expect(opened.observation?.title).toContain("Bridge Fixture");

        const freeShot = await bridge.screenshot(
          "r-headed-free-shot",
          sessionId,
        );
        const freeArtifact = freeShot.artifacts[0];
        if (!freeArtifact) throw new Error("headed free screenshot missing");
        const freeRevision = freeShot.observation?.revision;
        if (freeRevision === undefined)
          throw new Error("headed free screenshot revision missing");
        const freeEdge = await bridge.act("r-headed-free-edge", sessionId, {
          type: "moveAt",
          x: freeArtifact.width - 1,
          y: freeArtifact.height - 1,
          screenshotRevision: freeRevision,
        });
        expect(freeEdge.status).toBe("completed");

        const sized = await bridge.viewport("r-headed-viewport", sessionId, {
          preset: "mobile",
        });
        const revision = sized.observation?.revision;
        if (revision === undefined) throw new Error("headed revision missing");
        const moved = await bridge.act("r-headed-move", sessionId, {
          type: "moveAt",
          x: 180,
          y: 300,
          screenshotRevision: revision,
        });
        const movedRevision = moved.observation?.revision;
        if (movedRevision === undefined)
          throw new Error("headed move revision missing");
        const wheeled = await bridge.act("r-headed-wheel", sessionId, {
          type: "scrollAt",
          x: 180,
          y: 300,
          deltaY: 240,
          screenshotRevision: movedRevision,
        });
        const input = wheeled.observation?.controls.find(
          (control) => control.role === "textbox",
        );
        expect(input).toBeDefined();
        if (!input) throw new Error("headed fixture textbox missing");
        const filled = await bridge.fill(
          "r-headed-fill",
          sessionId,
          input.ref,
          "pears",
        );
        const add = filled.observation?.controls.find(
          (control) => control.name === "Add to cart",
        );
        expect(add).toBeDefined();
        if (!add) throw new Error("headed fixture add button missing");
        const clicked = await bridge.click(
          "r-headed-click",
          sessionId,
          add.ref,
        );
        expect(clicked.observation?.text).toContain("Item added: pears");

        const shot = await bridge.screenshot("r-headed-shot", sessionId);
        expect(shot.artifacts.length).toBe(1);
        expect(shot.artifacts[0]?.width).toBe(390);
        expect(shot.artifacts[0]?.height).toBe(844);
      } finally {
        await bridge.closeSession("r-headed-close", sessionId);
      }
    });
  },
);
