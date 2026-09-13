import { spawn, spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
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
const dir = join(tmpdir(), `bb-verbs-test-${process.pid}`);

/** Human verbs end to end: words in, readable lines out, no JSON files. */
describe("cli verbs", () => {
  let daemon: ReturnType<typeof spawn> | undefined;

  const bridge = (args: string[]): { out: string; status: number | null } => {
    const proc = spawnSync(
      process.execPath,
      [cli, "--daemon-dir", dir, ...args],
      {
        encoding: "utf8",
        timeout: 60_000,
      },
    );
    return {
      out: `${proc.stdout ?? ""}${proc.stderr ?? ""}`,
      status: proc.status,
    };
  };

  beforeAll(async () => {
    if (!existsSync(cli))
      throw new Error(
        "CLI dist missing — run `pnpm build` before interop tests",
      );
    daemon = spawn(
      process.execPath,
      [cli, "--daemon-dir", dir, "daemon", "start"],
      { stdio: "ignore" },
    );
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        const info = JSON.parse(
          await readFile(join(dir, "daemon.json"), "utf8"),
        ) as { port: number; token: string };
        const health = await fetch(`http://127.0.0.1:${info.port}/v1/health`, {
          headers: { authorization: `Bearer ${info.token}` },
          signal: AbortSignal.timeout(3000),
        });
        if (health.ok) break;
      } catch {
        // not ready yet
      }
      if (Date.now() > deadline) throw new Error("verb daemon did not start");
      await new Promise((r) => setTimeout(r, 250));
    }
  }, 60_000);

  afterAll(async () => {
    spawnSync(process.execPath, [cli, "--daemon-dir", dir, "daemon", "stop"], {
      timeout: 30_000,
    });
    daemon?.kill();
    daemon = undefined;
    const { rm } = await import("node:fs/promises");
    await rm(dir, { recursive: true, force: true });
  });

  it("browses entirely in words", () => {
    const opened = bridge(["open", fixture]);
    expect(opened.status).toBe(0);
    expect(opened.out).toContain("✓");

    const state = bridge(["state"]);
    expect(state.status).toBe(0);
    expect(state.out).toContain("Add to cart");

    const asJson = bridge(["state", "--json"]);
    expect(asJson.status).toBe(0);
    const parsed = JSON.parse(asJson.out) as {
      status: string;
      sessionId: string;
      observation: {
        controls: Array<{ ref: string; role: string; name: string }>;
      };
    };
    expect(parsed.status).toBe("completed");
    const input = parsed.observation.controls.find((c) => c.role === "textbox")
      ?.ref as string;

    // Refs are revision-scoped: take the Add ref from the fill result.
    const filledRaw = bridge(["fill", input, "pears", "--json"]);
    expect(filledRaw.status).toBe(0);
    const filledParsed = JSON.parse(filledRaw.out) as {
      observation: { controls: Array<{ ref: string; name: string }> };
    };
    const add = filledParsed.observation.controls.find(
      (c) => c.name === "Add to cart",
    )?.ref as string;
    const clicked = bridge(["click", add]);
    expect(clicked.status).toBe(0);
    expect(clicked.out).toContain("✓");

    const after = bridge(["state"]);
    expect(after.out).toContain("Item added: pears");

    const sized = bridge(["viewport", "mobile"]);
    expect(sized.status).toBe(0);
    expect(sized.out).toContain("390");

    const shot = bridge(["shot"]);
    expect(shot.status).toBe(0);
    const shotPath = /saved (.+\.png)/.exec(shot.out)?.[1] as string;
    expect(shotPath).toBeDefined();
    expect(existsSync(shotPath)).toBe(true);

    const full = bridge(["shot", "--full"]);
    expect(full.status).toBe(0);
    expect(full.out).toContain("full page");

    expect(bridge(["tabs"]).out).toMatch(/\*/);
    expect(bridge(["sessions"]).out).toContain(parsed.sessionId);
    expect(bridge(["viewport", "desktop"]).status).toBe(0);

    const bad = bridge(["click", "el-9-999"]);
    expect(bad.status).toBe(1);
    expect(bad.out).toContain("STALE");

    const closed = bridge(["close"]);
    expect(closed.status).toBe(0);
    expect(closed.out).toContain("closed");
  }, 120_000);

  it("reports new page errors on the action that caused them", () => {
    expect(bridge(["open", fixture]).status).toBe(0);
    const refOf = (name: string): string => {
      const s = JSON.parse(bridge(["state", "--json"]).out) as {
        observation: { controls: Array<{ ref: string; name: string }> };
      };
      const ref = s.observation.controls.find((c) => c.name === name)?.ref;
      expect(ref, `control ${name} present`).toBeDefined();
      return ref as string;
    };
    // A clean action reports no page errors.
    const clean = bridge(["click", refOf("Hover me")]);
    expect(clean.status).toBe(0);
    expect(clean.out).not.toContain("page console error");
    expect(clean.out).not.toContain("page request failed");
    // A click that logs a console error reports it on the same result.
    const boom = bridge(["click", refOf("Log console error")]);
    expect(boom.status).toBe(0);
    expect(boom.out).toContain("page console error");
    expect(boom.out).toContain("boom-42");
    // A click that fires a refused request reports it on the same result.
    const failed = bridge(["click", refOf("Fail a request")]);
    expect(failed.status).toBe(0);
    expect(failed.out).toContain("page request failed");
    expect(failed.out).toContain("127.0.0.1");
    expect(bridge(["close"]).status).toBe(0);
  }, 120_000);

  it("opens profiled sessions and releases the lock on close", () => {
    const profile = `e2e-${process.pid}`;
    const first = bridge(["open", fixture, "--profile", profile]);
    expect(first.status).toBe(0);
    expect(first.out).toContain("✓");
    expect(bridge(["close"]).status).toBe(0);
    // Same profile reusable after close (lock released, storage persists).
    const second = bridge(["open", fixture, "--profile", profile]);
    expect(second.status).toBe(0);
    expect(second.out).toContain("✓");
    expect(bridge(["close"]).status).toBe(0);
  }, 120_000);

  it("replaces a stale remembered session on open", () => {
    // Simulate a daemon restart: the remembered id no longer exists.
    writeFileSync(join(dir, "current-session"), "s-stale-deadbeef\n");
    const reopened = bridge(["open", fixture]);
    expect(reopened.status).toBe(0);
    expect(reopened.out).toContain("✓");
    expect(bridge(["state"]).status).toBe(0);
    expect(bridge(["close"]).status).toBe(0);
  }, 120_000);

  it("streams daemon events as JSON Lines without polling", async () => {
    const proc = spawn(
      process.execPath,
      [cli, "--daemon-dir", dir, "events", "--cursor", "0"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    try {
      const line = await new Promise<string>((resolve, reject) => {
        let output = "";
        const timeout = setTimeout(
          () => reject(new Error("events command produced no event")),
          10_000,
        );
        proc.stdout?.setEncoding("utf8");
        proc.stdout?.on("data", (chunk: string) => {
          output += chunk;
          const end = output.indexOf("\n");
          if (end < 0) return;
          clearTimeout(timeout);
          resolve(output.slice(0, end));
        });
        proc.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });
      expect(JSON.parse(line)).toMatchObject({
        seq: expect.any(Number),
        type: expect.any(String),
      });
    } finally {
      proc.kill();
    }
  });
});
