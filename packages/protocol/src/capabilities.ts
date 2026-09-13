/** Phase-0 capability discovery. MCP/JSONL/daemon share this shape. */
export interface Capabilities {
  protocolVersion: string;
  engine: "chromium";
  ops: string[];
  actionTypes: string[];
  observationModes: string[];
  deliveryMethods: string[];
  limits: {
    maxTextChars: number;
    maxControls: number;
    maxScreenshotWidth: number;
    maxScreenshotHeight: number;
    maxResponseBytes: number;
  };
}

export const FIRST_SLICE_OPS = [
  "capabilities",
  "open",
  "observe",
  "click",
  "fill",
  "screenshot",
  "close",
] as const;

/** Phase-1 vocabulary (§6). Additive over the first slice. */
export const PHASE1_OPS = [
  ...FIRST_SLICE_OPS,
  "navigate",
  "back",
  "forward",
  "reload",
  "press",
  "select",
  "check",
  "scroll",
  "hover",
  "wait",
  "diagnostics",
  "sessions",
  "tabs",
  "tab-open",
  "tab-close",
  "tab-select",
  "cancel",
  "act",
] as const;

/** Phase-2 transport ops (session creation for clients without one). */
export const PHASE2_OPS = [...PHASE1_OPS, "create"] as const;

/** Phase-4 handoff ops (takeover, annotations, coordinate tools). */
export const PHASE4_OPS = [
  ...PHASE2_OPS,
  "pause",
  "resume",
  "annotations",
  "locate",
] as const;

/** Phase-5 resilience ops (difficult pages, batches, search). */
export const PHASE5_OPS = [...PHASE4_OPS, "upload", "batch", "search"] as const;

/** Live-browsing ops (responsive viewports). */
export const PHASE6_OPS = [...PHASE5_OPS, "viewport"] as const;

export function getCapabilities(): Capabilities {
  return {
    protocolVersion: "1.0",
    engine: "chromium",
    ops: [...PHASE6_OPS],
    actionTypes: [
      "click",
      "fill",
      "press",
      "select",
      "check",
      "hover",
      "scroll",
      "navigate",
      "back",
      "forward",
      "reload",
      "clickAt",
      "moveAt",
      "scrollAt",
      "dragAt",
      "type",
      "upload",
    ],
    observationModes: ["controls", "summary", "delta", "visual", "inspect"],
    // Phase 0: filesystem path only. MCP base64 + HTTP artifact fetch land in Phase 2/3.
    deliveryMethods: ["artifact-path"],
    limits: {
      maxTextChars: 8000,
      maxControls: 200,
      maxScreenshotWidth: 1280,
      maxScreenshotHeight: 800,
      maxResponseBytes: 512_000,
    },
  };
}
