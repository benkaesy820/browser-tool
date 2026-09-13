import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it, beforeAll, afterAll } from "vitest";

const root = process.cwd();
const cli = join(root, "packages", "cli", "dist", "cli.js");
const fixture = pathToFileURL(
  join(root, "tests", "fixtures", "index.html"),
).href;

interface TextBlock {
  type: "text";
  text: string;
}

async function toolText(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const out = await client.callTool({ name, arguments: args });
  const text = (out.content as Array<{ type: string; text?: string }>).find(
    (b) => b.type === "text",
  )?.text;
  if (!text) throw new Error(`tool ${name} returned no text block`);
  return JSON.parse(text) as Record<string, unknown>;
}

describe("mcp transport (official SDK client, spawned server)", () => {
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;

  beforeAll(async () => {
    if (!existsSync(cli))
      throw new Error(
        "CLI dist missing — run `pnpm build` before interop tests",
      );
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [cli, "mcp", "--stdio"],
      stderr: "pipe",
    });
    (transport.stderr as unknown as NodeJS.ReadableStream | null)?.resume();
    client = new Client({ name: "interop-probe", version: "0.0.0" });
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    client = undefined;
    // The SDK client does not kill the server child; do it explicitly and
    // require a clean exit (the server shuts its browser down on SIGTERM).
    const pid = transport?.pid ?? null;
    if (pid) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
    await transport?.close().catch(() => undefined);
    transport = undefined;
  });

  it("handshakes with server identity", async () => {
    expect(client?.getServerVersion()?.name).toBe("browser-bridge");
  });

  it("completes the fixture workflow (same core, MCP framing)", async () => {
    const started = await toolText(client as Client, "browser_start", {
      url: fixture,
    });
    const sessionId = started["sessionId"] as string;

    const controls = (
      started["observation"] as {
        controls: Array<{ ref: string; role: string; name: string }>;
      }
    )["controls"];
    const input = controls.find((c) => c.role === "textbox")?.ref as string;
    const filled = await toolText(client as Client, "browser_act", {
      sessionId,
      action: { type: "fill", ref: input, text: "apples" },
    });
    const add = (
      filled["observation"] as {
        controls: Array<{ ref: string; name: string }>;
      }
    )["controls"].find((c) => c.name === "Add to cart")?.ref as string;
    const clicked = await toolText(client as Client, "browser_act", {
      sessionId,
      action: { type: "click", ref: add },
      postcondition: {
        type: "textVisible",
        text: "Item added: apples",
        timeoutMs: 5000,
      },
    });
    expect(clicked["postcondition"]).toMatchObject({ status: "satisfied" });

    const visual = await (client as Client).callTool({
      name: "browser_observe",
      arguments: { sessionId, includeScreenshot: true },
    });
    const image = (
      visual.content as Array<{ type: string; data?: string }>
    ).find((b) => b.type === "image");
    expect(Buffer.from(image?.data ?? "", "base64").subarray(0, 4)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );

    const closed = await toolText(client as Client, "browser_close", {
      sessionId,
    });
    expect(closed["closed"]).toBe(true);
  }, 120_000);

  it("reports the same error codes as the JSONL transport", async () => {
    const started = await toolText(client as Client, "browser_start", {
      url: fixture,
    });
    const sessionId = started["sessionId"] as string;
    const controls = (
      started["observation"] as {
        controls: Array<{ ref: string; name: string }>;
      }
    )["controls"];
    const dupe = controls.find((c) => c.name === "More info")?.ref as string;

    const out = await (client as Client).callTool({
      name: "browser_act",
      arguments: { sessionId, action: { type: "click", ref: dupe } },
    });
    expect(out.isError).toBe(true);
    // Identical code string the JSONL envelope carries for the same failure.
    expect(((out.content as Array<TextBlock>)[0] as TextBlock).text).toMatch(
      /^TARGET_AMBIGUOUS:/,
    );

    await toolText(client as Client, "browser_close", { sessionId });
  });

  it("aborts server work when the client cancels", async () => {
    const started = await toolText(client as Client, "browser_start", {
      url: fixture,
    });
    const sessionId = started["sessionId"] as string;

    const controller = new AbortController();
    const pending = (client as Client).callTool(
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
    await toolText(client as Client, "browser_close", { sessionId });
  });

  it("keeps stdout pure JSON-RPC and exits on stdin close", async () => {
    const child: ChildProcess = spawn(
      process.execPath,
      [cli, "mcp", "--stdio"],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const lines: string[] = [];
    const rl = createInterface({
      input: child.stdout as NodeJS.ReadableStream,
      crlfDelay: Infinity,
    });
    const it = rl[Symbol.asyncIterator]();
    const send = (obj: unknown): void => {
      child.stdin?.write(`${JSON.stringify(obj)}\n`);
    };
    const read = async (): Promise<Record<string, unknown>> => {
      const next = await it.next();
      if (next.done) throw new Error("server closed stdout early");
      lines.push(next.value as string);
      return JSON.parse(next.value as string) as Record<string, unknown>;
    };

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "framing-probe", version: "0.0.0" },
      },
    });
    const hello = await read();
    expect(
      (hello["result"] as { serverInfo?: { name?: string } })["serverInfo"]
        ?.name,
    ).toBe("browser-bridge");

    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const listed = await read();
    const tools =
      (listed["result"] as { tools?: Array<{ name?: string }> })["tools"] ?? [];
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

    send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "browser_close", arguments: { sessionId: "s-nope" } },
    });
    const failed = await read();
    const content =
      (failed["result"] as {
        content?: Array<{ text?: string }>;
        isError?: boolean;
      }) ?? {};
    expect(content.isError).toBe(true);
    expect(content.content?.[0]?.text).toMatch(/^SESSION_NOT_FOUND:/);

    child.stdin?.end();
    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => resolve(-1), 15_000);
      child.on("exit", (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
    expect(code).toBe(0);

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect((JSON.parse(line) as Record<string, unknown>)["jsonrpc"]).toBe(
        "2.0",
      );
    }
  }, 120_000);
});
