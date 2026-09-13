/** Typed client for the daemon API. Token lives in memory only, never storage. */

export interface Control {
  ref: string;
  role: string;
  name: string;
  frame: string;
  disabled: boolean;
}

export interface Observation {
  revision: number;
  url: string;
  title: string;
  text: string;
  controls: Control[];
  frames: Array<{ id: string; url: string; name?: string; error?: string }>;
  truncated: boolean;
  continuation?: string;
}

export interface SessionState {
  id: string;
  paused: boolean;
  owner: "agent" | "human";
  ownerSince?: string;
  annotationCount: number;
}

export interface Annotation {
  id: string;
  tabId: string;
  revision: number;
  kind: "click" | "region";
  x: number;
  y: number;
  w?: number;
  h?: number;
  note: string;
  at: string;
}

export interface EngineEvent {
  seq: number;
  at: string;
  type: string;
  sessionId: string;
  tabId?: string;
  revision?: number;
  summary: string;
}

export interface Envelope {
  status: string;
  code?: string;
  message?: string;
  sessionId: string;
  tabId: string;
  op: string;
  observation?: Observation;
  postcondition?: { status: string };
  diagnostics?: {
    consoleErrors: string[];
    requestFailures: Array<{ url: string; error: string }>;
    badResponses: Array<{ url: string; status: number }>;
  };
  session?: SessionState;
  sessions?: string[];
  tabs?: Array<{ id: string; url: string; current: boolean }>;
  annotations?: Annotation[];
  location?: { x: number; y: number; width: number; height: number };
  artifacts?: Array<{ id: string; path: string }>;
  warnings?: string[];
}

let counter = 0;

export class BridgeApi {
  constructor(
    private readonly base: string,
    private readonly token: string,
  ) {}

  async call(
    op: string,
    extra: Record<string, unknown> = {},
  ): Promise<Envelope> {
    counter += 1;
    const res = await fetch(`${this.base}/v1/request`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        protocolVersion: "1.0",
        requestId: `vw-${counter}`,
        op,
        ...extra,
      }),
    });
    const body = (await res.json()) as Envelope;
    if (body.status !== "completed") {
      throw new Error(
        `${body.code ?? "ERROR"}: ${body.message ?? "request failed"}`,
      );
    }
    return body;
  }

  async health(): Promise<{
    ok: boolean;
    sessions: number;
    headed: boolean;
    viewerBuilt: boolean;
  }> {
    const res = await fetch(`${this.base}/v1/health`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    return (await res.json()) as {
      ok: boolean;
      sessions: number;
      headed: boolean;
      viewerBuilt: boolean;
    };
  }

  async artifactBytes(sessionId: string, artifactId: string): Promise<Blob> {
    const res = await fetch(
      `${this.base}/v1/artifacts/${sessionId}/${artifactId}`,
      {
        headers: { authorization: `Bearer ${this.token}` },
      },
    );
    if (!res.ok)
      throw new Error(`artifact ${artifactId} unavailable (${res.status})`);
    return await res.blob();
  }

  /** Manual SSE over fetch (EventSource cannot send Authorization headers). */
  async streamEvents(
    cursor: number,
    signal: AbortSignal,
    onEvent: (event: EngineEvent | { type: "gap" }) => void,
  ): Promise<void> {
    const res = await fetch(`${this.base}/v1/events?cursor=${cursor}`, {
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "text/event-stream",
      },
      signal,
    });
    if (!res.ok || !res.body)
      throw new Error(`events stream failed (${res.status})`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.match(/\r?\n\r?\n/);
      while (boundary?.index !== undefined) {
        const chunk = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        for (const line of chunk.split("\n")) {
          const normalized = line.replace(/\r$/, "");
          if (normalized.startsWith("data: ")) {
            onEvent(JSON.parse(normalized.slice(6)) as EngineEvent);
          }
        }
        boundary = buffer.match(/\r?\n\r?\n/);
      }
    }
  }
}

export function tokenFromHash(): string {
  const match = window.location.hash.match(/token=([^&]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : "";
}
