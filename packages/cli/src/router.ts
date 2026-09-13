import { appendFile, readFile, writeFile } from "node:fs/promises";
import { BrowserBridge } from "@browser-bridge/core";
import {
  ERROR_CONTRACT,
  negotiateVersion,
  requestSchema,
  toErrorResult,
  type ErrorCode,
  type ErrorResult,
  type Postcondition,
  type Request,
  type Result,
} from "@browser-bridge/protocol";

const CREATE_DEDUPE_MS = 5 * 60_000;
const CREATE_DEDUPE_CAP = 200;
const UNCERTAIN_TTL_MS = 30 * 60_000;
const JOURNAL_CAP_LINES = 2000;

/**
 * Failures proven to happen before any page side effect: safe to mark the
 * journal complete, so a later retry with the same id executes normally.
 * Anything else leaves the id uncertain (OUTCOME_UNKNOWN on retry).
 */
const PRE_EFFECT_CODES = new Set<ErrorCode>([
  "INVALID_REQUEST",
  "VERSION_UNSUPPORTED",
  "SESSION_NOT_FOUND",
  "TAB_NOT_FOUND",
  "STALE_OBSERVATION",
  "TARGET_AMBIGUOUS",
  "TARGET_NOT_ACTIONABLE",
  "TARGET_NOT_FOUND",
  "POLICY_DENIED",
  "CANCELLED",
]);

export interface RouterOptions {
  /** Durable write-ahead journal; enables cross-restart OUTCOME_UNKNOWN. */
  journalPath?: string;
  uncertainTtlMs?: number;
}

function codeOf(err: unknown): ErrorCode {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === "string" && code in ERROR_CONTRACT)
    return code as ErrorCode;
  return "BROWSER_CRASHED";
}

function idsOf(raw: unknown): { sessionId?: string; tabId?: string } {
  if (typeof raw !== "object" || raw === null) return {};
  const rec = raw as Record<string, unknown>;
  return {
    ...(typeof rec["sessionId"] === "string"
      ? { sessionId: rec["sessionId"] as string }
      : {}),
    ...(typeof rec["tabId"] === "string"
      ? { tabId: rec["tabId"] as string }
      : {}),
  };
}

function invalidDetails(raw: unknown): string {
  const parsed = requestSchema.safeParse(raw);
  if (parsed.success) return "invalid request";
  return parsed.error.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ")
    .slice(0, 1000);
}

function needSession(req: Request): string {
  if (
    !("sessionId" in req) ||
    typeof req.sessionId !== "string" ||
    req.sessionId.length === 0
  ) {
    throw Object.assign(new Error(`Op "${req.op}" requires a sessionId`), {
      code: "INVALID_REQUEST",
    });
  }
  return req.sessionId;
}

/**
 * Single command router serving every adapter (JSONL stdio, daemon HTTP,
 * future MCP). Adapters translate framing; they never reimplement dispatch.
 */
export class Router {
  private readonly createSeen = new Map<
    string,
    { at: number; result: Result }
  >();
  private readonly journalPath: string | undefined;
  private readonly uncertainTtlMs: number;
  private uncertain = new Map<string, { at: number; op?: string }>();
  private journalLoaded = false;
  private journalAppends = 0;
  /** Same-id concurrent dispatches join one execution (no double submit). */
  private readonly inflight = new Map<string, Promise<Result | ErrorResult>>();

  constructor(
    private readonly engine: BrowserBridge,
    opts: RouterOptions = {},
  ) {
    this.journalPath = opts.journalPath;
    this.uncertainTtlMs = opts.uncertainTtlMs ?? UNCERTAIN_TTL_MS;
  }

  /**
   * Load (once) the write-ahead journal: ids begun but never completed
   * within the TTL are uncertain — a previous worker may have applied
   * them before dying. Completed history is rotated away.
   */
  private async loadJournal(): Promise<void> {
    if (this.journalLoaded || !this.journalPath) return;
    this.journalLoaded = true;
    let text = "";
    try {
      text = await readFile(this.journalPath, "utf8");
    } catch {
      return;
    }
    const begun = new Map<string, { at: number; op?: string }>();
    const ended = new Set<string>();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as {
          t?: unknown;
          id?: unknown;
          at?: unknown;
          op?: unknown;
        };
        if (typeof entry.id !== "string") continue;
        if (entry.t === "begin" && typeof entry.at === "number") {
          begun.set(entry.id, {
            at: entry.at,
            ...(typeof entry.op === "string" ? { op: entry.op } : {}),
          });
        }
        if (entry.t === "end") ended.add(entry.id);
      } catch {
        continue;
      }
    }
    const now = Date.now();
    const lines: string[] = [];
    for (const [id, info] of begun) {
      if (!ended.has(id) && now - info.at < this.uncertainTtlMs) {
        this.uncertain.set(id, info);
        lines.push(
          JSON.stringify({
            t: "begin",
            id,
            ...(info.op ? { op: info.op } : {}),
            at: info.at,
          }),
        );
      }
    }
    await writeFile(
      this.journalPath,
      lines.length > 0 ? `${lines.join("\n")}\n` : "",
    ).catch(() => undefined);
  }

  private async journal(
    t: "begin" | "end",
    requestId: string,
    op?: string,
  ): Promise<void> {
    if (!this.journalPath) return;
    const line =
      t === "begin"
        ? JSON.stringify({ t, id: requestId, op, at: Date.now() })
        : JSON.stringify({ t, id: requestId, at: Date.now() });
    await appendFile(this.journalPath, `${line}\n`).catch(() => undefined);
    if (t === "end") {
      this.uncertain.delete(requestId);
    } else {
      this.uncertain.set(requestId, { at: Date.now(), ...(op ? { op } : {}) });
    }
    this.journalAppends += 1;
    if (this.journalAppends >= JOURNAL_CAP_LINES) {
      this.journalAppends = 0;
      const lines = [...this.uncertain.entries()].map(([id, info]) =>
        JSON.stringify({
          t: "begin",
          id,
          ...(info.op ? { op: info.op } : {}),
          at: info.at,
        }),
      );
      await writeFile(
        this.journalPath,
        lines.length > 0 ? `${lines.join("\n")}\n` : "",
      ).catch(() => undefined);
    }
  }

  async dispatch(raw: unknown): Promise<Result | ErrorResult> {
    const negotiated = negotiateVersion(raw);
    if (negotiated.error) return negotiated.error;

    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success) {
      return toErrorResult("INVALID_REQUEST", invalidDetails(raw), {
        requestId: negotiated.requestId,
        ...idsOf(raw),
      });
    }
    const req = parsed.data as Request;
    if (this.journalPath) {
      await this.loadJournal();
      if (this.uncertain.has(req.requestId)) {
        return toErrorResult(
          "OUTCOME_UNKNOWN",
          `Request ${req.requestId} may have executed before a restart. Verify the external state instead of retrying blindly.`,
          { requestId: req.requestId, ...idsOf(raw) },
        );
      }
    }
    const running = this.inflight.get(req.requestId);
    if (running) return running;
    const run = this.execute(req, raw);
    this.inflight.set(req.requestId, run);
    try {
      return await run;
    } finally {
      if (this.inflight.get(req.requestId) === run)
        this.inflight.delete(req.requestId);
    }
  }

  private async execute(
    req: Request,
    raw: unknown,
  ): Promise<Result | ErrorResult> {
    if (this.journalPath) {
      await this.journal("begin", req.requestId, req.op);
    }
    try {
      const out = await this.route(req);
      await this.journal("end", req.requestId);
      return out;
    } catch (err) {
      const code = codeOf(err);
      if (PRE_EFFECT_CODES.has(code)) await this.journal("end", req.requestId);
      const message = err instanceof Error ? err.message : String(err);
      return toErrorResult(code, message.slice(0, 1000), {
        requestId: req.requestId,
        ...idsOf(raw),
      });
    }
  }

  private rememberCreate(requestId: string, result: Result): void {
    this.createSeen.set(requestId, { at: Date.now(), result });
    while (this.createSeen.size > CREATE_DEDUPE_CAP) {
      const oldest = this.createSeen.keys().next();
      if (oldest.done) break;
      this.createSeen.delete(oldest.value);
    }
  }

  private async route(req: Request): Promise<Result> {
    const engine = this.engine;
    switch (req.op) {
      case "capabilities":
        return {
          protocolVersion: "1.0",
          requestId: req.requestId,
          sessionId: "",
          tabId: "",
          status: "completed",
          op: "capabilities",
          capabilities: engine.capabilities(),
          artifacts: [],
          warnings: [],
        };
      case "create": {
        const hit = this.createSeen.get(req.requestId);
        if (hit && Date.now() - hit.at < CREATE_DEDUPE_MS) return hit.result;
        const created =
          req.profile === undefined
            ? await engine.createSession()
            : await engine.createSession({ profile: req.profile });
        const out: Result = {
          protocolVersion: "1.0",
          requestId: req.requestId,
          sessionId: created.sessionId,
          tabId: created.tabId,
          status: "completed",
          op: "create",
          artifacts: [],
          warnings: [],
        };
        this.rememberCreate(req.requestId, out);
        return out;
      }
      case "sessions":
        return engine.listSessions(req.requestId);
      case "open":
        return engine.open(req.requestId, req.sessionId, req.url, req.tabId);
      case "observe": {
        const observeOpts: {
          mode?: "controls" | "summary" | "delta" | "visual" | "inspect";
          baseRevision?: number;
          ref?: string;
          includeScreenshot?: boolean;
        } = {};
        if (req.mode !== undefined) observeOpts.mode = req.mode;
        if (req.baseRevision !== undefined)
          observeOpts.baseRevision = req.baseRevision;
        if (req.ref !== undefined) observeOpts.ref = req.ref;
        if (req.includeScreenshot !== undefined)
          observeOpts.includeScreenshot = req.includeScreenshot;
        return engine.observe(
          req.requestId,
          needSession(req),
          req.tabId,
          observeOpts,
        );
      }
      case "click":
        return engine.click(
          req.requestId,
          needSession(req),
          req.ref,
          req.tabId,
          {
            ...(req.button === undefined ? {} : { button: req.button }),
            ...(req.clickCount === undefined
              ? {}
              : { clickCount: req.clickCount }),
          },
        );
      case "fill":
        return engine.fill(
          req.requestId,
          needSession(req),
          req.ref,
          req.text,
          req.tabId,
        );
      case "press":
        return engine.press(
          req.requestId,
          needSession(req),
          req.key,
          req.ref,
          req.tabId,
        );
      case "select":
        return engine.select(
          req.requestId,
          needSession(req),
          req.ref,
          req.values,
          req.tabId,
        );
      case "check":
        return engine.check(
          req.requestId,
          needSession(req),
          req.ref,
          req.checked,
          req.tabId,
        );
      case "scroll":
        return engine.scroll(
          req.requestId,
          needSession(req),
          req.ref,
          req.pixels,
          req.tabId,
        );
      case "hover":
        return engine.hover(
          req.requestId,
          needSession(req),
          req.ref,
          req.tabId,
        );
      case "navigate":
        return engine.navigate(
          req.requestId,
          needSession(req),
          req.url,
          req.tabId,
        );
      case "back":
        return engine.back(req.requestId, needSession(req), req.tabId);
      case "forward":
        return engine.forward(req.requestId, needSession(req), req.tabId);
      case "reload":
        return engine.reload(req.requestId, needSession(req), req.tabId);
      case "wait":
        return engine.wait(
          req.requestId,
          needSession(req),
          req.condition,
          req.tabId,
        );
      case "diagnostics":
        return engine.diagnostics(req.requestId, needSession(req), req.tabId);
      case "screenshot":
        return engine.screenshot(
          req.requestId,
          needSession(req),
          req.tabId,
          req.maskRefs ?? [],
          req.fullPage ?? false,
        );
      case "tabs":
        return engine.tabList(req.requestId, needSession(req));
      case "tab-open":
        return engine.tabOpen(req.requestId, needSession(req), req.url);
      case "tab-close":
        return engine.tabClose(req.requestId, needSession(req), req.tabId);
      case "tab-select": {
        if (typeof req.tabId !== "string") {
          throw Object.assign(new Error('Op "tab-select" requires a tabId'), {
            code: "INVALID_REQUEST",
          });
        }
        return engine.tabSelect(req.requestId, needSession(req), req.tabId);
      }
      case "cancel":
        return engine.cancel(req.requestId, needSession(req));
      case "pause": {
        if (req.timeoutMs !== undefined) {
          return engine.pause(req.requestId, needSession(req), {
            timeoutMs: req.timeoutMs,
          });
        }
        return engine.pause(req.requestId, needSession(req));
      }
      case "resume":
        return engine.resume(req.requestId, needSession(req));
      case "annotations": {
        const sid = needSession(req);
        if (req.mode === "list")
          return engine.annotationsList(req.requestId, sid, req.tabId);
        if (
          req.kind === undefined ||
          req.x === undefined ||
          req.y === undefined ||
          req.note === undefined
        ) {
          throw Object.assign(
            new Error("annotations add requires kind, x, y, and note"),
            { code: "INVALID_REQUEST" },
          );
        }
        const input: {
          tabId?: string;
          kind: "click" | "region";
          x: number;
          y: number;
          w?: number;
          h?: number;
          note: string;
          screenshotRevision?: number;
        } = {
          kind: req.kind,
          x: req.x,
          y: req.y,
          note: req.note,
        };
        if (req.tabId !== undefined) input.tabId = req.tabId;
        if (req.w !== undefined) input.w = req.w;
        if (req.h !== undefined) input.h = req.h;
        if (req.screenshotRevision !== undefined)
          input.screenshotRevision = req.screenshotRevision;
        return engine.annotationsAdd(req.requestId, sid, input);
      }
      case "locate":
        return engine.locate(
          req.requestId,
          needSession(req),
          req.ref,
          req.tabId,
        );
      case "viewport": {
        const size: {
          preset?: "mobile" | "tablet" | "desktop";
          width?: number;
          height?: number;
          keepWindow?: boolean;
          free?: boolean;
        } = {};
        if (req.preset !== undefined) size.preset = req.preset;
        if (req.width !== undefined) size.width = req.width;
        if (req.height !== undefined) size.height = req.height;
        if (req.keepWindow !== undefined) size.keepWindow = req.keepWindow;
        if (req.free !== undefined) size.free = req.free;
        return engine.viewport(
          req.requestId,
          needSession(req),
          size,
          req.tabId,
        );
      }
      case "upload":
        return engine.upload(
          req.requestId,
          needSession(req),
          req.ref,
          req.file,
          req.tabId,
        );
      case "batch": {
        const batchOpts: {
          stopOnError?: boolean;
          postcondition?: Postcondition;
          tabId?: string;
        } = {};
        if (req.stopOnError !== undefined)
          batchOpts.stopOnError = req.stopOnError;
        if (req.postcondition !== undefined)
          batchOpts.postcondition = req.postcondition;
        if (req.tabId !== undefined) batchOpts.tabId = req.tabId;
        return engine.batch(
          req.requestId,
          needSession(req),
          [...req.actions],
          batchOpts,
        );
      }
      case "search":
        return engine.search(
          req.requestId,
          needSession(req),
          req.query,
          req.limit,
          req.tabId,
        );
      case "act": {
        const options: {
          postcondition?: Postcondition;
          expectedRevision?: number;
          tabId?: string;
        } = {};
        if (req.postcondition !== undefined)
          options.postcondition = req.postcondition;
        if (req.expectedRevision !== undefined)
          options.expectedRevision = req.expectedRevision;
        if (req.tabId !== undefined) options.tabId = req.tabId;
        return engine.act(req.requestId, needSession(req), req.action, options);
      }
      case "close":
        return engine.closeSession(req.requestId, needSession(req));
    }
  }
}
