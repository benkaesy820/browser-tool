import { createInterface } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { BrowserBridge } from "@browser-bridge/core";
import type { Logger } from "pino";
import { Router } from "./router.js";

const MAX_LINE_BYTES = 1_048_576;

/**
 * `bridge serve --stdio`: persistent child process speaking JSON Lines.
 * One request object per input line, one response object per output line.
 * Standard output carries protocol messages ONLY; all logging goes to
 * standard error. A contract test fails the build if stdout is polluted.
 */
export async function serveStdio(
  log: Logger,
  opts: { headed?: boolean } = {},
): Promise<void> {
  const engine = new BrowserBridge({ headless: !(opts.headed ?? false) });
  const router = new Router(engine, { journalPath: engine.journalPath() });
  let shuttingDown = false;

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await engine
      .shutdown()
      .catch((err) => log.warn({ err: String(err) }, "shutdown error"));
  };
  process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));
  process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));

  const rl = createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim().length === 0) continue;
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
      output.write(
        `${JSON.stringify({
          protocolVersion: "1.0",
          requestId: "",
          status: "error",
          code: "INVALID_REQUEST",
          message: "Line exceeds 1MB bound",
          outcomeUnknown: false,
          retryable: false,
        })}\n`,
      );
      continue;
    }
    const started = Date.now();
    let raw: unknown;
    try {
      raw = JSON.parse(line) as unknown;
    } catch {
      output.write(
        `${JSON.stringify({
          protocolVersion: "1.0",
          requestId: "",
          status: "error",
          code: "INVALID_REQUEST",
          message: "stdin line is not valid JSON",
          outcomeUnknown: false,
          retryable: false,
        })}\n`,
      );
      continue;
    }
    const response = await router.dispatch(raw);
    output.write(`${JSON.stringify(response)}\n`);
    const op = (raw as Record<string, unknown>)?.["op"];
    log.info(
      {
        op: typeof op === "string" ? op : "?",
        ms: Date.now() - started,
        status: (response as { status: string }).status,
        code: (response as { code?: string }).code,
      },
      "served",
    );
  }
  await shutdown();
}
