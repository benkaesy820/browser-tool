import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { BrowserBridge } from "@browser-bridge/core";
import type {
  Action as WireAction,
  Observation,
  Postcondition as WireCondition,
} from "@browser-bridge/protocol";
import { z } from "zod";
import { engineCodeOf, textResult, toolError } from "./content.js";
import {
  actionSchema,
  conditionSchema,
  sessionIdSchema,
  tabIdSchema,
  type Action,
  type Condition,
} from "./params.js";

function packageVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      version?: unknown;
    };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function observationUri(sessionId: string, tabId: string): string {
  return `browser://sessions/${sessionId}/tabs/${tabId}/observation`;
}

function screenshotUri(sessionId: string, tabId: string): string {
  return `browser://sessions/${sessionId}/tabs/${tabId}/screenshot`;
}

function resourceLinks(
  sessionId: string,
  tabId: string,
): { observation: string; screenshot: string } {
  return {
    observation: observationUri(sessionId, tabId),
    screenshot: screenshotUri(sessionId, tabId),
  };
}

function slimObservation(obs: Observation | undefined): unknown {
  if (!obs) return undefined;
  return {
    revision: obs.revision,
    url: obs.url,
    title: obs.title,
    text: obs.text,
    controls: obs.controls,
    truncated: obs.truncated,
    ...(obs.continuation ? { continuation: obs.continuation } : {}),
  };
}

/** Structural mapping keeps the MCP surface decoupled from wire-schema drift. */
function toWireAction(action: Action): WireAction {
  switch (action.type) {
    case "click":
      return {
        type: "click",
        ref: action.ref,
        ...(action.button === undefined ? {} : { button: action.button }),
        ...(action.clickCount === undefined
          ? {}
          : { clickCount: action.clickCount }),
      };
    case "fill":
      return { type: "fill", ref: action.ref, text: action.text };
    case "press":
      return action.ref === undefined
        ? { type: "press", key: action.key }
        : { type: "press", key: action.key, ref: action.ref };
    case "select":
      return { type: "select", ref: action.ref, values: [...action.values] };
    case "check":
      return { type: "check", ref: action.ref, checked: action.checked };
    case "hover":
      return { type: "hover", ref: action.ref };
    case "scroll":
      return action.ref === undefined
        ? { type: "scroll", pixels: action.pixels }
        : { type: "scroll", ref: action.ref, pixels: action.pixels };
    case "navigate":
      return { type: "navigate", url: action.url };
    case "back":
      return { type: "back" };
    case "forward":
      return { type: "forward" };
    case "reload":
      return { type: "reload" };
    case "clickAt":
      return {
        type: "clickAt",
        x: action.x,
        y: action.y,
        screenshotRevision: action.screenshotRevision,
        ...(action.button === undefined ? {} : { button: action.button }),
        ...(action.clickCount === undefined
          ? {}
          : { clickCount: action.clickCount }),
      };
    case "moveAt":
      return {
        type: "moveAt",
        x: action.x,
        y: action.y,
        screenshotRevision: action.screenshotRevision,
      };
    case "scrollAt":
      return {
        type: "scrollAt",
        x: action.x,
        y: action.y,
        deltaX: action.deltaX ?? 0,
        deltaY: action.deltaY ?? 0,
        screenshotRevision: action.screenshotRevision,
      };
    case "dragAt":
      return {
        type: "dragAt",
        from: { ...action.from },
        to: { ...action.to },
        screenshotRevision: action.screenshotRevision,
        ...(action.button === undefined ? {} : { button: action.button }),
      };
    case "type":
      return { type: "type", text: action.text };
    case "upload":
      return { type: "upload", ref: action.ref, file: action.file };
  }
}

function toWireCondition(condition: Condition): WireCondition {
  switch (condition.type) {
    case "textVisible":
      return {
        type: "textVisible",
        text: condition.text,
        timeoutMs: condition.timeoutMs,
      };
    case "urlContains":
      return {
        type: "urlContains",
        value: condition.value,
        timeoutMs: condition.timeoutMs,
      };
    case "elementVisible":
      return {
        type: "elementVisible",
        ref: condition.ref,
        timeoutMs: condition.timeoutMs,
      };
  }
}

function failed(err: unknown): CallToolResult {
  const code = engineCodeOf(err);
  return toolError(code, err instanceof Error ? err.message : String(err));
}

/**
 * Create the MCP server over a dedicated engine instance (same core the
 * JSONL and daemon transports share — MCP and JSONL tests exercise one
 * engine implementation).
 */
export function createMcpServer(engine: BrowserBridge): McpServer {
  const server = new McpServer({
    name: "browser-bridge",
    version: packageVersion(),
  });
  let requestCounter = 0;
  const rid = (): string => `mcp-${++requestCounter}`;

  async function withCancellation<T>(
    signal: AbortSignal,
    sessionId: string | undefined,
    work: () => Promise<T>,
  ): Promise<T> {
    if (signal.aborted)
      throw new McpError(
        ErrorCode.InternalError,
        "request cancelled by client",
      );
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        if (sessionId !== undefined) {
          engine
            .cancel(`mcp-cancel-${Date.now()}`, sessionId)
            .catch(() => undefined);
        }
        reject(
          new McpError(ErrorCode.InternalError, "request cancelled by client"),
        );
      };
      signal.addEventListener("abort", onAbort, { once: true });
      work().then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (err: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(err);
        },
      );
    });
  }

  server.registerTool(
    "browser_start",
    {
      description:
        "Create an isolated browser session (and optionally open a URL). " +
        "Call this first; keep the sessionId for every later call.",
      inputSchema: {
        url: z.string().url().optional().describe("Page to open immediately"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args, extra) => {
      try {
        return await withCancellation(extra.signal, undefined, async () => {
          const { sessionId, tabId } = await engine.createSession();
          if (args.url !== undefined) {
            const opened = await engine.open(rid(), sessionId, args.url, tabId);
            return textResult({
              sessionId,
              tabId,
              observation: slimObservation(opened.observation),
              resources: resourceLinks(sessionId, tabId),
            });
          }
          return textResult({
            sessionId,
            tabId,
            resources: resourceLinks(sessionId, tabId),
          });
        });
      } catch (err) {
        return failed(err);
      }
    },
  );

  server.registerTool(
    "browser_act",
    {
      description:
        "Perform one browser action (click, fill, press, select, check, hover, scroll, " +
        "navigate, back, forward, reload, clickAt, moveAt, scrollAt, dragAt, type, upload) and optionally verify the expected outcome. " +
        "Always act on refs from a fresh observation; stale refs are rejected, " +
        "ambiguous labels are never guessed.",
      inputSchema: {
        sessionId: sessionIdSchema,
        tabId: tabIdSchema,
        action: actionSchema.describe("The single action to perform"),
        postcondition: conditionSchema
          .optional()
          .describe(
            "Expected outcome; a miss returns status timeout, not an error",
          ),
        expectedRevision: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Reject when the tab moved past this observation revision"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args, extra) => {
      try {
        return await withCancellation(
          extra.signal,
          args.sessionId,
          async () => {
            const options: {
              postcondition?: WireCondition;
              expectedRevision?: number;
              tabId?: string;
            } = {};
            if (args.postcondition !== undefined)
              options.postcondition = toWireCondition(args.postcondition);
            if (args.expectedRevision !== undefined)
              options.expectedRevision = args.expectedRevision;
            if (args.tabId !== undefined) options.tabId = args.tabId;
            const out = await engine.act(
              rid(),
              args.sessionId,
              toWireAction(args.action),
              options,
            );
            return textResult({
              sessionId: out.sessionId,
              tabId: out.tabId,
              postcondition: out.postcondition,
              warnings: out.warnings,
              observation: slimObservation(out.observation),
              resources: resourceLinks(out.sessionId, out.tabId),
            });
          },
        );
      } catch (err) {
        return failed(err);
      }
    },
  );

  server.registerTool(
    "browser_observe",
    {
      description:
        "Read the current page: URL, title, text, and actionable controls with refs. " +
        "Modes: controls/summary (snapshot), delta (changes since baseRevision), " +
        "visual (numbered overlay + optional screenshot), inspect (focused control details). " +
        "Set includeScreenshot for a vision snapshot (image-capable clients); " +
        "text-only clients get the same semantic observation without it.",
      inputSchema: {
        sessionId: sessionIdSchema,
        tabId: tabIdSchema,
        mode: z
          .enum(["controls", "summary", "delta", "visual", "inspect"])
          .default("controls"),
        baseRevision: z.number().int().nonnegative().optional(),
        ref: z
          .string()
          .regex(/^el-\d+-\d+$/)
          .optional()
          .describe("Inspect target for mode=inspect"),
        includeScreenshot: z
          .boolean()
          .default(false)
          .describe("Attach a PNG snapshot for vision-capable clients"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args, extra) => {
      try {
        return await withCancellation(
          extra.signal,
          args.sessionId,
          async () => {
            const opts: {
              mode: "controls" | "summary" | "delta" | "visual" | "inspect";
              baseRevision?: number;
              ref?: string;
              includeScreenshot?: boolean;
            } = {
              mode: args.mode,
            };
            if (args.baseRevision !== undefined)
              opts.baseRevision = args.baseRevision;
            if (args.ref !== undefined) opts.ref = args.ref;
            if (args.includeScreenshot) opts.includeScreenshot = true;
            const out =
              args.tabId === undefined
                ? await engine.observe(rid(), args.sessionId, undefined, opts)
                : await engine.observe(rid(), args.sessionId, args.tabId, opts);
            let imageBase64: string | undefined;
            if (args.includeScreenshot) {
              // Visual mode already attached an artifact; other modes capture separately.
              let artifact = out.artifacts[0];
              if (!artifact) {
                const shot =
                  args.tabId === undefined
                    ? await engine.screenshot(rid(), args.sessionId)
                    : await engine.screenshot(
                        rid(),
                        args.sessionId,
                        args.tabId,
                      );
                artifact = shot.artifacts[0];
              }
              if (artifact) {
                const bytes = await engine.artifactBytes(
                  out.sessionId,
                  artifact.id,
                );
                if (bytes) imageBase64 = bytes.toString("base64");
              }
            }
            return textResult(
              {
                sessionId: out.sessionId,
                tabId: out.tabId,
                session: engine.sessionState(out.sessionId),
                observation: slimObservation(out.observation),
                ...(out.delta ? { delta: out.delta } : {}),
                ...(out.overlay ? { overlay: out.overlay } : {}),
                ...(out.inspection ? { inspection: out.inspection } : {}),
                resources: resourceLinks(out.sessionId, out.tabId),
              },
              imageBase64 ? { imageBase64 } : undefined,
            );
          },
        );
      } catch (err) {
        return failed(err);
      }
    },
  );

  server.registerTool(
    "browser_wait",
    {
      description:
        "Wait for an explicit page condition (text, URL, element) instead of guessing delays. " +
        "Throws a timeout error when the condition misses its deadline.",
      inputSchema: {
        sessionId: sessionIdSchema,
        tabId: tabIdSchema,
        condition: conditionSchema.describe(
          "Condition to poll until satisfied or timed out",
        ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args, extra) => {
      try {
        return await withCancellation(
          extra.signal,
          args.sessionId,
          async () => {
            const out =
              args.tabId === undefined
                ? await engine.wait(
                    rid(),
                    args.sessionId,
                    toWireCondition(args.condition),
                  )
                : await engine.wait(
                    rid(),
                    args.sessionId,
                    toWireCondition(args.condition),
                    args.tabId,
                  );
            return textResult({
              sessionId: out.sessionId,
              tabId: out.tabId,
              postcondition: out.postcondition,
              observation: slimObservation(out.observation),
              resources: resourceLinks(out.sessionId, out.tabId),
            });
          },
        );
      } catch (err) {
        return failed(err);
      }
    },
  );

  server.registerTool(
    "browser_diagnostics",
    {
      description:
        "Bounded console errors, failed requests, and HTTP error responses captured for the tab. " +
        "Use after reproducing a bug to see what the page itself reported.",
      inputSchema: { sessionId: sessionIdSchema, tabId: tabIdSchema },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args, extra) => {
      try {
        return await withCancellation(
          extra.signal,
          args.sessionId,
          async () => {
            const out =
              args.tabId === undefined
                ? await engine.diagnostics(rid(), args.sessionId)
                : await engine.diagnostics(rid(), args.sessionId, args.tabId);
            return textResult({
              sessionId: out.sessionId,
              tabId: out.tabId,
              diagnostics: out.diagnostics,
            });
          },
        );
      } catch (err) {
        return failed(err);
      }
    },
  );

  server.registerTool(
    "browser_tabs",
    {
      description:
        "List, open, select, close, or resize tabs. Without a sessionId, operation list " +
        "returns every session with its tabs (discovery).",
      inputSchema: {
        sessionId: sessionIdSchema
          .optional()
          .describe("Omit only for operation list (all sessions)"),
        operation: z.enum(["list", "open", "select", "close", "viewport"]),
        tabId: tabIdSchema,
        url: z
          .string()
          .url()
          .optional()
          .describe("Initial page for operation open"),
        preset: z
          .enum(["mobile", "tablet", "desktop"])
          .optional()
          .describe("Viewport preset for operation viewport"),
        width: z
          .number()
          .int()
          .min(320)
          .max(3840)
          .optional()
          .describe("Custom viewport width for operation viewport"),
        height: z
          .number()
          .int()
          .min(320)
          .max(2160)
          .optional()
          .describe("Custom viewport height for operation viewport"),
        keepWindow: z
          .boolean()
          .optional()
          .describe(
            "Pin the page to the viewport size without resizing the OS window",
          ),
        free: z
          .boolean()
          .optional()
          .describe("Clear a viewport override; takes no size"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args, extra) => {
      try {
        return await withCancellation(
          extra.signal,
          args.sessionId,
          async () => {
            if (args.operation === "list" && args.sessionId === undefined) {
              return textResult({ sessions: engine.inventory() });
            }
            if (args.sessionId === undefined) {
              return toolError(
                "INVALID_REQUEST",
                'Operation requires a sessionId (only "list" works without one)',
              );
            }
            const sid = args.sessionId;
            switch (args.operation) {
              case "list": {
                const out = await engine.tabList(rid(), sid);
                return textResult({ sessionId: out.sessionId, tabs: out.tabs });
              }
              case "open": {
                const out =
                  args.url === undefined
                    ? await engine.tabOpen(rid(), sid)
                    : await engine.tabOpen(rid(), sid, args.url);
                return textResult({
                  sessionId: out.sessionId,
                  tabId: out.tabId,
                  observation: slimObservation(out.observation),
                  resources: resourceLinks(out.sessionId, out.tabId),
                });
              }
              case "select": {
                if (args.tabId === undefined)
                  return toolError(
                    "INVALID_REQUEST",
                    "select requires a tabId",
                  );
                const out = await engine.tabSelect(rid(), sid, args.tabId);
                return textResult({
                  sessionId: out.sessionId,
                  tabId: out.tabId,
                  observation: slimObservation(out.observation),
                  resources: resourceLinks(out.sessionId, out.tabId),
                });
              }
              case "close": {
                const out =
                  args.tabId === undefined
                    ? await engine.tabClose(rid(), sid)
                    : await engine.tabClose(rid(), sid, args.tabId);
                return textResult({
                  sessionId: out.sessionId,
                  tabId: out.tabId,
                  warnings: out.warnings,
                });
              }
              case "viewport": {
                const size: {
                  preset?: "mobile" | "tablet" | "desktop";
                  width?: number;
                  height?: number;
                  keepWindow?: boolean;
                  free?: boolean;
                } = {};
                if (args.preset !== undefined) size.preset = args.preset;
                if (args.width !== undefined) size.width = args.width;
                if (args.height !== undefined) size.height = args.height;
                if (args.keepWindow !== undefined)
                  size.keepWindow = args.keepWindow;
                if (args.free !== undefined) size.free = args.free;
                const out =
                  args.tabId === undefined
                    ? await engine.viewport(rid(), sid, size)
                    : await engine.viewport(rid(), sid, size, args.tabId);
                return textResult({
                  sessionId: out.sessionId,
                  tabId: out.tabId,
                  observation: slimObservation(out.observation),
                  resources: resourceLinks(out.sessionId, out.tabId),
                });
              }
            }
          },
        );
      } catch (err) {
        return failed(err);
      }
    },
  );

  server.registerTool(
    "browser_close",
    {
      description:
        "Close a session and release its browser context. Sessions do not time out on their own.",
      inputSchema: { sessionId: sessionIdSchema },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args, extra) => {
      try {
        return await withCancellation(
          extra.signal,
          args.sessionId,
          async () => {
            const out = await engine.closeSession(rid(), args.sessionId);
            return textResult({ sessionId: out.sessionId, closed: true });
          },
        );
      } catch (err) {
        return failed(err);
      }
    },
  );

  server.registerTool(
    "browser_takeover",
    {
      description:
        "Human-takeover lease: pause rejects agent mutations with SESSION_PAUSED " +
        "so a person can drive the same tab (login, CAPTCHA, judgment calls); " +
        "resume hands control back with a fresh observation. Status reports the lease.",
      inputSchema: {
        sessionId: sessionIdSchema,
        operation: z.enum(["pause", "resume", "status"]),
        timeoutMs: z
          .number()
          .int()
          .min(5000)
          .max(600_000)
          .optional()
          .describe("Auto-resume a pause after this long"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args, extra) => {
      try {
        return await withCancellation(
          extra.signal,
          args.sessionId,
          async () => {
            if (args.operation === "status") {
              return textResult({
                session: engine.sessionState(args.sessionId),
              });
            }
            if (args.operation === "pause") {
              const out =
                args.timeoutMs === undefined
                  ? await engine.pause(rid(), args.sessionId)
                  : await engine.pause(rid(), args.sessionId, {
                      timeoutMs: args.timeoutMs,
                    });
              return textResult({
                sessionId: out.sessionId,
                session: out.session,
                warnings: out.warnings,
              });
            }
            const out = await engine.resume(rid(), args.sessionId);
            return textResult({
              sessionId: out.sessionId,
              session: out.session,
              warnings: out.warnings,
              observation: slimObservation(out.observation),
            });
          },
        );
      } catch (err) {
        return failed(err);
      }
    },
  );

  server.registerTool(
    "browser_batch",
    {
      description:
        "Run up to 20 actions against one observation in a single call, with " +
        "one final observation. Later steps reuse the refs issued before the " +
        "batch; a step that invalidates them aborts (or records and continues).",
      inputSchema: {
        sessionId: sessionIdSchema,
        tabId: tabIdSchema,
        actions: z.array(actionSchema).min(1).max(20),
        stopOnError: z.boolean().default(true),
        postcondition: conditionSchema.optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args, extra) => {
      try {
        return await withCancellation(
          extra.signal,
          args.sessionId,
          async () => {
            const options: {
              stopOnError?: boolean;
              postcondition?: WireCondition;
              tabId?: string;
            } = {};
            if (args.stopOnError !== undefined)
              options.stopOnError = args.stopOnError;
            if (args.postcondition !== undefined)
              options.postcondition = toWireCondition(args.postcondition);
            if (args.tabId !== undefined) options.tabId = args.tabId;
            const out = await engine.batch(
              rid(),
              args.sessionId,
              args.actions.map(toWireAction),
              options,
            );
            return textResult({
              sessionId: out.sessionId,
              tabId: out.tabId,
              postcondition: out.postcondition,
              steps: out.steps,
              warnings: out.warnings,
              observation: slimObservation(out.observation),
              resources: resourceLinks(out.sessionId, out.tabId),
            });
          },
        );
      } catch (err) {
        return failed(err);
      }
    },
  );

  server.registerTool(
    "browser_search",
    {
      description:
        "Substring-search controls by name or role on the current page. " +
        "Refreshes first, so returned refs are valid immediately.",
      inputSchema: {
        sessionId: sessionIdSchema,
        tabId: tabIdSchema,
        query: z.string().min(1).max(200),
        limit: z.number().int().min(1).max(50).default(20),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args, extra) => {
      try {
        return await withCancellation(
          extra.signal,
          args.sessionId,
          async () => {
            const out =
              args.tabId === undefined
                ? await engine.search(
                    rid(),
                    args.sessionId,
                    args.query,
                    args.limit,
                  )
                : await engine.search(
                    rid(),
                    args.sessionId,
                    args.query,
                    args.limit,
                    args.tabId,
                  );
            return textResult({
              sessionId: out.sessionId,
              tabId: out.tabId,
              matches: out.matches,
              observation: slimObservation(out.observation),
            });
          },
        );
      } catch (err) {
        return failed(err);
      }
    },
  );

  server.registerResource(
    "session-observation",
    new ResourceTemplate(
      "browser://sessions/{sessionId}/tabs/{tabId}/observation",
      { list: undefined },
    ),
    {
      title: "Latest tab observation",
      description:
        "Most recent page observation as JSON (pure read; does not refresh the tab).",
      mimeType: "application/json",
    },
    async (uri, vars) => {
      const sessionId = String(
        (vars["sessionId"] as string | string[] | undefined) ?? "",
      );
      const tabId = String(
        (vars["tabId"] as string | string[] | undefined) ?? "",
      );
      const observation = engine.peekObservation(sessionId, tabId);
      if (!observation) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `No observation for session ${sessionId} tab ${tabId}`,
        );
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(slimObservation(observation)),
          },
        ],
      };
    },
  );

  server.registerResource(
    "session-screenshot",
    new ResourceTemplate(
      "browser://sessions/{sessionId}/tabs/{tabId}/screenshot",
      { list: undefined },
    ),
    {
      title: "Fresh tab screenshot",
      description:
        "Captures the tab on read and returns PNG bytes for vision-capable clients.",
      mimeType: "image/png",
    },
    async (uri, vars) => {
      const sessionId = String(
        (vars["sessionId"] as string | string[] | undefined) ?? "",
      );
      const tabId = String(
        (vars["tabId"] as string | string[] | undefined) ?? "",
      );
      try {
        const shot = await engine.screenshot(rid(), sessionId, tabId);
        const artifact = shot.artifacts[0];
        if (!artifact)
          throw new McpError(
            ErrorCode.InternalError,
            "Screenshot produced no artifact",
          );
        const bytes = await engine.artifactBytes(sessionId, artifact.id);
        if (!bytes)
          throw new McpError(
            ErrorCode.InternalError,
            "Screenshot bytes unavailable",
          );
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "image/png",
              blob: bytes.toString("base64"),
            },
          ],
        };
      } catch (err) {
        if (err instanceof McpError) throw err;
        throw new McpError(
          ErrorCode.InvalidParams,
          err instanceof Error ? err.message : String(err),
        );
      }
    },
  );

  return server;
}
