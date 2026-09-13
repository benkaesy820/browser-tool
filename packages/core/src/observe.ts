import type { Page } from "playwright";
import { getCapabilities } from "@browser-bridge/protocol";
import type { Collection } from "./refs.js";
import type { Observation } from "@browser-bridge/protocol";

export interface Snapshot {
  observation: Observation;
}

function truncate(
  text: string,
  max: number,
): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

export async function snapshot(
  page: Page,
  revision: number,
  collected: Collection,
): Promise<Snapshot> {
  const caps = getCapabilities();
  const url = page.url();
  let title = "";
  try {
    title = await page.title();
  } catch {
    title = "";
  }
  let rawText = "";
  try {
    rawText = await page.locator("body").innerText();
  } catch {
    rawText = "";
  }
  // Agents must see framed content too (iframes hold real controls).
  for (const frame of page.frames().slice(1)) {
    try {
      const part = await frame.locator("body").innerText();
      if (part.trim()) rawText += `\n${part}`;
    } catch {
      // Cross-origin or detached frame: controls may still resolve.
    }
  }
  const normalized = rawText
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const t = truncate(normalized, caps.limits.maxTextChars);
  const controls = collected.targets.map((x) => ({
    ref: x.ref,
    role: x.role,
    name: x.name,
    frame: x.frame,
    disabled: x.disabled,
  }));
  const truncated =
    t.truncated ||
    (await page
      .locator("body")
      .count()
      .then(() => false)
      .catch(() => true));
  return {
    observation: {
      revision,
      url,
      title,
      text: t.text,
      controls,
      frames: collected.frames.map((f) => ({
        id: f.id,
        url: f.url,
        ...(f.name ? { name: f.name } : {}),
        ...(f.error ? { error: f.error } : {}),
      })),
      truncated,
      ...(t.truncated
        ? {
            continuation:
              "Text truncated at 8000 chars. Use mode=inspect on a control or narrow the page.",
          }
        : {}),
    },
  };
}
