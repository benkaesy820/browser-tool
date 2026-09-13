// Independent JSONL client using Node built-ins only (no dependencies).
// Drives `bridge serve --stdio`: one request object per stdin line, one
// response object per stdout line. Anything on stdout that is not a valid
// response object is a contract violation.
//
// Usage:
//   node workflow.mjs <fixture-file-url>
//   BRIDGE_BIN=bridge node workflow.mjs "file:///path/to/index.html"
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";

const bridgeBin = process.env["BRIDGE_BIN"] ?? "bridge";
const fixtureUrl = process.argv[2];
if (!fixtureUrl) {
  console.error("usage: node workflow.mjs <fixture-file-url>");
  process.exit(2);
}

const child = spawn(bridgeBin, ["serve", "--stdio"], {
  stdio: ["pipe", "pipe", "inherit"],
  // Windows resolves .cmd shims (npm-style installs) only through a shell.
  shell: process.platform === "win32",
});
const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
let n = 0;

async function call(op) {
  const request = { protocolVersion: "1.0", requestId: `ex-${++n}`, ...op };
  child.stdin.write(`${JSON.stringify(request)}\n`);
  const next = await lines.next();
  if (next.done) throw new Error("serve closed stdout early");
  const response = JSON.parse(next.value);
  if (response.status !== "completed") {
    throw new Error(`${op.op} failed: ${response.code} ${response.message}`);
  }
  return response;
}

function ref(controls, pred, what) {
  const found = controls.find(pred);
  if (!found) throw new Error(`control not found: ${what}`);
  return found.ref;
}

const created = await call({ op: "create" });
const opened = await call({ op: "open", sessionId: created.sessionId, url: fixtureUrl });
const input = ref(opened.observation.controls, (c) => c.role === "textbox", "item input");
const filled = await call({ op: "fill", sessionId: created.sessionId, ref: input, text: "apples" });
const add = ref(filled.observation.controls, (c) => c.name === "Add to cart", "add button");
const clicked = await call({ op: "click", sessionId: created.sessionId, ref: add });
if (!clicked.observation.text.includes("Item added: apples")) {
  throw new Error("expected confirmation text missing");
}
const shot = await call({ op: "screenshot", sessionId: created.sessionId });
if (!shot.artifacts[0] || !existsSync(shot.artifacts[0].path)) {
  throw new Error("screenshot artifact missing");
}
await call({ op: "close", sessionId: created.sessionId });
child.stdin.end();
await new Promise((resolve, reject) => {
  child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`serve exited ${code}`))));
});
console.log("PASS: node-stdio workflow");
