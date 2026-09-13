import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BrowserBridge } from "@browser-bridge/core";
import { Router } from "@browser-bridge/cli";

/** Journal durability across versions: no browser needed (read-only ops). */
describe("journal upgrade compat", () => {
  it("treats legacy entries (no op field) as uncertain", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bb-journal-"));
    const journal = join(dir, "journal.jsonl");
    writeFileSync(
      journal,
      `${JSON.stringify({ t: "begin", id: "legacy-1", at: Date.now() })}\n`,
    );
    const engine = new BrowserBridge({ headless: true });
    const router = new Router(engine, { journalPath: journal });
    try {
      const out = await router.dispatch({
        protocolVersion: "1.0",
        requestId: "legacy-1",
        op: "sessions",
      });
      expect(out).toMatchObject({ status: "error", code: "OUTCOME_UNKNOWN" });
    } finally {
      await engine.shutdown();
    }
  });

  it("completes normally journaled ids without false uncertainty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bb-journal-"));
    const journal = join(dir, "journal.jsonl");
    const engine = new BrowserBridge({ headless: true });
    try {
      const first = new Router(engine, { journalPath: journal });
      const once = await first.dispatch({
        protocolVersion: "1.0",
        requestId: "r-j1",
        op: "sessions",
      });
      expect(once).toMatchObject({ status: "completed" });
      // A restarted router over the same file must not cry uncertain.
      const second = new Router(engine, { journalPath: journal });
      const twice = await second.dispatch({
        protocolVersion: "1.0",
        requestId: "r-j1",
        op: "sessions",
      });
      expect(twice).toMatchObject({ status: "completed" });
    } finally {
      await engine.shutdown();
    }
  });
});
