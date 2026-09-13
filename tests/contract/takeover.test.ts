import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserBridge } from "@browser-bridge/core";
import { Router } from "@browser-bridge/cli";
import { ERROR_CONTRACT } from "@browser-bridge/protocol";
import { describe, expect, it, beforeAll, afterAll } from "vitest";

const fixture = pathToFileURL(
  join(process.cwd(), "tests", "fixtures", "index.html"),
).href;

/** Transport-agnostic takeover semantics through the shared router. */
describe("takeover contract", () => {
  const engine = new BrowserBridge({ headless: true });
  const router = new Router(engine);
  let n = 0;

  beforeAll(async () => {
    await engine.launch();
  }, 60_000);

  afterAll(async () => {
    await engine.shutdown();
  });

  const ask = async (
    op: string,
    extra: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> => {
    n += 1;
    const out = await router.dispatch({
      protocolVersion: "1.0",
      requestId: `r-tk-${n}`,
      op,
      ...extra,
    });
    return out as unknown as Record<string, unknown>;
  };

  const refOf = (
    obs: unknown,
    pred: (c: { ref: string; role: string; name: string }) => boolean,
    what: string,
  ): string => {
    const controls = (
      obs as { controls: Array<{ ref: string; role: string; name: string }> }
    ).controls;
    const found = controls.find(pred);
    if (!found) throw new Error(`control not found: ${what}`);
    return found.ref;
  };

  it("pauses agent mutations but keeps reads available", async () => {
    const created = await ask("create", {});
    const sid = created["sessionId"] as string;
    try {
      const opened = await ask("open", { sessionId: sid, url: fixture });
      const input = refOf(
        opened["observation"],
        (c) => c.role === "textbox",
        "item input",
      );

      const paused = await ask("pause", { sessionId: sid });
      expect(paused["status"]).toBe("completed");
      expect(paused["session"]).toMatchObject({ paused: true, owner: "human" });

      const blocked = await ask("click", { sessionId: sid, ref: input });
      expect(blocked).toMatchObject({
        status: "error",
        code: "SESSION_PAUSED",
        retryable: true,
      });
      expect(ERROR_CONTRACT["SESSION_PAUSED"]).toMatchObject({
        outcomeUnknown: false,
        retryable: true,
      });

      const observed = await ask("observe", { sessionId: sid });
      expect(observed["status"]).toBe("completed");
      const diag = await ask("diagnostics", { sessionId: sid });
      expect(diag["status"]).toBe("completed");

      const resumed = await ask("resume", { sessionId: sid });
      expect(resumed["status"]).toBe("completed");
      expect(resumed["session"]).toMatchObject({
        paused: false,
        owner: "agent",
      });
      // Resume refreshes: revision advanced past the pre-pause observation.
      const before = (opened["observation"] as { revision: number }).revision;
      const after = (resumed["observation"] as { revision: number }).revision;
      expect(after).toBeGreaterThan(before);

      const filled = await ask("fill", {
        sessionId: sid,
        ref: refOf(
          resumed["observation"],
          (c) => c.role === "textbox",
          "input",
        ),
        text: "x",
      });
      expect(filled["status"]).toBe("completed");
    } finally {
      await ask("resume", { sessionId: sid });
      await ask("close", { sessionId: sid }).catch(() => undefined);
    }
  });

  it("lets the human channel work during a hold and invalidates stale refs", async () => {
    const created = await ask("create", {});
    const sid = created["sessionId"] as string;
    try {
      const opened = await ask("open", { sessionId: sid, url: fixture });
      const revision = (opened["observation"] as { revision: number }).revision;
      const input = refOf(
        opened["observation"],
        (c) => c.role === "textbox",
        "item input",
      );
      const box = await ask("locate", { sessionId: sid, ref: input });
      expect(box["status"]).toBe("completed");
      const loc = box["location"] as {
        x: number;
        y: number;
        width: number;
        height: number;
      };
      expect(loc.width).toBeGreaterThan(0);

      await ask("pause", { sessionId: sid });

      // Human clicks the input via coordinates, types, then clicks Add.
      const atInput = await ask("act", {
        sessionId: sid,
        action: {
          type: "clickAt",
          x: loc.x + 2,
          y: loc.y + 2,
          screenshotRevision: revision,
        },
      });
      expect(atInput["status"]).toBe("completed");
      const typed = await ask("act", {
        sessionId: sid,
        action: { type: "type", text: "pears" },
      });
      expect(typed["status"]).toBe("completed");

      const afterType = await ask("observe", { sessionId: sid });
      const addBox = await ask("locate", {
        sessionId: sid,
        ref: refOf(
          afterType["observation"],
          (c) => c.name === "Add to cart",
          "add button",
        ),
      });
      const addLoc = addBox["location"] as { x: number; y: number };
      const addRev = (afterType["observation"] as { revision: number })
        .revision;
      const humanClick = await ask("act", {
        sessionId: sid,
        action: {
          type: "clickAt",
          x: addLoc.x + 2,
          y: addLoc.y + 2,
          screenshotRevision: addRev,
        },
      });
      expect(humanClick["status"]).toBe("completed");

      // Stale geometry is rejected, never reinterpreted.
      const stale = await ask("act", {
        sessionId: sid,
        action: { type: "clickAt", x: 10, y: 10, screenshotRevision: revision },
      });
      expect(stale).toMatchObject({
        status: "error",
        code: "STALE_OBSERVATION",
      });

      const outsideObs = await ask("observe", { sessionId: sid });
      const outsideRev = (outsideObs["observation"] as { revision: number })
        .revision;
      const outside = await ask("act", {
        sessionId: sid,
        action: {
          type: "clickAt",
          x: 99999,
          y: 10,
          screenshotRevision: outsideRev,
        },
      });
      expect(outside).toMatchObject({
        status: "error",
        code: "INVALID_REQUEST",
      });

      const resumed = await ask("resume", { sessionId: sid });
      expect((resumed["observation"] as { text: string })["text"]).toContain(
        "Item added: pears",
      );

      // Pre-pause refs died with the resume refresh.
      const dead = await ask("click", { sessionId: sid, ref: input });
      expect(dead).toMatchObject({
        status: "error",
        code: "STALE_OBSERVATION",
      });
    } finally {
      await ask("resume", { sessionId: sid });
      await ask("close", { sessionId: sid }).catch(() => undefined);
    }
  });

  it("supports revision-bound mouse drags during human takeover", async () => {
    const created = await ask("create", {});
    const sid = created["sessionId"] as string;
    try {
      const opened = await ask("open", { sessionId: sid, url: fixture });
      const revision = (opened["observation"] as { revision: number }).revision;
      const slider = refOf(
        opened["observation"],
        (control) => control.role === "slider",
        "range slider",
      );
      const located = await ask("locate", { sessionId: sid, ref: slider });
      const box = located["location"] as {
        x: number;
        y: number;
        width: number;
        height: number;
      };
      await ask("pause", { sessionId: sid });
      const dragged = await ask("act", {
        sessionId: sid,
        action: {
          type: "dragAt",
          from: { x: box.x + 5, y: box.y + box.height / 2 },
          to: { x: box.x + box.width - 5, y: box.y + box.height / 2 },
          screenshotRevision: revision,
        },
      });
      expect(dragged["status"]).toBe("completed");
      expect((dragged["observation"] as { text: string }).text).toMatch(
        /Range: (?:9\d|100)/,
      );
    } finally {
      await ask("resume", { sessionId: sid });
      await ask("close", { sessionId: sid }).catch(() => undefined);
    }
  });

  it("stores annotations against revisions and lists them", async () => {
    const created = await ask("create", {});
    const sid = created["sessionId"] as string;
    try {
      const opened = await ask("open", { sessionId: sid, url: fixture });
      const revision = (opened["observation"] as { revision: number }).revision;

      const added = await ask("annotations", {
        sessionId: sid,
        mode: "add",
        kind: "click",
        x: 120,
        y: 80,
        note: "This button overflows on mobile",
        screenshotRevision: revision,
      });
      expect(added["status"]).toBe("completed");
      expect((added["annotations"] as Array<{ id: string }>).length).toBe(1);

      const listed = await ask("annotations", { sessionId: sid, mode: "list" });
      const anns = listed["annotations"] as Array<{
        note: string;
        revision: number;
        x: number;
        y: number;
      }>;
      expect(anns.length).toBe(1);
      expect(anns[0]).toMatchObject({
        note: "This button overflows on mobile",
        revision,
        x: 120,
        y: 80,
      });

      const bad = await ask("annotations", {
        sessionId: sid,
        mode: "add",
        kind: "click",
        x: 1,
        y: 1,
        note: "stale pin",
        screenshotRevision: revision + 999,
      });
      expect(bad).toMatchObject({ status: "error", code: "STALE_OBSERVATION" });
    } finally {
      await ask("close", { sessionId: sid }).catch(() => undefined);
    }
  });

  it("emits an ordered event timeline with replay", async () => {
    const seen: Array<{ seq: number; type: string }> = [];
    const unsubscribe = engine.subscribe((e) =>
      seen.push({ seq: e.seq, type: e.type }),
    );
    try {
      const created = await ask("create", {});
      const sid = created["sessionId"] as string;
      await ask("open", { sessionId: sid, url: fixture });
      await ask("pause", { sessionId: sid });
      await ask("annotations", {
        sessionId: sid,
        mode: "add",
        kind: "click",
        x: 5,
        y: 5,
        note: "n",
      });
      await ask("resume", { sessionId: sid });
      await ask("close", { sessionId: sid });

      const types = seen.map((e) => e.type);
      for (const expected of [
        "session-created",
        "navigated",
        "paused",
        "annotated",
        "resumed",
        "session-closed",
      ]) {
        expect(types).toContain(expected);
      }
      const seqs = seen.map((e) => e.seq);
      expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);

      const replay = engine.eventsSince(0);
      expect(replay.gap).toBe(false);
      expect(replay.events.length).toBeGreaterThanOrEqual(seen.length);

      // A cursor past the head missed nothing.
      const beyond = engine.eventsSince(999_999_999);
      expect(beyond.events).toEqual([]);
      expect(beyond.gap).toBe(false);
    } finally {
      unsubscribe();
    }
  });

  it("reports a gap after retention overflow", async () => {
    const small = new BrowserBridge({ headless: true, eventCap: 5 });
    const smallRouter = new Router(small);
    await small.launch();
    try {
      const created = (await smallRouter.dispatch({
        protocolVersion: "1.0",
        requestId: "g-1",
        op: "create",
      })) as unknown as Record<string, unknown>;
      const sid = created["sessionId"] as string;
      const dispatch = (
        op: string,
        extra: Record<string, unknown> = {},
      ): Promise<unknown> =>
        smallRouter.dispatch({
          protocolVersion: "1.0",
          requestId: `g-${Math.random()}`,
          op,
          sessionId: sid,
          ...extra,
        });
      await dispatch("open", { url: fixture });
      await dispatch("pause", {});
      await dispatch("annotations", {
        mode: "add",
        kind: "click",
        x: 5,
        y: 5,
        note: "n",
      });
      await dispatch("resume", {});
      await dispatch("close", {});
      // 6 emissions (created, navigated, paused, annotated, resumed, closed)
      // against a cap of 5: replay-from-zero must report the drop.
      const replay = small.eventsSince(0);
      expect(replay.events.length).toBe(5);
      expect(replay.gap).toBe(true);
    } finally {
      await small.shutdown();
    }
  });
});
