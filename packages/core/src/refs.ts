import type { Frame, Locator, Page } from "playwright";

export interface RegisteredTarget {
  ref: string;
  role: string;
  name: string;
  /** nth interactive match within its frame at observation time. */
  index: number;
  /** Frame id (f0 = main frame). */
  frame: string;
  /** Position in page.frames() at collection; best effort for overlays. */
  frameIndex: number;
  frameUrl: string;
  disabled: boolean;
}

export interface FrameSummary {
  id: string;
  url: string;
  name?: string;
  error?: string;
}

export interface Collection {
  targets: RegisteredTarget[];
  frames: FrameSummary[];
}

export const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="option"]',
  '[role="menuitem"]',
  '[role="region"]',
].join(", ");

/** Accessible name fallback chain: aria-label > associated label > text > value > placeholder > tag. */
async function describeElement(
  el: Locator,
): Promise<{ role: string; name: string; disabled: boolean }> {
  const info = await el.evaluate((node) => {
    const e = node as HTMLElement;
    const ariaRole = e.getAttribute("role");
    const tag = e.tagName.toLowerCase();
    const type = (e.getAttribute("type") ?? "").toLowerCase();
    let role = ariaRole ?? tag;
    if (tag === "input")
      role =
        ariaRole ??
        (type === "checkbox"
          ? "checkbox"
          : type === "radio"
            ? "radio"
            : type === "range"
              ? "slider"
              : "textbox");
    if (tag === "a") role = ariaRole ?? "link";
    if (tag === "button") role = ariaRole ?? "button";
    if (tag === "select") role = ariaRole ?? "combobox";
    const ariaLabel = e.getAttribute("aria-label") ?? "";
    const labelEls = (
      e as unknown as { labels?: NodeListOf<HTMLLabelElement> | null }
    ).labels;
    const labelledBy =
      labelEls && labelEls.length > 0
        ? ((labelEls[0] as HTMLElement).innerText ?? "").trim()
        : "";
    const text = (e.innerText ?? "").trim().slice(0, 120);
    const value = (e as HTMLInputElement).value ?? "";
    const placeholder = e.getAttribute("placeholder") ?? "";
    const name =
      ariaLabel || labelledBy || text || value || placeholder || `${tag}`;
    const disabled =
      (e as HTMLButtonElement).disabled === true ||
      e.getAttribute("aria-disabled") === "true";
    return { role, name: name.slice(0, 120), disabled };
  });
  return info;
}

async function collectInFrame(
  frame: Frame,
  frameId: string,
  frameIndex: number,
  frameUrl: string,
  maxControls: number,
  revision: number,
  startIndex: number,
): Promise<{ targets: RegisteredTarget[] }> {
  const locator = frame.locator(INTERACTIVE_SELECTOR);
  const count = await locator.count();
  const targets: RegisteredTarget[] = [];
  const limit = Math.min(count, maxControls);
  for (let i = 0; i < limit; i++) {
    const el = locator.nth(i);
    if ((await el.count()) === 0) continue;
    let visible = false;
    try {
      visible = await el.isVisible();
    } catch {
      visible = false;
    }
    if (!visible) continue;
    const info = await describeElement(el);
    // Revision-qualified: a string from rN never resolves at rM, so a
    // changed page cannot silently repoint an old handle (plan §5 rule 3).
    targets.push({
      ref: `el-${revision}-${startIndex + targets.length + 1}`,
      role: info.role,
      name: info.name,
      index: i,
      frame: frameId,
      frameIndex,
      frameUrl,
      disabled: info.disabled,
    });
  }
  return { targets };
}

export async function collectTargets(
  page: Page,
  maxControls: number,
  revision: number,
): Promise<Collection> {
  const targets: RegisteredTarget[] = [];
  const frames: FrameSummary[] = [];
  const all = page.frames();
  for (let f = 0; f < all.length; f++) {
    const frame = all[f] as Frame;
    const id = `f${f}`;
    const url = frame.url();
    let name: string | undefined;
    try {
      name = (await frame
        .evaluate(() => window.name || undefined)
        .catch(() => undefined)) as string | undefined;
    } catch {
      name = undefined;
    }
    frames.push({ id, url, ...(name ? { name } : {}) });
    const remaining = maxControls - targets.length;
    if (remaining <= 0) break;
    try {
      const collected = await collectInFrame(
        frame,
        id,
        f,
        url,
        remaining,
        revision,
        targets.length,
      );
      targets.push(...collected.targets);
    } catch (err) {
      frames[f] = {
        id,
        url,
        ...(name ? { name } : {}),
        error: String(err).slice(0, 200),
      };
    }
  }
  return { targets, frames };
}

const INSPECT_ATTRIBUTES = [
  "id",
  "class",
  "href",
  "value",
  "placeholder",
  "type",
  "name",
  "role",
  "aria-label",
  "aria-disabled",
  "aria-expanded",
  "aria-checked",
  "for",
  "target",
  "alt",
  "title",
  "data-testid",
];

/** Focused element details for inspect mode (one controlled evaluation). */
export async function inspectElement(el: Locator): Promise<{
  role: string;
  name: string;
  disabled: boolean;
  attributes: Record<string, string>;
  text: string;
}> {
  const info = await el.evaluate((node, allowlist: string[]) => {
    const e = node as HTMLElement;
    const ariaRole = e.getAttribute("role");
    const tag = e.tagName.toLowerCase();
    const type = (e.getAttribute("type") ?? "").toLowerCase();
    let role = ariaRole ?? tag;
    if (tag === "input")
      role =
        ariaRole ??
        (type === "checkbox"
          ? "checkbox"
          : type === "radio"
            ? "radio"
            : type === "range"
              ? "slider"
              : "textbox");
    if (tag === "a") role = ariaRole ?? "link";
    if (tag === "button") role = ariaRole ?? "button";
    if (tag === "select") role = ariaRole ?? "combobox";
    const attributes: Record<string, string> = {};
    for (const key of allowlist) {
      const value = e.getAttribute(key);
      if (value !== null && value !== "") attributes[key] = value.slice(0, 300);
    }
    return {
      role,
      name: ((e as HTMLElement).innerText ?? "").trim().slice(0, 300),
      disabled:
        (e as HTMLButtonElement).disabled === true ||
        e.getAttribute("aria-disabled") === "true",
      attributes,
      text: ((e as HTMLElement).innerText ?? "").trim().slice(0, 1000),
    };
  }, INSPECT_ATTRIBUTES);
  return info;
}

/**
 * Revalidate a ref immediately before acting (plan §5 rule 4).
 * Matches within the ref's own frame; identical controls in several
 * frames are ambiguous, never silently first-picked (plan §5 rule 2).
 */
export async function resolveTarget(
  page: Page,
  targets: RegisteredTarget[],
  ref: string,
): Promise<{ locator: Locator; target: RegisteredTarget }> {
  const target = targets.find((t) => t.ref === ref);
  if (!target) {
    const err = new Error(
      `Unknown or stale ref ${ref}. Re-observe and retry with a fresh ref.`,
    );
    (err as NodeJS.ErrnoException).code = "STALE_OBSERVATION";
    throw err;
  }
  const matches: Array<{ frame: Frame; t: RegisteredTarget }> = [];
  for (const frame of page.frames()) {
    if (frame.url() !== target.frameUrl) continue;
    // Throwaway generation for revalidation: only role/name/index are read.
    const fresh = await collectInFrame(
      frame,
      target.frame,
      target.frameIndex,
      target.frameUrl,
      500,
      0,
      0,
    );
    for (const t of fresh.targets) {
      if (t.role === target.role && t.name === target.name)
        matches.push({ frame, t });
    }
  }
  if (matches.length === 0) {
    const err = new Error(
      `Target ${ref} (${target.role} "${target.name}") detached since observation.`,
    );
    (err as NodeJS.ErrnoException).code = "STALE_OBSERVATION";
    throw err;
  }
  if (matches.length > 1) {
    const err = new Error(
      `Ambiguous target: ${matches.length} controls match ${target.role} "${target.name}". Refine scope; refusing to pick the first match.`,
    );
    (err as NodeJS.ErrnoException).code = "TARGET_AMBIGUOUS";
    throw err;
  }
  const found = matches[0] as { frame: Frame; t: RegisteredTarget };
  if (found.t.disabled) {
    const err = new Error(`Target ${ref} is disabled and not actionable.`);
    (err as NodeJS.ErrnoException).code = "TARGET_NOT_ACTIONABLE";
    throw err;
  }
  const locator = found.frame.locator(INTERACTIVE_SELECTOR).nth(found.t.index);
  return { locator, target: found.t };
}
