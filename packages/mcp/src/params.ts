import { z } from "zod";

/** MCP tool parameters mirror the protocol contracts with plain JSON types. */

export const refSchema = z
  .string()
  .regex(
    /^el-\d+-\d+$/,
    "element reference from a fresh observation, e.g. el-5-7",
  );

const timeoutMs = z.number().int().min(250).max(30_000).default(5000);

export const conditionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("textVisible"),
    text: z.string().min(1).max(500),
    timeoutMs,
  }),
  z.object({
    type: z.literal("urlContains"),
    value: z.string().min(1).max(2000),
    timeoutMs,
  }),
  z.object({ type: z.literal("elementVisible"), ref: refSchema, timeoutMs }),
]);

export type Condition = z.infer<typeof conditionSchema>;

const mouseButtonSchema = z.enum(["left", "right", "middle"]);

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
    key: z
      .string()
      .min(1)
      .max(50)
      .describe("Key name, e.g. Enter, Tab, Backspace, a"),
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
    screenshotRevision: z.number().int().nonnegative(),
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
    screenshotRevision: z.number().int().nonnegative(),
    button: mouseButtonSchema.optional(),
  }),
  z.object({ type: z.literal("type"), text: z.string().min(1).max(4000) }),
  z.object({
    type: z.literal("upload"),
    ref: refSchema,
    file: z.string().min(1).max(4096),
  }),
]);

export type Action = z.infer<typeof actionSchema>;

export const sessionIdSchema = z
  .string()
  .min(1)
  .describe("Session id from browser_start");
export const tabIdSchema = z
  .string()
  .min(1)
  .optional()
  .describe("Tab id; omit for the selected tab");
