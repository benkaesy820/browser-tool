import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, beforeAll, afterAll } from "vitest";

const root = process.cwd();
const cli = join(root, "packages", "cli", "dist", "cli.js");
const fixture = pathToFileURL(
  join(root, "tests", "fixtures", "index.html"),
).href;
const dir = join(tmpdir(), `bb-daemon-test-${process.pid}`);
const daemonJson = join(dir, "daemon.json");

interface Info {
  port: number;
  token: string;
}

async function readInfo(): Promise<Info> {
  const raw = await readFile(daemonJson, "utf8");
  return JSON.parse(raw) as Info;
}

async function waitForDaemon(): Promise<Info> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const info = await readInfo();
      const health = await fetch(`http://127.0.0.1:${info.port}/v1/health`, {
        headers: { authorization: `Bearer ${info.token}` },
        signal: AbortSignal.timeout(3000),
      });
      if (health.ok) return info;
    } catch {
      // not ready yet
    }
    if (Date.now() > deadline) throw new Error("daemon did not become ready");
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

function bridgeCallStdin(json: string): {
  stdout: string;
  status: number | null;
} {
  const proc = spawnSync(
    process.execPath,
    [cli, "--daemon-dir", dir, "call", "--stdin"],
    {
      input: json,
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  return { stdout: proc.stdout as string, status: proc.status };
}

describe("daemon transport", () => {
  let daemon: ChildProcess | undefined;

  beforeAll(async () => {
    if (!existsSync(cli))
      throw new Error(
        "CLI dist missing — run `pnpm build` before interop tests",
      );
    daemon = spawn(
      process.execPath,
      [cli, "--daemon-dir", dir, "daemon", "start"],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    daemon.stdout?.resume();
    daemon.stderr?.resume();
    await waitForDaemon();
  }, 60_000);

  afterAll(async () => {
    try {
      spawnSync(
        process.execPath,
        [cli, "--daemon-dir", dir, "daemon", "stop"],
        { timeout: 30_000 },
      );
    } catch {
      // already gone
    }
    daemon?.kill();
    const { rm } = await import("node:fs/promises");
    await rm(dir, { recursive: true, force: true });
  });

  it("refuses unauthenticated requests", async () => {
    const info = await readInfo();
    const res = await fetch(`http://127.0.0.1:${info.port}/v1/health`, {
      signal: AbortSignal.timeout(5000),
    });
    expect(res.status).toBe(401);
  });

  it("refuses a second instance on the same dir", async () => {
    const proc = spawnSync(
      process.execPath,
      [cli, "--daemon-dir", dir, "daemon", "start"],
      {
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    expect(proc.status).toBe(2);
  });

  it("deduplicates session creation by requestId", async () => {
    const info = await waitForDaemon();
    const body = {
      protocolVersion: "1.0",
      requestId: `dup-${Date.now()}`,
      op: "create",
    };
    const first = await call(info, body);
    const second = await call(info, body);
    expect(first["status"]).toBe("completed");
    expect(second["sessionId"]).toBe(first["sessionId"]);
    await call(info, {
      protocolVersion: "1.0",
      requestId: `close-${Date.now()}`,
      op: "close",
      sessionId: first["sessionId"],
    });
  });

  it("completes the fixture workflow across separate calls and processes", async () => {
    const info = await waitForDaemon();
    let n = 0;
    const req = (
      op: string,
      extra: Record<string, unknown> = {},
    ): Record<string, unknown> => ({
      protocolVersion: "1.0",
      requestId: `r-${Date.now()}-${++n}`,
      op,
      ...extra,
    });

    const created = await call(info, req("create"));
    expect(created["status"]).toBe("completed");
    const sid = created["sessionId"] as string;

    // A FRESH process reuses the same session (the Phase-2 gate).
    const viaChild = bridgeCallStdin(
      JSON.stringify(req("observe", { sessionId: sid })),
    );
    expect(viaChild.status).toBe(0);
    const observed = JSON.parse(viaChild.stdout) as Record<string, unknown>;
    expect(observed["sessionId"]).toBe(sid);

    const opened = await call(
      info,
      req("open", { sessionId: sid, url: fixture }),
    );
    const controls = (
      opened["observation"] as {
        controls: Array<{ ref: string; role: string; name: string }>;
      }
    )["controls"];
    const input = controls.find((c) => c.role === "textbox")?.ref as string;

    const filled = await call(
      info,
      req("fill", { sessionId: sid, ref: input, text: "apples" }),
    );
    const controls2 = (
      filled["observation"] as {
        controls: Array<{ ref: string; name: string }>;
      }
    )["controls"];
    const add = controls2.find((c) => c.name === "Add to cart")?.ref as string;

    const clicked = await call(
      info,
      req("click", { sessionId: sid, ref: add }),
    );
    expect((clicked["observation"] as { text: string })["text"]).toContain(
      "Item added: apples",
    );

    const shot = await call(info, req("screenshot", { sessionId: sid }));
    const artifacts = shot["artifacts"] as Array<{ id: string }>;
    expect(artifacts.length).toBe(1);

    // Authenticated artifact bytes over HTTP.
    const png = await fetch(
      `http://127.0.0.1:${info.port}/v1/artifacts/${sid}/${artifacts[0]?.id}`,
      {
        headers: { authorization: `Bearer ${info.token}` },
        signal: AbortSignal.timeout(15_000),
      },
    );
    expect(png.status).toBe(200);
    const bytes = Buffer.from(await png.arrayBuffer());
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const closed = await call(info, req("close", { sessionId: sid }));
    expect(closed["status"]).toBe("completed");
  }, 120_000);
});
