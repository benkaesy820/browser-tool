import { describe, expect, it } from "vitest";
import { requestSchema, resultSchema } from "@browser-bridge/protocol";

describe("protocol v1 validation", () => {
  it("accepts the first-slice ops", () => {
    const r = requestSchema.safeParse({
      protocolVersion: "1.0",
      requestId: "r-1",
      op: "capabilities",
    });
    expect(r.success).toBe(true);
  });

  it("rejects unknown ops explicitly", () => {
    const r = requestSchema.safeParse({
      protocolVersion: "1.0",
      requestId: "r-2",
      op: "teleport",
    });
    expect(r.success).toBe(false);
  });

  it("rejects incompatible major versions", () => {
    const r = requestSchema.safeParse({
      protocolVersion: "2.0",
      requestId: "r-3",
      op: "capabilities",
    });
    expect(r.success).toBe(false);
  });

  it("rejects malformed refs", () => {
    const r = requestSchema.safeParse({
      protocolVersion: "1.0",
      requestId: "r-4",
      op: "click",
      ref: "button-1",
    });
    expect(r.success).toBe(false);
  });

  it("accepts direct mouse click options", () => {
    const r = requestSchema.safeParse({
      protocolVersion: "1.0",
      requestId: "r-click-options",
      op: "click",
      ref: "el-1-1",
      button: "middle",
      clickCount: 2,
    });
    expect(r.success).toBe(true);
  });

  it("accepts the phase-1 vocabulary", () => {
    for (const op of [
      "navigate",
      "back",
      "press",
      "select",
      "check",
      "scroll",
      "hover",
      "diagnostics",
      "tabs",
      "cancel",
    ] as const) {
      const base = {
        protocolVersion: "1.0",
        requestId: `r-${op}`,
        op,
      } as Record<string, unknown>;
      if (op === "navigate") base["url"] = "http://localhost:3000/";
      if (op === "press") base["key"] = "Enter";
      if (op === "select") {
        base["ref"] = "el-1-1";
        base["values"] = ["a"];
      }
      if (op === "check") {
        base["ref"] = "el-1-2";
        base["checked"] = true;
      }
      if (op === "hover") base["ref"] = "el-1-3";
      expect(requestSchema.safeParse(base).success, op).toBe(true);
    }
  });

  it("validates the act envelope with postconditions", () => {
    const good = requestSchema.safeParse({
      protocolVersion: "1.0",
      requestId: "r-act",
      op: "act",
      action: { type: "click", ref: "el-3-1" },
      postcondition: {
        type: "textVisible",
        text: "Item added",
        timeoutMs: 2000,
      },
      expectedRevision: 3,
    });
    expect(good.success).toBe(true);

    const badAction = requestSchema.safeParse({
      protocolVersion: "1.0",
      requestId: "r-act-bad",
      op: "act",
      action: { type: "teleport", ref: "el-1" },
    });
    expect(badAction.success).toBe(false);

    for (const action of [
      { type: "back" },
      { type: "forward" },
      { type: "reload" },
      { type: "moveAt", x: 10, y: 20, screenshotRevision: 3 },
      {
        type: "scrollAt",
        x: 10,
        y: 20,
        deltaX: 40,
        deltaY: 300,
        screenshotRevision: 3,
      },
      {
        type: "clickAt",
        x: 10,
        y: 20,
        button: "right",
        clickCount: 2,
        screenshotRevision: 3,
      },
    ] as const) {
      const history = requestSchema.safeParse({
        protocolVersion: "1.0",
        requestId: "r-act-hist",
        op: "act",
        action,
      });
      expect(history.success, action.type).toBe(true);
    }

    expect(
      requestSchema.safeParse({
        protocolVersion: "1.0",
        requestId: "r-bad-button",
        op: "act",
        action: {
          type: "clickAt",
          x: 10,
          y: 20,
          button: "fourth",
          screenshotRevision: 3,
        },
      }).success,
    ).toBe(false);
  });

  it("keeps phase-0 results compatible (new fields optional)", () => {
    const legacy = resultSchema.safeParse({
      protocolVersion: "1.0",
      requestId: "r-1",
      sessionId: "s-1",
      tabId: "t-1",
      status: "completed",
      op: "open",
      artifacts: [],
      warnings: [],
    });
    expect(legacy.success).toBe(true);
  });
});
