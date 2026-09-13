import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, beforeAll, afterEach } from "vitest";
import { errorResultSchema, resultSchema } from "@browser-bridge/protocol";

const root = process.cwd();
const cli = join(root, "packages", "cli", "dist", "cli.js");
const fixture = pathToFileURL(
  join(root, "tests", "fixtures", "index.html"),
).href;

interface Session {
  child: ChildProcess;
  lines: string[];
  ask: (obj: unknown) => Promise<Record<string, unknown>>;
  sendRaw: (text: string) => void;
  read: () => Promise<Record<string, unknown>>;
}

function startServe(): Session {
  const child = spawn(process.execPath, [cli, "serve", "--stdio"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines: string[] = [];
  const rl = createInterface({
    input: child.stdout as NodeJS.ReadableStream,
    crlfDelay: Infinity,
  });
  const it = rl[Symbol.asyncIterator]();
  const read = async (): Promise<Record<string, unknown>> => {
    const next = await it.next();
    if (next.done) throw new Error("serve closed stdout early");
    lines.push(next.value as string);
    return JSON.parse(next.value as string) as Record<string, unknown>;
  };
  const sendRaw = (text: string): void => {
    child.stdin?.write(text);
  };
  const ask = async (obj: unknown): Promise<Record<string, unknown>> => {
    sendRaw(`${JSON.stringify(obj)}\n`);
    return read();
  };
  return { child, lines, ask, sendRaw, read };
}

function assertStdoutPurity(lines: string[]): void {
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      throw new Error(
        `stdout line is not JSON (log leak?): ${line.slice(0, 200)}`,
      );
    }
    const ok =
      resultSchema.safeParse(parsed).success ||
      errorResultSchema.safeParse(parsed).success;
    if (!ok)
      throw new Error(
        `stdout line is not a protocol envelope: ${line.slice(0, 200)}`,
      );
  }
}

describe("stdio transport", () => {
  beforeAll(() => {
    if (!existsSync(cli))
      throw new Error(
        "CLI dist missing — run `pnpm build` before interop tests",
      );
  });

  let current: ChildProcess | undefined;
  afterEach(() => {
    current?.kill();
    current = undefined;
  });

  it("completes the fixture workflow over JSONL with pure stdout", async () => {
    const session = startServe();
    current = session.child;
    const base = { protocolVersion: "1.0" };

    const created = await session.ask({
      ...base,
      requestId: "r-1",
      op: "create",
    });
    expect(created["status"]).toBe("completed");
    const sid = created["sessionId"] as string;

    const opened = await session.ask({
      ...base,
      requestId: "r-2",
      op: "open",
      sessionId: sid,
      url: fixture,
    });
    const controls = (
      opened["observation"] as {
        controls: Array<{ ref: string; role: string; name: string }>;
      }
    )["controls"];
    const input = controls.find((c) => c.role === "textbox")?.ref as string;

    const filled = await session.ask({
      ...base,
      requestId: "r-3",
      op: "fill",
      sessionId: sid,
      ref: input,
      text: "apples",
    });
    const controls2 = (
      filled["observation"] as {
        controls: Array<{ ref: string; name: string }>;
      }
    )["controls"];
    const add = controls2.find((c) => c.name === "Add to cart")?.ref as string;

    const clicked = await session.ask({
      ...base,
      requestId: "r-4",
      op: "click",
      sessionId: sid,
      ref: add,
    });
    expect((clicked["observation"] as { text: string })["text"]).toContain(
      "Item added: apples",
    );

    const shot = await session.ask({
      ...base,
      requestId: "r-5",
      op: "screenshot",
      sessionId: sid,
    });
    expect(((shot["artifacts"] as Array<unknown>) ?? []).length).toBe(1);

    const closed = await session.ask({
      ...base,
      requestId: "r-6",
      op: "close",
      sessionId: sid,
    });
    expect(closed["status"]).toBe("completed");

    session.child.stdin?.end();
    const code = await new Promise<number | null>((resolve) =>
      session.child.on("exit", resolve),
    );
    expect(code).toBe(0);
    assertStdoutPurity(session.lines);
  }, 120_000);

  it("returns schema-valid envelopes for malformed input", async () => {
    const session = startServe();
    current = session.child;

    const badVersion = await session.ask({
      protocolVersion: "2.0",
      requestId: "r-x",
      op: "capabilities",
    });
    expect(badVersion).toMatchObject({
      status: "error",
      code: "VERSION_UNSUPPORTED",
      requestId: "r-x",
    });

    session.sendRaw("this is not json\n");
    const garbage = await session.read();
    expect(garbage).toMatchObject({ status: "error", code: "INVALID_REQUEST" });

    const unknown = await session.ask({
      protocolVersion: "1.0",
      requestId: "r-y",
      op: "teleport",
    });
    expect(unknown).toMatchObject({ status: "error", code: "INVALID_REQUEST" });

    session.child.stdin?.end();
    await new Promise<number | null>((resolve) =>
      session.child.on("exit", resolve),
    );
    assertStdoutPurity(session.lines);
  }, 120_000);
});
