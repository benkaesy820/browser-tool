import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserBridge } from "@browser-bridge/core";
import { Router } from "@browser-bridge/cli";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
const fixture = pathToFileURL(
  join(process.cwd(), "tests", "fixtures", "index.html"),
).href;

/** Responsive viewports through the shared router. */
describe("viewport contract", () => {
  const engine = new BrowserBridge({ headless: true });
  const router = new Router(engine);
  let n = 0;

  beforeAll(async () => {
    await engine.launch();
  }, 60_000);

  afterAll(async () => {
    await engine.shutdown();
  });

  afterAll(async () => {
    await engine.shutdown();
  });

  const ask = async (
    op: string,
    extra: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> => {
    n += 1;
    const out = await router.dispatch({
      protocolVersion: "1.0",
      requestId: `r-vp-${n}`,
      op,
      ...extra,
    });
    return out as unknown as Record<string, unknown>;
  };

  it("resizes to presets and proves it with capture dimensions", async () => {
    const created = await ask("create", {});
    const sid = created["sessionId"] as string;
    try {
      await ask("open", { sessionId: sid, url: fixture });
      const mobile = await ask("viewport", {
        sessionId: sid,
        preset: "mobile",
      });
      expect(mobile["status"]).toBe("completed");
      const shot = await ask("screenshot", { sessionId: sid });
      const artifact = (
        shot["artifacts"] as Array<{ width: number; height: number }>
      )[0] as {
        width: number;
        height: number;
      };
      expect(artifact.width).toBe(390);
      expect(artifact.height).toBe(844);

      const custom = await ask("viewport", {
        sessionId: sid,
        width: 500,
        height: 500,
      });
      expect(custom["status"]).toBe("completed");
      const shot2 = await ask("screenshot", { sessionId: sid });
      expect(
        (
          (shot2["artifacts"] as Array<{ width: number }>)[0] as {
            width: number;
          }
        ).width,
      ).toBe(500);
    } finally {
      await ask("close", { sessionId: sid });
    }
  });

  it("pins the page without the window and frees it again", async () => {
    const created = await ask("create", {});
    const sid = created["sessionId"] as string;
    try {
      await ask("open", { sessionId: sid, url: fixture });
      const pinned = await ask("viewport", {
        sessionId: sid,
        preset: "mobile",
        keepWindow: true,
      });
      expect(pinned["status"]).toBe("completed");
      const shot = await ask("screenshot", { sessionId: sid });
      const artifact = (
        shot["artifacts"] as Array<{ width: number; height: number }>
      )[0] as { width: number; height: number };
      expect(artifact.width).toBe(390);
      expect(artifact.height).toBe(844);

      const freed = await ask("viewport", { sessionId: sid, free: true });
      expect(freed["status"]).toBe("completed");
      const shot2 = await ask("screenshot", { sessionId: sid });
      const back = (
        shot2["artifacts"] as Array<{ width: number; height: number }>
      )[0] as { width: number; height: number };
      expect(back.width).toBe(1280);
      expect(back.height).toBe(720);

      const mixed = await ask("viewport", {
        sessionId: sid,
        free: true,
        preset: "mobile",
      });
      expect(mixed).toMatchObject({
        status: "error",
        code: "INVALID_REQUEST",
      });
    } finally {
      await ask("close", { sessionId: sid });
    }
  });

  it("stitches the full page on request, viewport otherwise", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bb-tall-"));
    const rows = Array.from(
      { length: 60 },
      (_, i) => `<div style="height:50px;">row ${i}</div>`,
    ).join("");
    writeFileSync(
      join(dir, "tall.html"),
      `<!doctype html><html><body>${rows}</body></html>`,
    );
    const tall = pathToFileURL(join(dir, "tall.html")).href;
    const created = await ask("create", {});
    const sid = created["sessionId"] as string;
    try {
      await ask("open", { sessionId: sid, url: tall });
      const shot = await ask("screenshot", { sessionId: sid });
      const viewportDims = (
        shot["artifacts"] as Array<{ width: number; height: number }>
      )[0] as { width: number; height: number };
      expect(viewportDims.height).toBe(720);
      const full = await ask("screenshot", {
        sessionId: sid,
        fullPage: true,
      });
      expect(full["status"]).toBe("completed");
      const fullDims = (
        full["artifacts"] as Array<{ width: number; height: number }>
      )[0] as { width: number; height: number };
      expect(fullDims.width).toBe(viewportDims.width);
      expect(fullDims.height).toBeGreaterThan(2000);
    } finally {
      await ask("close", { sessionId: sid });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects nonsense sizes and paused sessions", async () => {
    const created = await ask("create", {});
    const sid = created["sessionId"] as string;
    try {
      await ask("open", { sessionId: sid, url: fixture });
      const bad = await ask("viewport", {
        sessionId: sid,
        width: 100,
        height: 100,
      });
      expect(bad).toMatchObject({ status: "error", code: "INVALID_REQUEST" });
      const neither = await ask("viewport", { sessionId: sid });
      expect(neither).toMatchObject({
        status: "error",
        code: "INVALID_REQUEST",
      });

      await ask("pause", { sessionId: sid });
      const held = await ask("viewport", { sessionId: sid, preset: "desktop" });
      expect(held).toMatchObject({ status: "error", code: "SESSION_PAUSED" });
      await ask("resume", { sessionId: sid });
    } finally {
      await ask("resume", { sessionId: sid });
      await ask("close", { sessionId: sid });
    }
  });
});
