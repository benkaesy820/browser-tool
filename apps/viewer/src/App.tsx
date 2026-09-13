import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BridgeApi,
  tokenFromHash,
  type Annotation,
  type EngineEvent,
  type Observation,
  type SessionState,
} from "./api";

type Mode = "view" | "click" | "scroll" | "drag" | "annotate";

const INVENTORY_EVENTS = new Set([
  "session-created",
  "session-closed",
  "tab-opened",
  "tab-closed",
  "tab-selected",
  "paused",
  "resumed",
  "annotated",
]);
const PAGE_EVENTS = new Set([
  "navigated",
  "action",
  "waited",
  "viewport",
  "resumed",
  "tab-selected",
]);

interface Shot {
  url: string;
  revision: number;
  at: string;
  width: number;
  height: number;
}

export default function App(): JSX.Element {
  const [token, setToken] = useState<string>(() => tokenFromHash());
  const [draftToken, setDraftToken] = useState("");
  const api = useMemo(
    () => (token ? new BridgeApi(window.location.origin, token) : null),
    [token],
  );
  const [connected, setConnected] = useState(false);
  const [headed, setHeaded] = useState(false);
  const [sessions, setSessions] = useState<string[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [tabs, setTabs] = useState<
    Array<{ id: string; url: string; current: boolean }>
  >([]);
  const [tabId, setTabId] = useState("");
  const [observation, setObservation] = useState<Observation | undefined>(
    undefined,
  );
  const [lease, setLease] = useState<SessionState | undefined>(undefined);
  const [shot, setShot] = useState<Shot | undefined>(undefined);
  const [shotLoading, setShotLoading] = useState(false);
  const [events, setEvents] = useState<EngineEvent[]>([]);
  const [cursor, setCursor] = useState(0);
  const [gap, setGap] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<EngineEvent | undefined>(
    undefined,
  );
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [diagnostics, setDiagnostics] = useState<
    | {
        consoleErrors: string[];
        requestFailures: Array<{ url: string; error: string }>;
        badResponses: Array<{ url: string; status: number }>;
      }
    | undefined
  >(undefined);
  const [mode, setMode] = useState<Mode>("view");
  const [pendingAnn, setPendingAnn] = useState<
    | { kind: "click" | "region"; x: number; y: number; w?: number; h?: number }
    | undefined
  >(undefined);
  const [note, setNote] = useState("");
  const [typeText, setTypeText] = useState("");
  const [keyText, setKeyText] = useState("");
  const [viewW, setViewW] = useState("");
  const [viewH, setViewH] = useState("");
  const [pauseTimeout, setPauseTimeout] = useState("none");
  const [lastOutcome, setLastOutcome] = useState<string | undefined>(undefined);
  const [toast, setToast] = useState<string | undefined>(undefined);
  const [sideTab, setSideTab] = useState<
    "timeline" | "observation" | "diagnostics" | "annotations"
  >("timeline");
  const imgRef = useRef<HTMLImageElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef<{ x: number; y: number } | undefined>(undefined);
  const cursorRef = useRef(0);
  cursorRef.current = cursor;

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(
      () => setToast((t) => (t === message ? undefined : t)),
      5000,
    );
  }, []);

  const refreshShot = useCallback(async (): Promise<Shot | undefined> => {
    if (!api || !sessionId) return undefined;
    setShotLoading(true);
    try {
      const shotOut = await api.call("screenshot", {
        sessionId,
        ...(tabId ? { tabId } : {}),
      });
      const artifact = shotOut.artifacts?.[0];
      const revision =
        shotOut.observation?.revision ?? observation?.revision ?? 0;
      if (shotOut.observation) setObservation(shotOut.observation);
      if (shotOut.session) setLease(shotOut.session);
      if (artifact) {
        const blob = await api.artifactBytes(sessionId, artifact.id);
        const url = URL.createObjectURL(blob);
        const nextShot: Shot = {
          url,
          revision,
          at: new Date().toISOString(),
          width: (artifact as { width?: number }).width ?? 0,
          height: (artifact as { height?: number }).height ?? 0,
        };
        setShot((prev) => {
          if (prev) URL.revokeObjectURL(prev.url);
          return nextShot;
        });
        return nextShot;
      }
    } catch (err) {
      showToast(String(err instanceof Error ? err.message : err));
    } finally {
      setShotLoading(false);
    }
    return undefined;
  }, [api, sessionId, tabId, observation?.revision, showToast]);

  const refreshObservation = useCallback(async () => {
    if (!api || !sessionId) return;
    try {
      const out = await api.call("observe", {
        sessionId,
        ...(tabId ? { tabId } : {}),
      });
      setObservation(out.observation);
      if (out.session) setLease(out.session);
      if (out.tabId) setTabId(out.tabId);
    } catch (err) {
      showToast(String(err instanceof Error ? err.message : err));
    }
  }, [api, sessionId, tabId, showToast]);

  const refreshAll = useCallback(async () => {
    if (!api) return;
    try {
      const health = await api.health();
      setConnected(true);
      setHeaded(health.headed);
      const listed = await api.call("sessions", {});
      setSessions(listed.sessions ?? []);
      if (sessionId) {
        const tabsOut = await api.call("tabs", { sessionId });
        setTabs(tabsOut.tabs ?? []);
        const anns = await api.call("annotations", {
          sessionId,
          mode: "list",
          ...(tabId ? { tabId } : {}),
        });
        setAnnotations(anns.annotations ?? []);
      }
    } catch {
      setConnected(false);
    }
  }, [api, sessionId, tabId]);

  const liveRefs = useRef({
    refreshAll,
    refreshObservation,
    refreshShot,
    sessionId,
    hasShot: shot !== undefined,
  });
  liveRefs.current = {
    refreshAll,
    refreshObservation,
    refreshShot,
    sessionId,
    hasShot: shot !== undefined,
  };

  // Session/tab boot + live event stream with cursor resume. State refreshes
  // are event-driven; the stream heartbeat detects dead connections.
  useEffect(() => {
    if (!api) return;
    let stopped = false;
    const controller = new AbortController();
    void liveRefs.current.refreshAll();
    const loop = async (): Promise<void> => {
      let backoff = 1000;
      while (!stopped) {
        try {
          await api.streamEvents(
            cursorRef.current,
            controller.signal,
            (event) => {
              if (event.type === "gap") {
                setGap(true);
                void liveRefs.current.refreshAll();
                return;
              }
              const e = event as EngineEvent;
              setConnected(true);
              setCursor(e.seq);
              setEvents((prev) => [...prev.slice(-299), e]);
              if (INVENTORY_EVENTS.has(e.type)) {
                void liveRefs.current.refreshAll();
              }
              if (
                e.sessionId === liveRefs.current.sessionId &&
                PAGE_EVENTS.has(e.type)
              ) {
                if (liveRefs.current.hasShot) {
                  void liveRefs.current.refreshShot();
                } else {
                  void liveRefs.current.refreshObservation();
                }
              }
            },
          );
          backoff = 1000;
        } catch {
          if (stopped) break;
          setConnected(false);
          await new Promise((r) => setTimeout(r, backoff));
          backoff = Math.min(backoff * 2, 10_000);
        }
      }
    };
    void loop();
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [api]);

  useEffect(() => {
    if (api && sessionId) void refreshObservation();
  }, [api, sessionId, tabId, refreshObservation]);

  const wheelRefs = useRef({
    api,
    sessionId,
    tabId,
    mode,
    shot,
    observation,
    refreshShot,
    showToast,
  });
  wheelRefs.current = {
    api,
    sessionId,
    tabId,
    mode,
    shot,
    observation,
    refreshShot,
    showToast,
  };

  // A native non-passive wheel listener is deliberate: framework-level wheel
  // delegation can be passive or replaced during rerenders. Debounce one
  // trackpad gesture into one exact browser wheel action.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let deltaX = 0;
    let deltaY = 0;
    let point = { x: 0, y: 0 };
    let timer: number | undefined;
    const flush = (): void => {
      try {
        timer = undefined;
        const sendX = Math.max(-5000, Math.min(5000, Math.trunc(deltaX)));
        const sendY = Math.max(-5000, Math.min(5000, Math.trunc(deltaY)));
        const sendPoint = { ...point };
        deltaX = 0;
        deltaY = 0;
        if (sendX === 0 && sendY === 0) {
          return;
        }
        void (async () => {
          try {
            const current = wheelRefs.current;
            if (!current.api || !current.sessionId || !current.shot) {
              setLastOutcome("wheel ignored (no active session)");
              return;
            }
            const bridge = current.api;
            const activeSession = current.sessionId;
            let coordinateShot = current.shot;
            if (
              current.observation &&
              current.observation.revision > coordinateShot.revision
            ) {
              const fresh = await current.refreshShot();
              if (!fresh) return;
              coordinateShot = fresh;
            }
            const request = (screenshotRevision: number) =>
              bridge.call("act", {
                sessionId: activeSession,
                ...(current.tabId ? { tabId: current.tabId } : {}),
                action: {
                  type: "scrollAt",
                  x: sendPoint.x,
                  y: sendPoint.y,
                  deltaX: sendX,
                  deltaY: sendY,
                  screenshotRevision,
                },
              });
            let out: Awaited<ReturnType<BridgeApi["call"]>>;
            try {
              out = await request(coordinateShot.revision);
            } catch (err) {
              if (!String(err).includes("STALE_OBSERVATION")) throw err;
              const fresh = await current.refreshShot();
              if (!fresh) throw err;
              out = await request(fresh.revision);
            }
            if (!out) return;
            if (out.observation) setObservation(out.observation);
            if (out.session) setLease(out.session);
            setLastOutcome(
              `scrollAt (${sendPoint.x}, ${sendPoint.y}) · ${sendX},${sendY}`,
            );
            await current.refreshShot();
          } catch (err) {
            const message = String(err instanceof Error ? err.message : err);
            setLastOutcome(`scroll error: ${message}`);
            wheelRefs.current.showToast(message);
          }
        })();
      } catch (err) {
        setLastOutcome(`wheel flush error: ${String(err)}`);
      }
    };
    const onWheel = (event: WheelEvent): void => {
      const current = wheelRefs.current;
      const image = imgRef.current;
      if (
        current.mode !== "scroll" ||
        !current.shot ||
        !current.sessionId ||
        !image
      )
        return;
      event.preventDefault();
      setLastOutcome("wheel gesture queued");
      const rect = image.getBoundingClientRect();
      const clientX = Math.min(
        rect.right - 1,
        Math.max(rect.left, event.clientX),
      );
      const clientY = Math.min(
        rect.bottom - 1,
        Math.max(rect.top, event.clientY),
      );
      point = {
        x: Math.round(
          (clientX - rect.left) * (current.shot.width / rect.width),
        ),
        y: Math.round(
          (clientY - rect.top) * (current.shot.height / rect.height),
        ),
      };
      const scale =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 40
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? shot.height
            : 1;
      const rawDeltaX = Number.isFinite(event.deltaX) ? event.deltaX : 0;
      const rawDeltaY = Number.isFinite(event.deltaY) ? event.deltaY : 0;
      deltaX += rawDeltaX * scale;
      deltaY += rawDeltaY * scale;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(flush, 120);
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      stage.removeEventListener("wheel", onWheel);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [api, sessionId]);

  if (!api) {
    return (
      <div className="gate">
        <h1>Browser Bridge</h1>
        <p>
          Paste the viewer token (<code>bridge viewer</code> prints a URL
          carrying it).
        </p>
        <div className="row">
          <input
            data-testid="token-input"
            type="password"
            value={draftToken}
            onChange={(e) => setDraftToken(e.target.value)}
            placeholder="daemon token"
            aria-label="daemon token"
          />
          <button
            data-testid="token-save"
            onClick={() => setToken(draftToken.trim())}
            disabled={!draftToken.trim()}
          >
            Connect
          </button>
        </div>
      </div>
    );
  }

  const paused = lease?.paused ?? false;
  const shotStale =
    shot && observation ? observation.revision > shot.revision : false;

  const toPage = (
    clientX: number,
    clientY: number,
  ): { x: number; y: number } => {
    const img = imgRef.current as HTMLImageElement;
    const rect = img.getBoundingClientRect();
    return {
      x: Math.round(
        (clientX - rect.left) *
          ((shot?.width ?? img.naturalWidth) / rect.width),
      ),
      y: Math.round(
        (clientY - rect.top) *
          ((shot?.height ?? img.naturalHeight) / rect.height),
      ),
    };
  };

  const ensureCurrentShot = async (): Promise<Shot | undefined> => {
    if (!shot) return undefined;
    if (observation && observation.revision > shot.revision) {
      return await refreshShot();
    }
    return shot;
  };

  const sendClick = async (x: number, y: number): Promise<void> => {
    if (!api || !sessionId) return;
    const coordinateShot = await ensureCurrentShot();
    if (!coordinateShot) return;
    try {
      const request = (screenshotRevision: number) =>
        api.call("act", {
          sessionId,
          ...(tabId ? { tabId } : {}),
          action: { type: "clickAt", x, y, screenshotRevision },
        });
      let out: Awaited<ReturnType<BridgeApi["call"]>>;
      try {
        out = await request(coordinateShot.revision);
      } catch (err) {
        if (!String(err).includes("STALE_OBSERVATION")) throw err;
        const fresh = await refreshShot();
        if (!fresh) throw err;
        out = await request(fresh.revision);
      }
      setLastOutcome(
        `clickAt (${x}, ${y}) → ${out.postcondition?.status ?? "done"}`,
      );
      if (out.observation) setObservation(out.observation);
      if (out.session) setLease(out.session);
      await refreshShot();
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err);
      if (message.includes("STALE_OBSERVATION")) {
        showToast(
          "Page moved under the picture — refreshed the screenshot, click again.",
        );
        await refreshObservation();
        await refreshShot();
      } else {
        showToast(message);
      }
    }
  };

  const sendDrag = async (
    from: { x: number; y: number },
    to: { x: number; y: number },
  ): Promise<void> => {
    if (!api || !sessionId) return;
    const coordinateShot = await ensureCurrentShot();
    if (!coordinateShot) return;
    try {
      const request = (screenshotRevision: number) =>
        api.call("act", {
          sessionId,
          ...(tabId ? { tabId } : {}),
          action: { type: "dragAt", from, to, screenshotRevision },
        });
      let out: Awaited<ReturnType<BridgeApi["call"]>>;
      try {
        out = await request(coordinateShot.revision);
      } catch (err) {
        if (!String(err).includes("STALE_OBSERVATION")) throw err;
        const fresh = await refreshShot();
        if (!fresh) throw err;
        out = await request(fresh.revision);
      }
      setLastOutcome(
        `dragAt (${from.x}, ${from.y}) → (${to.x}, ${to.y}) · ${out.postcondition?.status ?? "done"}`,
      );
      if (out.observation) setObservation(out.observation);
      if (out.session) setLease(out.session);
      await refreshShot();
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err);
      showToast(message);
      if (message.includes("STALE_OBSERVATION")) {
        await refreshObservation();
        await refreshShot();
      }
    }
  };

  const changeViewport = async (
    size:
      | { preset: "mobile" | "tablet" | "desktop"; keepWindow: true }
      | { width: number; height: number; keepWindow: true }
      | { free: true },
  ): Promise<void> => {
    if (!api || !sessionId) return;
    try {
      const out = await api.call("viewport", {
        sessionId,
        ...(tabId ? { tabId } : {}),
        ...size,
      });
      if (out.observation) setObservation(out.observation);
      await refreshShot();
    } catch (err) {
      showToast(String(err instanceof Error ? err.message : err));
    }
  };

  const saveAnnotation = async (): Promise<void> => {
    if (!api || !sessionId || !pendingAnn || !note.trim() || !shot) return;
    try {
      await api.call("annotations", {
        sessionId,
        ...(tabId ? { tabId } : {}),
        mode: "add",
        kind: pendingAnn.kind,
        x: pendingAnn.x,
        y: pendingAnn.y,
        ...(pendingAnn.w !== undefined
          ? { w: pendingAnn.w, h: pendingAnn.h }
          : {}),
        note: note.trim(),
        screenshotRevision: shot.revision,
      });
      setPendingAnn(undefined);
      setNote("");
      const anns = await api.call("annotations", {
        sessionId,
        mode: "list",
        ...(tabId ? { tabId } : {}),
      });
      setAnnotations(anns.annotations ?? []);
      if (anns.session) setLease(anns.session);
    } catch (err) {
      showToast(String(err instanceof Error ? err.message : err));
    }
  };

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">Browser Bridge</span>
        <span
          className={`conn ${connected ? "on" : "off"}`}
          data-testid="connection"
        >
          {connected ? "connected" : "disconnected"}
        </span>
        {headed && <span className="pill">visible browser</span>}
        <span
          className={`owner ${paused ? "human" : "agent"}`}
          data-testid="owner-badge"
        >
          {paused ? "human hold" : "agent control"}
        </span>
        {sessionId && (
          <span className="ids mono">
            {sessionId} · {tabId || "—"} · r{observation?.revision ?? "—"}
          </span>
        )}
        {gap && <span className="pill warn">event gap — state refreshed</span>}
      </header>

      <div className="layout">
        <aside className="rail" aria-label="Sessions and tabs">
          <div className="rail-head">
            <h2>Sessions</h2>
            <button
              data-testid="new-session"
              onClick={async () => {
                if (!api) return;
                const created = await api.call("create", {});
                setSessionId(created.sessionId);
                setTabId(created.tabId);
                setObservation(undefined);
                setShot(undefined);
                await refreshAll();
              }}
            >
              New
            </button>
          </div>
          <ul className="list">
            {sessions.map((s) => (
              <li key={s}>
                <button
                  data-testid="session-item"
                  className={s === sessionId ? "active" : ""}
                  onClick={() => {
                    setSessionId(s);
                    setTabId("");
                    setObservation(undefined);
                    setShot(undefined);
                  }}
                >
                  <span className="mono">{s}</span>
                </button>
              </li>
            ))}
            {sessions.length === 0 && (
              <li className="empty">No sessions yet.</li>
            )}
          </ul>
          <h2>Tabs</h2>
          <ul className="list">
            {tabs.map((t) => (
              <li key={t.id}>
                <button
                  data-testid="tab-item"
                  className={
                    t.id === tabId || (tabId === "" && t.current)
                      ? "active"
                      : ""
                  }
                  onClick={async () => {
                    if (!api) return;
                    await api.call("tab-select", { sessionId, tabId: t.id });
                    setTabId(t.id);
                  }}
                >
                  <span className="mono">{t.id}</span>
                  <span className="muted small">{t.url}</span>
                </button>
              </li>
            ))}
          </ul>
          {sessionId && (
            <button
              className="danger"
              onClick={async () => {
                if (!api) return;
                await api.call("close", { sessionId });
                setSessionId("");
                setTabId("");
                setObservation(undefined);
                setShot(undefined);
                await refreshAll();
              }}
            >
              Stop session
            </button>
          )}
        </aside>

        <section className="previewPane" aria-label="Browser preview">
          <div className="toolbar">
            <button
              data-testid="observe-btn"
              disabled={!sessionId}
              onClick={() => void refreshObservation()}
            >
              Observe
            </button>
            <button
              data-testid="screenshot-btn"
              disabled={!sessionId || shotLoading}
              onClick={() => void refreshShot()}
            >
              {shotLoading ? "Capturing…" : "Screenshot"}
            </button>
            {paused ? (
              <button
                data-testid="resume-btn"
                className="human"
                disabled={!sessionId}
                onClick={async () => {
                  if (!api) return;
                  await api.call("resume", { sessionId });
                  await refreshObservation();
                  await refreshShot();
                }}
              >
                Resume agent
              </button>
            ) : (
              <span className="pauseGroup">
                <button
                  data-testid="pause-btn"
                  className="human"
                  disabled={!sessionId}
                  onClick={async () => {
                    if (!api) return;
                    await api.call(
                      "pause",
                      pauseTimeout === "none"
                        ? { sessionId }
                        : { sessionId, timeoutMs: Number(pauseTimeout) },
                    );
                    await refreshObservation();
                  }}
                >
                  Take over
                </button>
                <select
                  value={pauseTimeout}
                  onChange={(e) => setPauseTimeout(e.target.value)}
                  aria-label="Auto-resume"
                >
                  <option value="none">hold</option>
                  <option value="60000">1 min</option>
                  <option value="300000">5 min</option>
                </select>
              </span>
            )}
            <div className="seg" role="group" aria-label="Preview mode">
              {(["view", "click", "scroll", "drag", "annotate"] as Mode[]).map(
                (m) => (
                  <button
                    key={m}
                    className={mode === m ? "active" : ""}
                    onClick={() => setMode(m)}
                  >
                    {m === "view"
                      ? "View"
                      : m === "click"
                        ? "Click"
                        : m === "scroll"
                          ? "Scroll"
                          : m === "drag"
                            ? "Drag"
                            : "Annotate"}
                  </button>
                ),
              )}
            </div>
            <div className="seg" role="group" aria-label="Viewport">
              {(["mobile", "tablet", "desktop"] as const).map((p) => (
                <button
                  key={p}
                  data-testid={`viewport-${p}`}
                  disabled={!sessionId}
                  title={
                    p === "mobile"
                      ? "390×844"
                      : p === "tablet"
                        ? "820×1180"
                        : "1440×900"
                  }
                  onClick={() =>
                    void changeViewport({ preset: p, keepWindow: true })
                  }
                >
                  {p[0]?.toUpperCase()}
                </button>
              ))}
            </div>
            <button
              data-testid="viewport-free"
              disabled={!sessionId}
              onClick={() => void changeViewport({ free: true })}
              title="Follow the browser window again"
            >
              Auto
            </button>
            <input
              value={viewW}
              onChange={(e) => setViewW(e.target.value)}
              placeholder="W"
              aria-label="custom viewport width"
              className="keyin"
            />
            <input
              value={viewH}
              onChange={(e) => setViewH(e.target.value)}
              placeholder="H"
              aria-label="custom viewport height"
              className="keyin"
            />
            <button
              data-testid="viewport-apply"
              disabled={!sessionId || !viewW || !viewH}
              onClick={() =>
                void changeViewport({
                  width: Number(viewW),
                  height: Number(viewH),
                  keepWindow: true,
                })
              }
            >
              Fit
            </button>
            <input
              value={typeText}
              onChange={(e) => setTypeText(e.target.value)}
              placeholder="type into focused field"
              aria-label="type text"
              className="textin"
            />
            <button
              disabled={!sessionId || !typeText}
              onClick={async () => {
                if (!api) return;
                const out = await api.call("act", {
                  sessionId,
                  ...(tabId ? { tabId } : {}),
                  action: { type: "type", text: typeText },
                });
                setTypeText("");
                if (out.observation) setObservation(out.observation);
                if (out.session) setLease(out.session);
                await refreshShot();
              }}
            >
              Send
            </button>
            <input
              value={keyText}
              onChange={(e) => setKeyText(e.target.value)}
              placeholder="key"
              aria-label="press key"
              className="keyin"
            />
            <button
              disabled={!sessionId || !keyText}
              onClick={async () => {
                if (!api) return;
                const out = await api.call("act", {
                  sessionId,
                  ...(tabId ? { tabId } : {}),
                  action: { type: "press", key: keyText },
                });
                setKeyText("");
                if (out.observation) setObservation(out.observation);
                if (out.session) setLease(out.session);
                await refreshShot();
              }}
            >
              Key
            </button>
          </div>

          <div ref={stageRef} className="stage">
            {!shot && !shotLoading && (
              <p className="empty">
                No screenshot yet — capture one to see this tab.
              </p>
            )}
            {shotLoading && !shot && <p className="empty">Capturing…</p>}
            {shot && (
              <img
                ref={imgRef}
                data-testid="preview-img"
                className={`mode-${mode}`}
                src={shot.url}
                alt={`Tab screenshot r${shot.revision}`}
                draggable={false}
                onClick={(e) => {
                  if (mode !== "click") return;
                  const p = toPage(e.clientX, e.clientY);
                  void sendClick(p.x, p.y);
                }}
                onMouseDown={(e) => {
                  if (mode !== "annotate" && mode !== "drag") return;
                  dragStart.current = toPage(e.clientX, e.clientY);
                }}
                onMouseUp={(e) => {
                  if (
                    (mode !== "annotate" && mode !== "drag") ||
                    !dragStart.current
                  )
                    return;
                  const end = toPage(e.clientX, e.clientY);
                  const start = dragStart.current;
                  dragStart.current = undefined;
                  if (mode === "drag") {
                    void sendDrag(start, end);
                    return;
                  }
                  const w = Math.abs(end.x - start.x);
                  const h = Math.abs(end.y - start.y);
                  if (w < 4 || h < 4) {
                    setPendingAnn({ kind: "click", x: end.x, y: end.y });
                  } else {
                    setPendingAnn({
                      kind: "region",
                      x: Math.min(start.x, end.x),
                      y: Math.min(start.y, end.y),
                      w,
                      h,
                    });
                  }
                }}
                onMouseLeave={() => {
                  dragStart.current = undefined;
                }}
              />
            )}
            {shot && (
              <div className="markers" aria-hidden="true">
                {annotations
                  .filter((a) => a.revision === shot.revision)
                  .map((a) => (
                    <span
                      key={a.id}
                      className="marker"
                      title={a.note}
                      style={{
                        left: `${(a.x / (shot.width || 1)) * 100}%`,
                        top: `${(a.y / (shot.height || 1)) * 100}%`,
                      }}
                    />
                  ))}
              </div>
            )}
            {paused && (
              <div className="holdBanner">
                Human hold — agent mutations are rejected until resume.
              </div>
            )}
            {shotStale && (
              <div className="staleBanner">
                Preview is older than the latest observation — capture again.
              </div>
            )}
          </div>

          <div className="previewFoot mono small">
            <span>{observation?.url ?? "—"}</span>
            <span>{observation?.title ?? ""}</span>
            <span>
              shot r{shot?.revision ?? "—"} ·{" "}
              {shot?.at ? new Date(shot.at).toLocaleTimeString() : "—"}
            </span>
            <span data-testid="shot-dims">
              {shot && shot.width > 0 ? `${shot.width}×${shot.height}` : "—"}
            </span>
          </div>

          {pendingAnn && (
            <div className="annForm">
              <span className="mono small">
                {pendingAnn.kind} @ ({pendingAnn.x}, {pendingAnn.y})
              </span>
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="What should change here?"
                aria-label="annotation note"
              />
              <button
                onClick={() => void saveAnnotation()}
                disabled={!note.trim()}
              >
                Save
              </button>
              <button onClick={() => setPendingAnn(undefined)}>Cancel</button>
            </div>
          )}
          {lastOutcome && <p className="outcome mono small">{lastOutcome}</p>}
        </section>

        <aside className="side" aria-label="Inspector">
          <div className="sidetabs" role="tablist">
            {(
              ["timeline", "observation", "diagnostics", "annotations"] as const
            ).map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={sideTab === t}
                className={sideTab === t ? "active" : ""}
                onClick={() => setSideTab(t)}
              >
                {t}
              </button>
            ))}
          </div>

          {sideTab === "timeline" && (
            <ul className="timeline" data-testid="timeline">
              {events
                .filter((e) => !sessionId || e.sessionId === sessionId)
                .slice(-120)
                .reverse()
                .map((e) => (
                  <li key={e.seq}>
                    <button
                      data-testid="event-item"
                      className={selectedEvent?.seq === e.seq ? "active" : ""}
                      onClick={() => setSelectedEvent(e)}
                    >
                      <span className="mono muted">#{e.seq}</span>{" "}
                      <span className={`chip ${e.type}`}>{e.type}</span>
                      <span className="summary">{e.summary}</span>
                    </button>
                  </li>
                ))}
              {events.length === 0 && (
                <li className="empty">
                  No events yet — act in a session to fill this in.
                </li>
              )}
            </ul>
          )}
          {sideTab === "timeline" && selectedEvent && (
            <pre className="detail mono small">
              {JSON.stringify(selectedEvent, null, 2)}
            </pre>
          )}

          {sideTab === "observation" && (
            <div className="obs">
              {observation?.truncated && (
                <p className="warn">
                  Truncated. {observation.continuation ?? ""}
                </p>
              )}
              {(observation ? [observation] : []).length > 0 && observation && (
                <>
                  <pre className="paratext" data-testid="obs-text">
                    {observation.text || "(no text)"}
                  </pre>
                  <table>
                    <thead>
                      <tr>
                        <th>ref</th>
                        <th>role</th>
                        <th>name</th>
                        <th>state</th>
                      </tr>
                    </thead>
                    <tbody>
                      {observation.controls.map((c) => (
                        <tr
                          key={c.ref}
                          className={c.disabled ? "disabled" : ""}
                        >
                          <td className="mono">{c.ref}</td>
                          <td>{c.role}</td>
                          <td>{c.name}</td>
                          <td>{c.disabled ? "disabled" : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
              {!observation && (
                <p className="empty">No observation — select a session.</p>
              )}
            </div>
          )}

          {sideTab === "diagnostics" && (
            <div className="diag">
              <button
                disabled={!sessionId}
                onClick={async () => {
                  if (!api) return;
                  const out = await api.call("diagnostics", {
                    sessionId,
                    ...(tabId ? { tabId } : {}),
                  });
                  setDiagnostics(
                    out.diagnostics as {
                      consoleErrors: string[];
                      requestFailures: Array<{ url: string; error: string }>;
                      badResponses: Array<{ url: string; status: number }>;
                    },
                  );
                }}
              >
                Fetch diagnostics
              </button>
              {diagnostics && (
                <>
                  <h3>Console errors ({diagnostics.consoleErrors.length})</h3>
                  <ul>
                    {diagnostics.consoleErrors.map((e, i) => (
                      <li key={i} className="mono small">
                        {e}
                      </li>
                    ))}
                  </ul>
                  <h3>
                    Failed requests ({diagnostics.requestFailures.length})
                  </h3>
                  <ul>
                    {diagnostics.requestFailures.map((e, i) => (
                      <li key={i} className="mono small">
                        {e.url} — {e.error}
                      </li>
                    ))}
                  </ul>
                  <h3>HTTP errors ({diagnostics.badResponses.length})</h3>
                  <ul>
                    {diagnostics.badResponses.map((e, i) => (
                      <li key={i} className="mono small">
                        {e.status} {e.url}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}

          {sideTab === "annotations" && (
            <div className="anns">
              <p className="muted small">
                Pinned to screenshot revisions — agents read these via the
                annotations op.
              </p>
              <ul>
                {annotations.map((a) => (
                  <li key={a.id} className="mono small">
                    r{a.revision} {a.kind} ({a.x}, {a.y}) — {a.note}
                  </li>
                ))}
                {annotations.length === 0 && (
                  <li className="empty">No annotations.</li>
                )}
              </ul>
            </div>
          )}
        </aside>
      </div>

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
