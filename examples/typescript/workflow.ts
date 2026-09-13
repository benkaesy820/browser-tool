// Independent daemon client in dependency-free TypeScript (erasable syntax
// only, so it runs directly on Node 22.18+ with type stripping — no build).
// Assumes a running daemon (start one first, stop it when done):
//   1. bridge daemon start --detach
//   2. BRIDGE_DAEMON_DIR=<dir> node workflow.ts "file:///path/to/index.html"
//   3. bridge daemon stop
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Control {
  ref: string;
  role: string;
  name: string;
  disabled: boolean;
}

interface Observation {
  revision: number;
  url: string;
  title: string;
  text: string;
  controls: Control[];
  truncated: boolean;
}

interface Response {
  status: string;
  code?: string;
  message?: string;
  sessionId: string;
  tabId: string;
  op: string;
  observation?: Observation;
  artifacts?: Array<{ id: string; path: string }>;
}

const daemonDir: string = process.env["BRIDGE_DAEMON_DIR"] ?? join(tmpdir(), "browser-bridge");
const info = JSON.parse(readFileSync(join(daemonDir, "daemon.json"), "utf8")) as {
  port: number;
  token: string;
};

const fixtureUrl: string | undefined = process.argv[2];
if (!fixtureUrl) {
  console.error("usage: node workflow.ts <fixture-file-url>");
  process.exit(2);
}

let n = 0;
async function call(op: Record<string, unknown>, sessionId?: string): Promise<Response> {
  n += 1;
  const body: Record<string, unknown> = { protocolVersion: "1.0", requestId: `exts-${n}`, ...op };
  if (sessionId !== undefined) body["sessionId"] = sessionId;
  const res = await fetch(`http://127.0.0.1:${info.port}/v1/request`, {
    method: "POST",
    headers: { authorization: `Bearer ${info.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = (await res.json()) as Response;
  if (parsed.status !== "completed") {
    throw new Error(`${String(op["op"])} failed: ${parsed.code} ${parsed.message}`);
  }
  return parsed;
}

function ref(controls: Control[], pred: (c: Control) => boolean, what: string): string {
  const found: Control | undefined = controls.find(pred);
  if (!found) throw new Error(`control not found: ${what}`);
  return found.ref;
}

const created: Response = await call({ op: "create" });
const session: string = created.sessionId;
const opened: Response = await call({ op: "open", url: fixtureUrl }, session);
const controls: Control[] = opened.observation?.controls ?? [];
const input: string = ref(controls, (c: Control) => c.role === "textbox", "item input");
const filled: Response = await call({ op: "fill", ref: input, text: "apples" }, session);
const add: string = ref(filled.observation?.controls ?? [], (c: Control) => c.name === "Add to cart", "add button");
const clicked: Response = await call({ op: "click", ref: add }, session);
if (!(clicked.observation?.text ?? "").includes("Item added: apples")) {
  throw new Error("expected confirmation text missing");
}
const shot: Response = await call({ op: "screenshot" }, session);
const shotPath: string = shot.artifacts?.[0]?.path ?? "";
if (!shotPath || !existsSync(shotPath)) throw new Error("screenshot artifact missing");
await call({ op: "close" }, session);
console.log("PASS: typescript workflow");
