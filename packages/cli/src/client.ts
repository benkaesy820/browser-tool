import { readDaemonInfo, type DaemonInfo } from "./files.js";

/** Exit codes: 0 completed, 1 protocol error, 2 transport/daemon problem. */
export const EXIT_OK = 0;
export const EXIT_PROTOCOL_ERROR = 1;
export const EXIT_TRANSPORT_ERROR = 2;

export interface DaemonEvent {
  seq: number;
  at: string;
  type: string;
  sessionId: string;
  tabId?: string;
  revision?: number;
  summary: string;
}

async function post(
  info: DaemonInfo,
  path: string,
  body?: unknown,
): Promise<Response> {
  const init: RequestInit = {
    method: "POST",
    headers: { authorization: `Bearer ${info.token}` },
    signal: AbortSignal.timeout(60_000),
  };
  // A JSON content-type with an empty body makes Fastify reject the call
  // with 400 — only claim JSON when a body actually follows.
  if (body !== undefined) {
    (init.headers as Record<string, string>)["content-type"] =
      "application/json";
    init.body = JSON.stringify(body);
  }
  return fetch(`http://127.0.0.1:${info.port}${path}`, init);
}

export async function daemonCall(
  dir: string | undefined,
  request: unknown,
): Promise<{ text: string; exitCode: number }> {
  let info: DaemonInfo;
  try {
    info = await readDaemonInfo(dir);
  } catch (err) {
    return {
      text: `${JSON.stringify({ ok: false, error: String((err as Error).message) })}\n`,
      exitCode: EXIT_TRANSPORT_ERROR,
    };
  }
  let res: Response;
  try {
    res = await post(info, "/v1/request", request);
  } catch (err) {
    return {
      text: `${JSON.stringify({ ok: false, error: `daemon unreachable: ${String(err)}` })}\n`,
      exitCode: EXIT_TRANSPORT_ERROR,
    };
  }
  const text = await res.text();
  let exitCode = EXIT_OK;
  try {
    const parsed = JSON.parse(text) as { status?: string };
    if (parsed.status === "error") exitCode = EXIT_PROTOCOL_ERROR;
  } catch {
    exitCode = EXIT_TRANSPORT_ERROR;
  }
  return { text: `${text}\n`, exitCode };
}

/** Consume the authenticated daemon SSE stream and emit decoded events. */
export async function daemonEvents(
  dir: string | undefined,
  cursor: number,
  onEvent: (event: DaemonEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const info = await readDaemonInfo(dir);
  const res = await fetch(
    `http://127.0.0.1:${info.port}/v1/events?cursor=${Math.max(0, Math.floor(cursor))}`,
    {
      headers: {
        authorization: `Bearer ${info.token}`,
        accept: "text/event-stream",
      },
      ...(signal ? { signal } : {}),
    },
  );
  if (!res.ok || !res.body) {
    throw new Error(`event stream failed with HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.match(/\r?\n\r?\n/);
    while (boundary?.index !== undefined) {
      const block = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      const data = block
        .split("\n")
        .map((line) => line.replace(/\r$/, ""))
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) onEvent(JSON.parse(data) as DaemonEvent);
      boundary = buffer.match(/\r?\n\r?\n/);
    }
  }
}

export async function daemonStatus(
  dir: string | undefined,
): Promise<{ text: string; exitCode: number }> {
  const info = await readDaemonInfo(dir).catch(() => undefined);
  if (!info) {
    return {
      text: `${JSON.stringify({ running: false })}\n`,
      exitCode: EXIT_OK,
    };
  }
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/v1/health`, {
      headers: { authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(5000),
    });
    const body = (await res.json()) as {
      ok?: boolean;
      sessions?: number;
      headed?: boolean;
      viewerBuilt?: boolean;
    };
    return {
      text: `${JSON.stringify({ running: res.ok && body.ok === true, port: info.port, pid: info.pid, sessions: body.sessions ?? 0, headed: body.headed ?? false, viewerBuilt: body.viewerBuilt ?? false })}\n`,
      exitCode: EXIT_OK,
    };
  } catch {
    return {
      text: `${JSON.stringify({ running: false, staleFile: true })}\n`,
      exitCode: EXIT_OK,
    };
  }
}

export async function daemonStop(
  dir: string | undefined,
): Promise<{ text: string; exitCode: number }> {
  const info = await readDaemonInfo(dir).catch(() => undefined);
  if (!info) {
    return {
      text: `${JSON.stringify({ ok: true, note: "daemon was not running" })}\n`,
      exitCode: EXIT_OK,
    };
  }
  try {
    const res = await post(info, "/v1/shutdown");
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok || typeof body !== "object" || body === null) {
      return {
        text: `${JSON.stringify({ ok: false, error: `shutdown failed with HTTP ${res.status}` })}\n`,
        exitCode: EXIT_TRANSPORT_ERROR,
      };
    }
    return { text: `${JSON.stringify(body)}\n`, exitCode: EXIT_OK };
  } catch (err) {
    return {
      text: `${JSON.stringify({ ok: false, error: String(err) })}\n`,
      exitCode: EXIT_TRANSPORT_ERROR,
    };
  }
}
