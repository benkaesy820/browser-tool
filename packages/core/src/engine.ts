import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize, sep } from "node:path";
import {
  Browser,
  BrowserContext,
  CDPSession,
  Locator,
  Page,
  chromium,
} from "playwright";
import {
  getCapabilities,
  type Action,
  type Artifact,
  type ErrorCode,
  type Observation,
  type Postcondition,
  type Result,
} from "@browser-bridge/protocol";
import { assertAllowedUrl } from "./policy.js";
import {
  collectTargets,
  inspectElement,
  resolveTarget,
  INTERACTIVE_SELECTOR,
  type RegisteredTarget,
} from "./refs.js";
import {
  glidePath,
  glideDelay,
  clickPause,
  clickPoint,
  wheelPath,
  wheelDelay,
  sleep,
  type Point,
} from "./motion.js";
import { snapshot } from "./observe.js";

const DIAG_CAP = 50;
const DIAG_ENTRY_CHARS = 500;
type MouseButton = "left" | "right" | "middle";

export interface TabDiagnostics {
  consoleErrors: string[];
  requestFailures: Array<{ url: string; error: string }>;
  badResponses: Array<{ url: string; status: number }>;
  downloads: DownloadRecord[];
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
  type:
    | "session-created"
    | "session-closed"
    | "tab-opened"
    | "tab-closed"
    | "tab-selected"
    | "navigated"
    | "action"
    | "waited"
    | "screenshot"
    | "downloaded"
    | "dialog"
    | "browser-died"
    | "viewport"
    | "paused"
    | "resumed"
    | "annotated";
  sessionId: string;
  tabId?: string;
  revision?: number;
  summary: string;
}

export const VIEWPORT_PRESETS = {
  mobile: { width: 390, height: 844 },
  tablet: { width: 820, height: 1180 },
  desktop: { width: 1440, height: 900 },
} as const;

export type ViewportPreset = keyof typeof VIEWPORT_PRESETS;

const EVENT_CAP = 500;
const ANNOTATION_CAP = 100;
const HISTORY_CAP = 10;
const OVERLAY_CAP = 100;
const UPLOAD_MAX_BYTES = 25_000_000;
const DEFAULT_ARTIFACT_TTL_MS = 7 * 24 * 60 * 60_000;

/** Windows-safe directory removal: scanners briefly lock new files. */
async function rmRetry(path: string, attempts = 5): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch {
      if (i === attempts - 1) return;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

/** Strip query/fragment from logged URLs (tokens hide in query strings). */
export function sanitizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return raw.slice(0, 300);
  }
}

/** Playwright action timeouts mean "present but not actionable", not a crash. */
async function actionable<T>(
  fn: () => Promise<T>,
  what: string,
  onTimeout?: () => Promise<string | undefined>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if ((err as { name?: string })?.name === "TimeoutError") {
      let detail = "";
      if (onTimeout) {
        const found = await onTimeout().catch(() => undefined);
        if (found) detail = ` — ${found}`;
      }
      throw Object.assign(
        new Error(`${what} did not become actionable in time${detail}`),
        {
          code: "TARGET_NOT_ACTIONABLE",
        },
      );
    }
    throw err;
  }
}

interface CoverReport {
  topRole: string;
  topName: string;
  scopeName: string;
  isDialog: boolean;
  buttons: string[];
}

export interface DownloadRecord {
  id: string;
  fileName: string;
  path: string;
  bytes: number;
}

export interface DialogRecord {
  type: string;
  message: string;
  dismissed: boolean;
  at: string;
}

interface TabState {
  id: string;
  page: Page;
  revision: number;
  targets: RegisteredTarget[];
  /** Refs issued by the latest observation only — older strings are stale. */
  issued: Map<string, number>;
  lastObservation: Observation | undefined;
  /** Bounded snapshots for delta mode (oldest first). */
  history: Observation[];
  diagnostics: TabDiagnostics;
  downloads: DownloadRecord[];
  lastDialog: DialogRecord | undefined;
  downloadWaiters: Array<() => void>;
  /** Last known cursor position for visible glides (headed sessions). */
  mouse: Point | undefined;
  /**
   * DevTools-style viewport override: page pinned to width/height while the
   * OS window stays put. The stored CDP session must clear it — overrides
   * are scoped to the session that set them, and Playwright's own
   * viewportSize()/screenshot() do not see them.
   */
  pinned: { width: number; height: number; cdp: CDPSession } | undefined;
}

interface SessionState {
  id: string;
  context: BrowserContext;
  /** Named persistent profile, if any (locked to this session). */
  profileName: string | undefined;
  /** Set when the browser died out from under the session (never auto-cleared). */
  browserDead: boolean;
  /** Set while closeSession/shutdown is tearing the session down. */
  closing: boolean;
  tabs: Map<string, TabState>;
  /** Selected tab for requests that omit tabId. Falls back to first tab. */
  currentTabId: string | undefined;
  queue: Promise<unknown>;
  /** Bumped by `cancel`; queued and in-flight wait work aborts on mismatch. */
  generation: number;
  seenRequests: Map<string, { at: number; result: Result }>;
  dir: string;
  /** Human-takeover lease. While paused, agent mutations are rejected. */
  paused: boolean;
  owner: "agent" | "human";
  ownerSince: string | undefined;
  pauseTimer: NodeJS.Timeout | undefined;
  annotations: Annotation[];
}

function cancelled(): Error {
  return Object.assign(new Error("Operation cancelled by session cancel"), {
    code: "CANCELLED",
  });
}

function postconditionTimeout(what: string): Error {
  return Object.assign(new Error(`Postcondition timed out: ${what}`), {
    code: "POSTCONDITION_TIMEOUT",
  });
}

/**
 * The human coordinate channel: viewport coordinates from a person looking
 * at the real browser (via the viewer), plus unfocused key presses.
 * Allowed while paused; everything else is agent traffic.
 */
function isHumanChannel(action: Action): boolean {
  if (
    action.type === "clickAt" ||
    action.type === "dragAt" ||
    action.type === "moveAt" ||
    action.type === "scrollAt" ||
    action.type === "type"
  )
    return true;
  return action.type === "press" && action.ref === undefined;
}

function codeOf(err: unknown): string {
  return (err as NodeJS.ErrnoException)?.code ?? "BROWSER_CRASHED";
}

export interface EngineOptions {
  artifactRoot?: string;
  headless?: boolean;
  /**
   * Glide the visible cursor along a path before clicks/hovers instead of
   * teleporting. Defaults on for headed sessions (someone is watching),
   * off headless. Adds ~0.2–0.5 s per click.
   */
  humanMotion?: boolean;
  /** Retained engine events per instance (default 500). */
  eventCap?: number;
  /** Root for named persistent profiles (default: OS tmpdir, never the repo). */
  profilesRoot?: string;
  /** Artifact retention for crash leftovers, ms (default 7 days). */
  artifactTtlMs?: number;
}

/** What shutdown cleaned: removed dirs plus failures for the retention sweep. */
export interface ShutdownReport {
  removed: string[];
  failed: Array<{ dir: string; error: string }>;
}

export class BrowserBridge {
  private browser: Browser | undefined;
  private sessions = new Map<string, SessionState>();
  private readonly artifactRoot: string;
  private readonly headless: boolean;
  private readonly humanMotion: boolean;
  private readonly eventCap: number;
  private readonly profilesRoot: string;
  private readonly artifactTtlMs: number;
  private eventSeq = 0;
  private eventLog: EngineEvent[] = [];
  private eventListeners = new Set<(event: EngineEvent) => void>();

  constructor(opts: EngineOptions = {}) {
    this.artifactRoot = opts.artifactRoot ?? join(process.cwd(), "artifacts");
    this.headless = opts.headless ?? true;
    this.humanMotion = opts.humanMotion ?? !this.headless;
    this.eventCap = opts.eventCap ?? EVENT_CAP;
    this.profilesRoot =
      opts.profilesRoot ?? join(tmpdir(), "browser-bridge-profiles");
    this.artifactTtlMs = opts.artifactTtlMs ?? DEFAULT_ARTIFACT_TTL_MS;
  }

  journalPath(): string {
    return join(this.artifactRoot, "journal.jsonl");
  }

  private emit(
    type: EngineEvent["type"],
    sessionId: string,
    summary: string,
    extra: { tabId?: string; revision?: number } = {},
  ): void {
    this.eventSeq += 1;
    const event: EngineEvent = {
      seq: this.eventSeq,
      at: new Date().toISOString(),
      type,
      sessionId,
      summary,
      ...(extra.tabId !== undefined ? { tabId: extra.tabId } : {}),
      ...(extra.revision !== undefined ? { revision: extra.revision } : {}),
    };
    this.eventLog.push(event);
    while (this.eventLog.length > this.eventCap) this.eventLog.shift();
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch {
        // A slow viewer must never break the engine.
      }
    }
  }

  /** Replay retained events after a cursor; gap reports dropped history. */
  eventsSince(cursor: number): {
    events: EngineEvent[];
    gap: boolean;
    next: number;
  } {
    const at = Math.max(0, Math.floor(cursor));
    const events = this.eventLog.filter((e) => e.seq > at);
    const first = events[0] as EngineEvent | undefined;
    // Gap only when retained history resumes after the cursor (overflow).
    // An empty replay means the cursor is at/past the head: nothing missed.
    const gap = first !== undefined && first.seq > at + 1;
    return { events, gap, next: this.eventSeq };
  }

  subscribe(listener: (event: EngineEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  async launch(): Promise<void> {
    if (this.browser?.isConnected() === true) return;
    this.browser = undefined;
    await mkdir(this.artifactRoot, { recursive: true }).catch(() => undefined);
    await this.sweepArtifacts();
    // Normal OS rendering scale (no --force-device-scale-factor): the audit
    // window stays comfortable to watch. Follow-mode viewport ops measure
    // and fit the OS window explicitly (fitWindowToViewport), and all page
    // geometry stays in CSS pixels, so scaling never clips content.
    this.browser = await chromium.launch({ headless: this.headless });
    const launched = this.browser;
    launched.on("disconnected", () => {
      if (this.browser === launched && !launched.isConnected()) {
        this.browser = undefined;
        this.markBrowserDead();
      }
    });
  }

  /** The shared browser died: sessions keep identity but report the crash. */
  private markBrowserDead(): void {
    for (const session of this.sessions.values()) {
      if (
        session.profileName !== undefined ||
        session.closing ||
        session.browserDead
      )
        continue;
      session.browserDead = true;
      this.emit(
        "browser-died",
        session.id,
        `browser died unexpectedly; create a new session`,
      );
    }
  }

  /** Retention: remove crash-leftover session dirs older than the TTL. */
  private async sweepArtifacts(): Promise<void> {
    const cutoff = Date.now() - this.artifactTtlMs;
    let entries: string[] = [];
    try {
      entries = await readdir(this.artifactRoot);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.startsWith("s-")) continue;
      try {
        const full = join(this.artifactRoot, entry);
        const st = await stat(full);
        if (st.isDirectory() && st.mtimeMs < cutoff) {
          await rm(full, { recursive: true, force: true });
        }
      } catch {
        // Already gone.
      }
    }
  }

  /** Shut everything down; reports which session directories were removed. */
  async shutdown(): Promise<ShutdownReport> {
    const removed: string[] = [];
    const failed: Array<{ dir: string; error: string }> = [];
    for (const s of this.sessions.values()) {
      s.closing = true;
      if (s.pauseTimer !== undefined) clearTimeout(s.pauseTimer);
      await s.context.close().catch(() => undefined);
      if (s.profileName !== undefined)
        await this.releaseProfile(s.profileName).catch(() => undefined);
      try {
        await rmRetry(s.dir);
        removed.push(s.dir);
      } catch (err) {
        failed.push({ dir: s.dir, error: String(err).slice(0, 300) });
      }
    }
    this.sessions.clear();
    await this.browser?.close().catch(() => undefined);
    this.browser = undefined;
    return { removed, failed };
  }

  capabilities() {
    return getCapabilities();
  }

  sessionCount(): number {
    return this.sessions.size;
  }

  /** Ownership + takeover state for viewers and agents. */
  sessionState(sessionId: string): {
    id: string;
    paused: boolean;
    owner: "agent" | "human";
    ownerSince?: string;
    annotationCount: number;
  } {
    const session = this.requireSession(sessionId);
    return {
      id: session.id,
      paused: session.paused,
      owner: session.owner,
      ...(session.ownerSince !== undefined
        ? { ownerSince: session.ownerSince }
        : {}),
      annotationCount: session.annotations.length,
    };
  }

  /** Agent mutations are rejected while a human holds the session. */
  private assertAgentAllowed(session: SessionState, what: string): void {
    if (session.paused) {
      throw Object.assign(
        new Error(
          `Session ${session.id} is paused for human takeover; ${what} rejected. Wait for resume, then re-observe.`,
        ),
        { code: "SESSION_PAUSED" },
      );
    }
  }

  /** Read-only inventory for discovery surfaces (MCP resources, viewer). */
  inventory(): Array<{
    sessionId: string;
    tabs: Array<{ tabId: string; url: string; current: boolean }>;
  }> {
    return [...this.sessions.values()].map((session) => ({
      sessionId: session.id,
      tabs: [...session.tabs.values()].map((tab) => ({
        tabId: tab.id,
        url: tab.page.url(),
        current: tab.id === session.currentTabId,
      })),
    }));
  }

  /** Latest observation without forcing a refresh (pure read for resources). */
  peekObservation(sessionId: string, tabId?: string): Observation | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    if (tabId) return session.tabs.get(tabId)?.lastObservation;
    if (session.currentTabId) {
      const current = session.tabs.get(session.currentTabId)?.lastObservation;
      if (current) return current;
    }
    return session.tabs.values().next().value?.lastObservation;
  }

  /**
   * Resolve a screenshot artifact to bytes on disk. Returns undefined unless
   * the session exists, the id matches the expected shape, and the path
   * stays inside the session's owned directory.
   */
  async artifactBytes(
    sessionId: string,
    artifactId: string,
  ): Promise<Buffer | undefined> {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    if (!/^shot-[A-Za-z0-9_-]+$/.test(artifactId)) return undefined;
    const full = normalize(join(session.dir, `${artifactId}.png`));
    if (!full.startsWith(normalize(session.dir + sep))) return undefined;
    const { readFile } = await import("node:fs/promises");
    return readFile(full).catch(() => undefined);
  }

  private profileDir(name: string): string {
    return normalize(join(this.profilesRoot, name));
  }

  /**
   * Lock a named persistent profile to this worker. The lock file carries
   * our pid; a live holder rejects newcomers, a dead one is replaceable.
   */
  private async acquireProfile(name: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
      throw Object.assign(new Error(`Invalid profile name ${name}`), {
        code: "INVALID_REQUEST",
      });
    }
    const dir = this.profileDir(name);
    if (!dir.startsWith(normalize(this.profilesRoot + sep))) {
      throw Object.assign(new Error("Profile path escape"), {
        code: "POLICY_DENIED",
      });
    }
    await mkdir(dir, { recursive: true });
    const lock = join(dir, "lock.json");
    const claim = async (): Promise<void> => {
      await writeFile(
        lock,
        JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
        { flag: "wx" },
      );
    };
    try {
      await claim();
      return;
    } catch {
      // Lock exists: live holder wins, stale lock is replaceable.
    }
    let holder = 0;
    try {
      holder = (JSON.parse(await readFile(lock, "utf8")) as { pid?: unknown })
        .pid as number;
    } catch {
      holder = 0;
    }
    let alive = false;
    if (typeof holder === "number" && holder > 0) {
      try {
        process.kill(holder, 0);
        alive = true;
      } catch {
        alive = false;
      }
    }
    if (alive) {
      throw Object.assign(
        new Error(`Profile ${name} is locked by live process ${holder}`),
        { code: "POLICY_DENIED" },
      );
    }
    await rm(lock, { force: true });
    try {
      await claim();
    } catch {
      throw Object.assign(
        new Error(`Profile ${name} is locked by another worker`),
        { code: "POLICY_DENIED" },
      );
    }
  }

  private async releaseProfile(name: string): Promise<void> {
    await rm(join(this.profileDir(name), "lock.json"), { force: true }).catch(
      () => undefined,
    );
  }

  async createSession(
    opts: { profile?: string } = {},
  ): Promise<{ sessionId: string; tabId: string }> {
    await this.launch();
    const id = `s-${randomUUID().slice(0, 8)}`;
    const dir = normalize(join(this.artifactRoot, id));
    if (
      !dir.startsWith(normalize(this.artifactRoot + sep)) &&
      dir !== normalize(this.artifactRoot)
    ) {
      throw Object.assign(new Error("Artifact path escape"), {
        code: "POLICY_DENIED",
      });
    }
    await mkdir(dir, { recursive: true });
    let context: BrowserContext;
    let profileName: string | undefined;
    try {
      if (opts.profile !== undefined) {
        await this.acquireProfile(opts.profile);
        profileName = opts.profile;
        try {
          context = await chromium.launchPersistentContext(
            this.profileDir(opts.profile),
            {
              headless: this.headless,
              // Headed gets a free window (viewport null, OS scale intact);
              // `viewport` pins an exact size on demand. Headless keeps
              // Playwright's fixed default viewport.
              ...(this.headless ? {} : { viewport: null }),
            },
          );
        } catch (err) {
          await this.releaseProfile(opts.profile);
          profileName = undefined;
          throw err;
        }
      } else {
        const browser = this.browser as Browser;
        // Headed: no emulated viewport, so the page fills the window and
        // follows OS window drags like a normal browser. `viewport` pins
        // an exact size on demand. Headless keeps the fixed default.
        context = await browser.newContext(
          this.headless ? {} : { viewport: null },
        );
      }
    } catch (err) {
      await rmRetry(dir).catch(() => undefined);
      throw err;
    }
    const session: SessionState = {
      id,
      context,
      profileName,
      browserDead: false,
      closing: false,
      tabs: new Map(),
      currentTabId: undefined,
      queue: Promise.resolve(),
      generation: 0,
      seenRequests: new Map(),
      dir,
      paused: false,
      owner: "agent",
      ownerSince: undefined,
      pauseTimer: undefined,
      annotations: [],
    };
    // Popups open new pages in the context; adopt them as tabs instead of
    // leaking untracked pages (register listeners BEFORE any navigation).
    // Deferred: createTab registers its own page synchronously, so anything
    // still orphaned after a beat is a genuine popup.
    context.on("page", (page) => {
      const timer = setTimeout(() => {
        void (async () => {
          if (page.isClosed()) return;
          if (!this.sessions.has(id)) return;
          if ([...session.tabs.values()].some((t) => t.page === page)) return;
          try {
            const tab = await this.adoptPage(session, page);
            this.emit(
              "tab-opened",
              session.id,
              `tab ${tab.id} opened by popup → ${page.url()}`,
              { tabId: tab.id },
            );
          } catch {
            // Context is closing; nothing to adopt.
          }
        })();
      }, 250);
      timer.unref?.();
    });
    // A dying context marks its session; clean shutdowns set closing first.
    context.on("close", () => {
      if (session.closing || session.browserDead) return;
      session.browserDead = true;
      this.emit(
        "browser-died",
        session.id,
        `browser died unexpectedly; create a new session`,
      );
    });
    this.sessions.set(id, session);
    try {
      const existing = context.pages();
      let tab: TabState;
      if (profileName !== undefined && existing.length > 0) {
        // Persistent contexts may already hold pages (e.g. restored tabs).
        tab = await this.adoptPage(session, existing[0] as Page);
      } else {
        tab = await this.createTab(session);
      }
      session.currentTabId = tab.id;
    } catch (err) {
      this.sessions.delete(id);
      await context.close().catch(() => undefined);
      if (profileName !== undefined)
        await this.releaseProfile(profileName).catch(() => undefined);
      await rmRetry(dir).catch(() => undefined);
      throw err;
    }
    this.emit(
      "session-created",
      id,
      `session ${id} created${profileName ? ` (profile ${profileName})` : ""}`,
      {
        tabId: session.currentTabId as string,
      },
    );
    return { sessionId: id, tabId: session.currentTabId as string };
  }

  /** Register an externally arrived page (popup, restored tab) as a tab. */
  private async adoptPage(
    session: SessionState,
    page: Page,
  ): Promise<TabState> {
    const tab: TabState = {
      id: `t-${randomUUID().slice(0, 8)}`,
      page,
      revision: 0,
      targets: [],
      issued: new Map(),
      lastObservation: undefined,
      history: [],
      diagnostics: {
        consoleErrors: [],
        requestFailures: [],
        badResponses: [],
        downloads: [],
      },
      downloads: [],
      lastDialog: undefined,
      downloadWaiters: [],
      mouse: undefined,
      pinned: undefined,
    };
    this.attachTabListeners(session, tab);
    session.tabs.set(tab.id, tab);
    return tab;
  }

  private pushCapped<T>(arr: T[], item: T): void {
    arr.push(item);
    while (arr.length > DIAG_CAP) arr.shift();
  }

  private trunc(s: string): string {
    return s.length > DIAG_ENTRY_CHARS ? s.slice(0, DIAG_ENTRY_CHARS) : s;
  }

  /**
   * Error watch: snapshot markers so a mutating op reports only the page
   * errors IT caused (console errors, failed requests, bad responses).
   * Agents fire actions and move on — without this, a click that breaks
   * page JS returns a happy observation and the error is invisible unless
   * someone remembers to run `diagnostics`. The watch appends the new
   * errors to the result warnings (`!` lines), capped so output stays
   * small; `diagnostics` still shows the full history on demand.
   */
  private markDiagnostics(tab: TabState): {
    consoleErr: string | undefined;
    reqFail: { url: string; error: string } | undefined;
    badResp: { url: string; status: number } | undefined;
  } {
    const lastOf = <T>(arr: T[]): T | undefined =>
      arr.length > 0 ? arr[arr.length - 1] : undefined;
    return {
      consoleErr: lastOf(tab.diagnostics.consoleErrors),
      reqFail: lastOf(tab.diagnostics.requestFailures),
      badResp: lastOf(tab.diagnostics.badResponses),
    };
  }

  private newErrorWarnings(
    tab: TabState,
    marks: {
      consoleErr: string | undefined;
      reqFail: { url: string; error: string } | undefined;
      badResp: { url: string; status: number } | undefined;
    },
  ): string[] {
    // Entries since the mark (identity-based: caps shift, lengths lie).
    // An evicted mark means >50 errors mid-action: report the tail only.
    const freshOf = <T>(arr: T[], mark: T | undefined): T[] => {
      if (mark === undefined) return [...arr];
      const at = arr.indexOf(mark);
      return at >= 0 ? arr.slice(at + 1) : arr.slice(-2);
    };
    const lines: string[] = [];
    let overflow = 0;
    const push = (line: string): void => {
      if (lines.length < 5) lines.push(line);
      else overflow += 1;
    };
    for (const msg of freshOf(
      tab.diagnostics.consoleErrors,
      marks.consoleErr,
    )) {
      push(`page console error: ${msg.slice(0, 200)}`);
    }
    for (const f of freshOf(tab.diagnostics.requestFailures, marks.reqFail)) {
      push(
        `page request failed: ${f.url.slice(0, 200)} (${f.error.slice(0, 100)})`,
      );
    }
    for (const b of freshOf(tab.diagnostics.badResponses, marks.badResp)) {
      push(`page HTTP ${b.status}: ${b.url.slice(0, 200)}`);
    }
    if (overflow > 0)
      lines.push(`(+${overflow} more new page errors — see diagnostics)`);
    return lines;
  }

  private async createTab(session: SessionState): Promise<TabState> {
    const page = await session.context.newPage();
    const tab: TabState = {
      id: `t-${randomUUID().slice(0, 8)}`,
      page,
      revision: 0,
      targets: [],
      issued: new Map(),
      lastObservation: undefined,
      history: [],
      diagnostics: {
        consoleErrors: [],
        requestFailures: [],
        badResponses: [],
        downloads: [],
      },
      downloads: [],
      lastDialog: undefined,
      downloadWaiters: [],
      mouse: undefined,
      pinned: undefined,
    };
    this.attachTabListeners(session, tab);
    session.tabs.set(tab.id, tab);
    return tab;
  }

  /**
   * Diagnostics, downloads, dialogs, and page-close tracking. Attached to
   * every page — created or adopted — before any navigation (§4, §6).
   */
  private attachTabListeners(session: SessionState, tab: TabState): void {
    const page = tab.page;
    // Bounded diagnostic listeners, attached before any navigation (§4).
    page.on("console", (msg) => {
      if (msg.type() === "error")
        this.pushCapped(tab.diagnostics.consoleErrors, this.trunc(msg.text()));
    });
    page.on("pageerror", (err) => {
      this.pushCapped(tab.diagnostics.consoleErrors, this.trunc(String(err)));
    });
    page.on("requestfailed", (req) => {
      this.pushCapped(tab.diagnostics.requestFailures, {
        url: this.trunc(sanitizeUrl(req.url())),
        error: this.trunc(req.failure()?.errorText ?? "failed"),
      });
    });
    page.on("response", (res) => {
      const status = res.status();
      if (status >= 400) {
        this.pushCapped(tab.diagnostics.badResponses, {
          url: this.trunc(sanitizeUrl(res.url())),
          status,
        });
      }
    });
    // Downloads land in the session artifact area, never the OS default.
    page.on("download", (download) => {
      void (async () => {
        try {
          const id = `dl-${randomUUID().slice(0, 8)}`;
          const suggested =
            download
              .suggestedFilename()
              .replace(/[^A-Za-z0-9._-]+/g, "_")
              .slice(0, 100) || "download";
          const file = normalize(join(session.dir, `${id}-${suggested}`));
          if (!file.startsWith(normalize(session.dir + sep))) return;
          await download.saveAs(file);
          const st = await stat(file).catch(() => undefined);
          const record = {
            id,
            fileName: suggested,
            path: file,
            bytes: st?.size ?? 0,
          };
          tab.downloads.push(record);
          this.pushCapped(tab.diagnostics.downloads, record);
          for (const waiter of tab.downloadWaiters.splice(0)) {
            try {
              waiter();
            } catch {
              // Listener already gone.
            }
          }
          this.emit("downloaded", session.id, `download ${suggested}`, {
            tabId: tab.id,
            revision: tab.revision,
          });
        } catch {
          // Tab may be closing; the download is simply lost with it.
        }
      })();
    });
    // Dialogs auto-dismiss so an unhandled dialog can never deadlock a
    // session; the content is recorded for diagnostics instead.
    page.on("dialog", (dialog) => {
      void (async () => {
        try {
          tab.lastDialog = {
            type: dialog.type(),
            message: dialog.message().slice(0, 500),
            dismissed: true,
            at: new Date().toISOString(),
          };
          await dialog.dismiss();
          this.emit(
            "dialog",
            session.id,
            `${dialog.type()} dismissed: ${dialog.message().slice(0, 120)}`,
            {
              tabId: tab.id,
              revision: tab.revision,
            },
          );
        } catch {
          // Already handled.
        }
      })();
    });
    // Pages closed by the site (popups calling window.close) leave the registry.
    // When the whole browser died, the registry stays: ops must report
    // BROWSER_CRASHED with session identity, not TAB_NOT_FOUND.
    page.on("close", () => {
      try {
        if (session.context.browser()?.isConnected() === false) return;
      } catch {
        return;
      }
      if (session.tabs.get(tab.id) === tab) {
        session.tabs.delete(tab.id);
        if (session.currentTabId === tab.id) session.currentTabId = undefined;
        this.emit(
          "tab-closed",
          session.id,
          `tab ${tab.id} closed by the page`,
          { tabId: tab.id },
        );
      }
    });
  }

  private requireSession(sessionId: string): SessionState {
    const s = this.sessions.get(sessionId);
    if (!s)
      throw Object.assign(new Error(`Session ${sessionId} not found`), {
        code: "SESSION_NOT_FOUND",
      });
    return s;
  }

  private requireTab(
    session: SessionState,
    tabId: string | undefined,
  ): TabState {
    const lookup = (id: string | undefined): TabState | undefined => {
      if (id) return session.tabs.get(id);
      if (session.currentTabId) {
        const current = session.tabs.get(session.currentTabId);
        if (current) return current;
      }
      const first = session.tabs.values().next();
      return (first.done ? undefined : first.value) as TabState | undefined;
    };
    const tab = lookup(tabId);
    if (tab) return tab;
    if (tabId) {
      if (session.browserDead) return this.deadSession(session);
      throw Object.assign(new Error(`Tab ${tabId} not found`), {
        code: "TAB_NOT_FOUND",
      });
    }
    if (session.browserDead) return this.deadSession(session);
    throw Object.assign(new Error("No tabs in session"), {
      code: "TAB_NOT_FOUND",
    });
  }

  private deadSession(session: SessionState): never {
    throw Object.assign(
      new Error(
        `The browser for session ${session.id} died unexpectedly. In-flight actions have unknown outcomes — verify externally. Create a new session to continue.`,
      ),
      { code: "BROWSER_CRASHED" },
    );
  }

  /**
   * Per-session serialization (§6). Queued work records the generation at
   * enqueue time and refuses to start after a `cancel` bumped it.
   * Takeover gating lives in the public methods (assertAgentAllowed), so
   * reads stay available while a human holds the session.
   */
  private enqueue<T>(session: SessionState, fn: () => Promise<T>): Promise<T> {
    const seenGeneration = session.generation;
    const run = (session.queue as Promise<unknown>).then(
      async () => {
        if (session.generation !== seenGeneration) throw cancelled();
        return fn();
      },
      async () => {
        if (session.generation !== seenGeneration) throw cancelled();
        return fn();
      },
    );
    session.queue = run.catch(() => undefined);
    return run;
  }

  private dedupe(session: SessionState, requestId: string): Result | undefined {
    const hit = session.seenRequests.get(requestId);
    if (!hit) return undefined;
    if (Date.now() - hit.at > 5 * 60_000) {
      session.seenRequests.delete(requestId);
      return undefined;
    }
    return hit.result;
  }

  private remember(
    session: SessionState,
    requestId: string,
    result: Result,
  ): void {
    session.seenRequests.set(requestId, { at: Date.now(), result });
    if (session.seenRequests.size > 200) {
      const oldest = session.seenRequests.keys().next();
      if (!oldest.done) session.seenRequests.delete(oldest.value);
    }
  }

  private async refresh(tab: TabState): Promise<Observation> {
    tab.revision += 1;
    const caps = getCapabilities();
    const collected = await collectTargets(
      tab.page,
      caps.limits.maxControls,
      tab.revision,
    );
    tab.targets = collected.targets;
    // Refs belong to one observation (plan §5): a new revision retires
    // every previously issued string, even positionally identical ones.
    tab.issued = new Map(collected.targets.map((t) => [t.ref, tab.revision]));
    const snap = await snapshot(tab.page, tab.revision, collected);
    tab.lastObservation = snap.observation;
    tab.history.push(snap.observation);
    while (tab.history.length > HISTORY_CAP) tab.history.shift();
    // Fresh documents wipe the injected ring: repaint on every observation
    // so the audit cursor is there from the first paint, not the first glide.
    if (!this.headless) {
      const area = await this.viewportArea(tab);
      const at = tab.mouse ?? { x: area.width / 2, y: area.height / 2 };
      await this.paintCursor(tab, at.x, at.y, false);
    }
    return tab.lastObservation;
  }

  /**
   * Resolve a ref against the CURRENT observation only, then revalidate it
   * against the live page (unique, actionable). Anything older is stale —
   * use the refs from the latest result instead.
   */
  private async resolveRef(
    tab: TabState,
    ref: string,
  ): Promise<{ locator: Locator; target: RegisteredTarget }> {
    if (tab.issued.get(ref) !== tab.revision) {
      throw Object.assign(
        new Error(
          `Stale ref ${ref}: the tab is at r${tab.revision}. Re-observe and use a current ref.`,
        ),
        { code: "STALE_OBSERVATION" },
      );
    }
    return resolveTarget(tab.page, tab.targets, ref);
  }

  /**
   * Hit-test diagnosis for actionability timeouts: name whatever sits on
   * top of the target point (modal walls, cookie banners, sticky chrome)
   * and offer current-observation refs for its buttons. Works off geometry,
   * not markup conventions, so role-less overlays are caught too. Runs only
   * on the failure path — zero happy-path cost.
   */
  private async describeCover(
    tab: TabState,
    x: number,
    y: number,
    expectedRole?: string,
    expectedName?: string,
  ): Promise<string | undefined> {
    const norm = (s: string): string =>
      s.toLowerCase().trim().replace(/\s+/g, " ");
    let report: CoverReport | null;
    try {
      report = await tab.page.evaluate(
        (pt: { x: number; y: number }): CoverReport | null => {
          const clean = (s: string): string =>
            s.trim().replace(/\s+/g, " ").slice(0, 80);
          const labelOf = (node: Element): string => {
            const e = node as HTMLElement;
            const aria = e.getAttribute("aria-label");
            if (aria) return aria;
            const value = (e as HTMLInputElement).value;
            if (typeof value === "string" && value) return value;
            try {
              return e.innerText ?? "";
            } catch {
              return e.textContent ?? "";
            }
          };
          const stack = document
            .elementsFromPoint(pt.x, pt.y)
            .filter(
              (el) =>
                el.id !== "bb-audit-cursor" &&
                !el.closest?.("#bb-audit-cursor"),
            );
          const top = stack[0];
          if (!top || top === document.documentElement || top === document.body)
            return null;
          const dialog = top.closest(
            'dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]',
          );
          const scope = dialog ?? top.parentElement ?? top;
          let dialogName = "";
          if (dialog) {
            const heading = dialog.querySelector(
              "h1, h2, h3, [role='heading']",
            );
            const ht = heading?.textContent?.trim() ?? "";
            dialogName = clean(ht || labelOf(dialog));
          }
          const buttons: string[] = [];
          const candidates = Array.from(
            scope.querySelectorAll('button, a, [role="button"]'),
          );
          for (const b of candidates) {
            const t = clean(labelOf(b) || b.textContent || "");
            if (t.length >= 2 && !buttons.includes(t)) buttons.push(t);
            if (buttons.length >= 8) break;
          }
          const topEl = top as HTMLElement;
          return {
            topRole: topEl.getAttribute("role") ?? topEl.tagName.toLowerCase(),
            topName: clean(labelOf(top) || top.textContent || ""),
            scopeName: dialog ? dialogName : "",
            isDialog: dialog !== null,
            buttons,
          };
        },
        { x, y },
      );
    } catch {
      return undefined;
    }
    if (!report) return undefined;
    if (
      expectedRole !== undefined &&
      expectedName !== undefined &&
      norm(report.topRole) === norm(expectedRole) &&
      norm(report.topName) === norm(expectedName)
    ) {
      return undefined; // topmost is (probably) the target itself
    }
    // Map overlay buttons to current-observation refs for one-step dismissal.
    // Best-effort ranking: real buttons beat links, exact names beat partial,
    // and classic dismiss words win ties. Failures just yield fewer refs.
    const dismissWord = (s: string): boolean =>
      /reject|accept|dismiss|close|agree|consent|not now|^ok$|got it|allow|deny/.test(
        s,
      );
    const ranked: Array<{ ref: string; name: string; score: number }> = [];
    for (const text of report.buttons) {
      const bn = norm(text);
      for (const t of tab.targets) {
        if (t.role !== "button" && t.role !== "link") continue;
        if (tab.issued.get(t.ref) !== tab.revision) continue;
        const tn = norm(t.name);
        if (tn.length < 2) continue;
        const exact = tn === bn;
        const partial = tn.includes(bn) || bn.includes(tn);
        if (!exact && (!partial || bn.length < 3)) continue;
        ranked.push({
          ref: t.ref,
          name: t.name,
          score:
            (t.role === "button" ? 2 : 0) +
            (exact ? 2 : 0) +
            (dismissWord(tn) ? 2 : 0),
        });
      }
    }
    ranked.sort((a, b) => b.score - a.score);
    const dismiss: string[] = [];
    for (const r of ranked) {
      if (!dismiss.some((d) => d.includes(r.ref)))
        dismiss.push(`${r.ref} (${r.name.slice(0, 40)})`);
      if (dismiss.length >= 3) break;
    }
    const what = report.isDialog
      ? `dialog "${report.scopeName || report.topName || "untitled"}"`
      : `<${report.topRole}> "${report.topName || "unnamed"}"`;
    return (
      `likely covered by ${what}` +
      (dismiss.length > 0 ? ` — dismiss with ${dismiss.join(", ")}` : "")
    );
  }

  /**
   * Glide the visible cursor to a viewport point (headed sessions only).
   * Records the landing position so the next move starts where this one
   * ended — one continuous hand, not teleports.
   */
  private async glideTo(tab: TabState, to: Point): Promise<void> {
    const area = await this.viewportArea(tab);
    const clamp = (point: Point): Point => ({
      x: Math.min(area.width - 1, Math.max(0, point.x)),
      y: Math.min(area.height - 1, Math.max(0, point.y)),
    });
    const landing = clamp(to);
    const from = clamp(tab.mouse ?? { x: area.width / 2, y: area.height / 2 });
    tab.mouse = landing;
    if (!this.humanMotion) {
      await tab.page.mouse.move(landing.x, landing.y);
      await this.paintCursor(tab, landing.x, landing.y, false);
      return;
    }
    for (const raw of glidePath(from, landing)) {
      const point = clamp(raw);
      await tab.page.mouse.move(point.x, point.y);
      await this.paintCursor(tab, point.x, point.y, false);
      await sleep(glideDelay());
    }
    await this.paintCursor(tab, landing.x, landing.y, false);
  }

  /**
   * Audit cursor: a visible ring in headed windows so a watcher can follow
   * the agent's hand. Playwright drives the page with synthetic input that
   * never moves the OS pointer, so without this the watcher sees effects
   * with no visible cause. Plain unmarked div: invisible to control
   * collection (role-based) and page text (empty). Never fails an action.
   */
  private async paintCursor(
    tab: TabState,
    x: number,
    y: number,
    pulse: boolean,
  ): Promise<void> {
    if (this.headless) return;
    await tab.page
      .evaluate(
        (pos: { x: number; y: number; pulse: boolean }) => {
          const ID = "bb-audit-cursor";
          let el = document.getElementById(ID);
          if (!el) {
            el = document.createElement("div");
            el.id = ID;
            el.setAttribute("aria-hidden", "true");
            const s = el.style;
            s.position = "fixed";
            s.left = "0";
            s.top = "0";
            s.width = "22px";
            s.height = "22px";
            s.margin = "-11px 0 0 -11px";
            s.border = "2px solid #e11d48";
            s.borderRadius = "50%";
            s.boxShadow =
              "0 0 0 2px rgba(255,255,255,.9), 0 0 8px rgba(0,0,0,.5)";
            s.zIndex = "2147483647";
            s.pointerEvents = "none";
            const dot = document.createElement("div");
            const d = dot.style;
            d.position = "absolute";
            d.left = "50%";
            d.top = "50%";
            d.width = "4px";
            d.height = "4px";
            d.margin = "-2px 0 0 -2px";
            d.borderRadius = "50%";
            d.background = "#e11d48";
            el.appendChild(dot);
            document.documentElement.appendChild(el);
          }
          const placed = `translate(${Math.round(pos.x)}px, ${Math.round(pos.y)}px)`;
          el.style.transform = placed;
          if (pos.pulse && typeof el.animate === "function") {
            el.animate(
              [
                { transform: `${placed} scale(1)`, opacity: "1" },
                { transform: `${placed} scale(1.9)`, opacity: "0.35" },
              ],
              { duration: 300 },
            );
          }
        },
        { x, y, pulse },
      )
      .catch(() => undefined);
  }

  /** Pulse the audit cursor where the last click landed. */
  private async clickPulse(tab: TabState): Promise<void> {
    if (tab.mouse) await this.paintCursor(tab, tab.mouse.x, tab.mouse.y, true);
  }

  /**
   * Cookie-wall sweep after navigation. Policy: reject tracking, never
   * accept it. Finds a consent container (dialog semantics or cookie-ish
   * identity) whose text is about cookies/consent, clicks its most
   * reject-like button once, and verifies the wall left. Returns a warning
   * line for transparency, or undefined when no wall was found. One pass —
   * walls that need a human choice are reported, not fought.
   */
  private async sweepCookieWall(tab: TabState): Promise<string | undefined> {
    const norm = (s: string): string =>
      s.toLowerCase().trim().replace(/\s+/g, " ");
    const found = await this.findCookieWall(tab);
    if (!found) return undefined;
    if (found.acceptOnly) {
      return `A cookie consent wall ("${found.desc}") only offers Accept; left untouched — this tool never accepts tracking`;
    }
    // Collect controls so the wall button maps to a current ref.
    await this.refresh(tab);
    const target = tab.targets.find(
      (t) =>
        t.role === "button" &&
        tab.issued.get(t.ref) === tab.revision &&
        (norm(t.name) === norm(found.button) ||
          norm(t.name).includes(norm(found.button))),
    );
    if (!target) {
      return `A cookie consent wall ("${found.desc}") is showing; it needs a human choice`;
    }
    try {
      const { locator } = await this.resolveRef(tab, target.ref);
      await locator.click({ timeout: 5000 });
    } catch {
      return `A cookie consent wall ("${found.desc}") is still showing; it needs a human choice`;
    }
    await tab.page.waitForTimeout(800).catch(() => undefined);
    const again = await this.findCookieWall(tab);
    if (again) {
      return `A cookie consent wall ("${found.desc}") is still showing after rejecting; it needs a human choice`;
    }
    return `Cookie consent wall dismissed (clicked "${target.name}"); tracking rejected, never accepted`;
  }

  /**
   * Late-wall escape hatch for actions: when a click/fill/etc fails because
   * a cookie wall rendered after navigation, reject it once and let the
   * caller retry the action a single time. Returns true when a wall was
   * actually cleared. Never accepts tracking.
   */
  private async clearWallForAction(tab: TabState): Promise<boolean> {
    const norm = (s: string): string =>
      s.toLowerCase().trim().replace(/\s+/g, " ");
    const found = await this.findCookieWall(tab);
    if (!found || found.acceptOnly) return false;
    await this.refresh(tab);
    const target = tab.targets.find(
      (t) =>
        t.role === "button" &&
        tab.issued.get(t.ref) === tab.revision &&
        (norm(t.name) === norm(found.button) ||
          norm(t.name).includes(norm(found.button))),
    );
    if (!target) return false;
    try {
      const { locator } = await this.resolveRef(tab, target.ref);
      await locator.click({ timeout: 5000 });
    } catch {
      return false;
    }
    await tab.page.waitForTimeout(800).catch(() => undefined);
    return (await this.findCookieWall(tab)) === null;
  }

  /**
   * Run an action, and when it fails as not-actionable behind a late
   * cookie wall, reject the wall once and retry the action a single time.
   */
  private async actWithWallRetry<T>(
    tab: TabState,
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code !== "TARGET_NOT_ACTIONABLE") throw err;
      if (!(await this.clearWallForAction(tab))) throw err;
      return await fn();
    }
  }

  /** Locate a rejectable cookie-consent wall, if one is showing. */
  private async findCookieWall(
    tab: TabState,
  ): Promise<{ desc: string; button: string; acceptOnly: boolean } | null> {
    type Wall = { desc: string; button: string; acceptOnly: boolean } | null;
    try {
      return await tab.page.evaluate((): Wall => {
        const clean = (s: string): string =>
          s.trim().replace(/\s+/g, " ").slice(0, 60);
        const labelOf = (node: Element): string => {
          const e = node as HTMLElement;
          const aria = e.getAttribute("aria-label");
          if (aria) return aria;
          try {
            return e.innerText ?? "";
          } catch {
            return e.textContent ?? "";
          }
        };
        const cookieText =
          /cook|consent|tracking|gdpr|data protection|privacy polic/i;
        const strongReject =
          /reject all|^reject|decline all|^decline|deny all|^deny/i;
        const softReject =
          /necessary only|essentials? only|essential cookies|save (choices|preferences|settings)|customi|manage (choices|preferences|settings|options)/i;
        const seen = new Set<Element>();
        const containers: Element[] = [];
        for (const el of Array.from(
          document.querySelectorAll(
            'dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"], [id*="cookie" i], [id*="consent" i], [class*="cookie" i], [class*="consent" i]',
          ),
        )) {
          if (seen.has(el)) continue;
          seen.add(el);
          const r = el.getBoundingClientRect();
          if (r.width < 120 || r.height < 40) continue;
          if (!cookieText.test(labelOf(el))) continue;
          containers.push(el);
        }
        for (const scope of containers) {
          const buttons = Array.from(
            scope.querySelectorAll('button, a, [role="button"]'),
          ).filter((b) => {
            const r = b.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });
          const names = buttons.map((b) => clean(labelOf(b)));
          const pick =
            names.find((t) => strongReject.test(t)) ??
            names.find((t) => softReject.test(t));
          const desc =
            clean(scope.querySelector("h1, h2, h3")?.textContent ?? "") ||
            clean(labelOf(scope)).slice(0, 60);
          if (pick) return { desc, button: pick, acceptOnly: false };
          if (names.length > 0) return { desc, button: "", acceptOnly: true };
        }
        return null;
      });
    } catch {
      return null;
    }
  }
  /** Full-document content size for full-page capture dimensions. */
  private async viewportArea(tab: TabState): Promise<{
    width: number;
    height: number;
  }> {
    if (tab.pinned)
      return { width: tab.pinned.width, height: tab.pinned.height };
    const fixed = tab.page.viewportSize();
    if (fixed) return fixed;
    try {
      const live = await tab.page.evaluate(() => ({
        width: Math.max(1, Math.floor(window.innerWidth)),
        height: Math.max(1, Math.floor(window.innerHeight)),
      }));
      if (Number.isFinite(live.width) && Number.isFinite(live.height)) {
        return live;
      }
    } catch {
      // Closed pages fall back to the documented default for diagnostics.
    }
    return { width: 1280, height: 800 };
  }

  private async scrollSize(tab: TabState): Promise<{ w: number; h: number }> {
    try {
      return await tab.page.evaluate((): { w: number; h: number } => {
        const d = document.documentElement;
        return { w: d.scrollWidth, h: d.scrollHeight };
      });
    } catch {
      const viewport = await this.viewportArea(tab);
      return { w: viewport.width, h: viewport.height };
    }
  }

  /** Hide the audit cursor for clean captures; restored afterwards. */
  private async setCursorVisible(
    tab: TabState,
    visible: boolean,
  ): Promise<void> {
    if (this.headless) return;
    await tab.page
      .evaluate((show: boolean) => {
        const el = document.getElementById("bb-audit-cursor");
        if (el) (el as HTMLElement).style.display = show ? "" : "none";
      }, visible)
      .catch(() => undefined);
  }

  /** Failure-path cover diagnosis for a ref action (lazy: no happy-path cost). */
  private coverCheck(
    tab: TabState,
    locator: Locator,
    target: { role: string; name: string },
  ): () => Promise<string | undefined> {
    return async () => {
      const box = await locator.boundingBox().catch(() => null);
      if (!box) return undefined;
      return this.describeCover(
        tab,
        box.x + box.width / 2,
        box.y + box.height / 2,
        target.role,
        target.name,
      );
    };
  }

  private async doClick(
    tab: TabState,
    ref: string,
    button: MouseButton = "left",
    clickCount = 1,
  ): Promise<void> {
    const { locator, target: registered } = await this.resolveRef(tab, ref);
    const coverCheck = this.coverCheck(tab, locator, registered);
    // A click may start a download instead of navigating; race the load
    // wait against download arrival so download clicks stay fast.
    // Note: clicks settle on dispatch, not on navigation commit. Agents
    // awaiting a navigation outcome must use act with a postcondition (or
    // wait) — that wait is also what keeps submissions in flight for
    // crash recovery instead of settling early.
    let onDownload: (() => void) | undefined;
    const downloaded = new Promise<void>((resolve) => {
      onDownload = () => resolve();
      tab.downloadWaiters.push(onDownload);
      while (tab.downloadWaiters.length > 10) tab.downloadWaiters.shift();
    });
    try {
      await this.actWithWallRetry(tab, async () => {
        if (this.humanMotion) {
          const box = await locator.boundingBox().catch(() => null);
          if (box) {
            const target = clickPoint(box);
            await this.glideTo(tab, target);
            await sleep(clickPause());
            await actionable(
              () =>
                locator.click({
                  timeout: 10_000,
                  button,
                  clickCount,
                  position: { x: target.x - box.x, y: target.y - box.y },
                }),
              `Click on ${ref}`,
              coverCheck,
            );
          } else {
            await actionable(
              () => locator.click({ timeout: 10_000, button, clickCount }),
              `Click on ${ref}`,
              coverCheck,
            );
          }
        } else {
          await actionable(
            () => locator.click({ timeout: 10_000, button, clickCount }),
            `Click on ${ref}`,
            coverCheck,
          );
        }
      });
      await this.clickPulse(tab);
      await Promise.race([
        tab.page
          .waitForLoadState("domcontentloaded", { timeout: 10_000 })
          .catch(() => undefined),
        downloaded,
      ]);
    } finally {
      if (onDownload) {
        const at = tab.downloadWaiters.indexOf(onDownload);
        if (at >= 0) tab.downloadWaiters.splice(at, 1);
      }
    }
  }

  private async doFill(
    tab: TabState,
    ref: string,
    text: string,
  ): Promise<void> {
    const { locator, target } = await this.resolveRef(tab, ref);
    await this.actWithWallRetry(tab, () =>
      actionable(
        () => locator.fill(text, { timeout: 10_000 }),
        `Fill on ${ref}`,
        this.coverCheck(tab, locator, target),
      ),
    );
  }

  private async doPress(
    tab: TabState,
    key: string,
    ref?: string,
  ): Promise<void> {
    if (ref === undefined) {
      await tab.page.keyboard.press(key, { delay: 0 });
      return;
    }
    const { locator, target } = await this.resolveRef(tab, ref);
    await this.actWithWallRetry(tab, () =>
      actionable(
        () => locator.press(key, { timeout: 10_000 }),
        `Press on ${ref}`,
        this.coverCheck(tab, locator, target),
      ),
    );
  }

  private async doSelect(
    tab: TabState,
    ref: string,
    values: string[],
  ): Promise<void> {
    const { locator, target } = await this.resolveRef(tab, ref);
    await this.actWithWallRetry(tab, () =>
      actionable(
        () => locator.selectOption(values, { timeout: 10_000 }),
        `Select on ${ref}`,
        this.coverCheck(tab, locator, target),
      ),
    );
  }

  private async doCheck(
    tab: TabState,
    ref: string,
    checked: boolean,
  ): Promise<void> {
    const { locator, target } = await this.resolveRef(tab, ref);
    await this.actWithWallRetry(tab, () =>
      actionable(
        () => locator.setChecked(checked, { timeout: 10_000 }),
        `Check on ${ref}`,
        this.coverCheck(tab, locator, target),
      ),
    );
  }

  private async doHover(tab: TabState, ref: string): Promise<void> {
    const { locator, target } = await this.resolveRef(tab, ref);
    let position: { x: number; y: number } | undefined;
    if (this.humanMotion) {
      const box = await locator.boundingBox().catch(() => null);
      if (box) {
        const point = clickPoint(box);
        position = { x: point.x - box.x, y: point.y - box.y };
        await this.glideTo(tab, point);
      }
    }
    await this.actWithWallRetry(tab, () =>
      actionable(
        () =>
          locator.hover({ timeout: 10_000, ...(position ? { position } : {}) }),
        `Hover on ${ref}`,
        this.coverCheck(tab, locator, target),
      ),
    );
  }

  private async doScroll(
    tab: TabState,
    ref?: string,
    pixels = 400,
  ): Promise<void> {
    if (ref !== undefined) {
      const { locator } = await this.resolveRef(tab, ref);
      await actionable(
        () => locator.scrollIntoViewIfNeeded({ timeout: 10_000 }),
        `Scroll ${ref} into view`,
      );
      // Wheel over the element scrolls scrollable containers (virtualized lists).
      if (pixels !== 0) {
        const box = await locator.boundingBox().catch(() => null);
        if (box) {
          await this.glideTo(tab, {
            x: box.x + box.width / 2,
            y: box.y + box.height / 2,
          });
        } else {
          await locator.hover({ timeout: 10_000 }).catch(() => undefined);
        }
        await this.smoothWheel(tab, pixels);
      }
      return;
    }
    // No target: park the visible hand mid-page first so the watcher sees
    // the cause of the movement, not just the effect.
    if (this.humanMotion) {
      const area = await this.viewportArea(tab);
      await this.glideTo(tab, {
        x: area.width / 2,
        y: area.height / 2,
      });
    }
    await this.smoothWheel(tab, pixels);
  }

  /**
   * Natural wheel: chunked steps with short settles instead of one jump.
   * Reads as a hand on a wheel, and lets lazy-load / infinite scroll fire
   * between steps the way a single teleport never does.
   */
  private async smoothWheel(
    tab: TabState,
    deltaY: number,
    deltaX = 0,
  ): Promise<void> {
    const path = wheelPath(Math.trunc(deltaX), Math.trunc(deltaY));
    for (let i = 0; i < path.length; i++) {
      const step = path[i] as Point;
      await tab.page.mouse.wheel(step.x, step.y);
      if (i < path.length - 1) await sleep(wheelDelay());
    }
    await tab.page.waitForTimeout(120).catch(() => undefined);
  }

  /**
   * Explicit upload: the caller supplies the exact file per call. It must
   * exist, be a regular file, and fit the size bound — nothing is read from
   * ambient directories.
   */
  private async doUpload(
    tab: TabState,
    ref: string,
    file: string,
  ): Promise<string> {
    const { locator } = await this.resolveRef(tab, ref);
    let size = 0;
    try {
      const st = await stat(file);
      if (!st.isFile()) throw new Error("not a file");
      size = st.size;
    } catch {
      throw Object.assign(new Error(`Upload file unavailable: ${file}`), {
        code: "INVALID_REQUEST",
      });
    }
    if (size > UPLOAD_MAX_BYTES) {
      throw Object.assign(new Error(`Upload file exceeds 25MB bound`), {
        code: "INVALID_REQUEST",
      });
    }
    await actionable(
      () => locator.setInputFiles(file, { timeout: 15_000 }),
      `Upload to ${ref}`,
    );
    return file;
  }

  /**
   * Human coordinate input: click at viewport CSS pixels captured from a
   * screenshot of a known revision. Stale geometry is rejected, never
   * reinterpreted — the page may have moved under the picture.
   */
  private async doClickAt(
    tab: TabState,
    x: number,
    y: number,
    screenshotRevision: number,
    button: MouseButton = "left",
    clickCount = 1,
  ): Promise<void> {
    await this.validateScreenshotPoint(tab, x, y, screenshotRevision);
    if (this.humanMotion) {
      await this.glideTo(tab, { x, y });
      await sleep(clickPause());
    }
    await tab.page.mouse.click(x, y, { button, clickCount });
    tab.mouse = { x, y };
    await this.clickPulse(tab);
    await tab.page
      .waitForLoadState("domcontentloaded", { timeout: 10_000 })
      .catch(() => undefined);
  }

  private async validateScreenshotPoint(
    tab: TabState,
    x: number,
    y: number,
    screenshotRevision: number,
  ): Promise<void> {
    if (tab.revision !== screenshotRevision) {
      throw Object.assign(
        new Error(
          `Stale coordinates: screenshot r${screenshotRevision}, tab r${tab.revision}. Re-observe and retry.`,
        ),
        { code: "STALE_OBSERVATION" },
      );
    }
    const viewport = await this.viewportArea(tab);
    if (x < 0 || y < 0 || x >= viewport.width || y >= viewport.height) {
      throw Object.assign(
        new Error(
          `Coordinates (${x}, ${y}) fall outside the ${viewport.width}x${viewport.height} viewport`,
        ),
        { code: "INVALID_REQUEST" },
      );
    }
  }

  /** Revision-bound screenshot drag, matching the visible browser channel. */
  private async doDragAt(
    tab: TabState,
    from: Point,
    to: Point,
    screenshotRevision: number,
    button: MouseButton = "left",
  ): Promise<void> {
    await this.validateScreenshotPoint(tab, from.x, from.y, screenshotRevision);
    await this.validateScreenshotPoint(tab, to.x, to.y, screenshotRevision);
    await this.glideTo(tab, from);
    await tab.page.mouse.down({ button });
    try {
      await this.glideTo(tab, to);
    } finally {
      await tab.page.mouse.up({ button });
    }
    tab.mouse = to;
  }

  private async doMoveAt(
    tab: TabState,
    point: Point,
    screenshotRevision: number,
  ): Promise<void> {
    await this.validateScreenshotPoint(
      tab,
      point.x,
      point.y,
      screenshotRevision,
    );
    await this.glideTo(tab, point);
  }

  private async doScrollAt(
    tab: TabState,
    point: Point,
    deltaX: number,
    deltaY: number,
    screenshotRevision: number,
  ): Promise<void> {
    await this.validateScreenshotPoint(
      tab,
      point.x,
      point.y,
      screenshotRevision,
    );
    await this.glideTo(tab, point);
    await this.smoothWheel(tab, deltaY, deltaX);
  }

  private async doType(tab: TabState, text: string): Promise<void> {
    await tab.page.keyboard.type(text, { delay: 10 });
  }

  private async doGoto(tab: TabState, url: string): Promise<void> {
    assertAllowedUrl(url);
    await tab.page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    // Redirects (HTTP, meta-refresh, scripted) land here too: the final
    // document must still satisfy the URL policy.
    try {
      assertAllowedUrl(tab.page.url());
    } catch {
      throw Object.assign(
        new Error(
          `Navigation landed outside the URL policy: ${tab.page.url()}`,
        ),
        {
          code: "POLICY_DENIED",
        },
      );
    }
  }

  private async execAction(tab: TabState, action: Action): Promise<string[]> {
    switch (action.type) {
      case "click":
        await this.doClick(tab, action.ref, action.button, action.clickCount);
        return [];
      case "fill":
        await this.doFill(tab, action.ref, action.text);
        return [];
      case "press":
        await this.doPress(tab, action.key, action.ref);
        return [];
      case "select":
        await this.doSelect(tab, action.ref, action.values);
        return [];
      case "check":
        await this.doCheck(tab, action.ref, action.checked);
        return [];
      case "hover":
        await this.doHover(tab, action.ref);
        return [];
      case "scroll":
        await this.doScroll(tab, action.ref, action.pixels);
        return [];
      case "navigate":
        await this.doGoto(tab, action.url);
        return [];
      case "back":
        return this.doHistory(tab, "back");
      case "forward":
        return this.doHistory(tab, "forward");
      case "reload":
        return this.doHistory(tab, "reload");
      case "clickAt":
        await this.doClickAt(
          tab,
          action.x,
          action.y,
          action.screenshotRevision,
          action.button,
          action.clickCount,
        );
        return [];
      case "moveAt":
        await this.doMoveAt(
          tab,
          { x: action.x, y: action.y },
          action.screenshotRevision,
        );
        return [];
      case "scrollAt":
        await this.doScrollAt(
          tab,
          { x: action.x, y: action.y },
          action.deltaX ?? 0,
          action.deltaY ?? 0,
          action.screenshotRevision,
        );
        return [];
      case "dragAt":
        await this.doDragAt(
          tab,
          action.from,
          action.to,
          action.screenshotRevision,
          action.button,
        );
        return [];
      case "type":
        await this.doType(tab, action.text);
        return [];
      case "upload":
        await this.doUpload(tab, action.ref, action.file);
        return [];
    }
  }

  private async checkCondition(
    tab: TabState,
    condition: Postcondition,
  ): Promise<boolean> {
    switch (condition.type) {
      case "urlContains":
        return tab.page.url().includes(condition.value);
      case "textVisible": {
        const text = await tab.page
          .locator("body")
          .innerText()
          .catch(() => "");
        return text.includes(condition.text);
      }
      case "elementVisible": {
        const target = tab.targets.find((t) => t.ref === condition.ref);
        if (!target) return false;
        const fresh = await collectTargets(
          tab.page,
          getCapabilities().limits.maxControls,
          tab.revision,
        );
        const match = fresh.targets.find(
          (t) => t.role === target.role && t.name === target.name,
        );
        return match !== undefined;
      }
    }
  }

  private describeCondition(condition: Postcondition): string {
    switch (condition.type) {
      case "textVisible":
        return `text "${condition.text}" visible`;
      case "urlContains":
        return `URL containing "${condition.value}"`;
      case "elementVisible":
        return `element ${condition.ref} visible`;
    }
  }

  /** Poll an explicit condition; never assume fixed delays prove readiness. */
  private async waitForCondition(
    session: SessionState,
    tab: TabState,
    condition: Postcondition,
  ): Promise<void> {
    const generation = session.generation;
    const deadline = Date.now() + condition.timeoutMs;
    for (;;) {
      if (session.generation !== generation) throw cancelled();
      if (await this.checkCondition(tab, condition)) return;
      if (Date.now() >= deadline)
        throw postconditionTimeout(this.describeCondition(condition));
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  private result(
    op: string,
    requestId: string,
    session: SessionState,
    tab: TabState,
    observation: Observation | undefined,
    artifacts: Artifact[] = [],
    warnings: string[] = [],
  ): Result {
    return {
      protocolVersion: "1.0",
      requestId,
      sessionId: session.id,
      tabId: tab.id,
      status: "completed",
      op,
      ...(observation ? { observation } : {}),
      session: {
        id: session.id,
        paused: session.paused,
        owner: session.owner,
        ...(session.ownerSince !== undefined
          ? { ownerSince: session.ownerSince }
          : {}),
        annotationCount: session.annotations.length,
      },
      artifacts,
      warnings,
    };
  }

  async open(
    requestId: string,
    sessionId: string | undefined,
    url: string,
    tabId?: string,
  ): Promise<Result> {
    const session = this.requireSession(sessionId ?? "");
    return this.enqueue(session, async () => {
      const cached = this.dedupe(session, requestId);
      if (cached) return cached;
      assertAllowedUrl(url);
      this.assertAgentAllowed(session, "open");
      const tab =
        tabId !== undefined
          ? this.requireTab(session, tabId)
          : session.tabs.size > 0
            ? this.requireTab(session, undefined)
            : await this.createTab(session);
      // Register popup listener BEFORE navigation-driven actions (§6).
      const diagMarks = this.markDiagnostics(tab);
      await tab.page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      const consent = await this.sweepCookieWall(tab);
      const observation = await this.refresh(tab);
      this.emit("navigated", session.id, `open ${url}`, {
        tabId: tab.id,
        revision: observation.revision,
      });
      const out = this.result(
        "open",
        requestId,
        session,
        tab,
        observation,
        [],
        [
          ...(consent ? [consent] : []),
          ...this.newErrorWarnings(tab, diagMarks),
        ],
      );
      this.remember(session, requestId, out);
      return out;
    });
  }

  async observe(
    requestId: string,
    sessionId: string,
    tabId?: string,
    opts: {
      mode?: "controls" | "summary" | "delta" | "visual" | "inspect";
      baseRevision?: number;
      ref?: string;
      includeScreenshot?: boolean;
    } = {},
  ): Promise<Result> {
    const session = this.requireSession(sessionId);
    return this.enqueue(session, async () => {
      const cached = this.dedupe(session, requestId);
      if (cached) return cached;
      const tab = this.requireTab(session, tabId);
      const mode = opts.mode ?? "controls";
      if (mode === "delta") {
        const out = this.withDelta(
          this.result("observe", requestId, session, tab, tab.lastObservation),
          tab,
          opts.baseRevision,
        );
        this.remember(session, requestId, out);
        return out;
      }
      if (mode === "inspect") {
        if (!opts.ref) {
          throw Object.assign(new Error("inspect mode requires a ref"), {
            code: "INVALID_REQUEST",
          });
        }
        // No refresh: inspect the current registry (observe first). The live
        // revalidation inside still guards against a changed page.
        const last = tab.lastObservation;
        if (!last) {
          throw Object.assign(new Error("No observation yet; observe first"), {
            code: "INVALID_REQUEST",
          });
        }
        const out = {
          ...this.result("observe", requestId, session, tab, last),
          inspection: await this.inspectControl(tab, opts.ref),
        };
        this.remember(session, requestId, out);
        return out;
      }
      const observation = await this.refresh(tab);
      const base = this.result("observe", requestId, session, tab, observation);
      if (mode === "visual") {
        const out = await this.withVisual(
          base,
          session,
          tab,
          opts.includeScreenshot ?? false,
        );
        this.remember(session, requestId, out);
        return out;
      }
      this.remember(session, requestId, base);
      return base;
    });
  }

  private withDelta(
    base: Result,
    tab: TabState,
    baseRevision: number | undefined,
  ): Result {
    const current = tab.lastObservation;
    const baseObs =
      baseRevision === undefined
        ? undefined
        : tab.history.find((h) => h.revision === baseRevision);
    if (!current || !baseObs) {
      return {
        ...base,
        delta: {
          ...(baseRevision !== undefined ? { baseRevision } : {}),
          revision: current?.revision ?? tab.revision,
          reset: true as const,
          resetReason:
            current === undefined
              ? "no observation yet; observe first"
              : baseRevision === undefined
                ? "no baseRevision supplied; full state below"
                : "base revision expired from retention; full state below",
          addedText: current ? current.text.split("\n").slice(0, 100) : [],
          removedText: [],
          addedControls: current?.controls ?? [],
          removedRefs: [],
        },
        ...(current ? { observation: current } : {}),
      };
    }
    const baseLines = new Set(baseObs.text.split("\n"));
    const currentLines = current.text.split("\n");
    const addedText = currentLines
      .filter((l) => l.trim() !== "" && !baseLines.has(l))
      .slice(0, 100);
    const currentSet = new Set(currentLines);
    const removedText = baseObs.text
      .split("\n")
      .filter((l) => l.trim() !== "" && !currentSet.has(l))
      .slice(0, 100);
    const baseKeys = new Set(
      baseObs.controls.map((c) => `${c.role}::${c.name}`),
    );
    const currentKeys = new Set(
      current.controls.map((c) => `${c.role}::${c.name}`),
    );
    const out = {
      ...base,
      observation: current,
      delta: {
        baseRevision: baseObs.revision,
        revision: current.revision,
        reset: false as const,
        addedText,
        removedText,
        addedControls: current.controls.filter(
          (c) => !baseKeys.has(`${c.role}::${c.name}`),
        ),
        removedRefs: baseObs.controls
          .filter((c) => !currentKeys.has(`${c.role}::${c.name}`))
          .map((c) => c.ref),
      },
    };
    return out;
  }

  private async withVisual(
    base: Result,
    session: SessionState,
    tab: TabState,
    includeScreenshot: boolean,
  ): Promise<Result> {
    const overlay = await this.buildOverlay(tab);
    if (!includeScreenshot) {
      return { ...base, overlay };
    }
    const shot = await this.captureScreenshot(session, tab, []);
    return {
      ...base,
      overlay,
      artifacts: [...base.artifacts, shot.artifact],
    };
  }

  /** Numbered overlay table (cap 100): viewer renders markers, agents use coords. */
  private async buildOverlay(tab: TabState): Promise<
    Array<{
      n: number;
      ref: string;
      role: string;
      name: string;
      frame: string;
      x: number;
      y: number;
    }>
  > {
    const overlay: Array<{
      n: number;
      ref: string;
      role: string;
      name: string;
      frame: string;
      x: number;
      y: number;
    }> = [];
    const frames = tab.page.frames();
    for (const t of tab.targets.slice(0, OVERLAY_CAP)) {
      try {
        const frame = frames[t.frameIndex];
        if (!frame || frame.url() !== t.frameUrl) continue;
        const box = await frame
          .locator(INTERACTIVE_SELECTOR)
          .nth(t.index)
          .boundingBox()
          .catch(() => null);
        if (!box) continue;
        overlay.push({
          n: overlay.length + 1,
          ref: t.ref,
          role: t.role,
          name: t.name,
          frame: t.frame,
          x: Math.round(box.x + box.width / 2),
          y: Math.round(box.y + box.height / 2),
        });
      } catch {
        continue;
      }
    }
    return overlay;
  }

  private async inspectControl(
    tab: TabState,
    ref: string,
  ): Promise<Result["inspection"]> {
    const { locator, target } = await this.resolveRef(tab, ref);
    const [details, box, visible] = await Promise.all([
      inspectElement(locator),
      locator.boundingBox().catch(() => null),
      locator.isVisible().catch(() => false),
    ]);
    return {
      ref,
      role: details.role,
      name: target.name,
      frame: target.frame,
      disabled: details.disabled,
      visible,
      box: box
        ? { x: box.x, y: box.y, width: box.width, height: box.height }
        : null,
      attributes: details.attributes,
      text: details.text,
    };
  }

  async click(
    requestId: string,
    sessionId: string,
    ref: string,
    tabId?: string,
    options: { button?: MouseButton; clickCount?: number } = {},
  ): Promise<Result> {
    const session = this.requireSession(sessionId);
    return this.enqueue(session, async () => {
      const cached = this.dedupe(session, requestId);
      if (cached) return cached;
      const tab = this.requireTab(session, tabId);
      this.assertAgentAllowed(session, "click");
      const diagMarks = this.markDiagnostics(tab);
      await this.doClick(tab, ref, options.button, options.clickCount);
      const observation = await this.refresh(tab);
      this.emit(
        "action",
        session.id,
        `click ${ref}${options.clickCount && options.clickCount > 1 ? ` ×${options.clickCount}` : ""}${options.button && options.button !== "left" ? ` (${options.button})` : ""}`,
        {
          tabId: tab.id,
          revision: observation.revision,
        },
      );
      const out = this.result(
        "click",
        requestId,
        session,
        tab,
        observation,
        [],
        this.newErrorWarnings(tab, diagMarks),
      );
      this.remember(session, requestId, out);
      return out;
    });
  }

  async fill(
    requestId: string,
    sessionId: string,
    ref: string,
    text: string,
    tabId?: string,
  ): Promise<Result> {
    const session = this.requireSession(sessionId);
    return this.enqueue(session, async () => {
      const cached = this.dedupe(session, requestId);
      if (cached) return cached;
      const tab = this.requireTab(session, tabId);
      this.assertAgentAllowed(session, "fill");
      const diagMarks = this.markDiagnostics(tab);
      await this.doFill(tab, ref, text);
      const observation = await this.refresh(tab);
      this.emit("action", session.id, `fill ${ref} (${text.length} chars)`, {
        tabId: tab.id,
        revision: observation.revision,
      });
      const out = this.result(
        "fill",
        requestId,
        session,
        tab,
        observation,
        [],
        this.newErrorWarnings(tab, diagMarks),
      );
      this.remember(session, requestId, out);
      return out;
    });
  }

  async screenshot(
    requestId: string,
    sessionId: string,
    tabId?: string,
    maskRefs: string[] = [],
    fullPage = false,
  ): Promise<Result> {
    const session = this.requireSession(sessionId);
    return this.enqueue(session, async () => {
      const cached = this.dedupe(session, requestId);
      if (cached) return cached;
      const tab = this.requireTab(session, tabId);
      const { artifact, observation } = await this.captureScreenshot(
        session,
        tab,
        maskRefs,
        fullPage,
      );
      const out = this.result(
        "screenshot",
        requestId,
        session,
        tab,
        observation,
        [artifact],
      );
      this.emit("screenshot", session.id, `screenshot ${artifact.id}`, {
        tabId: tab.id,
        revision: observation.revision,
      });
      this.remember(session, requestId, out);
      return out;
    });
  }

  private async captureScreenshot(
    session: SessionState,
    tab: TabState,
    maskRefs: string[],
    fullPage = false,
  ): Promise<{ artifact: Artifact; observation: Observation }> {
    const masks: Locator[] = [];
    for (const ref of maskRefs) {
      const resolved = await this.resolveRef(tab, ref);
      masks.push(resolved.locator);
    }
    // A pinned page is invisible to Playwright's viewport AND its capture
    // clip, so capture the override area directly over CDP. Playwright
    // mask overlays cannot be injected into this path: masks plus a pin is
    // a usage error rather than silent non-redaction.
    if (tab.pinned && masks.length > 0) {
      throw Object.assign(
        new Error("screenshot maskRefs need an unpinned viewport"),
        { code: "INVALID_REQUEST" },
      );
    }
    const id = `shot-${randomUUID().slice(0, 8)}`;
    const file = normalize(join(session.dir, `${id}.png`));
    if (!file.startsWith(normalize(session.dir + sep))) {
      throw Object.assign(new Error("Artifact path escape"), {
        code: "POLICY_DENIED",
      });
    }
    // Clean captures: the audit cursor documents live watching, not evidence.
    await this.setCursorVisible(tab, false);
    try {
      let buf: Buffer;
      let shotWidth: number;
      let shotHeight: number;
      if (tab.pinned) {
        // Playwright's viewport AND its capture clip are blind to the
        // override, so capture the pinned area directly over CDP.
        const data = (await tab.pinned.cdp.send("Page.captureScreenshot", {
          format: "png",
          ...(fullPage ? { captureBeyondViewport: true } : {}),
        })) as { data: string };
        buf = Buffer.from(data.data, "base64");
        shotWidth = tab.pinned.width;
        shotHeight = fullPage
          ? (await this.scrollSize(tab)).h
          : tab.pinned.height;
      } else {
        buf = await tab.page.screenshot({
          type: "png",
          scale: "css",
          mask: masks,
          ...(fullPage ? { fullPage: true } : {}),
        });
        if (fullPage) {
          const doc = await this.scrollSize(tab);
          shotWidth = doc.w;
          shotHeight = doc.h;
        } else {
          const viewport = await this.viewportArea(tab);
          shotWidth = viewport.width;
          shotHeight = viewport.height;
        }
      }
      if (buf.length > 8_000_000) {
        throw Object.assign(new Error("Screenshot exceeds 8MB bound"), {
          code: "BROWSER_CRASHED",
        });
      }
      await writeFile(file, buf);
      const observation = tab.lastObservation ?? (await this.refresh(tab));
      return {
        artifact: {
          id,
          kind: "screenshot",
          path: file,
          width: shotWidth,
          height: shotHeight,
          capturedAt: new Date().toISOString(),
          observationRevision: observation.revision,
        },
        observation,
      };
    } finally {
      await this.setCursorVisible(tab, true);
    }
  }

  async listSessions(requestId: string): Promise<Result> {
    return {
      protocolVersion: "1.0",
      requestId,
      sessionId: "",
      tabId: "",
      status: "completed",
      op: "sessions",
      sessions: [...this.sessions.keys()],
      artifacts: [],
      warnings: [],
    };
  }

  async tabList(requestId: string, sessionId: string): Promise<Result> {
    const session = this.requireSession(sessionId);
    const tab = this.requireTab(session, undefined);
    return {
      ...this.result("tabs", requestId, session, tab, undefined),
      tabs: [...session.tabs.values()].map((t) => ({
        id: t.id,
        url: t.page.url(),
        current: t.id === (session.currentTabId ?? tab.id),
      })),
    };
  }

  async tabOpen(
    requestId: string,
    sessionId: string,
    url?: string,
  ): Promise<Result> {
    const session = this.requireSession(sessionId);
    return this.enqueue(session, async () => {
      const cached = this.dedupe(session, requestId);
      if (cached) return cached;
      this.assertAgentAllowed(session, "tab-open");
      const tab = await this.createTab(session);
      session.currentTabId = tab.id;
      const warnings: string[] = [];
      const diagMarks = this.markDiagnostics(tab);
      if (url !== undefined) {
        await this.doGoto(tab, url);
        const consent = await this.sweepCookieWall(tab);
        if (consent) warnings.push(consent);
      }
      const observation = await this.refresh(tab);
      this.emit(
        "tab-opened",
        session.id,
        `tab ${tab.id} opened${url ? ` → ${url}` : ""}`,
        { tabId: tab.id, revision: observation.revision },
      );
      const out = this.result(
        "tab-open",
        requestId,
        session,
        tab,
        observation,
        [],
        [...warnings, ...this.newErrorWarnings(tab, diagMarks)],
      );
      this.remember(session, requestId, out);
      return out;
    });
  }

  async tabClose(
    requestId: string,
    sessionId: string,
    tabId?: string,
  ): Promise<Result> {
    const session = this.requireSession(sessionId);
    return this.enqueue(session, async () => {
      const cached = this.dedupe(session, requestId);
      if (cached) return cached;
      const tab = this.requireTab(session, tabId);
      this.assertAgentAllowed(session, "tab-close");
      await tab.page.close().catch(() => undefined);
      session.tabs.delete(tab.id);
      if (session.currentTabId === tab.id) session.currentTabId = undefined;
      const next =
        session.tabs.size > 0 ? this.requireTab(session, undefined) : undefined;
      if (next) session.currentTabId ??= next.id;
      this.emit("tab-closed", session.id, `tab ${tab.id} closed`, {
        tabId: tab.id,
      });
      const out = {
        ...this.result(
          "tab-close",
          requestId,
          session,
          next ?? tab,
          next?.lastObservation,
        ),
        warnings: next
          ? []
          : ["Session has no tabs left; open a tab before acting"],
      };
      this.remember(session, requestId, out);
      return out;
    });
  }

  async tabSelect(
    requestId: string,
    sessionId: string,
    tabId: string,
  ): Promise<Result> {
    const session = this.requireSession(sessionId);
    return this.enqueue(session, async () => {
      const cached = this.dedupe(session, requestId);
      if (cached) return cached;
      const tab = this.requireTab(session, tabId);
      this.assertAgentAllowed(session, "tab-select");
      session.currentTabId = tab.id;
      const observation = await this.refresh(tab);
      this.emit("tab-selected", session.id, `tab ${tab.id} selected`, {
        tabId: tab.id,
        revision: observation.revision,
      });
      const out = this.result(
        "tab-select",
        requestId,
        session,
        tab,
        observation,
      );
      this.remember(session, requestId, out);
      return out;
    });
  }

  async navigate(
    requestId: string,
    sessionId: string,
    url: string,
    tabId?: string,
  ): Promise<Result> {
    const session = this.requireSession(sessionId);
    return this.enqueue(session, async () => {
      const cached = this.dedupe(session, requestId);
      if (cached) return cached;
      const tab = this.requireTab(session, tabId);
      this.assertAgentAllowed(session, "navigate");
      const diagMarks = this.markDiagnostics(tab);
      await this.doGoto(tab, url);
      const consent = await this.sweepCookieWall(tab);
      const observation = await this.refresh(tab);
      this.emit("navigated", session.id, `navigate ${url}`, {
        tabId: tab.id,
        revision: observation.revision,
      });
      const out = this.result(
        "navigate",
        requestId,
        session,
        tab,
        observation,
        [],
        [
          ...(consent ? [consent] : []),
          ...this.newErrorWarnings(tab, diagMarks),
        ],
      );
      this.remember(session, requestId, out);
      return out;
    });
  }

  private async doHistory(
    tab: TabState,
    which: "back" | "forward" | "reload",
  ): Promise<string[]> {
    if (which === "back") {
      const moved = await tab.page
        .goBack({ waitUntil: "domcontentloaded", timeout: 15_000 })
        .catch(() => null);
      return moved ? [] : ["No back history; page unchanged"];
    }
    if (which === "forward") {
      const moved = await tab.page
        .goForward({ waitUntil: "domcontentloaded", timeout: 15_000 })
        .catch(() => null);
      return moved ? [] : ["No forward history; page unchanged"];
    }
    await tab.page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
    return [];
  }

  private async historyOp(
    op: "back" | "forward" | "reload",
    requestId: string,
    sessionId: string,
    tabId?: string,
  ): Promise<Result> {
    const session = this.requireSession(sessionId);
    return this.enqueue(session, async () => {
      const cached = this.dedupe(session, requestId);
      if (cached) return cached;
      const tab = this.requireTab(session, tabId);
      this.assertAgentAllowed(session, "history");
      const diagMarks = this.markDiagnostics(tab);
      const warnings = await this.doHistory(tab, op);
      const consent = await this.sweepCookieWall(tab);
      if (consent) warnings.push(consent);
      const observation = await this.refresh(tab);
      this.emit("navigated", session.id, `${op} → ${observation.url}`, {
        tabId: tab.id,
        revision: observation.revision,
      });
      const out = this.result(
        op,
        requestId,
        session,
        tab,
        observation,
        [],
        [...warnings, ...this.newErrorWarnings(tab, diagMarks)],
      );
      this.remember(session, requestId, out);
      return out;
    });
  }

  async back(
    requestId: string,
    sessionId: string,
    tabId?: string,
  ): Promise<Result> {
    return this.historyOp("back", requestId, sessionId, tabId);
  }

  async forward(
    requestId: string,
    sessionId: string,
    tabId?: string,
  ): Promise<Result> {
    return this.historyOp("forward", requestId, sessionId, tabId);
  }

  async reload(
    requestId: string,
    sessionId: string,
    tabId?: string,
  ): Promise<Result> {
    return this.historyOp("reload", requestId, sessionId, tabId);
  }

  async press(
    requestId: string,
    sessionId: string,
    key: string,
    ref?: string,
    tabId?: string,
  ): Promise<Result> {
    const session = this.requireSession(sessionId);
    return this.enqueue(session, async () => {
      const cached = this.dedupe(session, requestId);
      if (cached) return cached;
      const tab = this.requireTab(session, tabId);
      this.assertAgentAllowed(session, "press");
      const diagMarks = this.markDiagnostics(tab);
      await this.doPress(tab, key, ref);
      const observation = await this.refresh(tab);
      this.emit(
        "action",
        session.id,
        `press ${key}${ref ? ` on ${ref}` : ""}`,
        { tabId: tab.id, revision: observation.revision },
      );
      const out = this.result(
        "press",
        requestId,
        session,
        tab,
        observation,
        [],
        this.newErrorWarnings(tab, diagMarks),
      );
      this.remember(session, requestId, out);
      return out;
    });
  }

  async select(
    requestId: string,
    sessionId: string,
    ref: string,
    values: string[],
    tabId?: string,
  ): Promise<Result> {
    const session = this.requireSession(sessionId);
    return this.enqueue(session, async () => {
      const cached = this.dedupe(session, requestId);
      if (cached) return cached;
      const tab = this.requireTab(session, tabId);
      this.assertAgentAllowed(session, "select");
      const diagMarks = this.markDiagnostics(tab);
      await this.doSelect(tab, ref, values);
      const observation = await this.refresh(tab);
      this.emit("action", session.id, `select ${ref} = ${values.join(",")}`, {
        tabId: tab.id,
        revision: observation.revision,
      });
      const out = this.result(
        "select",
        requestId,
        session,
        tab,
        observation,
        [],
        this.newErrorWarnings(tab, diagMarks),
      );
      this.remember(session, requestId, out);
      return out;
    });
  }

  async check(
    requestId: string,
    sessionId: string,
    ref: string,
    checked: boolean,
    tabId?: string,
  ): Promise<Result> {
    const session = this.requireSession(sessionId);
    return this.enqueue(session, async () => {
      const cached = this.dedupe(session, requestId);
      if (cached) return cached;
      const tab = this.requireTab(session, tabId);
      this.assertAgentAllowed(session, "check");
      const diagMarks = this.markDiagnostics(tab);
      await this.doCheck(tab, ref, checked);
      const observation = await this.refresh(tab);
      this.emit(
        "action",
        session.id,
        `check ${ref} = ${checked ? "on" : "off"}`,
        { tabId: tab.id, revision: observation.revision },
      );
      const out = this.result(
        "check",
        requestId,
        session,
        tab,
        observation,
        [],
        this.newErrorWarnings(tab, diagMarks),
      );
      this.remember(session, requestId, out);
      return out;
    });
  }

  async scroll(
    requestId: string,
    sessionId: string,
    ref?: string,
    pixels = 400,
    tabId?: string,
  ): Promise<Result> {
    const session = this.requireSession(sessionId);
    return this.enqueue(session, async () => {
      const cached = this.dedupe(session, requestId);
      if (cached) return cached;
      const tab = this.requireTab(session, tabId);
      this.assertAgentAllowed(session, "scroll");
      const diagMarks = this.markDiagnostics(tab);
      await this.doScroll(tab, ref, pixels);
      const observation = await this.refresh(tab);
      this.emit(
        "action",
        session.id,
        `scroll${ref ? ` ${ref}` : ` ${pixels}px`}`,
        { tabId: tab.id, revision: observation.revision },
      );
      const out = this.result(
        "scroll",
        requestId,
        session,
        tab,
        observation,
        [],
        this.newErrorWarnings(tab, diagMarks),
      );
      this.remember(session, requestId, out);
      return out;
    });
  }

  async hover(
    requestId: string,
    sessionId: string,
    ref: string,
    tabId?: string,
  ): Promise<Result> {
    const session = this.requireSession(sessionId);
    return this.enqueue(session, async () => {
      const cached = this.dedupe(session, requestId);
      if (cached) return cached;
      const tab = this.requireTab(session, tabId);
      this.assertAgentAllowed(session, "hover");
      const diagMarks = this.markDiagnostics(tab);
      await this.doHover(tab, ref);
      const observation = await this.refresh(tab);
      this.emit("action", session.id, `hover ${ref}`, {
        tabId: tab.id,
        revision: observation.revision,
      });
      const out = this.result(
        "hover",
        requestId,
        session,
        tab,
        observation,
        [],
        this.newErrorWarnings(tab, diagMarks),
      );
      this.remember(session, requestId, out);
      return out;
    });
  }

  async wait(
    requestId: string,
    sessionId: string,
    condition: Postcondition,
    tabId?: string,
  ): Promise<Result> {
    const session = this.requireSession(sessionId);
    return this.enqueue(session, async () => {
      const cached = this.dedupe(session, requestId);
      if (cached) return cached;
      const tab = this.requireTab(session, tabId);
      this.assertAgentAllowed(session, "wait");
      const diagMarks = this.markDiagnostics(tab);
      await this.waitForCondition(session, tab, condition);
      const observation = await this.refresh(tab);
      this.emit(
        "waited",
        session.id,
        `wait satisfied: ${this.describeCondition(condition)}`,
        { tabId: tab.id, revision: observation.revision },
      );
      const out = {
        ...this.result(
          "wait",
          requestId,
          session,
          tab,
          observation,
          [],
          this.newErrorWarnings(tab, diagMarks),
        ),
        postcondition: { status: "satisfied" as const },
      };
      this.remember(session, requestId, out);
      return out;
    });
  }

  async diagnostics(
    requestId: string,
    sessionId: string,
    tabId?: string,
  ): Promise<Result> {
    const session = this.requireSession(sessionId);
    return this.enqueue(session, async () => {
      const cached = this.dedupe(session, requestId);
      if (cached) return cached;
      const tab = this.requireTab(session, tabId);
      const out = {
        ...this.result(
          "diagnostics",
          requestId,
          session,
          tab,
          tab.lastObservation,
        ),
        diagnostics: {
          consoleErrors: [...tab.diagnostics.consoleErrors],
          requestFailures: tab.diagnostics.requestFailures.map((e) => ({
            ...e,
          })),
          badResponses: tab.diagnostics.badResponses.map((e) => ({ ...e })),
          downloads: tab.downloads.map((e) => ({ ...e })),
          ...(tab.lastDialog ? { dialog: { ...tab.lastDialog } } : {}),
        },
      };
      this.remember(session, requestId, out);
      return out;
    });
  }

  /**
   * Best-effort cancellation. Bumps the generation immediately (not queued)
   * so queued work refuses to start and in-flight `wait` loops abort.
   * In-flight clicks/fills already delivered to the page cannot be undone.
   */
  async cancel(requestId: string, sessionId: string): Promise<Result> {
    const session = this.requireSession(sessionId);
    session.generation += 1;
    const tab =
      session.tabs.size > 0 ? this.requireTab(session, undefined) : undefined;
    return {
      protocolVersion: "1.0",
      requestId,
      sessionId: session.id,
      tabId: tab?.id ?? "t-none",
      status: "completed",
      op: "cancel",
      artifacts: [],
      warnings: [
        "In-flight page actions are not abortable; only queued work and waits were cancelled",
      ],
    };
  }

  /**
   * Unified action + postcondition envelope (§4). Distinguishes command
   * completion from the requested outcome: a missed postcondition returns
   * `postcondition.status: "timeout"` with the executed action, not an error.
   */
  async act(
    requestId: string,
    sessionId: string,
    action: Action,
    options: {
      postcondition?: Postcondition;
      expectedRevision?: number;
      tabId?: string;
    } = {},
  ): Promise<Result> {
    const session = this.requireSession(sessionId);
    return this.enqueue(session, async () => {
      const cached = this.dedupe(session, requestId);
      if (cached) return cached;
      const tab = this.requireTab(session, options.tabId);
      if (
        options.expectedRevision !== undefined &&
        tab.revision !== options.expectedRevision
      ) {
        throw Object.assign(
          new Error(
            `Stale observation: tab at revision ${tab.revision}, expected ${options.expectedRevision}`,
          ),
          { code: "STALE_OBSERVATION" },
        );
      }
      if (!isHumanChannel(action)) this.assertAgentAllowed(session, "act");
      const diagMarks = this.markDiagnostics(tab);
      const actionWarnings = await this.execAction(tab, action);
      let postcondition: { status: "satisfied" | "timeout" | "not-requested" } =
        { status: "not-requested" };
      if (options.postcondition) {
        try {
          await this.waitForCondition(session, tab, options.postcondition);
          postcondition = { status: "satisfied" };
        } catch (err) {
          if (codeOf(err) === "CANCELLED") throw err;
          if (codeOf(err) === "POSTCONDITION_TIMEOUT") {
            postcondition = { status: "timeout" };
          } else {
            throw err;
          }
        }
      }
      const observation = await this.refresh(tab);
      this.emit(
        "action",
        session.id,
        `act ${action.type} → ${postcondition.status}`,
        {
          tabId: tab.id,
          revision: observation.revision,
        },
      );
      const out = {
        ...this.result(
          "act",
          requestId,
          session,
          tab,
          observation,
          [],
          [...actionWarnings, ...this.newErrorWarnings(tab, diagMarks)],
        ),
        postcondition,
      };
      this.remember(session, requestId, out);
      return out;
    });
  }

  /**
   * Begin a human takeover: agent mutations are rejected with
   * SESSION_PAUSED until resume. Reads stay available so the agent can
   * watch. Optional timeoutMs auto-resumes a forgotten hold.
   */
  async pause(
    requestId: string,
    sessionId: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<Result> {
    const session = this.requireSession(sessionId);
    return this.enqueue(session, async () => {
      const cached = this.dedupe(session, requestId);
      if (cached) return cached;
      const tab =
        session.tabs.size > 0 ? this.requireTab(session, undefined) : undefined;
      if (session.pauseTimer !== undefined) {
        clearTimeout(session.pauseTimer);
        session.pauseTimer = undefined;
      }
      session.paused = true;
      session.owner = "human";
      session.ownerSince = new Date().toISOString();
      if (opts.timeoutMs !== undefined) {
        session.pauseTimer = setTimeout(() => {
          void this.resume(`auto-${Date.now()}`, sessionId).catch(
            () => undefined,
          );
        }, opts.timeoutMs);
        session.pauseTimer.unref?.();
      }
      this.emit(
        "paused",
        session.id,
        `takeover started${opts.timeoutMs ? ` (auto-resume in ${opts.timeoutMs}ms)` : ""}`,
        {
          ...(tab ? { tabId: tab.id } : {}),
        },
      );
      const out = tab
        ? this.result(
            "pause",
            requestId,
            session,
            tab,
            tab.lastObservation,
            [],
            [],
          )
        : {
            protocolVersion: "1.0" as const,
            requestId,
            sessionId: session.id,
            tabId: "t-none",
            status: "completed" as const,
            op: "pause",
            session: this.sessionState(sessionId),
            artifacts: [],
            warnings: [],
          };
      this.remember(session, requestId, out);
      return out;
    });
  }

  /**
   * End the takeover and hand control back: refreshes the current tab so
   * the agent's next observation is the human's final state, invalidating
   * every ref the agent held before the pause.
   */
  async resume(requestId: string, sessionId: string): Promise<Result> {
    const session = this.requireSession(sessionId);
    return this.enqueue(session, async () => {
      const cached = this.dedupe(session, requestId);
      if (cached) return cached;
      const warnings: string[] = [];
      if (!session.paused)
        warnings.push("Session was not paused; refreshed anyway");
      if (session.pauseTimer !== undefined) {
        clearTimeout(session.pauseTimer);
        session.pauseTimer = undefined;
      }
      session.paused = false;
      session.owner = "agent";
      session.ownerSince = undefined;
      const tab = this.requireTab(session, undefined);
      const observation = await this.refresh(tab);
      this.emit(
        "resumed",
        session.id,
        `takeover ended at r${observation.revision}`,
        {
          tabId: tab.id,
          revision: observation.revision,
        },
      );
      const out = this.result(
        "resume",
        requestId,
        session,
        tab,
        observation,
        [],
        warnings,
      );
      this.remember(session, requestId, out);
      return out;
    });
  }

  async annotationsAdd(
    requestId: string,
    sessionId: string,
    input: {
      tabId?: string;
      kind: "click" | "region";
      x: number;
      y: number;
      w?: number;
      h?: number;
      note: string;
      screenshotRevision?: number;
    },
  ): Promise<Result> {
    const session = this.requireSession(sessionId);
    return this.enqueue(session, async () => {
      const cached = this.dedupe(session, requestId);
      if (cached) return cached;
      const tab = this.requireTab(session, input.tabId);
      if (
        input.screenshotRevision !== undefined &&
        tab.revision !== input.screenshotRevision
      ) {
        throw Object.assign(
          new Error(
            `Stale annotation: screenshot r${input.screenshotRevision}, tab r${tab.revision}`,
          ),
          { code: "STALE_OBSERVATION" },
        );
      }
      const annotation: Annotation = {
        id: `an-${randomUUID().slice(0, 8)}`,
        tabId: tab.id,
        revision: tab.revision,
        kind: input.kind,
        x: input.x,
        y: input.y,
        ...(input.w !== undefined ? { w: input.w } : {}),
        ...(input.h !== undefined ? { h: input.h } : {}),
        note: input.note,
        at: new Date().toISOString(),
      };
      session.annotations.push(annotation);
      while (session.annotations.length > ANNOTATION_CAP)
        session.annotations.shift();
      this.emit(
        "annotated",
        session.id,
        `${input.kind} @ (${input.x}, ${input.y}): ${input.note.slice(0, 80)}`,
        {
          tabId: tab.id,
          revision: tab.revision,
        },
      );
      const out = {
        ...this.result(
          "annotations",
          requestId,
          session,
          tab,
          tab.lastObservation,
        ),
        annotations: [annotation],
      };
      this.remember(session, requestId, out);
      return out;
    });
  }

  async annotationsList(
    requestId: string,
    sessionId: string,
    tabId?: string,
  ): Promise<Result> {
    const session = this.requireSession(sessionId);
    return this.enqueue(session, async () => {
      const cached = this.dedupe(session, requestId);
      if (cached) return cached;
      const tab = this.requireTab(session, tabId);
      const list = tabId
        ? session.annotations.filter((a) => a.tabId === tab.id)
        : [...session.annotations];
      const out = {
        ...this.result(
          "annotations",
          requestId,
          session,
          tab,
          tab.lastObservation,
        ),
        annotations: list,
      };
      this.remember(session, requestId, out);
      return out;
    });
  }

  /** Viewport CSS-pixel box for a ref (viewer overlays, coordinate fallback). */
  async locate(
    requestId: string,
    sessionId: string,
    ref: string,
    tabId?: string,
  ): Promise<Result> {
    const session = this.requireSession(sessionId);
    return this.enqueue(session, async () => {
      const cached = this.dedupe(session, requestId);
      if (cached) return cached;
      const tab = this.requireTab(session, tabId);
      const { locator } = await this.resolveRef(tab, ref);
      const box = await locator.boundingBox();
      if (!box) {
        throw Object.assign(new Error(`Target ${ref} has no visible box`), {
          code: "TARGET_NOT_ACTIONABLE",
        });
      }
      const out = {
        ...this.result("locate", requestId, session, tab, tab.lastObservation),
        location: { x: box.x, y: box.y, width: box.width, height: box.height },
      };
      this.remember(session, requestId, out);
      return out;
    });
  }

  async upload(
    requestId: string,
    sessionId: string,
    ref: string,
    file: string,
    tabId?: string,
  ): Promise<Result> {
    const session = this.requireSession(sessionId);
    return this.enqueue(session, async () => {
      const cached = this.dedupe(session, requestId);
      if (cached) return cached;
      const tab = this.requireTab(session, tabId);
      this.assertAgentAllowed(session, "upload");
      const diagMarks = this.markDiagnostics(tab);
      const chosen = await this.doUpload(tab, ref, file);
      const observation = await this.refresh(tab);
      this.emit("action", session.id, `upload ${ref} <- ${chosen}`, {
        tabId: tab.id,
        revision: observation.revision,
      });
      const out = this.result(
        "upload",
        requestId,
        session,
        tab,
        observation,
        [],
        this.newErrorWarnings(tab, diagMarks),
      );
      this.remember(session, requestId, out);
      return out;
    });
  }

  /**
   * Bounded batch: up to 20 actions against ONE observation, one queue
   * slot, one final observation. Later steps reuse the refs issued before
   * the batch; a step that invalidates them aborts the batch (or records
   * and continues with stopOnError=false). Cancellation is honored
   * between steps.
   */
  async batch(
    requestId: string,
    sessionId: string,
    actions: Action[],
    opts: {
      stopOnError?: boolean;
      postcondition?: Postcondition;
      tabId?: string;
    } = {},
  ): Promise<Result> {
    const session = this.requireSession(sessionId);
    return this.enqueue(session, async () => {
      const cached = this.dedupe(session, requestId);
      if (cached) return cached;
      const tab = this.requireTab(session, opts.tabId);
      this.assertAgentAllowed(session, "batch");
      const generation = session.generation;
      const diagMarks = this.markDiagnostics(tab);
      const steps: Array<{
        type: string;
        ok: boolean;
        code?: string;
        message?: string;
      }> = [];
      let postcondition: { status: "satisfied" | "timeout" | "not-requested" } =
        { status: "not-requested" };
      for (const action of actions) {
        if (session.generation !== generation) throw cancelled();
        try {
          const warnings = await this.execAction(tab, action);
          steps.push({
            type: action.type,
            ok: true,
            ...(warnings.length > 0 ? { message: warnings.join("; ") } : {}),
          });
        } catch (err) {
          const code = codeOf(err);
          steps.push({
            type: action.type,
            ok: false,
            code,
            message: String(err instanceof Error ? err.message : err).slice(
              0,
              300,
            ),
          });
          if (opts.stopOnError ?? true) break;
        }
      }
      const failed = steps.find((s) => !s.ok);
      if (failed && (opts.stopOnError ?? true)) {
        throw Object.assign(
          new Error(
            `Batch stopped at ${failed.type}: ${failed.message ?? failed.code}`,
          ),
          {
            code: (failed.code ?? "BROWSER_CRASHED") as ErrorCode,
          },
        );
      }
      if (opts.postcondition) {
        try {
          await this.waitForCondition(session, tab, opts.postcondition);
          postcondition = { status: "satisfied" };
        } catch (err) {
          if (codeOf(err) === "CANCELLED") throw err;
          if (codeOf(err) === "POSTCONDITION_TIMEOUT") {
            postcondition = { status: "timeout" };
          } else {
            throw err;
          }
        }
      }
      const observation = await this.refresh(tab);
      this.emit(
        "action",
        session.id,
        `batch ${steps.filter((s) => s.ok).length}/${steps.length} ok`,
        {
          tabId: tab.id,
          revision: observation.revision,
        },
      );
      const out = {
        ...this.result(
          "batch",
          requestId,
          session,
          tab,
          observation,
          [],
          this.newErrorWarnings(tab, diagMarks),
        ),
        postcondition,
        steps,
      };
      this.remember(session, requestId, out);
      return out;
    });
  }

  /** Scoped page search: refresh, then substring-match controls by name/role. */
  async search(
    requestId: string,
    sessionId: string,
    query: string,
    limit = 20,
    tabId?: string,
  ): Promise<Result> {
    const session = this.requireSession(sessionId);
    return this.enqueue(session, async () => {
      const cached = this.dedupe(session, requestId);
      if (cached) return cached;
      const tab = this.requireTab(session, tabId);
      const observation = await this.refresh(tab);
      const needle = query.toLowerCase();
      const matches = tab.targets
        .filter(
          (t) =>
            t.name.toLowerCase().includes(needle) ||
            t.role.toLowerCase().includes(needle),
        )
        .slice(0, Math.max(1, Math.min(limit, 50)))
        .map((t) => ({
          ref: t.ref,
          role: t.role,
          name: t.name,
          frame: t.frame,
        }));
      const out = {
        ...this.result("search", requestId, session, tab, observation),
        matches,
      };
      this.remember(session, requestId, out);
      return out;
    });
  }

  /**
   * Resize the tab viewport (responsive testing). Presets: mobile 390x844,
   * tablet 820x1180, desktop 1440x900 — or any custom size in bounds.
   * Layout changes invalidate refs, so this refreshes like navigation.
   * Headed sessions start with a free window that follows OS resizes;
   * this op pins an exact size instead (and the window follows it), unless
   * keepWindow pins the page and leaves the OS window untouched
   * (DevTools-style override), or free clears an override.
   */
  async viewport(
    requestId: string,
    sessionId: string,
    size: {
      preset?: ViewportPreset;
      width?: number;
      height?: number;
      keepWindow?: boolean;
      free?: boolean;
    },
    tabId?: string,
  ): Promise<Result> {
    const session = this.requireSession(sessionId);
    return this.enqueue(session, async () => {
      const cached = this.dedupe(session, requestId);
      if (cached) return cached;
      const tab = this.requireTab(session, tabId);
      this.assertAgentAllowed(session, "viewport");
      const warnings: string[] = [];
      const diagMarks = this.markDiagnostics(tab);
      if (size.free === true) {
        if (
          size.preset !== undefined ||
          size.width !== undefined ||
          size.height !== undefined ||
          size.keepWindow === true
        ) {
          throw Object.assign(
            new Error("viewport free takes no size or keepWindow flag"),
            { code: "INVALID_REQUEST" },
          );
        }
        await this.clearViewportOverride(tab);
        // Clearing drops to the raw window size: restore Playwright's own
        // viewport unless the tab is window-free (never follow-sized).
        const viewport = tab.page.viewportSize();
        if (viewport) await tab.page.setViewportSize(viewport);
        const observation = await this.refresh(tab);
        this.emit("viewport", session.id, "viewport free", {
          tabId: tab.id,
          revision: observation.revision,
        });
        const out = this.result(
          "viewport",
          requestId,
          session,
          tab,
          observation,
          [],
          this.newErrorWarnings(tab, diagMarks),
        );
        this.remember(session, requestId, out);
        return out;
      }
      let width = size.width;
      let height = size.height;
      if (size.preset !== undefined) {
        width = VIEWPORT_PRESETS[size.preset].width;
        height = VIEWPORT_PRESETS[size.preset].height;
      }
      if (
        width === undefined ||
        height === undefined ||
        !Number.isInteger(width) ||
        !Number.isInteger(height) ||
        width < 320 ||
        width > 3840 ||
        height < 320 ||
        height > 2160
      ) {
        throw Object.assign(
          new Error(
            "Supply a preset (mobile|tablet|desktop) or integer width+height within 320..3840 x 320..2160",
          ),
          { code: "INVALID_REQUEST" },
        );
      }
      if (size.keepWindow === true) {
        await this.pinViewportOverride(tab, width, height);
      } else {
        await this.clearViewportOverride(tab);
        await tab.page.setViewportSize({ width, height });
        if (!this.headless) {
          const fitWarning = await this.fitWindowToViewport(tab, width, height);
          if (fitWarning) warnings.push(fitWarning);
        }
      }
      const observation = await this.refresh(tab);
      this.emit(
        "viewport",
        session.id,
        `viewport ${width}x${height}${size.preset ? ` (${size.preset})` : ""}${size.keepWindow === true ? " (window kept)" : ""}`,
        {
          tabId: tab.id,
          revision: observation.revision,
        },
      );
      const out = this.result(
        "viewport",
        requestId,
        session,
        tab,
        observation,
        [],
        [...warnings, ...this.newErrorWarnings(tab, diagMarks)],
      );
      this.remember(session, requestId, out);
      return out;
    });
  }

  /**
   * Fit the headed OS window around an exact page size. The page itself is
   * already correct (setViewportSize works in CSS pixels at any OS scale);
   * this only sizes the window so a watcher sees all of it. Chrome is
   * measured live (outer bounds minus inner size, same DIP units), so OS
   * scaling, themes, and bookmark bars are all accounted for. Headed only.
   * Returns a warning when the window could not be fitted; the page size
   * itself is still exact.
   */
  private async fitWindowToViewport(
    tab: TabState,
    width: number,
    height: number,
  ): Promise<string | undefined> {
    let cdp: CDPSession | undefined;
    try {
      cdp = await tab.page.context().newCDPSession(tab.page);
      const inner = await tab.page.evaluate(
        (): {
          w: number;
          h: number;
        } => ({ w: window.innerWidth, h: window.innerHeight }),
      );
      const target = await cdp.send("Target.getTargetInfo", {});
      const { windowId } = await cdp.send("Browser.getWindowForTarget", {
        targetId: target.targetInfo.targetId,
      });
      const { bounds } = await cdp.send("Browser.getWindowBounds", {
        windowId,
      });
      const outerW = bounds.width ?? NaN;
      const outerH = bounds.height ?? NaN;
      const chromeW = outerW - inner.w;
      const chromeH = outerH - inner.h;
      if (
        !(
          Number.isFinite(chromeW) &&
          Number.isFinite(chromeH) &&
          chromeW >= 0 &&
          chromeW <= 400 &&
          chromeH >= 0 &&
          chromeH <= 600
        )
      ) {
        return "window chrome looked implausible; page size is exact but the OS window was left alone";
      }
      await cdp.send("Browser.setWindowBounds", {
        windowId,
        bounds: {
          left: bounds.left ?? 0,
          top: bounds.top ?? 0,
          width: Math.round(width + chromeW),
          height: Math.round(height + chromeH),
          windowState: "normal",
        },
      });
      return undefined;
    } catch (err: unknown) {
      return `OS window could not be fitted (${String(err).slice(0, 120)}); page size is exact`;
    } finally {
      await cdp?.detach().catch(() => undefined);
    }
  }

  /**
   * Clear a DevTools-style viewport override on the tab (no-op when none).
   * Clearing alone falls back to the raw window size, so callers restore
   * Playwright's own viewport afterwards unless the tab is window-free.
   * The override must be cleared on the session that set it.
   */
  private async clearViewportOverride(tab: TabState): Promise<void> {
    if (!tab.pinned) return;
    try {
      await tab.pinned.cdp.send("Emulation.clearDeviceMetricsOverride");
    } catch (err: unknown) {
      throw Object.assign(
        new Error(`Could not clear the viewport override: ${String(err)}`),
        { code: codeOf(err) },
      );
    } finally {
      await tab.pinned.cdp.detach().catch(() => undefined);
      tab.pinned = undefined;
    }
  }

  /**
   * Pin the page to an exact size without touching the OS window
   * (DevTools device-mode style). Responsive layout testing only: no
   * user-agent, touch, or physical-device emulation.
   */
  private async pinViewportOverride(
    tab: TabState,
    width: number,
    height: number,
  ): Promise<void> {
    await this.clearViewportOverride(tab);
    const cdp = await tab.page.context().newCDPSession(tab.page);
    try {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
    } catch (err: unknown) {
      await cdp.detach().catch(() => undefined);
      throw Object.assign(
        new Error(`Could not pin the viewport: ${String(err)}`),
        { code: codeOf(err) },
      );
    }
    tab.pinned = { width, height, cdp };
  }

  async closeSession(requestId: string, sessionId: string): Promise<Result> {
    const session = this.requireSession(sessionId);
    session.closing = true;
    return this.enqueue(session, async () => {
      this.assertAgentAllowed(session, "close");
      const firstTab = session.tabs.values().next();
      const tab = (firstTab.done ? undefined : firstTab.value) as
        | TabState
        | undefined;
      await session.context.close().catch((err: unknown) => {
        throw Object.assign(new Error(`Close failed: ${String(err)}`), {
          code: codeOf(err),
        });
      });
      if (session.profileName !== undefined)
        await this.releaseProfile(session.profileName);
      if (session.pauseTimer !== undefined) clearTimeout(session.pauseTimer);
      this.sessions.delete(sessionId);
      // Retention: artifacts were already delivered; the owned directory goes.
      await rmRetry(session.dir).catch(() => undefined);
      this.emit("session-closed", sessionId, `session ${sessionId} closed`);
      return {
        protocolVersion: "1.0",
        requestId,
        sessionId,
        tabId: tab?.id ?? "t-closed",
        status: "completed",
        op: "close",
        artifacts: [],
        warnings: [],
      };
    });
  }
}
