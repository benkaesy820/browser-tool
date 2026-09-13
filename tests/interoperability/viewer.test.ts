import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Page } from "playwright";
import { describe, expect, it, beforeAll, afterAll } from "vitest";

const root = process.cwd();
const cli = join(root, "packages", "cli", "dist", "cli.js");
const fixture = pathToFileURL(
  join(root, "tests", "fixtures", "index.html"),
).href;
const dir = join(tmpdir(), `bb-viewer-test-${process.pid}`);

interface DaemonInfo {
  port: number;
  token: string;
}

async function waitForDaemon(): Promise<DaemonInfo> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const info = JSON.parse(
        await readFile(join(dir, "daemon.json"), "utf8"),
      ) as DaemonInfo;
      const health = await fetch(`http://127.0.0.1:${info.port}/v1/health`, {
        headers: { authorization: `Bearer ${info.token}` },
        signal: AbortSignal.timeout(3000),
      });
      if (health.ok) return info;
    } catch {
      // not ready yet
    }
    if (Date.now() > deadline) throw new Error("viewer daemon did not start");
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function call(
  info: DaemonInfo,
  op: string,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${info.port}/v1/request`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${info.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      protocolVersion: "1.0",
      requestId: `r-vw-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      op,
      ...extra,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  return (await res.json()) as Record<string, unknown>;
}

async function waitForText(
  page: Page,
  testId: string,
  substr: string,
  timeoutMs = 15_000,
): Promise<void> {
  await page.waitForFunction(
    ([id, text]: string[]) =>
      document
        .querySelector(`[data-testid="${id}"]`)
        ?.textContent?.includes(text ?? "") ?? false,
    [testId, substr],
    { timeout: timeoutMs },
  );
}

describe("viewer stack", () => {
  let daemon: ChildProcess | undefined;
  let info: DaemonInfo | undefined;

  beforeAll(async () => {
    if (!existsSync(cli))
      throw new Error(
        "CLI dist missing — run `pnpm build` before interop tests",
      );
    if (!existsSync(join(root, "apps", "viewer", "dist", "index.html"))) {
      throw new Error(
        "Viewer dist missing — run `pnpm build` before interop tests",
      );
    }
    daemon = spawn(
      process.execPath,
      [cli, "--daemon-dir", dir, "daemon", "start"],
      { stdio: "ignore" },
    );
    info = await waitForDaemon();
  }, 60_000);

  afterAll(async () => {
    try {
      const { spawnSync } = await import("node:child_process");
      spawnSync(
        process.execPath,
        [cli, "--daemon-dir", dir, "daemon", "stop"],
        { timeout: 30_000 },
      );
    } catch {
      // already gone
    }
    daemon?.kill();
    daemon = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  it("serves the viewer shell without auth and guards assets", async () => {
    const page = await fetch(`http://127.0.0.1:${(info as DaemonInfo).port}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("Browser Bridge");

    const files = await readdir(join(root, "apps", "viewer", "dist", "assets"));
    const js = files.find((f) => f.endsWith(".js"));
    expect(js).toBeDefined();
    const asset = await fetch(
      `http://127.0.0.1:${(info as DaemonInfo).port}/assets/${js}`,
    );
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("javascript");

    const traversal = await fetch(
      `http://127.0.0.1:${(info as DaemonInfo).port}/assets/..%2f..%2fpackage.json`,
    );
    const traversalText = await traversal.text();
    expect(traversalText.includes('"name": "browser-bridge"')).toBe(false);

    const health = await fetch(
      `http://127.0.0.1:${(info as DaemonInfo).port}/v1/health`,
      {
        headers: { authorization: `Bearer ${(info as DaemonInfo).token}` },
      },
    );
    expect(
      ((await health.json()) as { viewerBuilt?: boolean }).viewerBuilt,
    ).toBe(true);
  });

  it("streams ordered engine events with replay", async () => {
    const me = info as DaemonInfo;
    const controller = new AbortController();
    const seen: Array<{ seq: number; type: string }> = [];
    let sawId = false;
    let sawNamedEvent = false;
    let buffer = "";
    const streamDone = (async (): Promise<void> => {
      const res = await fetch(
        `http://127.0.0.1:${me.port}/v1/events?cursor=0`,
        {
          headers: {
            authorization: `Bearer ${me.token}`,
            accept: "text/event-stream",
          },
          signal: controller.signal,
        },
      );
      const reader = res.body?.getReader();
      if (!reader) throw new Error("no stream body");
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx = buffer.indexOf("\n\n");
        while (idx >= 0) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of chunk.split("\n")) {
            if (line.startsWith("id: ")) sawId = true;
            if (line.startsWith("event: ")) sawNamedEvent = true;
            if (line.startsWith("data: ")) {
              const event = JSON.parse(line.slice(6)) as {
                seq: number;
                type: string;
              };
              seen.push(event);
            }
          }
          idx = buffer.indexOf("\n\n");
        }
      }
    })();
    streamDone.catch(() => undefined);

    const created = await call(me, "create", {});
    const sid = created["sessionId"] as string;
    await call(me, "open", { sessionId: sid, url: fixture });
    await call(me, "pause", { sessionId: sid });

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !seen.some((e) => e.type === "paused")) {
      await new Promise((r) => setTimeout(r, 200));
    }
    controller.abort();
    await streamDone.catch(() => undefined);

    const types = seen.map((e) => e.type);
    expect(types).toContain("session-created");
    expect(types).toContain("navigated");
    expect(types).toContain("paused");
    expect(sawId).toBe(true);
    expect(sawNamedEvent).toBe(true);
    const seqs = seen.map((e) => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);

    await call(me, "resume", { sessionId: sid });
    await call(me, "close", { sessionId: sid });
  }, 120_000);

  it("runs the takeover gate over viewer HTTP (same tab, fresh state)", async () => {
    const me = info as DaemonInfo;
    const created = await call(me, "create", {});
    const sid = created["sessionId"] as string;
    try {
      const opened = await call(me, "open", { sessionId: sid, url: fixture });
      const controls = (
        opened["observation"] as {
          controls: Array<{ ref: string; role: string }>;
        }
      )["controls"];
      const input = controls.find((c) => c.role === "textbox")?.ref as string;
      const revision = (opened["observation"] as { revision: number }).revision;

      // Agent pauses itself and asks the person to fill the form.
      const paused = await call(me, "pause", { sessionId: sid });
      expect((paused["session"] as { owner?: string }).owner).toBe("human");

      // Agent traffic is now rejected…
      const blocked = await call(me, "fill", {
        sessionId: sid,
        ref: input,
        text: "agent-wins",
      });
      expect(blocked).toMatchObject({
        status: "error",
        code: "SESSION_PAUSED",
      });

      // …while the human channel types and submits through the same queue.
      const box = await call(me, "locate", { sessionId: sid, ref: input });
      const loc = box["location"] as { x: number; y: number };
      await call(me, "act", {
        sessionId: sid,
        action: {
          type: "clickAt",
          x: loc.x + 2,
          y: loc.y + 2,
          screenshotRevision: revision,
        },
      });
      await call(me, "act", {
        sessionId: sid,
        action: { type: "type", text: "human-picked" },
      });
      const afterType = await call(me, "observe", { sessionId: sid });
      const addControls = (
        afterType["observation"] as {
          controls: Array<{ ref: string; name: string }>;
        }
      )["controls"];
      const addBox = await call(me, "locate", {
        sessionId: sid,
        ref: addControls.find((c) => c.name === "Add to cart")?.ref as string,
      });
      const addLoc = addBox["location"] as { x: number; y: number };
      const addRev = (afterType["observation"] as { revision: number })
        .revision;
      await call(me, "act", {
        sessionId: sid,
        action: {
          type: "clickAt",
          x: addLoc.x + 2,
          y: addLoc.y + 2,
          screenshotRevision: addRev,
        },
      });

      // Resume hands the human's final state to the agent on the same tab.
      const resumed = await call(me, "resume", { sessionId: sid });
      expect(resumed["tabId"]).toBe(created["tabId"]);
      expect((resumed["observation"] as { text: string })["text"]).toContain(
        "Item added: human-picked",
      );
    } finally {
      await call(me, "resume", { sessionId: sid });
      await call(me, "close", { sessionId: sid });
    }
  }, 120_000);

  it("drives takeover through the real React UI", async () => {
    const me = info as DaemonInfo;
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${me.port}/#token=${me.token}`);
      await waitForText(page, "connection", "connected");

      await page.getByTestId("new-session").click();
      await page.waitForSelector('[data-testid="session-item"]', {
        timeout: 15_000,
      });
      await page.getByTestId("session-item").first().click();
      await waitForText(page, "owner-badge", "agent control");

      const selectedSession = (
        await page.getByTestId("session-item").first().textContent()
      )?.trim();
      if (!selectedSession) throw new Error("viewer session id missing");
      await call(me, "open", { sessionId: selectedSession, url: fixture });
      await page.getByRole("tab", { name: "observation" }).click();
      await waitForText(page, "obs-text", "Bridge Fixture");

      await page.getByTestId("pause-btn").click();
      await waitForText(page, "owner-badge", "human hold");

      await page.getByRole("tab", { name: "timeline" }).click();
      const events = await page.getByTestId("event-item").count();
      expect(events).toBeGreaterThan(0);

      await page.getByTestId("resume-btn").click();
      await waitForText(page, "owner-badge", "agent control");

      await page.getByTestId("viewport-mobile").click();
      await waitForText(page, "shot-dims", "390");
      await page.getByRole("button", { name: "Scroll" }).click();
      const preview = page.getByTestId("preview-img");
      expect(await preview.getAttribute("class")).toContain("mode-scroll");
      const previewBox = await preview.boundingBox();
      if (!previewBox) throw new Error("viewer preview missing");
      await page.mouse.move(
        previewBox.x + previewBox.width / 2,
        previewBox.y + Math.min(previewBox.height / 2, 200),
      );
      await page.mouse.wheel(0, 360);
      await page.waitForFunction(
        () =>
          document.querySelector(".outcome")?.textContent?.includes("scrollAt"),
        undefined,
        { timeout: 15_000 },
      );
      await page.getByTestId("viewport-free").click();
      await waitForText(page, "shot-dims", "1280");
      await page.close();
    } finally {
      await browser.close();
    }
  }, 120_000);
});
