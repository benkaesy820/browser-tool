import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ERROR_CODES, PHASE5_OPS } from "@browser-bridge/protocol";

const doc = (name: string): string =>
  readFileSync(join(process.cwd(), "docs", name), "utf8");

/** Documentation must name every wire op, error code, and tool — or it rots. */
describe("docs consistency", () => {
  it("protocol doc covers all ops and error codes", () => {
    const text = doc("protocol.md");
    const missingOps = [...PHASE5_OPS].filter(
      (op) => !text.includes(`\`${op}\``),
    );
    expect(
      missingOps,
      `ops missing from docs/protocol.md: ${missingOps.join(", ")}`,
    ).toEqual([]);
    const missingCodes = [...ERROR_CODES].filter(
      (code) => !text.includes(code),
    );
    expect(
      missingCodes,
      `codes missing from docs/protocol.md: ${missingCodes.join(", ")}`,
    ).toEqual([]);
  });

  it("mcp doc covers all tools", () => {
    const text = doc("mcp.md");
    const tools = [
      "browser_start",
      "browser_act",
      "browser_observe",
      "browser_wait",
      "browser_diagnostics",
      "browser_tabs",
      "browser_batch",
      "browser_search",
      "browser_takeover",
      "browser_close",
    ];
    const missing = tools.filter((t) => !text.includes(`\`${t}\``));
    expect(
      missing,
      `tools missing from docs/mcp.md: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("cli doc covers all commands", () => {
    const text = doc("cli.md");
    for (const cmd of [
      "serve",
      "daemon start",
      "daemon stop",
      "call",
      "capabilities",
      "doctor",
      "status",
      "viewer",
      "mcp --stdio",
      "batch --stdin",
      "diagnostics",
      "search",
      "select",
      "check",
      "upload",
      "inspect",
      "profile",
    ]) {
      expect(text.includes(cmd), `docs/cli.md missing: ${cmd}`).toBe(true);
    }
  });
});
