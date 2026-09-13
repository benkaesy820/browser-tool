import { describe, expect, it } from "vitest";
import { BrowserBridge } from "@browser-bridge/core";
import { Router } from "@browser-bridge/cli";
import { errorResultSchema, resultSchema } from "@browser-bridge/protocol";

function router() {
  return new Router(new BrowserBridge({ headless: true }));
}

describe("transport contract (shared router)", () => {
  it("rejects non-objects with INVALID_REQUEST", async () => {
    const out = await router().dispatch("not-an-object");
    expect(out).toMatchObject({ status: "error", code: "INVALID_REQUEST" });
    expect(errorResultSchema.safeParse(out).success).toBe(true);
  });

  it("negotiates versions explicitly", async () => {
    const out = await router().dispatch({
      protocolVersion: "9.9",
      requestId: "r-x",
      op: "capabilities",
    });
    expect(out).toMatchObject({
      status: "error",
      code: "VERSION_UNSUPPORTED",
      requestId: "r-x",
    });
    expect(errorResultSchema.safeParse(out).success).toBe(true);
  });

  it("rejects unknown ops with INVALID_REQUEST", async () => {
    const out = await router().dispatch({
      protocolVersion: "1.0",
      requestId: "r-x",
      op: "teleport",
    });
    expect(out).toMatchObject({ status: "error", code: "INVALID_REQUEST" });
  });

  it("requires a sessionId for session-scoped ops", async () => {
    const out = await router().dispatch({
      protocolVersion: "1.0",
      requestId: "r-x",
      op: "click",
      ref: "el-1-1",
    });
    expect(out).toMatchObject({ status: "error", code: "INVALID_REQUEST" });
  });

  it("maps unknown sessions to SESSION_NOT_FOUND (not retryable)", async () => {
    const out = await router().dispatch({
      protocolVersion: "1.0",
      requestId: "r-x",
      sessionId: "s-nope",
      op: "observe",
    });
    expect(out).toMatchObject({
      status: "error",
      code: "SESSION_NOT_FOUND",
      retryable: false,
      outcomeUnknown: false,
    });
    expect(errorResultSchema.safeParse(out).success).toBe(true);
  });

  it("serves capability discovery without a browser", async () => {
    const out = await router().dispatch({
      protocolVersion: "1.0",
      requestId: "r-cap",
      op: "capabilities",
    });
    expect(out).toMatchObject({ status: "completed", op: "capabilities" });
    expect(resultSchema.safeParse(out).success).toBe(true);
    if (out.status === "completed") {
      expect(out.capabilities?.ops).toContain("create");
      expect(out.capabilities?.ops).toContain("act");
      expect(out.capabilities?.protocolVersion).toBe("1.0");
    }
  });

  it("lists sessions without launching a browser", async () => {
    const out = await router().dispatch({
      protocolVersion: "1.0",
      requestId: "r-s",
      op: "sessions",
    });
    expect(out).toMatchObject({ status: "completed", sessions: [] });
    expect(resultSchema.safeParse(out).success).toBe(true);
  });

  it("validates phase-5 ops without a browser", async () => {
    const emptyBatch = await router().dispatch({
      protocolVersion: "1.0",
      requestId: "r-b",
      op: "batch",
      actions: [],
    });
    expect(emptyBatch).toMatchObject({
      status: "error",
      code: "INVALID_REQUEST",
    });

    const emptySearch = await router().dispatch({
      protocolVersion: "1.0",
      requestId: "r-q",
      op: "search",
      query: "",
    });
    expect(emptySearch).toMatchObject({
      status: "error",
      code: "INVALID_REQUEST",
    });

    const noSession = await router().dispatch({
      protocolVersion: "1.0",
      requestId: "r-u",
      op: "upload",
      ref: "el-1-1",
      file: "x",
    });
    expect(noSession).toMatchObject({
      status: "error",
      code: "INVALID_REQUEST",
    });

    const pauseUnknown = await router().dispatch({
      protocolVersion: "1.0",
      requestId: "r-p",
      op: "pause",
      sessionId: "s-nope",
    });
    expect(pauseUnknown).toMatchObject({
      status: "error",
      code: "SESSION_NOT_FOUND",
    });
  });
});
