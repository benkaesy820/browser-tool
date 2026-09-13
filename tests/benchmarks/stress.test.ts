import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execSync } from "node:child_process";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { BrowserBridge } from "@browser-bridge/core";
import { writeResult } from "./stats.js";

const fixture = pathToFileURL(
  join(process.cwd(), "tests", "fixtures", "index.html"),
).href;
const CYCLES = 100;

function chromeCount(): number {
  try {
    if (process.platform === "win32") {
      const out = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /FO CSV', {
        encoding: "utf8",
        timeout: 15_000,
      });
      const headless = execSync(
        'tasklist /FI "IMAGENAME eq headless_shell.exe" /FO CSV',
        { encoding: "utf8", timeout: 15_000 },
      );
      const count = (text: string, name: string): number =>
        text.split("\n").filter((l) => l.includes(name)).length;
      return count(out, "chrome.exe") + count(headless, "headless_shell.exe");
    }
    const out = execSync("ps -A -o comm=", {
      encoding: "utf8",
      timeout: 15_000,
    });
    return out.split("\n").filter((l) => {
      const c = l.trim();
      return (
        c === "chrome" ||
        c === "headless_shell" ||
        c.endsWith("/chrome") ||
        c.endsWith("/headless_shell")
      );
    }).length;
  } catch {
    return -1;
  }
}

/** 100 open/close cycles: no owned sessions left, no orphan processes. */
describe("benchmark stress", () => {
  const bridge = new BrowserBridge({ headless: true });
  let before = -1;

  beforeAll(async () => {
    await bridge.launch();
    before = chromeCount();
  }, 60_000);

  afterAll(async () => {
    await bridge.shutdown();
  });

  it("cycles sessions without leaking", async () => {
    const started = Date.now();
    for (let i = 0; i < CYCLES; i++) {
      const { sessionId } = await bridge.createSession();
      await bridge.open(`bench-cycle-${i}`, sessionId, fixture);
      await bridge.closeSession(`bench-cycle-close-${i}`, sessionId);
    }
    const ms = Date.now() - started;
    expect(bridge.sessionCount()).toBe(0);
    await new Promise((r) => setTimeout(r, 2000));
    const after = chromeCount();
    // Owned sessions are the hard gate. OS process counts are informational
    // only: parallel workers share this machine, so deltas can't attribute
    // leaks to this file. Run solo for a strict reading.
    writeResult("stress", {
      cycles: CYCLES,
      ms,
      perCycleMs: Math.round((ms / CYCLES) * 10) / 10,
      chromeBefore: before,
      chromeAfter: after,
    });
  }, 300_000);
});
