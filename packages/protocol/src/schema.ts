import { z } from "zod";
import { PROTOCOL_VERSION } from "./errors.js";

/**
 * Protocol v1 (Phase-1 slice).
 *
 * Phase 0: open / observe / click / fill / screenshot / close.
 * Phase 1 adds: session/tab lifecycle, navigation, press/select/check/
 * scroll/hover, explicit waits, diagnostics, cancellation, and the `act`
 * envelope binding an action to an optional postcondition. All additions
 * are optional fields or new `op` members; Phase-0 clients still validate.
 */

export const protocolVersionSchema = z.literal(PROTOCOL_VERSION);

export const refSchema = z
  .string()
  .regex(/^el-\d+-\d+$/, "ref must look like el-5-7 (revision-qualified)")
  .describe(
    "Opaque element reference, valid only for the observation revision that issued it",
  );

export const controlSchema = z.object({
  ref: refSchema,
  role: z.string(),
  name: z.string(),
  frame: z
    .string()
    .describe(
      "Frame id from the observation frames table; f0 is the main frame",
    ),
  disabled: z.boolean().default(false),
  checked: z.boolean().optional(),
  selected: z.boolean().optional(),
  expanded: z.boolean().optional(),
});

export type Control = z.infer<typeof controlSchema>;

export const frameInfoSchema = z.object({
  id: z.string(),
  url: z.string(),
  name: z.string().optional(),
  error: z.string().optional(),
});

export type FrameInfo = z.infer<typeof frameInfoSchema>;

export const observationSchema = z.object({
  revision: z.number().int().nonnegative(),
  url: z.string(),
  title: z.string(),
  text: z.string(),
  controls: z.array(controlSchema),
  frames: z.array(frameInfoSchema).default([]),
  truncated: z.boolean(),
  /** Present when output bounds cut the snapshot. */
  continuation: z.string().optional(),
});

export type Observation = z.infer<typeof observationSchema>;

const timeoutMsSchema = z.number().int().min(250).max(30_000).default(5000);

/** Explicit expected-outcome condition. Waiting never assumes fixed delays. */
export const postconditionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("textVisible"),
    text: z.string().min(1).max(500),
    timeoutMs: timeoutMsSchema,
  }),
  z.object({
    type: z.literal("urlContains"),
    value: z.string().min(1).max(2000),
    timeoutMs: timeoutMsSchema,
  }),
  z.object({
    type: z.literal("elementVisible"),
    ref: refSchema,
    timeoutMs: timeoutMsSchema,
  }),
]);

export type Postcondition = z.infer<typeof postconditionSchema>;

const mouseButtonSchema = z.enum(["left", "right", "middle"]);

/** Single browser action inside the `act` envelope. */
export const actionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("click"),
    ref: refSchema,
    button: mouseButtonSchema.optional(),
    clickCount: z.number().int().min(1).max(3).optional(),
  }),
  z.object({
    type: z.literal("fill"),
    ref: refSchema,
    text: z.string().max(4000),
  }),
  z.object({
    type: z.literal("press"),
    key: z.string().min(1).max(50),
    ref: refSchema.optional(),
  }),
  z.object({
    type: z.literal("select"),
    ref: refSchema,
    values: z.array(z.string().max(200)).min(1).max(10),
  }),
  z.object({ type: z.literal("check"), ref: refSchema, checked: z.boolean() }),
  z.object({ type: z.literal("hover"), ref: refSchema }),
  z.object({
    type: z.literal("scroll"),
    ref: refSchema.optional(),
    pixels: z.number().int().min(-5000).max(5000).default(400),
  }),
  z.object({ type: z.literal("navigate"), url: z.string().url() }),
  z.object({ type: z.literal("back") }),
  z.object({ type: z.literal("forward") }),
  z.object({ type: z.literal("reload") }),
  z.object({
    type: z.literal("clickAt"),
    x: z.number().min(0).max(10000),
    y: z.number().min(0).max(10000),
    screenshotRevision: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Observation revision of the screenshot the coordinates came from",
      ),
    button: mouseButtonSchema.optional(),
    clickCount: z.number().int().min(1).max(3).optional(),
  }),
  z.object({
    type: z.literal("moveAt"),
    x: z.number().min(0).max(10000),
    y: z.number().min(0).max(10000),
    screenshotRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("scrollAt"),
    x: z.number().min(0).max(10000),
    y: z.number().min(0).max(10000),
    deltaX: z.number().int().min(-5000).max(5000).optional(),
    deltaY: z.number().int().min(-5000).max(5000).optional(),
    screenshotRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("dragAt"),
    from: z.object({
      x: z.number().min(0).max(10000),
      y: z.number().min(0).max(10000),
    }),
    to: z.object({
      x: z.number().min(0).max(10000),
      y: z.number().min(0).max(10000),
    }),
    screenshotRevision: z
      .number()
      .int()
      .nonnegative()
      .describe("Observation revision of the screenshot the drag came from"),
    button: mouseButtonSchema.optional(),
  }),
  z.object({
    type: z.literal("type"),
    text: z
      .string()
      .min(1)
      .max(4000)
      .describe("Typed into the focused element"),
  }),
  z.object({
    type: z.literal("upload"),
    ref: refSchema,
    file: z
      .string()
      .min(1)
      .max(4096)
      .describe("Local file path to upload; must exist"),
  }),
]);

export type Action = z.infer<typeof actionSchema>;

const baseRequest = z.object({
  protocolVersion: protocolVersionSchema,
  requestId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  tabId: z.string().min(1).optional(),
});

export const capabilitiesRequestSchema = baseRequest.extend({
  op: z.literal("capabilities"),
});

export const openRequestSchema = baseRequest.extend({
  op: z.literal("open"),
  url: z.string().url(),
});

export const observeRequestSchema = baseRequest.extend({
  op: z.literal("observe"),
  mode: z
    .enum(["controls", "summary", "delta", "visual", "inspect"])
    .default("controls"),
  baseRevision: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Delta base; expired bases reset to a full snapshot"),
  ref: refSchema.optional().describe("Inspect target for mode=inspect"),
  includeScreenshot: z
    .boolean()
    .default(false)
    .describe("Attach a screenshot artifact in visual mode"),
});

export const clickRequestSchema = baseRequest.extend({
  op: z.literal("click"),
  ref: refSchema,
  button: mouseButtonSchema.optional(),
  clickCount: z.number().int().min(1).max(3).optional(),
});

export const fillRequestSchema = baseRequest.extend({
  op: z.literal("fill"),
  ref: refSchema,
  text: z.string().max(4000),
});

export const screenshotRequestSchema = baseRequest.extend({
  op: z.literal("screenshot"),
  maskRefs: z
    .array(refSchema)
    .min(1)
    .max(20)
    .optional()
    .describe("Redact these controls in the capture (best effort)"),
  fullPage: z
    .boolean()
    .optional()
    .describe(
      "Stitch the full scrollable page instead of the visible viewport",
    ),
});

export const uploadRequestSchema = baseRequest.extend({
  op: z.literal("upload"),
  ref: refSchema,
  file: z.string().min(1).max(4096),
});

export const batchRequestSchema = baseRequest.extend({
  op: z.literal("batch"),
  actions: z.array(actionSchema).min(1).max(20),
  stopOnError: z.boolean().default(true),
  postcondition: postconditionSchema.optional(),
});

export const searchRequestSchema = baseRequest.extend({
  op: z.literal("search"),
  query: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(50).default(20),
});

export const closeRequestSchema = baseRequest.extend({
  op: z.literal("close"),
});

export const navigateRequestSchema = baseRequest.extend({
  op: z.literal("navigate"),
  url: z.string().url(),
});

export const backRequestSchema = baseRequest.extend({
  op: z.literal("back"),
});

export const forwardRequestSchema = baseRequest.extend({
  op: z.literal("forward"),
});

export const reloadRequestSchema = baseRequest.extend({
  op: z.literal("reload"),
});

export const pressRequestSchema = baseRequest.extend({
  op: z.literal("press"),
  key: z.string().min(1).max(50),
  ref: refSchema.optional(),
});

export const selectRequestSchema = baseRequest.extend({
  op: z.literal("select"),
  ref: refSchema,
  values: z.array(z.string().max(200)).min(1).max(10),
});

export const checkRequestSchema = baseRequest.extend({
  op: z.literal("check"),
  ref: refSchema,
  checked: z.boolean(),
});

export const scrollRequestSchema = baseRequest.extend({
  op: z.literal("scroll"),
  ref: refSchema.optional(),
  pixels: z.number().int().min(-5000).max(5000).default(400),
});

export const hoverRequestSchema = baseRequest.extend({
  op: z.literal("hover"),
  ref: refSchema,
});

export const waitRequestSchema = baseRequest.extend({
  op: z.literal("wait"),
  condition: postconditionSchema,
});

export const diagnosticsRequestSchema = baseRequest.extend({
  op: z.literal("diagnostics"),
});

export const sessionsRequestSchema = baseRequest.extend({
  op: z.literal("sessions"),
});

export const tabsRequestSchema = baseRequest.extend({
  op: z.literal("tabs"),
});

export const tabOpenRequestSchema = baseRequest.extend({
  op: z.literal("tab-open"),
  url: z.string().url().optional(),
});

export const tabCloseRequestSchema = baseRequest.extend({
  op: z.literal("tab-close"),
});

export const tabSelectRequestSchema = baseRequest.extend({
  op: z.literal("tab-select"),
});

export const cancelRequestSchema = baseRequest.extend({
  op: z.literal("cancel"),
});

export const pauseRequestSchema = baseRequest.extend({
  op: z.literal("pause"),
  timeoutMs: z
    .number()
    .int()
    .min(5000)
    .max(600_000)
    .optional()
    .describe("Auto-resume after this long; omit to hold until resumed"),
});

export const resumeRequestSchema = baseRequest.extend({
  op: z.literal("resume"),
});

export const annotationsRequestSchema = baseRequest.extend({
  op: z.literal("annotations"),
  mode: z.enum(["add", "list"]),
  tabId: z.string().min(1).optional(),
  kind: z.enum(["click", "region"]).optional(),
  x: z.number().min(0).max(10000).optional(),
  y: z.number().min(0).max(10000).optional(),
  w: z.number().min(1).max(10000).optional(),
  h: z.number().min(1).max(10000).optional(),
  note: z.string().min(1).max(1000).optional(),
  screenshotRevision: z.number().int().nonnegative().optional(),
});

export const locateRequestSchema = baseRequest.extend({
  op: z.literal("locate"),
  ref: refSchema,
});

export const viewportRequestSchema = baseRequest.extend({
  op: z.literal("viewport"),
  preset: z.enum(["mobile", "tablet", "desktop"]).optional(),
  width: z.number().int().min(320).max(3840).optional(),
  height: z.number().int().min(320).max(2160).optional(),
  keepWindow: z
    .boolean()
    .optional()
    .describe(
      "Pin the page to the size without resizing the OS window (DevTools-style override)",
    ),
  free: z
    .boolean()
    .optional()
    .describe("Clear a viewport override; takes no size"),
});

export const createRequestSchema = baseRequest.extend({
  op: z.literal("create"),
  profile: z
    .string()
    .regex(
      /^[A-Za-z0-9_-]{1,64}$/,
      "profile names are [A-Za-z0-9_-], max 64 chars",
    )
    .optional()
    .describe("Named persistent profile, locked to one session at a time"),
});

export const actRequestSchema = baseRequest.extend({
  op: z.literal("act"),
  action: actionSchema,
  postcondition: postconditionSchema.optional(),
  /** Reject the action when the tab moved past this revision. */
  expectedRevision: z.number().int().nonnegative().optional(),
});

export const requestSchema = z.discriminatedUnion("op", [
  capabilitiesRequestSchema,
  openRequestSchema,
  observeRequestSchema,
  clickRequestSchema,
  fillRequestSchema,
  screenshotRequestSchema,
  closeRequestSchema,
  navigateRequestSchema,
  backRequestSchema,
  forwardRequestSchema,
  reloadRequestSchema,
  pressRequestSchema,
  selectRequestSchema,
  checkRequestSchema,
  scrollRequestSchema,
  hoverRequestSchema,
  waitRequestSchema,
  diagnosticsRequestSchema,
  sessionsRequestSchema,
  tabsRequestSchema,
  tabOpenRequestSchema,
  tabCloseRequestSchema,
  tabSelectRequestSchema,
  cancelRequestSchema,
  pauseRequestSchema,
  resumeRequestSchema,
  annotationsRequestSchema,
  locateRequestSchema,
  uploadRequestSchema,
  batchRequestSchema,
  searchRequestSchema,
  viewportRequestSchema,
  createRequestSchema,
  actRequestSchema,
]);

export type Request = z.infer<typeof requestSchema>;

export const artifactSchema = z.object({
  id: z.string(),
  kind: z.enum(["screenshot"]),
  /** Filesystem path. Only valid when caller shares the filesystem (Phase 0). */
  path: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  capturedAt: z.string(),
  observationRevision: z.number().int().nonnegative(),
});

export type Artifact = z.infer<typeof artifactSchema>;

export const postconditionResultSchema = z.object({
  status: z.enum(["satisfied", "timeout", "not-requested"]),
});

export const diagnosticsSchema = z.object({
  consoleErrors: z.array(z.string()),
  requestFailures: z.array(z.object({ url: z.string(), error: z.string() })),
  badResponses: z.array(
    z.object({ url: z.string(), status: z.number().int() }),
  ),
  downloads: z
    .array(
      z.object({
        id: z.string(),
        fileName: z.string(),
        path: z.string(),
        bytes: z.number().int(),
      }),
    )
    .default([]),
  dialog: z
    .object({ type: z.string(), message: z.string(), dismissed: z.boolean() })
    .optional()
    .describe("Most recent auto-dismissed dialog on this tab"),
});

export const deltaSchema = z.object({
  baseRevision: z.number().int().nonnegative().optional(),
  revision: z.number().int().nonnegative(),
  reset: z.boolean().default(false),
  resetReason: z.string().optional(),
  addedText: z.array(z.string()),
  removedText: z.array(z.string()),
  addedControls: z.array(controlSchema),
  removedRefs: z.array(z.string()),
});

export const overlaySchema = z.object({
  n: z.number().int().positive(),
  ref: refSchema,
  role: z.string(),
  name: z.string(),
  frame: z.string(),
  x: z.number(),
  y: z.number(),
});

export const locationSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

export const inspectionSchema = z.object({
  ref: refSchema,
  role: z.string(),
  name: z.string(),
  frame: z.string(),
  disabled: z.boolean(),
  visible: z.boolean(),
  box: locationSchema.nullable(),
  attributes: z.record(z.string()),
  text: z.string(),
});

export const matchSchema = z.object({
  ref: refSchema,
  role: z.string(),
  name: z.string(),
  frame: z.string(),
});

export const stepSchema = z.object({
  type: z.string(),
  ok: z.boolean(),
  code: z.string().optional(),
  message: z.string().optional(),
});

export const tabInfoSchema = z.object({
  id: z.string(),
  url: z.string(),
  current: z.boolean(),
});

export const sessionStateSchema = z.object({
  id: z.string(),
  paused: z.boolean(),
  owner: z.enum(["agent", "human"]),
  ownerSince: z.string().optional(),
  annotationCount: z.number().int().nonnegative(),
});

export const annotationSchema = z.object({
  id: z.string(),
  tabId: z.string(),
  revision: z.number().int().nonnegative(),
  kind: z.enum(["click", "region"]),
  x: z.number(),
  y: z.number(),
  w: z.number().optional(),
  h: z.number().optional(),
  note: z.string(),
  at: z.string(),
});

export const capabilitiesSchema = z.object({
  protocolVersion: z.string(),
  engine: z.string(),
  ops: z.array(z.string()),
  actionTypes: z.array(z.string()),
  observationModes: z.array(z.string()),
  deliveryMethods: z.array(z.string()),
  limits: z.object({
    maxTextChars: z.number().int(),
    maxControls: z.number().int(),
    maxScreenshotWidth: z.number().int(),
    maxScreenshotHeight: z.number().int(),
    maxResponseBytes: z.number().int(),
  }),
});

export const resultSchema = z.object({
  protocolVersion: protocolVersionSchema,
  requestId: z.string(),
  sessionId: z.string(),
  tabId: z.string(),
  status: z.enum(["completed"]),
  op: z.string(),
  observation: observationSchema.optional(),
  postcondition: postconditionResultSchema.optional(),
  diagnostics: diagnosticsSchema.optional(),
  capabilities: capabilitiesSchema.optional(),
  session: sessionStateSchema.optional(),
  annotations: z.array(annotationSchema).optional(),
  location: locationSchema.optional(),
  delta: deltaSchema.optional(),
  overlay: z.array(overlaySchema).optional(),
  inspection: inspectionSchema.optional(),
  matches: z.array(matchSchema).optional(),
  steps: z.array(stepSchema).optional(),
  sessions: z.array(z.string()).optional(),
  tabs: z.array(tabInfoSchema).optional(),
  artifacts: z.array(artifactSchema).default([]),
  warnings: z.array(z.string()).default([]),
});

export type Result = z.infer<typeof resultSchema>;

export const errorResultSchema = z.object({
  protocolVersion: protocolVersionSchema,
  requestId: z.string(),
  sessionId: z.string().optional(),
  tabId: z.string().optional(),
  status: z.literal("error"),
  code: z.string(),
  message: z.string(),
  outcomeUnknown: z.boolean(),
  retryable: z.boolean(),
});

export type ErrorResult = z.infer<typeof errorResultSchema>;
