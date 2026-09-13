import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { BrowserBridge } from "@browser-bridge/core";
import type { Control, Observation } from "@browser-bridge/protocol";

const indexUrl = pathToFileURL(
  join(process.cwd(), "tests", "fixtures", "index.html"),
).href;
const popupUrl = pathToFileURL(
  join(process.cwd(), "tests", "fixtures", "popup.html"),
).href;

function refOf(
  obs: Observation | undefined,
  pred: (c: Control) => boolean,
  what: string,
): string {
  const found = obs?.controls.find(pred);
  if (!found) throw new Error(`control not found: ${what}`);
  return found.ref;
}

describe("phase-1 engine slice", () => {
  const bridge = new BrowserBridge({ headless: true });

  beforeAll(async () => {
    await bridge.launch();
  }, 60_000);

  afterAll(async () => {
    await bridge.shutdown();
  });

  it("manages sessions and tabs", async () => {
    const { sessionId, tabId: firstTab } = await bridge.createSession();
    try {
      const listed = await bridge.listSessions("r-p1-sessions");
      expect(listed.sessions).toContain(sessionId);

      await bridge.open("r-p1-first-open", sessionId, indexUrl, firstTab);

      const opened = await bridge.tabOpen("r-p1-tabopen", sessionId, popupUrl);
      const secondTab = opened.tabId;
      expect(secondTab).not.toBe(firstTab);
      expect(opened.observation?.url).toContain("popup.html");

      const tabs = await bridge.tabList("r-p1-tabs", sessionId);
      expect(tabs.tabs).toHaveLength(2);
      expect(tabs.tabs?.find((t) => t.id === secondTab)?.current).toBe(true);

      // No tabId: follows the selected (current) tab.
      const current = await bridge.observe("r-p1-obs-current", sessionId);
      expect(current.tabId).toBe(secondTab);
      expect(current.observation?.url).toContain("popup.html");

      const selected = await bridge.tabSelect(
        "r-p1-select",
        sessionId,
        firstTab,
      );
      expect(selected.observation?.url).toContain("index.html");

      const closed = await bridge.tabClose(
        "r-p1-tabclose",
        sessionId,
        secondTab,
      );
      expect(closed.tabs ?? closed.observation).toBeDefined();
      const after = await bridge.tabList("r-p1-tabs-2", sessionId);
      expect(after.tabs).toHaveLength(1);
    } finally {
      await bridge.closeSession("r-p1-close", sessionId);
    }
  });

  it("navigates history and reloads", async () => {
    const { sessionId } = await bridge.createSession();
    try {
      await bridge.open("r-p1-nav-open", sessionId, indexUrl);
      const went = await bridge.navigate("r-p1-nav", sessionId, popupUrl);
      expect(went.observation?.url).toContain("popup.html");

      const back = await bridge.back("r-p1-back", sessionId);
      expect(back.status).toBe("completed");
      expect(back.observation?.url).toContain("index.html");

      const fwd = await bridge.forward("r-p1-fwd", sessionId);
      expect(fwd.observation?.url).toContain("popup.html");

      const reloaded = await bridge.reload("r-p1-reload", sessionId);
      expect(reloaded.status).toBe("completed");
      expect(reloaded.observation?.url).toContain("popup.html");

      const acted = await bridge.act("r-p1-act-back", sessionId, {
        type: "back",
      });
      expect(acted.status).toBe("completed");
      expect(acted.observation?.url).toContain("index.html");
    } finally {
      await bridge.closeSession("r-p1-nav-close", sessionId);
    }
  });

  it("operates select, checkbox, keyboard, hover, and scroll", async () => {
    const { sessionId } = await bridge.createSession();
    try {
      const opened = await bridge.open("r-p1-ctl-open", sessionId, indexUrl);

      const combo = refOf(
        opened.observation,
        (c) => c.name === "Choice",
        "Choice select",
      );
      const picked = await bridge.select("r-p1-select-opt", sessionId, combo, [
        "b",
      ]);
      expect(picked.observation?.text).toContain("Choice: b");

      const box = refOf(
        picked.observation,
        (c) => c.role === "checkbox",
        "agree checkbox",
      );
      const checked = await bridge.check("r-p1-check", sessionId, box, true);
      expect(checked.observation?.text).toContain("Agree: on");
      // Refs are revision-scoped: use the fresh observation for the next action.
      const boxAgain = refOf(
        checked.observation,
        (c) => c.role === "checkbox",
        "agree checkbox",
      );
      const unchecked = await bridge.check(
        "r-p1-uncheck",
        sessionId,
        boxAgain,
        false,
      );
      expect(unchecked.observation?.text).toContain("Agree: off");

      // Keyboard editing is verified through the app: fill, Backspace, submit.
      const input = refOf(
        unchecked.observation,
        (c) => c.role === "textbox",
        "item input",
      );
      const filled = await bridge.fill("r-p1-fill", sessionId, input, "xc");
      const inputAgain = refOf(
        filled.observation,
        (c) => c.role === "textbox",
        "item input",
      );
      const pressed = await bridge.press(
        "r-p1-press",
        sessionId,
        "Backspace",
        inputAgain,
      );
      const add = refOf(
        pressed.observation,
        (c) => c.name === "Add to cart",
        "add button",
      );
      const submitted = await bridge.click("r-p1-submit", sessionId, add);
      expect(submitted.observation?.text).toContain("Item added: x");

      const hoverBtn = refOf(
        submitted.observation,
        (c) => c.name === "Hover me",
        "hover button",
      );
      const hovered = await bridge.hover("r-p1-hover", sessionId, hoverBtn);
      expect(hovered.observation?.text).toContain("hovered");

      const scrolled = await bridge.scroll(
        "r-p1-scroll",
        sessionId,
        undefined,
        200,
      );
      expect(scrolled.status).toBe("completed");
    } finally {
      await bridge.closeSession("r-p1-ctl-close", sessionId);
    }
  });

  it("captures console diagnostics", async () => {
    const { sessionId } = await bridge.createSession();
    try {
      const opened = await bridge.open("r-p1-diag-open", sessionId, indexUrl);
      const boom = refOf(
        opened.observation,
        (c) => c.name === "Log console error",
        "boom button",
      );
      await bridge.click("r-p1-diag-click", sessionId, boom);
      const diag = await bridge.diagnostics("r-p1-diag", sessionId);
      expect(
        diag.diagnostics?.consoleErrors.some((e) => e.includes("boom-42")),
      ).toBe(true);
    } finally {
      await bridge.closeSession("r-p1-diag-close", sessionId);
    }
  });

  it("waits for conditions and reports timeouts", async () => {
    const { sessionId } = await bridge.createSession();
    try {
      const opened = await bridge.open("r-p1-wait-open", sessionId, indexUrl);
      const input = refOf(
        opened.observation,
        (c) => c.role === "textbox",
        "item input",
      );
      await bridge.fill("r-p1-wait-fill", sessionId, input, "mango");
      const filled = await bridge.observe("r-p1-wait-obs", sessionId);
      const add = refOf(
        filled.observation,
        (c) => c.name === "Add to cart",
        "add button",
      );
      await bridge.click("r-p1-wait-click", sessionId, add);

      const waited = await bridge.wait("r-p1-wait-ok", sessionId, {
        type: "textVisible",
        text: "Item added: mango",
        timeoutMs: 5000,
      });
      expect(waited.postcondition?.status).toBe("satisfied");

      const urlWait = await bridge.wait("r-p1-wait-url", sessionId, {
        type: "urlContains",
        value: "index.html",
        timeoutMs: 2000,
      });
      expect(urlWait.postcondition?.status).toBe("satisfied");

      await expect(
        bridge.wait("r-p1-wait-timeout", sessionId, {
          type: "textVisible",
          text: "zzz-never-appears",
          timeoutMs: 500,
        }),
      ).rejects.toMatchObject({ code: "POSTCONDITION_TIMEOUT" });
    } finally {
      await bridge.closeSession("r-p1-wait-close", sessionId);
    }
  });

  it("binds actions to postconditions with act", async () => {
    const { sessionId } = await bridge.createSession();
    try {
      const opened = await bridge.open("r-p1-act-open", sessionId, indexUrl);
      const input = refOf(
        opened.observation,
        (c) => c.role === "textbox",
        "item input",
      );
      await bridge.fill("r-p1-act-fill", sessionId, input, "kiwi");
      const filled = await bridge.observe("r-p1-act-obs", sessionId);
      const add = refOf(
        filled.observation,
        (c) => c.name === "Add to cart",
        "add button",
      );
      const revision = filled.observation?.revision ?? 0;

      const ok = await bridge.act(
        "r-p1-act-ok",
        sessionId,
        { type: "click", ref: add },
        {
          postcondition: {
            type: "textVisible",
            text: "Item added: kiwi",
            timeoutMs: 5000,
          },
        },
      );
      expect(ok.postcondition?.status).toBe("satisfied");
      expect(ok.observation?.text).toContain("Item added: kiwi");

      const addAgain = refOf(
        ok.observation,
        (c) => c.name === "Add to cart",
        "add button",
      );
      const missed = await bridge.act(
        "r-p1-act-miss",
        sessionId,
        { type: "click", ref: addAgain },
        {
          postcondition: {
            type: "textVisible",
            text: "zzz-never-appears",
            timeoutMs: 500,
          },
        },
      );
      // Command completed; only the expected outcome missed.
      expect(missed.status).toBe("completed");
      expect(missed.postcondition?.status).toBe("timeout");

      await expect(
        bridge.act(
          "r-p1-act-stale",
          sessionId,
          { type: "click", ref: addAgain },
          { expectedRevision: revision + 999 },
        ),
      ).rejects.toMatchObject({ code: "STALE_OBSERVATION" });
    } finally {
      await bridge.closeSession("r-p1-act-close", sessionId);
    }
  });

  it("cancels pending waits", async () => {
    const { sessionId } = await bridge.createSession();
    try {
      await bridge.open("r-p1-cancel-open", sessionId, indexUrl);
      const pending = bridge.wait("r-p1-cancel-wait", sessionId, {
        type: "textVisible",
        text: "zzz-never-appears",
        timeoutMs: 20000,
      });
      await bridge.cancel("r-p1-cancel", sessionId);
      await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });

      // Session stays usable after a cancel.
      const after = await bridge.observe("r-p1-cancel-obs", sessionId);
      expect(after.status).toBe("completed");
    } finally {
      await bridge.closeSession("r-p1-cancel-close", sessionId);
    }
  });
});
