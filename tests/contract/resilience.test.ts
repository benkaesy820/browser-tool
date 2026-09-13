import {
  existsSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserBridge, sanitizeUrl } from "@browser-bridge/core";
import { Router } from "@browser-bridge/cli";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  startFixtureServer,
  type FixtureServer,
} from "../fixtures/http-server.js";

const fileFixture = pathToFileURL(
  join(process.cwd(), "tests", "fixtures", "index.html"),
).href;

interface Control {
  ref: string;
  role: string;
  name: string;
  frame: string;
}

/** Difficult pages + operational resilience through the shared router. */
describe("resilience contract", () => {
  const engine = new BrowserBridge({ headless: true });
  const router = new Router(engine);
  let server: FixtureServer;
  let base = "";
  let n = 0;

  beforeAll(async () => {
    await engine.launch();
    server = await startFixtureServer();
    base = server.baseUrl;
  }, 60_000);

  afterAll(async () => {
    await engine.shutdown();
    await server.close();
  });

  const ask = async (
    op: string,
    extra: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> => {
    n += 1;
    const out = await router.dispatch({
      protocolVersion: "1.0",
      requestId: `r-rs-${n}`,
      op,
      ...extra,
    });
    return out as unknown as Record<string, unknown>;
  };

  const session = async (
    url: string,
  ): Promise<{ sid: string; obs: Record<string, unknown> }> => {
    const created = await ask("create", {});
    const sid = created["sessionId"] as string;
    const opened = await ask("open", { sessionId: sid, url });
    return { sid, obs: opened };
  };

  const refOf = (
    obs: unknown,
    pred: (c: Control) => boolean,
    what: string,
  ): string => {
    const controls = (obs as { controls: Control[] }).controls;
    const found = controls.find(pred);
    if (!found) throw new Error(`control not found: ${what}`);
    return found.ref;
  };

  it("sanitizes logged URLs", () => {
    expect(sanitizeUrl("http://x.test/p?token=secret&b=2#frag")).toBe(
      "http://x.test/p",
    );
    expect(sanitizeUrl("not a url")).toBe("not a url");
  });

  it("submits a form and counts the write server-side", async () => {
    server.reset();
    const { sid } = await session(`${base}/form`);
    try {
      const opened = await ask("observe", { sessionId: sid });
      const input = refOf(
        opened["observation"],
        (c) => c.role === "textbox",
        "name input",
      );
      const filled = await ask("fill", {
        sessionId: sid,
        ref: input,
        text: "ada",
      });
      const send = refOf(
        filled["observation"],
        (c) => c.name === "Send",
        "send button",
      );
      const submitted = await ask("click", { sessionId: sid, ref: send });
      expect((submitted["observation"] as { text: string })["text"]).toContain(
        "Submitted #1",
      );
      expect(server.writes("submit")).toBe(1);
    } finally {
      await ask("close", { sessionId: sid });
    }
  });

  it("follows redirects and meta-refresh hops", async () => {
    const { sid } = await session(`${base}/redirect`);
    try {
      const opened = await ask("observe", { sessionId: sid });
      expect((opened["observation"] as { url: string })["url"]).toContain(
        "/landing",
      );
      await ask("open", { sessionId: sid, url: `${base}/meta` });
      const waited = await ask("wait", {
        sessionId: sid,
        condition: { type: "urlContains", value: "/landing", timeoutMs: 8000 },
      });
      expect(waited["postcondition"]).toMatchObject({ status: "satisfied" });
    } finally {
      await ask("close", { sessionId: sid });
    }
  });

  it("opens slow pages within navigation bounds", async () => {
    const { sid } = await session(`${base}/slow?ms=1500`);
    try {
      const opened = await ask("observe", { sessionId: sid });
      expect((opened["observation"] as { text: string })["text"]).toContain(
        "slow ok",
      );
    } finally {
      await ask("close", { sessionId: sid });
    }
  });

  it("acts inside iframes with frame identity", async () => {
    const { sid } = await session(fileFixture);
    try {
      const opened = await ask("observe", { sessionId: sid });
      const obs = opened["observation"] as {
        controls: Control[];
        frames: Array<{ id: string; url: string }>;
      };
      expect(obs.frames.length).toBeGreaterThanOrEqual(2);
      const inner = obs.controls.find((c) => c.name === "Inner button");
      expect(inner?.frame).not.toBe("f0");
      const clicked = await ask("click", {
        sessionId: sid,
        ref: inner?.ref as string,
      });
      expect((clicked["observation"] as { text: string })["text"]).toContain(
        "inner clicked",
      );
    } finally {
      await ask("close", { sessionId: sid });
    }
  });

  it("adopts popups as tabs", async () => {
    const { sid } = await session(fileFixture);
    try {
      const opened = await ask("observe", { sessionId: sid });
      const link = refOf(
        opened["observation"],
        (c) => c.name === "Open popup",
        "popup link",
      );
      await ask("click", { sessionId: sid, ref: link });
      let tabs: Array<{ id: string }> = [];
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const listed = await ask("tabs", { sessionId: sid });
        tabs = (listed["tabs"] as Array<{ id: string }>) ?? [];
        if (tabs.length >= 2) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(tabs.length).toBeGreaterThanOrEqual(2);
      const popup = tabs.find((t) => t.id !== (opened["tabId"] as string))
        ?.id as string;
      await ask("tab-select", { sessionId: sid, tabId: popup });
      const waited = await ask("wait", {
        sessionId: sid,
        tabId: popup,
        condition: {
          type: "textVisible",
          text: "Hello from popup",
          timeoutMs: 8000,
        },
      });
      expect(waited["postcondition"]).toMatchObject({ status: "satisfied" });
      await ask("tab-close", { sessionId: sid, tabId: popup });
    } finally {
      await ask("close", { sessionId: sid });
    }
  });

  it("dismisses dialogs without deadlocking and records them", async () => {
    const { sid } = await session(`${base}/dialog`);
    try {
      const opened = await ask("observe", { sessionId: sid });
      const alertBtn = refOf(
        opened["observation"],
        (c) => c.name === "Raise alert",
        "alert button",
      );
      await ask("click", { sessionId: sid, ref: alertBtn });
      const waited = await ask("wait", {
        sessionId: sid,
        condition: {
          type: "textVisible",
          text: "after alert",
          timeoutMs: 8000,
        },
      });
      expect(waited["postcondition"]).toMatchObject({ status: "satisfied" });
      const diag = await ask("diagnostics", { sessionId: sid });
      const dialog = (
        diag["diagnostics"] as {
          dialog?: { type: string; message: string; dismissed: boolean };
        }
      )["dialog"];
      expect(dialog).toMatchObject({ type: "alert", dismissed: true });
      expect(dialog?.message).toContain("boom-alert");

      const fresh = await ask("observe", { sessionId: sid });
      const confirmBtn = refOf(
        fresh["observation"],
        (c) => c.name === "Ask confirm",
        "confirm button",
      );
      await ask("click", { sessionId: sid, ref: confirmBtn });
      const cancelled = await ask("wait", {
        sessionId: sid,
        condition: { type: "textVisible", text: "cancelled", timeoutMs: 8000 },
      });
      expect(cancelled["postcondition"]).toMatchObject({ status: "satisfied" });
    } finally {
      await ask("close", { sessionId: sid });
    }
  });

  it("uploads files to the page and posts them to the server", async () => {
    const tmp = join(tmpdir(), `bb-upload-${process.pid}-${Date.now()}.txt`);
    writeFileSync(tmp, "hello-upload-contents");
    try {
      const { sid } = await session(`${base}/upload-page`);
      try {
        server.reset();
        const opened = await ask("observe", { sessionId: sid });
        const file = refOf(
          opened["observation"],
          (c) => c.role === "textbox" && c.name === "File",
          "file input",
        );
        // File inputs surface as textboxes; the upload op targets them by ref.
        const uploaded = await ask("upload", {
          sessionId: sid,
          ref: file,
          file: tmp,
        });
        expect((uploaded["observation"] as { text: string })["text"]).toContain(
          "picked:",
        );
        const fresh = await ask("observe", { sessionId: sid });
        const send = refOf(
          fresh["observation"],
          (c) => c.name === "Send file",
          "send button",
        );
        const posted = await ask("click", { sessionId: sid, ref: send });
        expect((posted["observation"] as { text: string })["text"]).toContain(
          "hasFilename",
        );
        expect(server.writes("upload")).toBe(1);
      } finally {
        await ask("close", { sessionId: sid });
      }
    } finally {
      rmSync(tmp, { force: true });
    }
  });

  it("captures downloads into the session area", async () => {
    server.reset();
    const { sid } = await session(`${base}/landing`);
    try {
      const opened = await ask("observe", { sessionId: sid });
      const dl = refOf(
        opened["observation"],
        (c) => c.name === "Get report",
        "download link",
      );
      await ask("click", { sessionId: sid, ref: dl });
      let downloads: Array<{ fileName: string; path: string; bytes: number }> =
        [];
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const diag = await ask("diagnostics", { sessionId: sid });
        downloads = ((diag["diagnostics"] as { downloads?: typeof downloads })[
          "downloads"
        ] ?? []) as typeof downloads;
        if (downloads.length > 0) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(downloads.length).toBe(1);
      expect(downloads[0]?.bytes).toBeGreaterThan(0);
      expect(existsSync(downloads[0]?.path as string)).toBe(true);
      expect(server.writes("download")).toBe(1);
    } finally {
      await ask("close", { sessionId: sid });
    }
  });

  it("redacts masked regions in screenshots", async () => {
    const { sid } = await session(fileFixture);
    try {
      const opened = await ask("observe", { sessionId: sid });
      const add = refOf(
        opened["observation"],
        (c) => c.name === "Add to cart",
        "add button",
      );
      const shot = await ask("screenshot", { sessionId: sid, maskRefs: [add] });
      expect(shot["status"]).toBe("completed");
      expect(((shot["artifacts"] as Array<unknown>) ?? []).length).toBe(1);
      const bad = await ask("screenshot", {
        sessionId: sid,
        maskRefs: ["el-9-999"],
      });
      expect(bad).toMatchObject({ status: "error", code: "STALE_OBSERVATION" });
    } finally {
      await ask("close", { sessionId: sid });
    }
  });

  it("batches actions against one observation", async () => {
    const { sid } = await session(fileFixture);
    try {
      const opened = await ask("observe", { sessionId: sid });
      const input = refOf(
        opened["observation"],
        (c) => c.role === "textbox",
        "item input",
      );
      const add = refOf(
        opened["observation"],
        (c) => c.name === "Add to cart",
        "add button",
      );
      const batched = await ask("batch", {
        sessionId: sid,
        actions: [
          { type: "fill", ref: input, text: "bx" },
          { type: "click", ref: add },
        ],
      });
      expect(batched["status"]).toBe("completed");
      expect(
        (batched["steps"] as Array<{ ok: boolean }>).map((s) => s.ok),
      ).toEqual([true, true]);
      expect((batched["observation"] as { text: string })["text"]).toContain(
        "Item added: bx",
      );

      const mixed = await ask("batch", {
        sessionId: sid,
        stopOnError: false,
        actions: [
          {
            type: "fill",
            ref: refOf(
              batched["observation"],
              (c) => c.role === "textbox",
              "item input",
            ),
            text: "by",
          },
          { type: "click", ref: "el-9-999" },
          {
            type: "click",
            ref: refOf(
              batched["observation"],
              (c) => c.name === "Add to cart",
              "add button",
            ),
          },
        ],
      });
      expect(mixed["status"]).toBe("completed");
      expect(
        (mixed["steps"] as Array<{ ok: boolean }>).map((s) => s.ok),
      ).toEqual([true, false, true]);
      expect((mixed["observation"] as { text: string })["text"]).toContain(
        "Item added: by",
      );
    } finally {
      await ask("close", { sessionId: sid });
    }
  });

  it("searches controls and acts on the matches", async () => {
    const { sid } = await session(fileFixture);
    try {
      const found = await ask("search", { sessionId: sid, query: "cart" });
      const matches = found["matches"] as Array<{ ref: string; name: string }>;
      expect(matches.some((m) => m.name === "Add to cart")).toBe(true);
      const clicked = await ask("click", {
        sessionId: sid,
        ref: matches.find((m) => m.name === "Add to cart")?.ref as string,
      });
      expect(clicked["status"]).toBe("completed");
      const empty = await ask("search", {
        sessionId: sid,
        query: "zzz-no-such-control",
      });
      expect(empty["matches"]).toEqual([]);
    } finally {
      await ask("close", { sessionId: sid });
    }
  });

  it("diffs observations with deltas and resets", async () => {
    const { sid } = await session(fileFixture);
    try {
      const first = await ask("observe", { sessionId: sid });
      const r1 = (first["observation"] as { revision: number }).revision;
      const input = refOf(
        first["observation"],
        (c) => c.role === "textbox",
        "item input",
      );
      await ask("fill", { sessionId: sid, ref: input, text: "delta" });
      const filled = await ask("observe", { sessionId: sid });
      const add = refOf(
        filled["observation"],
        (c) => c.name === "Add to cart",
        "add button",
      );
      await ask("click", { sessionId: sid, ref: add });

      const delta = await ask("observe", {
        sessionId: sid,
        mode: "delta",
        baseRevision: r1,
      });
      expect(delta["delta"]).toMatchObject({ reset: false });
      expect(
        (delta["delta"] as { addedText: string[] })["addedText"].join("\n"),
      ).toContain("Item added: delta");

      const reset = await ask("observe", {
        sessionId: sid,
        mode: "delta",
        baseRevision: 999,
      });
      expect(reset["delta"]).toMatchObject({ reset: true });
      expect(reset["observation"]).toBeDefined();

      const noBase = await ask("observe", { sessionId: sid, mode: "delta" });
      expect(noBase["delta"]).toMatchObject({ reset: true });
    } finally {
      await ask("close", { sessionId: sid });
    }
  });

  it("inspects a control with attributes and geometry", async () => {
    const { sid } = await session(fileFixture);
    try {
      const opened = await ask("observe", { sessionId: sid });
      const input = refOf(
        opened["observation"],
        (c) => c.role === "textbox",
        "item input",
      );
      const inspected = await ask("observe", {
        sessionId: sid,
        mode: "inspect",
        ref: input,
      });
      const details = inspected["inspection"] as {
        role: string;
        attributes: Record<string, string>;
        box: { width: number } | null;
        visible: boolean;
      };
      expect(details.role).toBe("textbox");
      expect(details.attributes["id"]).toBe("item");
      expect(details.visible).toBe(true);
      expect(details.box?.width).toBeGreaterThan(0);
    } finally {
      await ask("close", { sessionId: sid });
    }
  });

  it("renders visual overlays with and without images", async () => {
    const { sid } = await session(fileFixture);
    try {
      const visual = await ask("observe", { sessionId: sid, mode: "visual" });
      const overlay = visual["overlay"] as Array<{
        n: number;
        ref: string;
        x: number;
        y: number;
      }>;
      expect(overlay.length).toBeGreaterThan(0);
      expect(overlay[0]).toMatchObject({ n: 1 });
      expect(typeof overlay[0]?.x).toBe("number");

      const shot = await ask("observe", {
        sessionId: sid,
        mode: "visual",
        includeScreenshot: true,
      });
      expect(((shot["artifacts"] as Array<unknown>) ?? []).length).toBe(1);
      expect((shot["overlay"] as Array<unknown>).length).toBeGreaterThan(0);
    } finally {
      await ask("close", { sessionId: sid });
    }
  });

  it("reports covered controls as not actionable", async () => {
    const { sid } = await session(`${base}/overlay`);
    try {
      const opened = await ask("observe", { sessionId: sid });
      const covered = refOf(
        opened["observation"],
        (c) => c.name === "Covered button",
        "covered button",
      );
      const blocked = await ask("click", { sessionId: sid, ref: covered });
      expect(blocked).toMatchObject({
        status: "error",
        code: "TARGET_NOT_ACTIONABLE",
      });
      // The error names the covering overlay and its dismiss control.
      expect(String(blocked["message"])).toContain("covered by");
      expect(String(blocked["message"])).toContain("Modal blocks the page");
      const dismissRef = / (el-\d+-\d+) \(Dismiss\)/.exec(
        String(blocked["message"]),
      )?.[1] as string;
      expect(dismissRef).toBeDefined();
      const dismissed = await ask("click", {
        sessionId: sid,
        ref: dismissRef,
      });
      expect(dismissed["status"]).toBe("completed");
      const dismiss = refOf(
        opened["observation"],
        (c) => c.name === "Dismiss",
        "dismiss button",
      );
      await ask("click", { sessionId: sid, ref: dismiss });
      const fresh = await ask("observe", { sessionId: sid });
      const freed = refOf(
        fresh["observation"],
        (c) => c.name === "Covered button",
        "covered button",
      );
      const clicked = await ask("click", { sessionId: sid, ref: freed });
      expect((clicked["observation"] as { text: string })["text"]).toContain(
        "covered clicked",
      );
    } finally {
      await ask("close", { sessionId: sid });
    }
  });

  it("rejects cookie walls on open and never accepts", async () => {
    const { sid, obs: opened } = await session(`${base}/cookie-wall`);
    try {
      const warnings = (opened["warnings"] as string[]) ?? [];
      expect(
        warnings.some(
          (w) => w.includes("dismissed") && w.includes("Reject all"),
        ),
      ).toBe(true);
      const buy = refOf(
        opened["observation"],
        (c) => c.name === "Buy now",
        "buy button",
      );
      const bought = await ask("click", { sessionId: sid, ref: buy });
      const text = (bought["observation"] as { text: string })["text"];
      expect(text).toContain("bought");
      expect(text).not.toContain("TRACKED");
    } finally {
      await ask("close", { sessionId: sid });
    }
  });

  it("pierces open shadow roots and discloses closed ones", async () => {
    const { sid } = await session(`${base}/shadow`);
    try {
      const opened = await ask("observe", { sessionId: sid });
      const controls = (opened["observation"] as { controls: Control[] })
        .controls;
      const shadow = controls.find((c) => c.name === "Shadow button")
        ?.ref as string;
      expect(shadow).toBeDefined();
      const clicked = await ask("click", { sessionId: sid, ref: shadow });
      expect((clicked["observation"] as { text: string })["text"]).toContain(
        "shadow clicked",
      );
      expect(controls.some((c) => c.name === "Hidden button")).toBe(false);
    } finally {
      await ask("close", { sessionId: sid });
    }
  });

  it("scrolls windowed virtual lists into view", async () => {
    const { sid } = await session(`${base}/virtual`);
    try {
      const empty = await ask("search", { sessionId: sid, query: "row 999" });
      expect(empty["matches"]).toEqual([]);

      const found = await ask("search", { sessionId: sid, query: "Rows" });
      const feed = (found["matches"] as Array<{ ref: string }>)[0]
        ?.ref as string;
      expect(feed).toBeDefined();
      await ask("scroll", { sessionId: sid, ref: feed, pixels: 900 });
      const mid = await ask("observe", { sessionId: sid });
      expect((mid["observation"] as { text: string })["text"]).toContain(
        "row 30",
      );

      // Wheel to the bottom in bounded steps (protocol caps pixels at 5000).
      let obs = mid;
      for (let i = 0; i < 6; i++) {
        obs = await ask("scroll", {
          sessionId: sid,
          ref: refOf(obs["observation"], (c) => c.name === "Rows", "feed"),
          pixels: 5000,
        });
      }
      const deep = await ask("search", { sessionId: sid, query: "row 999" });
      const row = (deep["matches"] as Array<{ ref: string }>)[0]?.ref as string;
      expect(row).toBeDefined();
      const clicked = await ask("click", { sessionId: sid, ref: row });
      expect((clicked["observation"] as { text: string })["text"]).toContain(
        "picked row 999",
      );
    } finally {
      await ask("close", { sessionId: sid });
    }
  });

  it("persists profiles across sessions and locks them", async () => {
    const profile = `p5-${process.pid}`;
    const first = await ask("create", { profile });
    const sid = first["sessionId"] as string;
    try {
      await ask("open", { sessionId: sid, url: `${base}/cookie-set` });
      const locked = await ask("create", { profile });
      expect(locked).toMatchObject({ status: "error", code: "POLICY_DENIED" });
    } finally {
      await ask("close", { sessionId: sid });
    }
    const second = await ask("create", { profile });
    const sid2 = second["sessionId"] as string;
    try {
      expect(second["status"]).toBe("completed");
      const echoed = await ask("open", {
        sessionId: sid2,
        url: `${base}/cookie-echo`,
      });
      expect((echoed["observation"] as { text: string })["text"]).toContain(
        "bridge=choc-chip",
      );
    } finally {
      await ask("close", { sessionId: sid2 });
    }
  });

  it("reports crashes fast and recovers for new sessions", async () => {
    const engine2 = new BrowserBridge({ headless: true });
    await engine2.launch();
    const { sessionId } = await engine2.createSession();
    try {
      await engine2.open("r-crash-open", sessionId, fileFixture);
      // Simulate unexpected browser death (not via shutdown).
      const internals = engine2 as unknown as {
        browser?: { close: () => Promise<void> };
      };
      await internals.browser?.close();
      const started = Date.now();
      await expect(
        engine2.observe("r-crash-obs", sessionId),
      ).rejects.toMatchObject({ code: "BROWSER_CRASHED" });
      expect(Date.now() - started).toBeLessThan(15_000);
      const created = await engine2.createSession();
      expect(created.sessionId).toMatch(/^s-/);
      await engine2.closeSession("r-crash-close", created.sessionId);
    } finally {
      await engine2.shutdown();
    }
  });

  it("drops query strings from logged request URLs", async () => {
    const { sid } = await session(`${base}/boom?token=secret`);
    try {
      const diag = await ask("diagnostics", { sessionId: sid });
      const bad = ((
        diag["diagnostics"] as { badResponses?: Array<{ url: string }> }
      )["badResponses"] ?? []) as Array<{ url: string }>;
      expect(bad.length).toBeGreaterThan(0);
      expect(bad[0]?.url).not.toContain("token=secret");
    } finally {
      await ask("close", { sessionId: sid });
    }
  });

  it("removes session artifacts on close and sweeps leftovers", async () => {
    const created = await ask("create", {});
    const sid = created["sessionId"] as string;
    await ask("open", { sessionId: sid, url: fileFixture });
    const shot = await ask("screenshot", { sessionId: sid });
    const path = (
      (shot["artifacts"] as Array<{ path: string }>)[0] as { path: string }
    ).path;
    expect(existsSync(path)).toBe(true);
    await ask("close", { sessionId: sid });
    expect(existsSync(path)).toBe(false);

    const strayRoot = mkdtempSync(join(tmpdir(), "bb-art-"));
    const stray = join(strayRoot, "s-stray");
    mkdirSync(stray);
    utimesSync(stray, new Date(2000, 0, 1), new Date(2000, 0, 1));
    const sweeper = new BrowserBridge({
      headless: true,
      artifactRoot: strayRoot,
      artifactTtlMs: 50,
    });
    await sweeper.launch();
    expect(existsSync(stray)).toBe(false);
    await sweeper.shutdown();
    rmSync(strayRoot, { recursive: true, force: true });
  });
});
