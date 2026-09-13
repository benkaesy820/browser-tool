import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, sep } from "node:path";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { BrowserBridge } from "@browser-bridge/core";
import type { Logger } from "pino";
import {
  daemonFile,
  readDaemonInfo,
  removeDaemonInfo,
  writeDaemonInfo,
} from "./files.js";
import { Router } from "./router.js";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "::ffff:127.0.0.1"]);

function denied(request: FastifyRequest, token: string): boolean {
  if (!LOOPBACK.has(request.hostname)) return true;
  // The viewer shell itself must load without a token (top-level navigation
  // cannot carry an Authorization header); loopback-only binding is its
  // protection, same exposure as the token file. All data APIs need Bearer.
  if (
    request.method === "GET" &&
    (request.url === "/" || request.url.startsWith("/assets/"))
  )
    return false;
  return request.headers["authorization"] !== `Bearer ${token}`;
}

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function defaultViewerDir(): string {
  // Installed CLI bundles apps/viewer/dist as packages/cli/viewer-dist.
  // Source checkouts resolve packages/cli/dist -> repo root -> apps/viewer/dist.
  const here = dirname(fileURLToPath(import.meta.url));
  const source = join(here, "..", "..", "..", "apps", "viewer", "dist");
  if (existsSync(join(source, "index.html"))) return source;
  const bundled = join(here, "..", "viewer-dist");
  return bundled;
}

async function viewerIndex(dir: string): Promise<string | undefined> {
  try {
    const st = await stat(join(dir, "index.html"));
    return st.isFile() ? join(dir, "index.html") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `bridge daemon start`: loopback-only HTTP service so independent shell
 * commands (separate processes) share browser sessions. Authenticated with
 * an OS-user-readable token file; a webpage cannot call it (no token, and
 * browsers never attach our Authorization header cross-origin — CORS is
 * never enabled).
 */
export async function startDaemon(
  log: Logger,
  opts: { port?: number; dir?: string; headed?: boolean; viewerDir?: string },
): Promise<void> {
  const file = daemonFile(opts.dir);

  // Refuse a second instance; tolerate a stale file.
  const stale = await readDaemonInfo(opts.dir).catch(() => undefined);
  if (stale) {
    const alive = await fetch(`http://127.0.0.1:${stale.port}/v1/health`, {
      headers: { authorization: `Bearer ${stale.token}` },
      signal: AbortSignal.timeout(3000),
    })
      .then((r) => r.ok)
      .catch(() => false);
    if (alive) {
      throw Object.assign(
        new Error(
          `Daemon already running (pid ${stale.pid}, port ${stale.port})`,
        ),
        {
          code: "DAEMON_RUNNING",
        },
      );
    }
    log.warn("Removing stale daemon file");
  }

  const token = randomUUID().replace(/-/g, "");
  const headed = opts.headed ?? false;
  const viewerDir = opts.viewerDir ?? defaultViewerDir();
  const engine = new BrowserBridge({ headless: !headed });
  const router = new Router(engine, { journalPath: engine.journalPath() });
  const app: FastifyInstance = Fastify({
    logger: false,
    trustProxy: false,
    bodyLimit: 1_048_576,
  });

  app.addHook("onRequest", async (request, reply) => {
    if (denied(request, token)) {
      await reply.code(401).send({ ok: false, error: "unauthorized" });
    }
  });

  app.post("/v1/request", async (request, reply) => {
    await reply.send(await router.dispatch(request.body));
  });

  app.get("/v1/health", async (_request, reply) => {
    await reply.send({
      ok: true,
      sessions: engine.sessionCount(),
      headed,
      viewerBuilt: (await viewerIndex(viewerDir)) !== undefined,
    });
  });

  app.get("/v1/artifacts/:session/:artifact", async (request, reply) => {
    const params = request.params as Record<string, string>;
    const bytes = await engine.artifactBytes(
      params["session"] ?? "",
      params["artifact"] ?? "",
    );
    if (!bytes) {
      await reply.code(404).send({ ok: false, error: "not found" });
      return;
    }
    await reply.header("content-type", "image/png").send(bytes);
  });

  // Live event stream for the viewer timeline (fetch + ReadableStream; the
  // token rides an Authorization header, which EventSource cannot send).
  // Format: `data: <engine-event-json>\n\n`, heartbeats `: ping\n\n`.
  // Reconnect with ?cursor=<last-seq>; a `gap` event reports dropped history.
  app.get("/v1/events", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const requestedCursor =
      typeof query["cursor"] === "string"
        ? Number(query["cursor"])
        : Number(request.headers["last-event-id"] ?? 0);
    const cursor =
      Number.isFinite(requestedCursor) && requestedCursor >= 0
        ? Math.floor(requestedCursor)
        : 0;
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    raw.flushHeaders();
    const send = (line: string): void => {
      if (!raw.destroyed && !raw.writableEnded) raw.write(line);
    };
    const sendEvent = (event: {
      seq: number;
      type: string;
      at: string;
      sessionId: string;
      tabId?: string;
      revision?: number;
      summary: string;
    }): void => {
      send(
        `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      );
    };
    send("retry: 1000\n\n");
    const unsubscribe = engine.subscribe((event) => {
      sendEvent(event);
    });
    const { events, gap, next } = engine.eventsSince(cursor);
    if (gap) {
      const first = events[0];
      sendEvent({
        seq: first ? first.seq - 1 : next,
        at: new Date().toISOString(),
        type: "gap",
        sessionId: "",
        summary: "event history overflowed; refresh current state",
      });
    }
    for (const event of events) sendEvent(event);
    const heartbeat = setInterval(() => send(": ping\n\n"), 15_000);
    raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  // Viewer shell (unauthenticated by design; see denied()). Only index.html
  // and bundled assets are served; anything else is rejected, and traversal
  // outside the build directory is impossible by construction.
  const serveFile = async (
    rel: string,
  ): Promise<{ bytes: Buffer; type: string } | undefined> => {
    const root = normalize(viewerDir + sep);
    const full = normalize(join(viewerDir, rel));
    if (!full.startsWith(root)) return undefined;
    try {
      const st = await stat(full);
      if (!st.isFile()) return undefined;
    } catch {
      return undefined;
    }
    const dot = full.lastIndexOf(".");
    const type = STATIC_TYPES[full.slice(dot)] ?? "application/octet-stream";
    return { bytes: await readFile(full), type };
  };

  app.get("/", async (_request, reply) => {
    if ((await viewerIndex(viewerDir)) === undefined) {
      await reply
        .code(503)
        .send({ ok: false, error: "viewer not built — run pnpm build first" });
      return;
    }
    const page = await serveFile("index.html");
    if (!page) {
      await reply.code(503).send({ ok: false, error: "viewer not built" });
      return;
    }
    await reply
      .header("content-type", page.type)
      .header("cache-control", "no-store")
      .send(page.bytes);
  });

  app.get("/assets/*", async (request, reply) => {
    const params = request.params as Record<string, string>;
    const page = await serveFile(join("assets", params["*"] ?? ""));
    if (!page) {
      await reply.code(404).send({ ok: false, error: "not found" });
      return;
    }
    await reply
      .header("content-type", page.type)
      .header("cache-control", "max-age=3600")
      .send(page.bytes);
  });

  app.post("/v1/shutdown", async (_request, reply) => {
    // Synchronous stop: clean up first so `daemon stop` returning means
    // the browser is closed. The reply goes out BEFORE app.close() because
    // closing first would wait on our own keep-alive connection (deadlock).
    // A crash mid-cleanup leaves a stale file, which `daemon start`
    // detects via health probe.
    log.info({ sessions: engine.sessionCount() }, "shutdown acknowledged");
    const report = await engine
      .shutdown()
      .catch(() => ({ removed: [], failed: [] }));
    log.info(
      { cleaned: report.removed.length, failed: report.failed },
      "daemon shutdown complete",
    );
    await removeDaemonInfo(opts.dir).catch(() => undefined);
    await reply.send({
      ok: true,
      cleaned: report.removed.length,
      failed: report.failed,
    });
    await app.close().catch(() => undefined);
    // Let the reply flush before exiting; otherwise the client sees reset.
    await new Promise((r) => setTimeout(r, 500));
    process.exit(0);
  });

  const address = await app.listen({ host: "127.0.0.1", port: opts.port ?? 0 });
  await writeDaemonInfo(
    {
      port: Number(new URL(address).port),
      token,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    },
    opts.dir,
  );
  log.info(
    { port: new URL(address).port, pid: process.pid, file, headed },
    "daemon ready",
  );

  const shutdown = async (): Promise<void> => {
    await engine.shutdown().catch(() => undefined);
    await app.close().catch(() => undefined);
    await removeDaemonInfo(opts.dir).catch(() => undefined);
  };
  process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));
  process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));
}

/**
 * `bridge daemon start --detach`: spawn a fully detached daemon that
 * outlives the invoking (ephemeral) shell, then wait for health.
 *
 * Why this exists: `daemon start` runs in the foreground by design. Each
 * agent `bash` invocation is a fresh short-lived shell — a foreground
 * start blocks until the tool timeout kills it, leaving a stale
 * `daemon.json` (dead pid) so the next `bridge state` fails with
 * `daemon unreachable`. PowerShell workarounds are fragile:
 * `Start-Job` dies with its shell and `Start-Process bridge ...` targets
 * the `.ps1` wrapper instead of `node`, so the daemon never survives.
 * `--detach` is the one supported background path (cross-platform via
 * `detached:true` + `unref()`; `windowsHide:true` on Windows).
 */
export async function startDaemonDetached(
  log: Logger,
  opts: { port?: number; dir?: string; headed?: boolean; viewerDir?: string },
): Promise<{ port: number; pid: number }> {
  // Refuse a second instance using the same health probe as foreground.
  const existing = await readDaemonInfo(opts.dir).catch(() => undefined);
  if (existing) {
    const alive = await fetch(`http://127.0.0.1:${existing.port}/v1/health`, {
      headers: { authorization: `Bearer ${existing.token}` },
      signal: AbortSignal.timeout(3000),
    })
      .then((r) => r.ok)
      .catch(() => false);
    if (alive) {
      throw Object.assign(
        new Error(
          `Daemon already running (pid ${existing.pid}, port ${existing.port})`,
        ),
        { code: "DAEMON_RUNNING" },
      );
    }
    log.warn("Removing stale daemon file");
  }

  const cliPath = join(dirname(fileURLToPath(import.meta.url)), "cli.js");
  const args = [cliPath];
  if (opts.dir !== undefined) args.push("--daemon-dir", opts.dir);
  args.push("daemon", "start");
  if (opts.port !== undefined) args.push("--port", String(opts.port));
  if (opts.headed === true) args.push("--headed");
  if (opts.viewerDir !== undefined) args.push("--viewer-dir", opts.viewerDir);

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();

  const deadline = Date.now() + 20_000;
  for (;;) {
    const info = await readDaemonInfo(opts.dir).catch(() => undefined);
    if (info) {
      // Ignore our own stale pre-spawn file: require a fresh timestamp
      // and a passing health probe before declaring success.
      const healthy = await fetch(`http://127.0.0.1:${info.port}/v1/health`, {
        headers: { authorization: `Bearer ${info.token}` },
        signal: AbortSignal.timeout(3000),
      })
        .then((r) => r.ok)
        .catch(() => false);
      if (healthy) {
        // No log.info here: stdout already carries {ok, detached, port,
        // pid} and a stderr line makes PowerShell 5.1 render the success
        // as a NativeCommandError decoration.
        return { port: info.port, pid: info.pid };
      }
    }
    if (Date.now() > deadline) {
      try {
        if (child.pid !== undefined) process.kill(child.pid);
      } catch {
        // already exited
      }
      throw Object.assign(
        new Error("Detached daemon did not become healthy in 20s"),
        { code: "DAEMON_START_TIMEOUT" },
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}
