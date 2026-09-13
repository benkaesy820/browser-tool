import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, beforeAll, afterAll } from "vitest";

const root = process.cwd();
const cli = join(root, "packages", "cli", "dist", "cli.js");
const fixture = pathToFileURL(
  join(root, "tests", "fixtures", "index.html"),
).href;
const dir = join(tmpdir(), `bb-examples-${process.pid}`);
const isWindows = process.platform === "win32";

/** PATH shim so examples invoke `bridge` exactly like a real install. */
function makePathEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const shim = join(tmpdir(), `bb-shim-${process.pid}`);
  mkdirSync(shim, { recursive: true });
  if (isWindows) {
    writeFileSync(
      join(shim, "bridge.cmd"),
      `@echo off\r\n"${process.execPath}" "${cli}" %*\r\n`,
    );
  } else {
    const file = join(shim, "bridge");
    writeFileSync(
      file,
      `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`,
    );
    chmodSync(file, 0o755);
  }
  return {
    ...process.env,
    PATH: `${shim}${delimiter}${process.env["PATH"]}`,
    ...extra,
  };
}

async function waitForDaemon(
  daemonDir: string,
): Promise<{ port: number; token: string }> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const info = JSON.parse(
        await readFile(join(daemonDir, "daemon.json"), "utf8"),
      ) as {
        port: number;
        token: string;
      };
      const health = await fetch(`http://127.0.0.1:${info.port}/v1/health`, {
        headers: { authorization: `Bearer ${info.token}` },
        signal: AbortSignal.timeout(3000),
      });
      if (health.ok) return info;
    } catch {
      // not ready yet
    }
    if (Date.now() > deadline) throw new Error("example daemon did not start");
    await new Promise((r) => setTimeout(r, 250));
  }
}

function findPython(): string | undefined {
  for (const bin of ["python", "python3", "py"]) {
    const probe = spawnSync(bin, ["--version"], { timeout: 10_000 });
    if (probe.status === 0) return bin;
  }
  return undefined;
}

describe("example clients", () => {
  beforeAll(async () => {
    if (!existsSync(cli))
      throw new Error(
        "CLI dist missing — run `pnpm build` before interop tests",
      );
    const daemon = spawn(
      process.execPath,
      [cli, "--daemon-dir", dir, "daemon", "start"],
      {
        stdio: "ignore",
        detached: false,
      },
    );
    daemon.unref();
    await waitForDaemon(dir);
    // Keep a handle for cleanup; the daemon outlives individual examples.
    (globalThis as unknown as { __bbDaemon: unknown }).__bbDaemon = daemon;
  }, 60_000);

  afterAll(async () => {
    spawnSync(process.execPath, [cli, "--daemon-dir", dir, "daemon", "stop"], {
      timeout: 30_000,
    });
    const daemon = (
      globalThis as unknown as { __bbDaemon?: { kill: () => void } }
    ).__bbDaemon;
    try {
      daemon?.kill();
    } catch {
      // already gone
    }
    const { rm } = await import("node:fs/promises");
    await rm(dir, { recursive: true, force: true });
  });

  it("node-stdio example completes the workflow (client 1: Node + JSONL)", () => {
    const proc = spawnSync(
      process.execPath,
      [join(root, "examples", "node-stdio", "workflow.mjs"), fixture],
      { env: makePathEnv(), encoding: "utf8", timeout: 120_000 },
    );
    expect(`${proc.stdout}\n${proc.stderr}`).toContain(
      "PASS: node-stdio workflow",
    );
    expect(proc.status).toBe(0);
  }, 120_000);

  it.skipIf(!isWindows)(
    "powershell example completes the workflow (client 2: PS + daemon)",
    () => {
      const proc = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          join(root, "examples", "powershell", "workflow.ps1"),
          "-FixtureUrl",
          fixture,
          "-DaemonDir",
          dir,
        ],
        { env: makePathEnv(), encoding: "utf8", timeout: 120_000 },
      );
      expect(`${proc.stdout}\n${proc.stderr}`).toContain(
        "PASS: powershell workflow",
      );
      expect(proc.status).toBe(0);
    },
    120_000,
  );

  it("typescript example completes the workflow (client 3: TS + fetch)", () => {
    const proc = spawnSync(
      process.execPath,
      [join(root, "examples", "typescript", "workflow.ts"), fixture],
      {
        env: makePathEnv({ BRIDGE_DAEMON_DIR: dir }),
        encoding: "utf8",
        timeout: 120_000,
      },
    );
    expect(`${proc.stdout}\n${proc.stderr}`).toContain(
      "PASS: typescript workflow",
    );
    expect(proc.status).toBe(0);
  }, 120_000);

  const python = findPython();
  it.skipIf(!python)(
    `python example completes the workflow (${python ?? "no python"})`,
    () => {
      const proc = spawnSync(
        python as string,
        [join(root, "examples", "python", "workflow.py"), fixture],
        { env: makePathEnv(), encoding: "utf8", timeout: 120_000 },
      );
      expect(`${proc.stdout}\n${proc.stderr}`).toContain(
        "PASS: python workflow",
      );
      expect(proc.status).toBe(0);
    },
    120_000,
  );

  it.skipIf(isWindows)(
    "shell example completes the workflow (sh + jq, posix only)",
    () => {
      const proc = spawnSync(
        "sh",
        [join(root, "examples", "shell", "workflow.sh")],
        {
          env: {
            ...makePathEnv(),
            FIXTURE_URL: fixture,
            BRIDGE_DAEMON_DIR: dir,
          },
          encoding: "utf8",
          timeout: 120_000,
        },
      );
      expect(`${proc.stdout}\n${proc.stderr}`).toContain(
        "PASS: shell workflow",
      );
      expect(proc.status).toBe(0);
    },
    120_000,
  );
});
