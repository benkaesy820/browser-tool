import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BrowserBridge } from "@browser-bridge/core";
import { createMcpServer } from "@browser-bridge/mcp";
import { describe, expect, it, beforeEach, afterEach } from "vitest";

const fixture = pathToFileURL(
  join(process.cwd(), "tests", "fixtures", "index.html"),
).href;

interface TextBlock {
  type: "text";
  text: string;
}

interface ImageBlock {
  type: "image";
  data: string;
  mimeType: string;
}

async function pair() {
  const engine = new BrowserBridge({ headless: true });
  const server = createMcpServer(engine);
  const client = new Client({ name: "contract-probe", version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return {
    client,
    close: async (): Promise<void> => {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
      await engine.shutdown().catch(() => undefined);
    },
  };
}

async function callText(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const out = await client.callTool({ name, arguments: args });
  const text = (out.content as Array<TextBlock | ImageBlock>).find(
    (b) => b.type === "text",
  ) as TextBlock | undefined;
  if (!text) throw new Error(`tool ${name} returned no text block`);
  return JSON.parse(text.text) as Record<string, unknown>;
}

describe("mcp contract (official SDK, in-process)", () => {
  let ctx: Awaited<ReturnType<typeof pair>> | undefined;
  beforeEach(async () => {
    ctx = await pair();
  });
  afterEach(async () => {
    await ctx?.close();
    ctx = undefined;
  });

  it("advertises ten documented tools", async () => {
    const { tools } = (await ctx?.client.listTools()) as {
      tools: Array<{
        name: string;
        description?: string;
        annotations?: Record<string, unknown>;
      }>;
    };
    expect(tools.map((t) => t.name).sort()).toEqual([
      "browser_act",
      "browser_batch",
      "browser_close",
      "browser_diagnostics",
      "browser_observe",
      "browser_search",
      "browser_start",
      "browser_tabs",
      "browser_takeover",
      "browser_wait",
    ]);
    for (const tool of tools)
      expect(tool.description?.length).toBeGreaterThan(20);
    const observe = tools.find((t) => t.name === "browser_observe");
    expect(observe?.annotations).toMatchObject({ readOnlyHint: true });
    const act = tools.find((t) => t.name === "browser_act");
    expect(act?.annotations).toMatchObject({ readOnlyHint: false });
  });

  it("runs the fixture workflow through tools (same core as JSONL)", async () => {
    const client = ctx?.client as Client;
    const started = await callText(client, "browser_start", { url: fixture });
    const sessionId = started["sessionId"] as string;
    expect(sessionId).toMatch(/^s-/);

    const controls = (
      started["observation"] as {
        controls: Array<{ ref: string; role: string; name: string }>;
      }
    )["controls"];
    const input = controls.find((c) => c.role === "textbox")?.ref as string;
    const filled = await callText(client, "browser_act", {
      sessionId,
      action: { type: "fill", ref: input, text: "apples" },
    });
    const add = (
      filled["observation"] as {
        controls: Array<{ ref: string; name: string }>;
      }
    )["controls"].find((c) => c.name === "Add to cart")?.ref as string;
    const clicked = await callText(client, "browser_act", {
      sessionId,
      action: { type: "click", ref: add },
      postcondition: {
        type: "textVisible",
        text: "Item added: apples",
        timeoutMs: 5000,
      },
    });
    expect(clicked["postcondition"]).toMatchObject({ status: "satisfied" });

    const observed = await callText(client, "browser_observe", { sessionId });
    expect((observed["observation"] as { text: string })["text"]).toContain(
      "Item added: apples",
    );

    const diag = await callText(client, "browser_diagnostics", { sessionId });
    expect(diag["diagnostics"]).toBeDefined();

    const tabs = await callText(client, "browser_tabs", {
      sessionId,
      operation: "list",
    });
    expect((tabs["tabs"] as Array<unknown>).length).toBe(1);

    const closed = await callText(client, "browser_close", { sessionId });
    expect(closed["closed"]).toBe(true);
  });

  it("returns the same stable error codes as JSONL", async () => {
    const client = ctx?.client as Client;
    const started = await callText(client, "browser_start", { url: fixture });
    const sessionId = started["sessionId"] as string;

    const controls = (
      started["observation"] as {
        controls: Array<{ ref: string; name: string }>;
      }
    )["controls"];
    const dupe = controls.find((c) => c.name === "More info")?.ref as string;
    const ambiguous = await client.callTool({
      name: "browser_act",
      arguments: { sessionId, action: { type: "click", ref: dupe } },
    });
    expect(ambiguous.isError).toBe(true);
    const text = ((ambiguous.content as Array<TextBlock>)[0] as TextBlock).text;
    expect(text).toMatch(/^TARGET_AMBIGUOUS:/);

    const stale = await client.callTool({
      name: "browser_act",
      arguments: { sessionId, action: { type: "click", ref: "el-9-999" } },
    });
    expect(stale.isError).toBe(true);
    expect(((stale.content as Array<TextBlock>)[0] as TextBlock).text).toMatch(
      /^STALE_OBSERVATION:/,
    );

    await callText(client, "browser_close", { sessionId });
  });

  it("delivers images to capable clients and text to everyone", async () => {
    const client = ctx?.client as Client;
    const started = await callText(client, "browser_start", { url: fixture });
    const sessionId = started["sessionId"] as string;

    const plain = await client.callTool({
      name: "browser_observe",
      arguments: { sessionId },
    });
    expect(
      (plain.content as Array<{ type: string }>).some(
        (b) => b.type === "image",
      ),
    ).toBe(false);

    const visual = await client.callTool({
      name: "browser_observe",
      arguments: { sessionId, includeScreenshot: true },
    });
    const image = (visual.content as Array<ImageBlock>).find(
      (b) => b.type === "image",
    ) as ImageBlock | undefined;
    expect(image?.mimeType).toBe("image/png");
    const bytes = Buffer.from(image?.data ?? "", "base64");
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    await callText(client, "browser_close", { sessionId });
  });

  it("reads observation and screenshot resources", async () => {
    const client = ctx?.client as Client;
    const started = await callText(client, "browser_start", { url: fixture });
    const sessionId = started["sessionId"] as string;
    const resources = started["resources"] as {
      observation: string;
      screenshot: string;
    };

    const templates = await client.listResourceTemplates();
    expect(
      templates.resourceTemplates.map((t) => t.uriTemplate).sort(),
    ).toEqual([
      "browser://sessions/{sessionId}/tabs/{tabId}/observation",
      "browser://sessions/{sessionId}/tabs/{tabId}/screenshot",
    ]);

    const obs = await client.readResource({ uri: resources.observation });
    const obsText = obs.contents[0];
    expect(obsText?.mimeType).toBe("application/json");
    expect(
      JSON.parse((obsText as { text?: string }).text ?? "{}") as Record<
        string,
        unknown
      >,
    ).toMatchObject({});

    const shot = await client.readResource({ uri: resources.screenshot });
    const blob = (shot.contents[0] as { blob?: string }).blob ?? "";
    expect(Buffer.from(blob, "base64").subarray(0, 4)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );

    await expect(
      client.readResource({
        uri: "browser://sessions/s-nope/tabs/t-nope/observation",
      }),
    ).rejects.toThrow();

    await callText(client, "browser_close", { sessionId });
  });

  it("rejects invalid tool arguments before touching the browser", async () => {
    const client = ctx?.client as Client;
    await expect(
      client.callTool({
        name: "browser_act",
        arguments: { sessionId: "s-x", action: { type: "teleport" } },
      }),
    ).rejects.toThrow();
    await expect(
      client.callTool({ name: "browser_nope", arguments: {} }),
    ).rejects.toThrow();
  });

  it("releases the session when the client cancels a wait", async () => {
    const client = ctx?.client as Client;
    const started = await callText(client, "browser_start", { url: fixture });
    const sessionId = started["sessionId"] as string;

    const controller = new AbortController();
    const pending = client.callTool(
      {
        name: "browser_wait",
        arguments: {
          sessionId,
          condition: {
            type: "textVisible",
            text: "zzz-never",
            timeoutMs: 20000,
          },
        },
      },
      undefined,
      { signal: controller.signal, timeout: 30000 },
    );
    setTimeout(() => controller.abort(), 500);
    await expect(pending).rejects.toThrow();

    const resumed = Date.now();
    const observed = await callText(client, "browser_observe", { sessionId });
    expect(Date.now() - resumed).toBeLessThan(15_000);
    expect(observed["sessionId"]).toBe(sessionId);

    await callText(client, "browser_close", { sessionId });
  });

  it("resizes viewports through browser_tabs", async () => {
    const client = ctx?.client as Client;
    const started = await callText(client, "browser_start", { url: fixture });
    const sessionId = started["sessionId"] as string;
    const resized = await callText(client, "browser_tabs", {
      sessionId,
      operation: "viewport",
      preset: "mobile",
    });
    expect(resized["tabId"]).toBeDefined();
    const visual = await callText(client, "browser_observe", {
      sessionId,
      mode: "visual",
      includeScreenshot: true,
    });
    expect((visual["observation"] as { url: string })["url"] ?? "").toContain(
      "index.html",
    );
    await callText(client, "browser_close", { sessionId });
  });

  it("batches, searches, and uploads through tools", async () => {
    const client = ctx?.client as Client;
    const started = await callText(client, "browser_start", { url: fixture });
    const sessionId = started["sessionId"] as string;
    const controls = (
      started["observation"] as {
        controls: Array<{ ref: string; role: string; name: string }>;
      }
    )["controls"];
    const input = controls.find((c) => c.role === "textbox")?.ref as string;
    const add = controls.find((c) => c.name === "Add to cart")?.ref as string;

    const batched = await callText(client, "browser_batch", {
      sessionId,
      actions: [
        { type: "fill", ref: input, text: "mcp-batch" },
        { type: "click", ref: add },
      ],
    });
    expect(
      (batched["steps"] as Array<{ ok: boolean }>).map((s) => s.ok),
    ).toEqual([true, true]);
    expect((batched["observation"] as { text: string })["text"]).toContain(
      "Item added: mcp-batch",
    );

    const found = await callText(client, "browser_search", {
      sessionId,
      query: "cart",
    });
    expect(
      (found["matches"] as Array<{ name: string }>).map((m) => m.name),
    ).toContain("Add to cart");

    const { writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");
    const tmp = joinPath(tmpdir(), `bb-mcp-upload-${process.pid}.txt`);
    writeFileSync(tmp, "mcp-upload-bytes");
    try {
      const uploadPage = pathToFileURL(
        join(process.cwd(), "tests", "fixtures", "upload.html"),
      ).href;
      const opened = await callText(client, "browser_act", {
        sessionId,
        action: { type: "navigate", url: uploadPage },
      });
      const fileInput = (
        opened["observation"] as {
          controls: Array<{ ref: string; role: string }>;
        }
      )["controls"].find((c) => c.role === "textbox")?.ref as string;
      const uploaded = await callText(client, "browser_act", {
        sessionId,
        action: { type: "upload", ref: fileInput, file: tmp },
      });
      expect((uploaded["observation"] as { text: string })["text"]).toContain(
        "picked:",
      );
    } finally {
      rmSync(tmp, { force: true });
      await callText(client, "browser_close", { sessionId });
    }
  });

  it("pauses for takeover and resumes with fresh state", async () => {
    const client = ctx?.client as Client;
    const started = await callText(client, "browser_start", { url: fixture });
    const sessionId = started["sessionId"] as string;

    const paused = await callText(client, "browser_takeover", {
      sessionId,
      operation: "pause",
    });
    expect(paused["session"]).toMatchObject({ paused: true, owner: "human" });

    const status = await callText(client, "browser_takeover", {
      sessionId,
      operation: "status",
    });
    expect(status["session"]).toMatchObject({ paused: true });

    const blocked = await client.callTool({
      name: "browser_act",
      arguments: { sessionId, action: { type: "reload" } },
    });
    expect(blocked.isError).toBe(true);
    expect(
      ((blocked.content as Array<{ text?: string }>)[0] as { text?: string })
        .text,
    ).toMatch(/^SESSION_PAUSED:/);

    const resumed = await callText(client, "browser_takeover", {
      sessionId,
      operation: "resume",
    });
    expect(resumed["session"]).toMatchObject({ paused: false, owner: "agent" });
    expect(resumed["observation"]).toBeDefined();

    await callText(client, "browser_close", { sessionId });
  });
});
