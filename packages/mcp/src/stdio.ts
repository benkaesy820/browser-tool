import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BrowserBridge } from "@browser-bridge/core";
import { createMcpServer } from "./server.js";

/**
 * Serve the MCP adapter over stdio (used by `bridge mcp --stdio`).
 * Standard output carries MCP framing only; diagnostics go to stderr.
 */
export async function runStdio(opts: { headed?: boolean } = {}): Promise<void> {
  const engine = new BrowserBridge({ headless: !(opts.headed ?? false) });
  const server = createMcpServer(engine);
  const transport = new StdioServerTransport();
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await engine.shutdown().catch(() => undefined);
  };
  process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));
  process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));
  await server.connect(transport);
  // A CLI subprocess must not outlive its pipe: when the client goes away,
  // shut the browser down and exit instead of orphaning Chromium.
  transport.onclose = () => {
    void shutdown().then(() => process.exit(0));
  };
  console.error("browser-bridge MCP ready");
}
