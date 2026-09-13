import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserBridge } from "@browser-bridge/core";
import { Router } from "@browser-bridge/cli";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const fixture = pathToFileURL(
  join(process.cwd(), "tests", "fixtures", "mouse.html"),
).href;

describe("mouse input contract", () => {
  const engine = new BrowserBridge({ headless: true });
  const router = new Router(engine);
  let request = 0;

  beforeAll(async () => engine.launch(), 60_000);
  afterAll(async () => engine.shutdown());

  const ask = async (
    op: string,
    extra: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> => {
    request += 1;
    return (await router.dispatch({
      protocolVersion: "1.0",
      requestId: `mouse-${request}`,
      op,
      ...extra,
    })) as unknown as Record<string, unknown>;
  };

  it("moves, scrolls at a point, and supports real mouse click variants", async () => {
    const created = await ask("create");
    const sessionId = created["sessionId"] as string;
    try {
      const opened = await ask("open", { sessionId, url: fixture });
      let observation = opened["observation"] as {
        revision: number;
        text: string;
        controls: Array<{ ref: string; name: string }>;
      };
      const target = observation.controls.find(
        (control) => control.name === "Mouse target",
      );
      if (!target) throw new Error("mouse target missing");
      const located = await ask("locate", { sessionId, ref: target.ref });
      const box = located["location"] as {
        x: number;
        y: number;
        width: number;
        height: number;
      };
      const point = {
        x: box.x + box.width / 2,
        y: box.y + box.height / 2,
      };

      const moved = await ask("act", {
        sessionId,
        action: {
          type: "moveAt",
          ...point,
          screenshotRevision: observation.revision,
        },
      });
      observation = moved["observation"] as typeof observation;
      expect(observation.text).toContain("move");

      const freshTarget = observation.controls.find(
        (control) => control.name === "Mouse target",
      );
      if (!freshTarget) throw new Error("fresh mouse target missing");
      const context = await ask("click", {
        sessionId,
        ref: freshTarget.ref,
        button: "right",
      });
      observation = context["observation"] as typeof observation;
      expect(observation.text).toContain("context");

      const doubled = await ask("act", {
        sessionId,
        action: {
          type: "clickAt",
          ...point,
          clickCount: 2,
          screenshotRevision: observation.revision,
        },
      });
      observation = doubled["observation"] as typeof observation;
      expect(observation.text).toContain("double");

      const scrolled = await ask("act", {
        sessionId,
        action: {
          type: "scrollAt",
          x: 640,
          y: 500,
          deltaY: 700,
          screenshotRevision: observation.revision,
        },
      });
      expect((scrolled["observation"] as { text: string }).text).toMatch(
        /scroll:[1-9]\d*/,
      );
    } finally {
      await ask("close", { sessionId });
    }
  });
});
