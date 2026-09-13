#!/usr/bin/env node
import { stdin, stdout } from "node:process";
import { Command } from "commander";
import { pino } from "pino";
import {
  daemonStatus,
  daemonStop,
  daemonCall,
  daemonEvents,
} from "./client.js";
import {
  verbBack,
  verbBatch,
  verbCheck,
  verbClick,
  verbClose,
  verbDiagnostics,
  verbFill,
  verbForward,
  verbGo,
  verbHover,
  verbInspect,
  verbOpen,
  verbPress,
  verbReload,
  verbScroll,
  verbSearch,
  verbSelect,
  verbSessions,
  verbShot,
  verbState,
  verbTabs,
  verbType,
  verbUpload,
  verbUse,
  verbViewport,
  verbWait,
  type VerbOptions,
} from "./verbs.js";
import { printCapabilities, runDoctor } from "./commands.js";
import { startDaemon, startDaemonDetached } from "./daemon.js";
import { serveStdio } from "./serve.js";

// Pino logs to stderr only; stdout stays pure protocol. Sensitive keys are
// redacted even though operational logs never carry page content by design.
const log = pino(
  {
    level: process.env["BRIDGE_LOG_LEVEL"] ?? "info",
    redact: {
      paths: [
        "*.token",
        "*.password",
        "*.secret",
        "*.cookie",
        "*.authorization",
      ],
      censor: "[redacted]",
    },
  },
  pino.destination(2),
);

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    stdin.on("end", () => resolve(data));
    stdin.on("error", reject);
  });
}

const program = new Command();
program
  .name("bridge")
  .description("Standalone browser service for CLI agents (Browser Bridge)")
  .version("0.5.0")
  .option(
    "--daemon-dir <dir>",
    "Override the daemon rendezvous directory (testing only)",
  );

program
  .command("serve")
  .description(
    "Run the JSONL stdio service (one request per stdin line, one response per stdout line)",
  )
  .option("--stdio", "Use standard input/output framing (required)")
  .option("--headed", "Show a visible browser window (needs a display)")
  .action(async (opts: { stdio?: boolean; headed?: boolean }) => {
    if (!opts.stdio) {
      stdout.write("serve requires --stdio\n");
      process.exitCode = 2;
      return;
    }
    if (opts.headed === true) {
      await serveStdio(log, { headed: true });
    } else {
      await serveStdio(log);
    }
  });

program
  .command("mcp")
  .description(
    "Run the MCP server over stdio (official SDK framing for MCP clients)",
  )
  .option("--stdio", "Use standard input/output framing (required)")
  .option("--headed", "Show a visible browser window (needs a display)")
  .action(async (opts: { stdio?: boolean; headed?: boolean }) => {
    if (!opts.stdio) {
      stdout.write("mcp requires --stdio\n");
      process.exitCode = 2;
      return;
    }
    const { runStdio } = await import("@browser-bridge/mcp");
    if (opts.headed === true) {
      await runStdio({ headed: true });
    } else {
      await runStdio();
    }
  });

const daemon = program
  .command("daemon")
  .description("Manage the local loopback daemon for cross-process sessions");

daemon
  .command("start")
  .description(
    "Start the daemon in the foreground (shares sessions across shell commands)",
  )
  .option("--port <port>", "Fixed port (default: ephemeral)")
  .option("--headed", "Show a visible browser window (needs a display)")
  .option("--viewer-dir <dir>", "Serve the viewer from this build directory")
  .option(
    "--detach",
    "Spawn a background daemon and return immediately (for ephemeral shells)",
  )
  .action(
    async (opts: {
      port?: string;
      headed?: boolean;
      viewerDir?: string;
      detach?: boolean;
    }) => {
      try {
        const dir = program.opts()["daemonDir"] as string | undefined;
        const base: {
          port?: number;
          dir?: string;
          headed?: boolean;
          viewerDir?: string;
        } = {};
        if (opts.port !== undefined) base.port = Number(opts.port);
        if (dir !== undefined) base.dir = dir;
        if (opts.headed !== undefined) base.headed = opts.headed;
        if (opts.viewerDir !== undefined) base.viewerDir = opts.viewerDir;
        if (opts.detach === true) {
          const info = await startDaemonDetached(log, base);
          // Flush stdout, then exit explicitly: the health-poll keep-alive
          // sockets and logger stream can otherwise keep this parent's loop
          // alive in interactive shells after the answer is printed (the
          // daemon itself is fully detached and unaffected).
          await new Promise<void>((resolve) => {
            stdout.write(
              `${JSON.stringify({ ok: true, detached: true, port: info.port, pid: info.pid })}\n`,
              () => resolve(),
            );
          });
          process.exit(0);
        }
        await startDaemon(log, base);
      } catch (err) {
        log.error({ err: String(err) }, "daemon start failed");
        process.exitCode = 2;
      }
    },
  );

daemon
  .command("stop")
  .description("Stop the running daemon")
  .action(async () => {
    const { text, exitCode: code } = await daemonStop(
      program.opts()["daemonDir"] as string | undefined,
    );
    stdout.write(text);
    process.exitCode = code;
  });

daemon
  .command("status")
  .description("Show daemon health (exit 0 even when stopped; read the JSON)")
  .action(async () => {
    const { text, exitCode: code } = await daemonStatus(
      program.opts()["daemonDir"] as string | undefined,
    );
    stdout.write(text);
    process.exitCode = code;
  });

program
  .command("call")
  .description("Send one request to the daemon (JSON argument or --stdin)")
  .argument("[json]", "Request object")
  .option("--stdin", "Read the request from stdin")
  .action(async (json: string | undefined, opts: { stdin?: boolean }) => {
    let rawText = json;
    if (opts.stdin) rawText = await readStdin();
    if (!rawText) {
      stdout.write("call needs a JSON argument or --stdin\n");
      process.exitCode = 2;
      return;
    }
    let request: unknown;
    try {
      request = JSON.parse(rawText) as unknown;
    } catch {
      stdout.write("call argument is not valid JSON\n");
      process.exitCode = 2;
      return;
    }
    const { text, exitCode: code } = await daemonCall(
      program.opts()["daemonDir"] as string | undefined,
      request,
    );
    stdout.write(text);
    process.exitCode = code;
  });

program
  .command("events")
  .description("Stream daemon events as JSON Lines over SSE (no polling)")
  .option("--cursor <seq>", "Resume after this event sequence", "0")
  .option("--session <id>", "Only print events for one session")
  .action(async (opts: { cursor: string; session?: string }) => {
    const cursor = Number(opts.cursor);
    if (!Number.isFinite(cursor) || cursor < 0) {
      stdout.write("events --cursor must be a non-negative number\n");
      process.exitCode = 2;
      return;
    }
    try {
      await daemonEvents(
        program.opts()["daemonDir"] as string | undefined,
        cursor,
        (event) => {
          if (
            opts.session === undefined ||
            event.sessionId === opts.session ||
            event.type === "gap"
          ) {
            stdout.write(`${JSON.stringify(event)}\n`);
          }
        },
      );
    } catch (err) {
      log.error({ err: String(err) }, "event stream failed");
      process.exitCode = 2;
    }
  });

program
  .command("capabilities")
  .description(
    "Print the static capability discovery document (no browser needed)",
  )
  .action(async () => {
    const { text, exitCode: code } = await printCapabilities();
    stdout.write(text);
    process.exitCode = code;
  });

// Human verbs: plain words over the JSON protocol, sharing one current
// session per daemon. Every verb also accepts --session/--tab/--json.
type LocalOpts = {
  session?: string;
  tab?: string;
  json?: boolean;
  keepWindow?: boolean;
  full?: boolean;
  profile?: string;
  out?: string;
  button?: "left" | "right" | "middle";
  count?: string;
};

function verbOpts(
  global: { daemonDir?: string },
  local: LocalOpts,
): VerbOptions {
  const out: VerbOptions = {};
  const dir = global["daemonDir"];
  if (typeof dir === "string" && dir) out.daemonDir = dir;
  if (local.session) out.session = local.session;
  if (local.tab) out.tab = local.tab;
  if (local.json) out.json = true;
  if (local.keepWindow) out.keepWindow = true;
  if (local.full) out.full = true;
  if (local.profile) out.profile = local.profile;
  if (local.out) out.out = local.out;
  if (local.button) out.button = local.button;
  if (local.count) out.clickCount = Number(local.count);
  return out;
}

function addVerb(
  name: string,
  description: string,
  args: string[],
  fn: (
    opts: VerbOptions,
    ...positionals: string[]
  ) => Promise<{ text: string; exitCode: number }>,
  extraOptions?: Array<{ flags: string; description: string }>,
): void {
  const cmd = program.command(name).description(description);
  for (const arg of args) cmd.argument(arg);
  cmd
    .option("--session <id>", "Session to use (default: current)")
    .option("--tab <id>", "Tab to use (default: selected)")
    .option("--json", "Print the raw protocol envelope");
  for (const opt of extraOptions ?? []) cmd.option(opt.flags, opt.description);
  // Commander calls handlers as (...declaredArgs, options, command).
  cmd.action(async (...all: unknown[]) => {
    const positionals = all.slice(0, args.length).map((v) => String(v ?? ""));
    const local = (all[args.length] ?? {}) as LocalOpts;
    const { text, exitCode: code } = await fn(
      verbOpts(program.opts(), local),
      ...positionals,
    );
    stdout.write(text);
    process.exitCode = code;
  });
}

addVerb(
  "open",
  "Open a URL (creates and remembers a session if needed)",
  ["<url>"],
  (o, url) => verbOpen(o, url),
  [
    {
      flags: "--profile <name>",
      description:
        "Persistent profile for the new session ([A-Za-z0-9_-], stays logged in across restarts)",
    },
  ],
);
addVerb("state", "Show the current page: text summary and controls", [], (o) =>
  verbState(o),
);
addVerb(
  "inspect",
  "Show dev details for one control (box, attributes, text)",
  ["<ref>"],
  (o, ref) => verbInspect(o, ref),
);
addVerb(
  "click",
  "Click a control by ref",
  ["<ref>"],
  (o, ref) => verbClick(o, ref),
  [
    {
      flags: "--button <button>",
      description: "Mouse button: left, right, or middle",
    },
    { flags: "--count <n>", description: "Click count: 1, 2, or 3" },
  ],
);
addVerb("fill", "Fill a field by ref", ["<ref>", "<text>"], (o, ref, text) =>
  verbFill(o, ref, text),
);
addVerb("type", "Type into the focused element", ["<text>"], (o, text) =>
  verbType(o, text),
);
addVerb("press", "Press a key (Enter, Tab, Escape, …)", ["<key>"], (o, key) =>
  verbPress(o, key),
);
addVerb("hover", "Hover a control by ref", ["<ref>"], (o, ref) =>
  verbHover(o, ref),
);
addVerb("scroll", "Scroll the page by pixels", ["[pixels]"], (o, pixels) =>
  verbScroll(o, pixels || "400"),
);
addVerb("go", "Navigate to a URL", ["<url>"], (o, url) => verbGo(o, url));
addVerb("back", "Go back in history", [], (o) => verbBack(o));
addVerb("forward", "Go forward in history", [], (o) => verbForward(o));
addVerb("reload", "Reload the page", [], (o) => verbReload(o));
addVerb("wait", "Wait until text is visible", ["<text>"], (o, text) =>
  verbWait(o, text),
);
program
  .command("select")
  .description("Select dropdown option(s) by ref")
  .argument("<ref>")
  .argument("<values...>")
  .option("--session <id>", "Session to use (default: current)")
  .option("--tab <id>", "Tab to use (default: selected)")
  .option("--json", "Print the raw protocol envelope")
  .action(async (ref: string, values: string[], local: LocalOpts) => {
    const { text, exitCode: code } = await verbSelect(
      verbOpts(program.opts(), local),
      String(ref),
      (values as string[]).map(String),
    );
    stdout.write(text);
    process.exitCode = code;
  });
program
  .command("check")
  .description("Set a checkbox by ref (on|off)")
  .argument("<ref>")
  .argument("<onoff>")
  .option("--session <id>", "Session to use (default: current)")
  .option("--tab <id>", "Tab to use (default: selected)")
  .option("--json", "Print the raw protocol envelope")
  .action(async (ref: string, onoff: string, local: LocalOpts) => {
    const lower = onoff.toLowerCase();
    if (lower !== "on" && lower !== "off") {
      stdout.write("check needs on|off (e.g. bridge check el-1-2 on)\n");
      process.exitCode = 2;
      return;
    }
    const { text, exitCode: code } = await verbCheck(
      verbOpts(program.opts(), local),
      String(ref),
      lower === "on",
    );
    stdout.write(text);
    process.exitCode = code;
  });
addVerb(
  "upload",
  "Upload a local file into a file input by ref",
  ["<ref>", "<file>"],
  (o, ref, file) => verbUpload(o, ref, file),
);
program
  .command("search")
  .description("Find controls by name or role (fresh refs)")
  .argument("<query>")
  .option("--limit <n>", "Max matches (1..50, default 20)")
  .option("--session <id>", "Session to use (default: current)")
  .option("--tab <id>", "Tab to use (default: selected)")
  .option("--json", "Print the raw protocol envelope")
  .action(async (query: string, local: LocalOpts & { limit?: string }) => {
    let limit = 20;
    if (local.limit !== undefined) {
      const n = Number(local.limit);
      if (!Number.isInteger(n) || n < 1 || n > 50) {
        stdout.write("search --limit needs 1..50\n");
        process.exitCode = 2;
        return;
      }
      limit = n;
    }
    const { text, exitCode: code } = await verbSearch(
      verbOpts(program.opts(), local),
      String(query),
      limit,
    );
    stdout.write(text);
    process.exitCode = code;
  });
addVerb(
  "diagnostics",
  "Show console errors, failed requests, bad responses",
  [],
  (o) => verbDiagnostics(o),
);
program
  .command("batch")
  .description(
    "Run up to 20 actions in one call (JSON array via arg or --stdin), one final observation",
  )
  .argument("[json]", "JSON array of actions")
  .option("--stdin", "Read the JSON array from stdin (Windows-safe)")
  .option("--session <id>", "Session to use (default: current)")
  .option("--tab <id>", "Tab to use (default: selected)")
  .option("--json", "Print the raw protocol envelope")
  .action(
    async (
      json: string | undefined,
      local: LocalOpts & { stdin?: boolean },
    ) => {
      let rawText = json;
      if (local.stdin) rawText = await readStdin();
      if (!rawText) {
        stdout.write(
          'batch needs a JSON array or --stdin (e.g. \'[{"type":"click","ref":"el-1-1"}]\')\n',
        );
        process.exitCode = 2;
        return;
      }
      const { text, exitCode: code } = await verbBatch(
        verbOpts(program.opts(), local),
        rawText,
      );
      stdout.write(text);
      process.exitCode = code;
    },
  );
addVerb("shot", "Capture a screenshot", [], (o) => verbShot(o), [
  {
    flags: "--full",
    description: "Stitch the full scrollable page instead of the viewport",
  },
  {
    flags: "--out <path>",
    description: "Copy the PNG to this path (e.g. your workspace)",
  },
]);
addVerb("tabs", "List tabs", [], (o) => verbTabs(o));
addVerb("sessions", "List sessions", [], (o) => verbSessions(o));
addVerb("use", "Remember a session as current", ["<id>"], (o, id) =>
  verbUse(o, id),
);
addVerb("close", "Close a session (default: current)", ["[id]"], (o, id) =>
  verbClose(o, id || undefined),
);
addVerb(
  "viewport",
  "Set viewport: mobile|tablet|desktop|free or WIDTHxHEIGHT (--keep-window pins the page, window untouched)",
  ["<spec>"],
  (o, spec) => verbViewport(o, spec),
  [
    {
      flags: "--keep-window",
      description: "Pin the page size without resizing the OS window",
    },
  ],
);

program
  .command("doctor")
  .description("Check runtime, Chromium install, and launch smoke test")
  .action(async () => {
    const { text, exitCode: code } = await runDoctor(log);
    stdout.write(text);
    process.exitCode = code;
  });

program
  .command("status")
  .description("Alias for daemon status")
  .action(async () => {
    const { text, exitCode: code } = await daemonStatus(
      program.opts()["daemonDir"] as string | undefined,
    );
    stdout.write(text);
    process.exitCode = code;
  });

program
  .command("viewer")
  .description(
    "Print the viewer URL and open it in your browser (needs a running daemon)",
  )
  .option("--no-open", "Print the URL without opening a browser")
  .action(async (opts: { open?: boolean }) => {
    const { openViewer } = await import("./viewer-cmd.js");
    const { text, exitCode: code } = await openViewer(
      program.opts()["daemonDir"] as string | undefined,
      {
        open: opts.open ?? true,
      },
    );
    stdout.write(text);
    process.exitCode = code;
  });

program.configureOutput({
  writeErr: (str) => process.stderr.write(str),
});

await program.parseAsync(process.argv).catch((err) => {
  log.error({ err: String(err) }, "fatal");
  process.exitCode = 2;
});
