import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  startFixtureServer,
  type FixtureServer,
} from "../fixtures/http-server.js";

const root = process.cwd();
const cli = join(root, "packages", "cli", "dist", "cli.js");
const dir = join(tmpdir(), `bb-recovery-test-${process.pid}`);

interface Info {
  port: number;
  token: string;
}

async function waitForDaemon(): Promise<Info> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const info = JSON.parse(
        await readFile(join(dir, "daemon.json"), "utf8"),
      ) as Info;
      const health = await fetch(`http://127.0.0.1:${info.port}/v1/health`, {
        headers: { authorization: `Bearer ${info.token}` },
        signal: AbortSignal.timeout(3000),
      });
      if (health.ok) return info;
    } catch {
      // not ready yet
    }
    if (Date.now() > deadline) throw new Error("daemon did not start");
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function call(
  info: Info,
  body: unknown,
): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${info.port}/v1/request`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${info.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  return (await res.json()) as Record<string, unknown>;
}

function stopDaemon(): void {
  spawnSync(process.execPath, [cli, "--daemon-dir", dir, "daemon", "stop"], {
    timeout: 60_000,
  });
}

/**
 * Lost-connection gate: a submission interrupted by daemon death must not
 * be duplicated on retry. The restarted daemon answers OUTCOME_UNKNOWN
 * from the write-ahead journal, and the fixture server proves a single
 * write — never from displayed text.
 */
describe("crash recovery", () => {
  let server: FixtureServer;
  let base = "";
  let daemon: ChildProcess | undefined;

  beforeAll(async () => {
    if (!existsSync(cli))
      throw new Error(
        "CLI dist missing — run `pnpm build` before interop tests",
      );
    server = await startFixtureServer();
    base = server.baseUrl;
  });

  afterAll(async () => {
    try {
      stopDaemon();
    } catch {
      // already gone
    }
    daemon?.kill();
    daemon = undefined;
    await server.close();
    const { rm } = await import("node:fs/promises");
    await rm(dir, { recursive: true, force: true });
  });

  it("reports OUTCOME_UNKNOWN after a mid-submit death without duplicating the write", async () => {
    server.reset();
    daemon = spawn(
      process.execPath,
      [cli, "--daemon-dir", dir, "daemon", "start"],
      { stdio: "ignore" },
    );
    const info = await waitForDaemon();
    let n = 0;
    const req = (
      op: string,
      extra: Record<string, unknown> = {},
    ): Record<string, unknown> => ({
      protocolVersion: "1.0",
      requestId: `r-rec-${++n}`,
      op,
      ...extra,
    });

    const created = await call(info, req("create"));
    const sid = created["sessionId"] as string;
    await call(
      info,
      req("open", { sessionId: sid, url: `${base}/form?block=1` }),
    );
    const observed = await call(info, req("observe", { sessionId: sid }));
    const controls = (
      observed["observation"] as {
        controls: Array<{ ref: string; role: string }>;
      }
    )["controls"];
    const input = controls.find((c) => c.role === "textbox")?.ref as string;
    // Fill focuses the input; Enter submits without actionability gating,
    // keeping the kill step deterministic under loaded CI machines.
    await call(
      info,
      req("fill", { sessionId: sid, ref: input, text: "kill-test" }),
    );

    const killId = `kill-${Date.now()}`;
    const pending = call(info, {
      protocolVersion: "1.0",
      requestId: killId,
      op: "act",
      sessionId: sid,
      action: { type: "press", key: "Enter" },
      postcondition: {
        type: "textVisible",
        text: "Submitted #",
        timeoutMs: 30000,
      },
    });
    pending.catch(() => undefined);
    const deadline = Date.now() + 15_000;
    while (server.writes("submit") < 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(server.writes("submit")).toBe(1);

    // The daemon dies with the submission in flight (graceful stop still
    // aborts it; the journal keeps the id begun-but-uncompleted).
    stopDaemon();
    const exitDeadline = Date.now() + 25_000;
    while (daemon?.exitCode === null && Date.now() < exitDeadline) {
      await new Promise((r) => setTimeout(r, 250));
    }
    daemon?.kill();
    daemon = undefined;
    // Release the held fixture request; the dead daemon never sees it.
    await fetch(`${base}/release?kind=submit`, { method: "POST" });

    daemon = spawn(
      process.execPath,
      [cli, "--daemon-dir", dir, "daemon", "start"],
      { stdio: "ignore" },
    );
    const info2 = await waitForDaemon();

    // Same request id on the restarted daemon: must NOT re-execute.
    // A fresh session id is used to prove the journal fires first —
    // session lookup never happens for uncertain ids.
    const retry = await call(info2, {
      protocolVersion: "1.0",
      requestId: killId,
      op: "act",
      sessionId: "s-definitely-gone",
      action: { type: "press", key: "Enter" },
    });
    expect(retry).toMatchObject({ status: "error", code: "OUTCOME_UNKNOWN" });
    expect(server.writes("submit")).toBe(1);

    stopDaemon();
    daemon = undefined;
    await pending.catch(() => undefined);
  }, 180_000);
});
