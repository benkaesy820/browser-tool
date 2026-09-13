import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { VIEWPORT_PRESETS } from "@browser-bridge/core";
import { daemonDir, readDaemonInfo } from "./files.js";
import { daemonCall } from "./client.js";

/**
 * Human verbs over the JSON protocol (`bridge open <url>`,
 * `bridge click <ref>`, …). One line in, a few readable lines out —
 * no JSON files, no request ids to invent. `--json` prints the raw
 * envelope for scripting and for agents.
 */

export interface VerbOptions {
  daemonDir?: string;
  session?: string;
  tab?: string;
  json?: boolean;
  keepWindow?: boolean;
  full?: boolean;
  profile?: string;
  out?: string;
  button?: "left" | "right" | "middle";
  clickCount?: number;
}

let counter = 0;
const rid = (): string => `v-${Date.now()}-${++counter}`;

async function currentSession(
  dir: string | undefined,
): Promise<string | undefined> {
  try {
    const id = (
      await readFile(join(daemonDir(dir), "current-session"), "utf8")
    ).trim();
    return id || undefined;
  } catch {
    return undefined;
  }
}

async function rememberSession(
  dir: string | undefined,
  id: string,
): Promise<void> {
  await writeFile(join(daemonDir(dir), "current-session"), `${id}\n`).catch(
    () => undefined,
  );
}

async function resolveSession(
  opts: VerbOptions,
  opts2?: { autoCreate?: boolean },
): Promise<string> {
  if (opts.session) return opts.session;
  const current = await currentSession(opts.daemonDir);
  if (current) return current;
  if (opts2?.autoCreate) return "";
  throw Object.assign(
    new Error(
      "No session. Run `bridge open <url>` first (it creates one) or `bridge use <id>`.",
    ),
    {
      code: "NO_SESSION",
    },
  );
}

function fail(text: string): { text: string; exitCode: number } {
  return { text, exitCode: 2 };
}

function describeError(envelope: Record<string, unknown>): string {
  const code = String(envelope["code"] ?? "ERROR");
  const message = String(envelope["message"] ?? "");
  const retry =
    envelope["retryable"] === true ? " (safe to retry after re-observing)" : "";
  return `✗ ${code}: ${message}${retry}\n`;
}

function obsLine(obs: Record<string, unknown> | undefined): string {
  if (!obs) return "";
  const controls = (obs["controls"] as Array<unknown>) ?? [];
  return `r${String(obs["revision"] ?? "?")} | ${String(obs["title"] ?? "")} | ${controls.length} controls`;
}

function postOf(envelope: Record<string, unknown>): string {
  const post = envelope["postcondition"] as { status?: string } | undefined;
  return post?.status && post.status !== "not-requested"
    ? ` → ${post.status}`
    : "";
}

function warnLines(envelope: Record<string, unknown>): string {
  const warnings = (envelope["warnings"] as Array<string>) ?? [];
  return warnings.map((w) => `! ${w}\n`).join("");
}

/**
 * Full observation block shared by `state` and every action. Actions
 * return the fresh post-action observation (same revision-scoped refs as
 * `state`), so agents chain the next click/fill from the same output
 * instead of paying for an extra `state` round trip.
 */
function formatObservation(obs: Record<string, unknown>): string {
  const controls =
    (obs["controls"] as Array<{
      ref: string;
      role: string;
      name: string;
      disabled: boolean;
    }>) ?? [];
  const shown = controls.slice(0, 40);
  const rows = shown
    .map(
      (c) =>
        `  ${c.ref} [${c.role}] ${c.name}${c.disabled ? " (disabled)" : ""}`,
    )
    .join("\n");
  const more =
    controls.length > shown.length
      ? `\n  … +${controls.length - shown.length} more (--json for all)`
      : "";
  const text = String(obs["text"] ?? "")
    .trim()
    .slice(0, 800);
  return `${String(obs["url"] ?? "")}\n  ${obsLine(obs)}\n${text ? `${text}\n` : ""}${rows}${more}`;
}

async function send(
  opts: VerbOptions,
  op: string,
  extra: Record<string, unknown>,
): Promise<{
  text: string;
  exitCode: number;
  envelope?: Record<string, unknown>;
}> {
  const { text, exitCode } = await daemonCall(opts.daemonDir, {
    protocolVersion: "1.0",
    requestId: rid(),
    op,
    ...extra,
  });
  let envelope: Record<string, unknown> | undefined;
  try {
    envelope = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { text, exitCode };
  }
  if (opts.json)
    return {
      text: `${JSON.stringify(envelope, null, 2)}\n`,
      exitCode,
      envelope,
    };
  if (envelope["status"] === "error")
    return { text: describeError(envelope), exitCode, envelope };
  return { text: "", exitCode, envelope };
}

type SendOut = {
  text: string;
  exitCode: number;
  envelope?: Record<string, unknown>;
};

/** Verbs format their own human output; this restores the raw envelope for --json. */
function jsonOut(
  opts: VerbOptions,
  out: SendOut,
): { text: string; exitCode: number } | undefined {
  if (opts.json && out.envelope) {
    return {
      text: `${JSON.stringify(out.envelope, null, 2)}\n`,
      exitCode: out.exitCode,
    };
  }
  return undefined;
}

function withSession(
  opts: VerbOptions,
  sessionId: string,
): Record<string, unknown> {
  return { sessionId, ...(opts.tab ? { tabId: opts.tab } : {}) };
}

async function createAndRemember(
  opts: VerbOptions,
): Promise<{ text: string; exitCode: number } | { sessionId: string }> {
  const created = await send(
    opts.daemonDir ? { daemonDir: opts.daemonDir } : {},
    "create",
    opts.profile ? { profile: opts.profile } : {},
  );
  if (!created.envelope || created.envelope["status"] !== "completed") {
    return created.text ? created : fail("could not create a session\n");
  }
  const sessionId = created.envelope["sessionId"] as string;
  await rememberSession(opts.daemonDir, sessionId);
  return { sessionId };
}

export async function verbOpen(
  opts: VerbOptions,
  url: string,
): Promise<{ text: string; exitCode: number }> {
  const explicit = opts.session;
  if (explicit && opts.profile) {
    return fail(
      "--profile only applies when creating a session, not with --session\n",
    );
  }
  let sessionId = explicit ?? (await currentSession(opts.daemonDir));
  let reused = sessionId !== undefined;
  if (!sessionId) {
    const created = await createAndRemember(opts);
    if (!("sessionId" in created)) return created;
    sessionId = created.sessionId;
  }
  const attempt = (id: string) =>
    send(opts, "open", { ...withSession(opts, id), url });
  let out = await attempt(sessionId);
  if (
    !explicit &&
    out.envelope?.["status"] === "error" &&
    out.envelope?.["code"] === "SESSION_NOT_FOUND"
  ) {
    // The daemon restarted (or sessions were cleaned) since this id was
    // remembered: replace the stale id and retry the open once.
    const recreated = await createAndRemember(opts);
    if (!("sessionId" in recreated)) return recreated;
    sessionId = recreated.sessionId;
    reused = false;
    out = await attempt(sessionId);
  }
  const asJson = jsonOut(opts, out);
  if (asJson) return asJson;
  if (!out.envelope || out.envelope["status"] !== "completed") return out;
  const obs = out.envelope["observation"] as
    | Record<string, unknown>
    | undefined;
  const profileNote =
    opts.profile && reused
      ? `! --profile ${opts.profile} ignored: reusing remembered session ${sessionId} (close it first for a profiled session)\n`
      : "";
  return {
    text: `✓ ${String(obs?.["url"] ?? url)}\n${obs ? `${formatObservation(obs)}\n` : ""}${profileNote}${warnLines(out.envelope)}`,
    exitCode: 0,
  };
}

export async function verbState(
  opts: VerbOptions,
): Promise<{ text: string; exitCode: number }> {
  let sessionId: string;
  try {
    sessionId = await resolveSession(opts);
  } catch (err) {
    return fail(`${(err as Error).message}\n`);
  }
  const out = await send(opts, "observe", withSession(opts, sessionId));
  const asJson = jsonOut(opts, out);
  if (asJson) return asJson;
  if (!out.envelope || out.envelope["status"] !== "completed") return out;
  const obs = out.envelope["observation"] as Record<string, unknown>;
  return {
    text: `${formatObservation(obs)}\n${warnLines(out.envelope)}`,
    exitCode: 0,
  };
}

async function verbActLike(
  opts: VerbOptions,
  label: string,
  op: string,
  extra: Record<string, unknown>,
): Promise<{ text: string; exitCode: number }> {
  let sessionId: string;
  try {
    sessionId = await resolveSession(opts);
  } catch (err) {
    return fail(`${(err as Error).message}\n`);
  }
  const out = await send(opts, op, {
    ...withSession(opts, sessionId),
    ...extra,
  });
  const asJson = jsonOut(opts, out);
  if (asJson) return asJson;
  if (!out.envelope || out.envelope["status"] !== "completed") return out;
  const obs = out.envelope["observation"] as
    | Record<string, unknown>
    | undefined;
  const status = obs ? `\n${formatObservation(obs)}` : "";
  return {
    text: `✓ ${label}${postOf(out.envelope)}${status}\n${warnLines(out.envelope)}`,
    exitCode: 0,
  };
}

export const verbClick = (
  opts: VerbOptions,
  ref: string,
): Promise<{ text: string; exitCode: number }> =>
  verbActLike(opts, `click ${ref}`, "click", {
    ref,
    ...(opts.button === undefined ? {} : { button: opts.button }),
    ...(opts.clickCount === undefined ? {} : { clickCount: opts.clickCount }),
  });

export const verbFill = (
  opts: VerbOptions,
  ref: string,
  text: string,
): Promise<{ text: string; exitCode: number }> =>
  verbActLike(opts, `fill ${ref} (${text.length} chars)`, "fill", {
    ref,
    text,
  });

export const verbType = (
  opts: VerbOptions,
  text: string,
): Promise<{ text: string; exitCode: number }> =>
  verbActLike(opts, `type (${text.length} chars)`, "act", {
    action: { type: "type", text },
  });

export const verbPress = (
  opts: VerbOptions,
  key: string,
): Promise<{ text: string; exitCode: number }> =>
  verbActLike(opts, `press ${key}`, "press", { key });

export const verbHover = (
  opts: VerbOptions,
  ref: string,
): Promise<{ text: string; exitCode: number }> =>
  verbActLike(opts, `hover ${ref}`, "hover", { ref });

export const verbScroll = (
  opts: VerbOptions,
  pixels: string,
  ref?: string,
): Promise<{ text: string; exitCode: number }> => {
  const extra: Record<string, unknown> = { pixels: Number(pixels) };
  if (ref) extra["ref"] = ref;
  return verbActLike(
    opts,
    `scroll ${pixels}${ref ? ` ${ref}` : ""}`,
    "scroll",
    extra,
  );
};

export const verbGo = (
  opts: VerbOptions,
  url: string,
): Promise<{ text: string; exitCode: number }> =>
  verbActLike(opts, `go ${url}`, "navigate", { url });

export const verbBack = (
  opts: VerbOptions,
): Promise<{ text: string; exitCode: number }> =>
  verbActLike(opts, "back", "back", {});

export const verbForward = (
  opts: VerbOptions,
): Promise<{ text: string; exitCode: number }> =>
  verbActLike(opts, "forward", "forward", {});

export const verbReload = (
  opts: VerbOptions,
): Promise<{ text: string; exitCode: number }> =>
  verbActLike(opts, "reload", "reload", {});

export const verbWait = (
  opts: VerbOptions,
  text: string,
): Promise<{ text: string; exitCode: number }> =>
  verbActLike(opts, `wait text "${text}"`, "wait", {
    condition: { type: "textVisible", text, timeoutMs: 15000 },
  });

export const verbSelect = (
  opts: VerbOptions,
  ref: string,
  values: string[],
): Promise<{ text: string; exitCode: number }> =>
  verbActLike(opts, `select ${ref} = ${values.join(",")}`, "select", {
    ref,
    values,
  });

export const verbCheck = (
  opts: VerbOptions,
  ref: string,
  checked: boolean,
): Promise<{ text: string; exitCode: number }> =>
  verbActLike(opts, `check ${ref} = ${checked ? "on" : "off"}`, "check", {
    ref,
    checked,
  });

export const verbUpload = (
  opts: VerbOptions,
  ref: string,
  file: string,
): Promise<{ text: string; exitCode: number }> =>
  verbActLike(opts, `upload ${ref} <- ${file}`, "upload", { ref, file });

/**
 * Dev detail on demand: role, box, visibility, attributes, and text for
 * one control — without dumping a full state. The evidence ladder is:
 * action `!` lines → `diagnostics` → `inspect <ref>` → `state --json` →
 * `shot --full` → viewer.
 */
export async function verbInspect(
  opts: VerbOptions,
  ref: string,
): Promise<{ text: string; exitCode: number }> {
  let sessionId: string;
  try {
    sessionId = await resolveSession(opts);
  } catch (err) {
    return fail(`${(err as Error).message}\n`);
  }
  const out = await send(opts, "observe", {
    ...withSession(opts, sessionId),
    mode: "inspect",
    ref,
  });
  const asJson = jsonOut(opts, out);
  if (asJson) return asJson;
  if (!out.envelope || out.envelope["status"] !== "completed") return out;
  const insp = (out.envelope["inspection"] as Record<string, unknown>) ?? {};
  const box = insp["box"] as
    | { x: number; y: number; width: number; height: number }
    | null
    | undefined;
  const attrs = (insp["attributes"] as Record<string, string>) ?? {};
  const attrLines = Object.entries(attrs)
    .slice(0, 12)
    .map(([k, v]) => `  @${k}="${String(v).slice(0, 120)}"`)
    .join("\n");
  const lines = [
    `${String(insp["ref"] ?? ref)} [${String(insp["role"] ?? "?")}] ${String(insp["name"] ?? "")}`,
    `  frame=${String(insp["frame"] ?? "?")} visible=${String(insp["visible"] ?? "?")} disabled=${String(insp["disabled"] ?? "?")}`,
    `  box=${box ? `${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)}` : "none"}`,
  ];
  if (attrLines) lines.push(attrLines);
  const text = String(insp["text"] ?? "")
    .trim()
    .slice(0, 500);
  if (text) lines.push(`  text: ${text}`);
  return {
    text: `${lines.join("\n")}\n${warnLines(out.envelope)}`,
    exitCode: 0,
  };
}

/**
 * Scoped control search: substring-match by name/role without dumping a
 * full state first. Prints matches (fresh refs) plus the observation line
 * so the next action chains directly.
 */
export async function verbSearch(
  opts: VerbOptions,
  query: string,
  limit = 20,
): Promise<{ text: string; exitCode: number }> {
  let sessionId: string;
  try {
    sessionId = await resolveSession(opts);
  } catch (err) {
    return fail(`${(err as Error).message}\n`);
  }
  const out = await send(opts, "search", {
    ...withSession(opts, sessionId),
    query,
    limit,
  });
  const asJson = jsonOut(opts, out);
  if (asJson) return asJson;
  if (!out.envelope || out.envelope["status"] !== "completed") return out;
  const matches =
    (out.envelope["matches"] as Array<{
      ref: string;
      role: string;
      name: string;
    }>) ?? [];
  const obs = out.envelope["observation"] as
    | Record<string, unknown>
    | undefined;
  const rows =
    matches.length > 0
      ? matches.map((m) => `  ${m.ref} [${m.role}] ${m.name}`).join("\n")
      : "  (no matches)";
  return {
    text: `"${query}" → ${matches.length} match${matches.length === 1 ? "" : "es"}${obs ? ` | ${obsLine(obs)}` : ""}\n${rows}\n${warnLines(out.envelope)}`,
    exitCode: 0,
  };
}

/**
 * One-call diagnostics: console errors, failed requests, bad responses,
 * downloads, and the last auto-dismissed dialog. One round trip instead
 * of guessing why a page misbehaves.
 */
export async function verbDiagnostics(
  opts: VerbOptions,
): Promise<{ text: string; exitCode: number }> {
  let sessionId: string;
  try {
    sessionId = await resolveSession(opts);
  } catch (err) {
    return fail(`${(err as Error).message}\n`);
  }
  const out = await send(opts, "diagnostics", withSession(opts, sessionId));
  const asJson = jsonOut(opts, out);
  if (asJson) return asJson;
  if (!out.envelope || out.envelope["status"] !== "completed") return out;
  const d = (out.envelope["diagnostics"] as Record<string, unknown>) ?? {};
  const lines: string[] = [];
  const push = (title: string, items: unknown[]): void => {
    lines.push(`${title} (${items.length}):`);
    for (const item of items.slice(0, 10)) {
      lines.push(
        `  - ${typeof item === "string" ? item.slice(0, 200) : JSON.stringify(item).slice(0, 200)}`,
      );
    }
  };
  push("consoleErrors", (d["consoleErrors"] as unknown[]) ?? []);
  push("requestFailures", (d["requestFailures"] as unknown[]) ?? []);
  push("badResponses", (d["badResponses"] as unknown[]) ?? []);
  push("downloads", (d["downloads"] as unknown[]) ?? []);
  if (d["dialog"] !== undefined)
    lines.push(`dialog: ${JSON.stringify(d["dialog"]).slice(0, 300)}`);
  return {
    text: `${lines.join("\n")}\n${warnLines(out.envelope)}`,
    exitCode: 0,
  };
}

/**
 * Bounded batch: up to 20 actions against ONE observation, one queue
 * slot, one final observation. The efficiency control — chains a whole
 * flow (fill + select + check + click…) in a single round trip instead
 * of one shell call per step. Actions JSON arrives via --stdin on
 * Windows (no quoting hell) or as an inline argument on POSIX.
 */
export async function verbBatch(
  opts: VerbOptions,
  rawActions: string,
): Promise<{ text: string; exitCode: number }> {
  let sessionId: string;
  try {
    sessionId = await resolveSession(opts);
  } catch (err) {
    return fail(`${(err as Error).message}\n`);
  }
  let actions: unknown;
  try {
    actions = JSON.parse(rawActions) as unknown;
  } catch {
    return fail("batch needs a JSON array of actions (or --stdin)\n");
  }
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > 20) {
    return fail("batch needs 1..20 actions in a JSON array\n");
  }
  const out = await send(opts, "batch", {
    ...withSession(opts, sessionId),
    actions,
  });
  const asJson = jsonOut(opts, out);
  if (asJson) return asJson;
  if (!out.envelope || out.envelope["status"] !== "completed") return out;
  const steps = (out.envelope["steps"] as Array<{
    type: string;
    ok: boolean;
    code?: string;
    message?: string;
  }>) ?? [{ type: "batch", ok: true }];
  const ok = steps.filter((s) => s.ok).length;
  const stepLines = steps
    .map(
      (s, i) =>
        `  ${i + 1}. ${s.type}: ${s.ok ? "ok" : `FAILED ${s.code ?? ""} ${s.message ?? ""}`.trim()}`,
    )
    .join("\n");
  const obs = out.envelope["observation"] as
    | Record<string, unknown>
    | undefined;
  const status = obs ? `\n${formatObservation(obs)}` : "";
  return {
    text: `✓ batch ${ok}/${steps.length} ok\n${stepLines}${status}\n${warnLines(out.envelope)}`,
    exitCode: 0,
  };
}

export async function verbShot(
  opts: VerbOptions,
): Promise<{ text: string; exitCode: number }> {
  let sessionId: string;
  try {
    sessionId = await resolveSession(opts);
  } catch (err) {
    return fail(`${(err as Error).message}\n`);
  }
  const out = await send(opts, "screenshot", {
    ...withSession(opts, sessionId),
    ...(opts.full ? { fullPage: true } : {}),
  });
  const asShot = jsonOut(opts, out);
  if (asShot) return asShot;
  if (!out.envelope || out.envelope["status"] !== "completed") return out;
  const artifacts =
    (out.envelope["artifacts"] as Array<{
      id: string;
      path: string;
      width?: number;
      height?: number;
    }>) ?? [];
  const first = artifacts[0];
  if (!first) return { text: "no artifact\n", exitCode: 0 };
  const dims =
    first.width !== undefined && first.height !== undefined
      ? ` (${first.width}x${first.height}${opts.full ? ", full page" : ""})`
      : "";
  const obs = out.envelope["observation"] as
    | Record<string, unknown>
    | undefined;
  const suffix = obs ? ` | ${obsLine(obs)}` : "";
  if (opts.out) {
    const copied = await copyArtifactTo(
      opts.daemonDir,
      sessionId,
      first.id,
      opts.out,
    );
    if (!copied.ok)
      return fail(
        `shot saved to artifact store but copy failed: ${copied.error}\n`,
      );
    return { text: `saved ${opts.out}${dims}${suffix}\n`, exitCode: 0 };
  }
  return {
    text: `saved ${first.path}${dims}${suffix}\n`,
    exitCode: 0,
  };
}

/**
 * Copy a session artifact to a caller-chosen path (e.g. the current
 * workspace). The store copy stays owned by the session (cleaned on
 * close); the copy is yours. Parent dirs are created.
 */
async function copyArtifactTo(
  dir: string | undefined,
  sessionId: string,
  artifactId: string,
  outPath: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let info;
  try {
    info = await readDaemonInfo(dir);
  } catch (err) {
    return { ok: false, error: String((err as Error).message) };
  }
  let bytes: ArrayBuffer;
  try {
    const res = await fetch(
      `http://127.0.0.1:${info.port}/v1/artifacts/${sessionId}/${artifactId}`,
      {
        headers: { authorization: `Bearer ${info.token}` },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!res.ok) return { ok: false, error: `artifact HTTP ${res.status}` };
    bytes = await res.arrayBuffer();
  } catch (err) {
    return {
      ok: false,
      error: `artifact fetch failed: ${String(err).slice(0, 200)}`,
    };
  }
  try {
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, Buffer.from(bytes));
  } catch (err) {
    return { ok: false, error: `write failed: ${String(err).slice(0, 200)}` };
  }
  return { ok: true };
}

export async function verbTabs(
  opts: VerbOptions,
): Promise<{ text: string; exitCode: number }> {
  let sessionId: string;
  try {
    sessionId = await resolveSession(opts);
  } catch (err) {
    return fail(`${(err as Error).message}\n`);
  }
  const out = await send(opts, "tabs", { sessionId });
  const asTabs = jsonOut(opts, out);
  if (asTabs) return asTabs;
  if (!out.envelope || out.envelope["status"] !== "completed") return out;
  const tabs =
    (out.envelope["tabs"] as Array<{
      id: string;
      url: string;
      current: boolean;
    }>) ?? [];
  if (tabs.length === 0) return { text: "no tabs\n", exitCode: 0 };
  return {
    text:
      tabs.map((t) => `${t.current ? "*" : " "} ${t.id}  ${t.url}`).join("\n") +
      "\n",
    exitCode: 0,
  };
}

export async function verbSessions(
  opts: VerbOptions,
): Promise<{ text: string; exitCode: number }> {
  const out = await send(opts, "sessions", {});
  const asSessions = jsonOut(opts, out);
  if (asSessions) return asSessions;
  if (!out.envelope || out.envelope["status"] !== "completed") return out;
  const sessions = (out.envelope["sessions"] as Array<string>) ?? [];
  return {
    text: sessions.length > 0 ? sessions.join("\n") + "\n" : "no sessions\n",
    exitCode: 0,
  };
}

export async function verbUse(
  opts: VerbOptions,
  id: string,
): Promise<{ text: string; exitCode: number }> {
  const out = await send({ ...opts, session: id }, "tabs", { sessionId: id });
  const asUse = jsonOut(opts, out);
  if (asUse) return asUse;
  if (!out.envelope || out.envelope["status"] !== "completed") return out;
  await rememberSession(opts.daemonDir, id);
  return { text: `using ${id}\n`, exitCode: 0 };
}

export async function verbClose(
  opts: VerbOptions,
  id?: string,
): Promise<{ text: string; exitCode: number }> {
  let sessionId: string;
  if (id) {
    sessionId = id;
  } else {
    try {
      sessionId = await resolveSession(opts);
    } catch (err) {
      return fail(`${(err as Error).message}\n`);
    }
  }
  const out = await send({ ...opts, session: sessionId }, "close", {
    sessionId,
  });
  const asClose = jsonOut(opts, out);
  if (asClose) return asClose;
  if (!out.envelope || out.envelope["status"] !== "completed") return out;
  const current = await currentSession(opts.daemonDir);
  if (current === sessionId) {
    await writeFile(
      join(daemonDir(opts.daemonDir), "current-session"),
      "",
    ).catch(() => undefined);
  }
  return { text: `closed ${sessionId}\n`, exitCode: 0 };
}

export async function verbViewport(
  opts: VerbOptions,
  spec: string,
): Promise<{ text: string; exitCode: number }> {
  let sessionId: string;
  try {
    sessionId = await resolveSession(opts);
  } catch (err) {
    return fail(`${(err as Error).message}\n`);
  }
  const lower = spec.toLowerCase();
  if (lower === "free") {
    if (opts.keepWindow)
      return fail("viewport free takes no --keep-window flag\n");
    const out = await send(opts, "viewport", {
      ...withSession(opts, sessionId),
      free: true,
    });
    const asFree = jsonOut(opts, out);
    if (asFree) return asFree;
    if (!out.envelope || out.envelope["status"] !== "completed") return out;
    const obs = out.envelope["observation"] as
      | Record<string, unknown>
      | undefined;
    return {
      text: `✓ viewport free${obs ? `\n${formatObservation(obs)}` : ""}\n${warnLines(out.envelope)}`,
      exitCode: 0,
    };
  }
  let extra: Record<string, unknown> | undefined;
  let dimensions: string | undefined;
  if (lower === "mobile" || lower === "tablet" || lower === "desktop") {
    extra = { preset: lower };
    const preset = VIEWPORT_PRESETS[lower];
    dimensions = `${preset.width}x${preset.height}`;
  } else {
    const match = /^(\d+)\s*[x×,]\s*(\d+)$/.exec(spec.trim());
    if (match?.[1] && match?.[2]) {
      extra = { width: Number(match[1]), height: Number(match[2]) };
      dimensions = `${match[1]}x${match[2]}`;
    }
  }
  if (!extra)
    return fail(
      "viewport needs mobile|tablet|desktop|free or WIDTHxHEIGHT (e.g. 390x844)\n",
    );
  if (opts.keepWindow) extra["keepWindow"] = true;
  const out = await send(opts, "viewport", {
    ...withSession(opts, sessionId),
    ...extra,
  });
  const asViewport = jsonOut(opts, out);
  if (asViewport) return asViewport;
  if (!out.envelope || out.envelope["status"] !== "completed") return out;
  const obs = out.envelope["observation"] as
    | Record<string, unknown>
    | undefined;
  return {
    text: `✓ viewport ${spec} (${dimensions}${opts.keepWindow ? ", window kept" : ""})${obs ? `\n${formatObservation(obs)}` : ""}\n${warnLines(out.envelope)}`,
    exitCode: 0,
  };
}
