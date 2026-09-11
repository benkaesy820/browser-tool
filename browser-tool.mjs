#!/usr/bin/env node

/**
 * Agent-first browser automation, diagnostics, workflows, and visual evidence.
 * Single-file Playwright utility designed for bounded, low-token results.
 *
 * Core surface:
 * - Persistent JSONL sessions: open, observe, act, close.
 * - Bounded semantic maps, health probes, workflows, responsive screenshots, and pixel diffs.
 * - Scoped auth, network simulation, geolocation, timezone, and sensitive-data redaction.
 */

import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

// ==========================================
// 1. PRESETS & CONSTANTS
// ==========================================
export const VIEWPORT_PRESETS = {
  desktop: { name: 'desktop-wide', viewport: { width: 1920, height: 1080 }, isMobile: false, hasTouch: false },
  laptop: { name: 'laptop-standard', viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false },
  tablet: { name: 'tablet-ipad', viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  'tablet-landscape': { name: 'tablet-landscape', viewport: { width: 1180, height: 820 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  mobile: { name: 'mobile-iphone', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
  'mobile-small': { name: 'mobile-compact', viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
};

export const NETWORK_PROFILES = {
  'slow-3g': { downloadThroughput: ((500 * 1024) / 8) * 0.8, uploadThroughput: ((500 * 1024) / 8) * 0.8, latency: 400 * 5 },
  'fast-3g': { downloadThroughput: ((1.6 * 1024 * 1024) / 8) * 0.9, uploadThroughput: ((750 * 1024) / 8) * 0.9, latency: 150 * 3.75 },
  'offline': { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }
};

export const QA_PRESET_MODES = {
  smoke: ['desktop'],
  standard: ['desktop', 'mobile'],
  release: ['desktop', 'laptop', 'tablet', 'tablet-landscape', 'mobile', 'mobile-small']
};

const DEFAULT_ACTION_TIMEOUT = 8000;
const DEFAULT_AGENT_ITEM_LIMIT = 40;
const DEFAULT_AGENT_TEXT_LIMIT = 700;
const DEFAULT_PAGE_READY_TIMEOUT = 10000;
const DEFAULT_SCREENSHOT_CONCURRENCY = 2;
const DEFAULT_MAX_OUTPUT_CHARS = 20000;
const DEFAULT_MAX_AGENT_SESSIONS = 8;
const DEFAULT_SESSION_IDLE_TIMEOUT = 30 * 60 * 1000;
const MAX_SESSION_REQUEST_CHARS = 250_000;
const MAX_SESSION_DIAGNOSTICS = 500;
const MAX_SESSION_SUBSCRIPTIONS = 32;
const MAX_SESSION_WATCHERS = 32;
const MAX_VIEWPORT_DIMENSION = 10000;
const TRACE_MODES = new Set(['off', 'on', 'on-failure']);
const SAFETY_MODES = new Set(['standard', 'safe', 'unsafe']);
const SESSION_OPERATIONS = new Set(['capabilities', 'sessions', 'open', 'observe', 'act', 'batch', 'tabs', 'subscribe', 'unsubscribe', 'watch', 'unwatch', 'close', 'quit', 'exit']);
const AGENT_ACTIONS = new Set(['click', 'fill', 'type', 'check', 'uncheck', 'select', 'selectOption', 'hover', 'press', 'scroll', 'navigate', 'goto', 'wait', 'assert', 'dialog', 'download', 'permissions', 'screenshot']);
const WORKFLOW_ACTIONS = new Set(['navigate', 'goto', 'upload', 'setInputFiles', 'dragAndDrop', 'drag', 'switchTab', 'mockRoute', 'mockApi', 'saveState', 'dialog', 'download', 'permissions', 'click', 'fill', 'type', 'check', 'uncheck', 'select', 'selectOption', 'press', 'hover', 'scroll', 'wait', 'assert', 'scrape', 'getText', 'screenshot', 'evaluate']);
const SESSION_EVENT_NAMES = new Set(['navigation', 'navigation.blocked', 'console.error', 'console.warning', 'network.error', 'request.failed', 'page.crash', 'page.closed', 'page.opened', 'dialog', 'download', 'watch.matched', 'watch.timeout', 'watch.error']);
const DEFAULT_SESSION_EVENTS = [...SESSION_EVENT_NAMES];
const MAX_WORKFLOW_STEPS = 200;
const MAX_BATCH_STEPS = 25;
const MAX_WORKFLOW_FILE_BYTES = 2_000_000;
const DEFAULT_WATCH_TIMEOUT = 30_000;
const MAX_WATCH_TIMEOUT = 10 * 60 * 1000;
const WATCH_REGISTRY_KEY = '__browser_tool_watchers__';
const PROTOCOL_VERSION = '1';
const NON_IDEMPOTENT_WORKFLOW_ACTIONS = new Set([
  'click', 'fill', 'type', 'check', 'uncheck', 'select', 'selectOption', 'press',
  'upload', 'setInputFiles', 'drag', 'dragAndDrop', 'download', 'permissions',
  'evaluate', 'mockRoute', 'mockApi', 'saveState'
]);
const DEFAULT_VISUAL_STABILITY_TIMEOUT = 5000;
const MAX_WORKFLOW_RETRIES = 10;
const CLI_BOOLEAN_OPTIONS = new Set([
  'allow-sensitive-trace', 'allow-overflow', 'allow-warnings', 'all',
  'force', 'fullpage', 'headless', 'json', 'no-freeze',
  'record', 'redact', 'retry-side-effects', 'safe', 'screenshot',
  'skip-layout', 'snapshots', 'unsafe'
]);
const activeAgentSessions = new Map();
// Session ids disposed moments ago, so cleanup `close` calls can be idempotent
// (an agent that was told SESSION_EXPIRED should not then trip over its own
// cleanup with SESSION_NOT_FOUND). Bounded to avoid unbounded growth.
const recentlyDisposedSessions = new Map();
const configuredContextFeatures = new WeakSet();

const VISUAL_STABILITY_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0s !important;
    caret-color: transparent !important;
  }
`;

const FAST_LAUNCH_ARGS = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-breakpad',
  '--disable-component-update',
  '--disable-sync'
];

class BrowserToolError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'BrowserToolError';
    this.code = code;
    this.details = details;
  }
}

// ==========================================
// 2. RESILIENT BROWSER LAUNCHER
// ==========================================
function bundledLaunchConfig(options) {
  const { headless = true, slowMo = 0, devtools = false } = options;
  return { headless, slowMo, devtools, args: FAST_LAUNCH_ARGS };
}

export async function launchResilientBrowser(options = {}) {
  try {
    const browser = await chromium.launch(bundledLaunchConfig(options));
    return { browser, channelUsed: 'bundled-chromium', attempts: [] };
  } catch (err) {
    const launchError = new Error(`[Browser Launcher] Bundled Chromium failed: ${errorMessage(err)}. Repair it with "npm run browsers:install".`);
    launchError.attempts = [{ candidate: 'bundled-chromium', error: errorMessage(err) }];
    throw launchError;
  }
}

export async function checkBrowserAvailability(options = {}) {
  const { headless = true } = options;
  let browser = null;
  try {
    browser = await chromium.launch(bundledLaunchConfig({ headless }));
    const version = browser.version();
    return { status: 'ok', channelUsed: 'bundled-chromium', browserVersion: version, attempts: [] };
  } catch (err) {
    return { status: 'error', channelUsed: null, browserVersion: null, attempts: [{ candidate: 'bundled-chromium', error: errorMessage(err) }], installHint: 'Run "npm run browsers:install", then run the doctor again.' };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function resolveBrowser(options = {}) {
  const {
    browser: providedBrowser = null,
    channelUsed = null,
    headless = true,
    slowMo = 0,
    devtools = false
  } = options;

  if (providedBrowser) {
    return { browser: providedBrowser, channelUsed: channelUsed || 'shared-browser', attempts: [], ownsBrowser: false };
  }

  const launched = await launchResilientBrowser({ headless, slowMo, devtools });
  return { ...launched, ownsBrowser: true };
}

const REDACTION_CSS = `
  input[type="password"], [data-sensitive], .sensitive-data {
    filter: blur(8px) !important;
  }
`;
const REDACTION_INIT_SCRIPT = `(() => {
  const styleId = '__browser_tool_redaction__';
  const css = ${JSON.stringify(REDACTION_CSS)};
  const install = () => {
    if (!document.documentElement || document.getElementById(styleId)) return;
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  };
  install();
  new MutationObserver(install).observe(document, { childList: true, subtree: true });
})();`;

async function applyRedaction(page) {
  await page.addStyleTag({ content: REDACTION_CSS }).catch(() => {});
}

function isHttpUrl(url) {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

async function configureContextFeatures(context, page, options = {}) {
  const { network, redact, token, cookie, geo, timezone, url } = options;

  // 1. Direct Token Injection. Keep credentials scoped to the target origin.
  if (token && !url) throw new Error('Token injection requires a target URL for origin scoping.');
  if ((token || cookie) && url && !isHttpUrl(url)) throw new Error('Token and cookie injection require an http(s) target URL.');
  const targetOrigin = url ? new URL(url).origin : null;
  const normalizedToken = typeof token === 'string' ? token.trim() : '';
  const authHeader = normalizedToken ? (/^Bearer\s+/i.test(normalizedToken) ? normalizedToken : `Bearer ${normalizedToken}`) : null;
  if (network && !NETWORK_PROFILES[network]) throw new Error(`Unknown network profile: ${network}. Expected slow-3g, fast-3g, or offline.`);

  // 2. Direct Cookie Injection
  if (cookie && !url) throw new Error('Cookie injection requires a target URL for origin scoping.');
  const firstContextConfiguration = !configuredContextFeatures.has(context);
  if (cookie && url && firstContextConfiguration) {
    try {
      const parsedUrl = new URL(url);
      const cookiesList = cookie.split(';').map(rawCookie => rawCookie.trim()).filter(Boolean).map((rawCookie) => {
        const separator = rawCookie.indexOf('=');
        if (separator <= 0) throw new Error('Invalid cookie segment. Expected name=value.');
        const name = rawCookie.slice(0, separator).trim();
        const value = rawCookie.slice(separator + 1).trim();
        if (!name) throw new Error('Cookie name cannot be empty.');
        return { name, value, domain: parsedUrl.hostname, path: '/' };
      });
      if (cookiesList.length === 0) throw new Error('Cookie string cannot be empty.');
      await context.addCookies(cookiesList);
    } catch (err) {
      throw new Error(`Cookie injection failed: ${errorMessage(err)}`);
    }
  }

  // 3. Network Throttling
  if (network && NETWORK_PROFILES[network]) {
    const profile = NETWORK_PROFILES[network];
    try {
      const session = await context.newCDPSession(page);
      await session.send('Network.emulateNetworkConditions', {
        offline: Boolean(profile.offline),
        latency: profile.latency || 0,
        downloadThroughput: profile.downloadThroughput || -1,
        uploadThroughput: profile.uploadThroughput || -1
      });
    } catch (err) {
      if (options.strict) throw new Error(`Network emulation failed: ${err.message}`);
    }
  }

  if (firstContextConfiguration) {
    // 4. Credentials use one context route so authorization is not
    // sent to third-party assets or lost when a popup opens.
    if (authHeader) {
      await context.route('**/*', async (route) => {
        try {
          const requestUrl = new URL(route.request().url());
          const headers = { ...route.request().headers() };
          if (authHeader && (!targetOrigin || requestUrl.origin === targetOrigin)) headers.authorization = authHeader;
          await route.continue({ headers });
        } catch {
          await route.continue().catch(() => {});
        }
      });
    }

    // 5. Install redaction at document start and reapply after navigation so
    // screenshots and recordings do not expose sensitive fields.
    if (redact) await context.addInitScript({ content: REDACTION_INIT_SCRIPT });
    configuredContextFeatures.add(context);
  }

  // Network emulation is page/CDP scoped, so configure every page once.
}

function parseGeo(geoStr) {
  if (!geoStr) return null;
  const [lat, lng] = geoStr.split(',').map(Number);
  if (Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
    return { latitude: lat, longitude: lng };
  }
  throw new BrowserToolError('INVALID_GEO', `Invalid geolocation "${geoStr}". Expected latitude -90..90 and longitude -180..180.`);
}

function parseClip(clipStr) {
  if (!clipStr || typeof clipStr !== 'string') return null;
  const [x, y, width, height] = clipStr.split(',').map(Number);
  if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(width) && Number.isFinite(height) && x >= 0 && y >= 0 && width > 0 && height > 0) {
    return { x, y, width, height };
  }
  throw new BrowserToolError('INVALID_CLIP', `Invalid clip "${clipStr}". Expected x,y,width,height with positive width and height.`);
}

function parseViewportSize(size) {
  if (size === undefined || size === null) return null;
  if (typeof size !== 'string' || !/^\d+x\d+$/.test(size)) {
    throw new BrowserToolError('INVALID_VIEWPORT_SIZE', '--size must use WIDTHxHEIGHT, for example 1280x720.');
  }
  const [width, height] = size.split('x').map(Number);
  return validateViewport({ width, height });
}

function resolveTargetScope(page, frameSelector) {
  if (!frameSelector) return page;
  return page.frameLocator(frameSelector);
}

function redactSensitiveText(value) {
  return String(value ?? '')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/((?:token|secret|password|passwd|authorization|cookie|api[-_]?key)\s*[:=]\s*)[^\s,;&]+/gi, '$1[redacted]')
    .slice(0, 700);
}

function errorMessage(err) {
  return redactSensitiveText((err instanceof Error ? err.message : String(err))
    .replace(/\u001b\[[0-9;]*m/g, '')
  );
}

function errorCode(err) {
  return err instanceof BrowserToolError && err.code ? err.code : 'BROWSER_TOOL_ERROR';
}

function errorDetails(err) {
  return err instanceof BrowserToolError && err.details !== undefined ? err.details : undefined;
}

function isConsoleWarningType(type) {
  return type === 'warning' || type === 'warn';
}

function normalizeRetryCount(value) {
  const retries = value === undefined || value === null ? 0 : Number(value);
  if (!Number.isInteger(retries) || retries < 0 || retries > MAX_WORKFLOW_RETRIES) {
    throw new BrowserToolError('INVALID_RETRY_COUNT', `retries must be an integer from 0 to ${MAX_WORKFLOW_RETRIES}.`);
  }
  return retries;
}

function requireString(value, code, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new BrowserToolError(code, `${field} must be a non-empty string.`);
  return value;
}

function validateWorkflowSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) throw new BrowserToolError('INVALID_WORKFLOW', 'Workflow must contain at least one step.');
  if (steps.length > MAX_WORKFLOW_STEPS) throw new BrowserToolError('WORKFLOW_TOO_LARGE', `Workflow cannot contain more than ${MAX_WORKFLOW_STEPS} steps.`);
  const retryCounts = [];
  steps.forEach((step, index) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      throw new BrowserToolError('INVALID_WORKFLOW_STEP', `Workflow step ${index + 1} must be a JSON object.`);
    }
    const action = requireString(step.action, 'INVALID_WORKFLOW_ACTION', `Workflow step ${index + 1} action`);
    if (!WORKFLOW_ACTIONS.has(action)) throw new BrowserToolError('UNSUPPORTED_ACTION', `Unsupported action: "${action}".`, { step: index + 1, action });
    retryCounts.push(normalizeRetryCount(step.retries));
    if (['navigate', 'goto'].includes(action)) requireString(step.url, 'INVALID_WORKFLOW_STEP', `Workflow step ${index + 1} url`);
    if (['click', 'fill', 'type', 'check', 'uncheck', 'select', 'selectOption', 'hover', 'assert', 'scrape', 'getText', 'upload', 'setInputFiles'].includes(action)) {
      requireString(step.selector, 'INVALID_WORKFLOW_STEP', `Workflow step ${index + 1} selector`);
    }
    const hasUploadFiles = Array.isArray(step.files) ? step.files.length > 0 : Boolean(step.files || step.file || step.path);
    if (['upload', 'setInputFiles'].includes(action) && !hasUploadFiles) {
      throw new BrowserToolError('INVALID_WORKFLOW_STEP', `Workflow step ${index + 1} upload requires files, file, or path.`);
    }
    if (action === 'dragAndDrop' || action === 'drag') {
      requireString(step.source || step.from, 'INVALID_WORKFLOW_STEP', `Workflow step ${index + 1} source`);
      requireString(step.target || step.to, 'INVALID_WORKFLOW_STEP', `Workflow step ${index + 1} target`);
    }
    if (action === 'evaluate' && typeof step.fn !== 'function' && typeof step.fn !== 'string' && typeof step.script !== 'string') {
      throw new BrowserToolError('INVALID_WORKFLOW_STEP', `Workflow step ${index + 1} evaluate requires fn or script.`);
    }
  });
  return retryCounts;
}

function validateSessionRequest(request) {
  const operation = request.op || request.action;
  if (typeof operation !== 'string' || !SESSION_OPERATIONS.has(operation)) {
    throw new BrowserToolError('UNSUPPORTED_OPERATION', `Unsupported session operation: ${operation}`);
  }
  if (operation === 'open') requireString(request.url, 'MISSING_URL', 'open url');
  if (operation === 'observe') {
    if (request.mode !== undefined && request.mode !== 'full' && request.mode !== 'delta') throw new BrowserToolError('INVALID_OBSERVE_MODE', 'observe mode must be full or delta.');
    if (request.view !== undefined && !['standard', 'controls'].includes(request.view)) throw new BrowserToolError('INVALID_OBSERVE_VIEW', 'observe view must be standard or controls.');
  }
  if (operation === 'batch') {
    if (!Array.isArray(request.steps) || request.steps.length === 0) throw new BrowserToolError('INVALID_BATCH', 'batch steps must be a non-empty array.');
    if (request.steps.length > MAX_BATCH_STEPS) throw new BrowserToolError('BATCH_TOO_LARGE', `batch cannot contain more than ${MAX_BATCH_STEPS} steps.`);
    request.steps.forEach((step, index) => {
      if (!step || typeof step !== 'object' || Array.isArray(step)) {
        throw new BrowserToolError('INVALID_BATCH_STEP', `batch step ${index + 1} must be a JSON object.`);
      }
      const stepAction = requireString(step.action, 'INVALID_BATCH_STEP', `batch step ${index + 1} action`);
      if (!AGENT_ACTIONS.has(stepAction) && stepAction !== 'evaluate') {
        throw new BrowserToolError('UNSUPPORTED_ACTION', `Unsupported batch action in step ${index + 1}: "${stepAction}".`, { step: index + 1, action: stepAction });
      }
    });
    if (request.observeAfter !== undefined && !['none', 'delta', 'full'].includes(request.observeAfter)) {
      throw new BrowserToolError('INVALID_BATCH', 'batch observeAfter must be none, delta, or full.');
    }
  }
  if (operation === 'tabs') {
    const tabAction = request.action || 'list';
    if (!['list', 'switch', 'close'].includes(tabAction)) throw new BrowserToolError('INVALID_TAB_ACTION', 'tabs action must be list, switch, or close.');
    if (['switch', 'close'].includes(tabAction)) {
      const index = Number(request.index);
      if (!Number.isInteger(index) || index < 0) throw new BrowserToolError('INVALID_TAB_INDEX', `tabs ${tabAction} requires a non-negative integer index.`);
    }
  }
  if (operation === 'subscribe') {
    normalizeEventList(request.events);
    normalizeCoalesceMs(request.coalesceMs ?? request['coalesce-ms']);
  }
  if (operation === 'unsubscribe') requireString(request.subscriptionId, 'MISSING_SUBSCRIPTION', 'unsubscribe subscriptionId');
  if (operation === 'watch') {
    requireString(request.selector, 'MISSING_TARGET', 'watch selector');
    const state = request.state || 'visible';
    if (!['attached', 'detached', 'visible', 'hidden'].includes(state)) throw new BrowserToolError('INVALID_WATCH_STATE', 'watch state must be attached, detached, visible, or hidden.');
    normalizeWatchTimeout(request.timeout ?? request.timeoutMs ?? request['timeout-ms']);
    if (request.containsText !== undefined) requireString(request.containsText, 'INVALID_WATCH', 'watch containsText');
    if (request.equalsText !== undefined) requireString(request.equalsText, 'INVALID_WATCH', 'watch equalsText');
  }
  if (operation === 'unwatch') requireString(request.watcherId, 'MISSING_WATCHER', 'unwatch watcherId');
  if (operation === 'act') {
    const action = requireString(request.action, 'INVALID_ACTION', 'act action');
    if (!AGENT_ACTIONS.has(action)) throw new BrowserToolError('UNSUPPORTED_ACTION', `Unsupported agent action: "${action}".`, { action });
    if (['click', 'fill', 'type', 'check', 'uncheck', 'select', 'selectOption', 'hover', 'assert'].includes(action)
      && !request.ref && !request.selector) throw new BrowserToolError('MISSING_TARGET', `${action} requires ref or selector.`);
    if (['navigate', 'goto'].includes(action)) requireString(request.url, 'INVALID_ACTION', `${action} url`);
  }
  return operation;
}

function getCapabilities() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    commands: ['capabilities', 'serve', 'session', 'doctor', 'map', 'probe', 'qa', 'interact', 'screenshot', 'diff', 'layout', 'clean', 'presets'],
    sessionOperations: [...SESSION_OPERATIONS],
    agentActions: [...AGENT_ACTIONS],
    workflowActions: [...WORKFLOW_ACTIONS],
    observeModes: ['full', 'delta'],
    observeViews: ['standard', 'controls'],
    optionalSessionActions: ['evaluate (requires the session to be opened with allowEvaluate: true)'],
    eventNames: [...SESSION_EVENT_NAMES],
    safetyModes: [...SAFETY_MODES],
    features: [
      'request-ids', 'structured-errors', 'bounded-output', 'semantic-locator-fallbacks',
      'diagnostic-filters', 'delta-observations', 'event-subscriptions', 'dom-watchers',
      'workflow-validation', 'safe-mode', 'session-discovery', 'ref-recovery',
      'batch-operations', 'observation-views', 'tab-management', 'opt-in-session-evaluate',
      'idempotent-close'
    ],
    defaultLimits: {
      maxItems: DEFAULT_AGENT_ITEM_LIMIT,
      maxText: DEFAULT_AGENT_TEXT_LIMIT,
      maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS,
      maxSessions: DEFAULT_MAX_AGENT_SESSIONS,
      idleTimeout: DEFAULT_SESSION_IDLE_TIMEOUT,
      maxWorkflowSteps: MAX_WORKFLOW_STEPS,
      maxWorkflowRetries: MAX_WORKFLOW_RETRIES,
      maxWorkflowFileBytes: MAX_WORKFLOW_FILE_BYTES,
      defaultWatchTimeout: DEFAULT_WATCH_TIMEOUT
    },
    maximumLimits: {
      maxSessionRequestChars: MAX_SESSION_REQUEST_CHARS,
      maxSessionDiagnostics: MAX_SESSION_DIAGNOSTICS,
      maxSessionSubscriptions: MAX_SESSION_SUBSCRIPTIONS,
      maxSessionWatchers: MAX_SESSION_WATCHERS,
      maxWatchTimeout: MAX_WATCH_TIMEOUT,
      maxViewportDimension: MAX_VIEWPORT_DIMENSION,
      maxBatchSteps: MAX_BATCH_STEPS
    }
  };
}

function normalizeNonNegativeInteger(value, name, fallback = 0) {
  const normalized = value === undefined || value === null ? fallback : Number(value);
  if (!Number.isInteger(normalized) || normalized < 0) throw new BrowserToolError('INVALID_LIMIT', `${name} must be a non-negative integer.`);
  return normalized;
}

function normalizeAgentLimit(value, name, minimum, maximum) {
  if (value === undefined || value === null) return undefined;
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw new BrowserToolError('INVALID_LIMIT', `${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return normalized;
}

function normalizeEventList(value) {
  const values = value === undefined || value === null ? DEFAULT_SESSION_EVENTS : Array.isArray(value) ? value : String(value).split(',');
  const events = values.map(event => String(event).trim()).filter(Boolean);
  if (events.length === 0) throw new BrowserToolError('INVALID_EVENT_LIST', 'events must contain at least one event name.');
  if (events.length > SESSION_EVENT_NAMES.size) throw new BrowserToolError('INVALID_EVENT_LIST', `events cannot contain more than ${SESSION_EVENT_NAMES.size} entries.`);
  if (events.some(event => event !== 'all' && !SESSION_EVENT_NAMES.has(event))) {
    throw new BrowserToolError('INVALID_EVENT_LIST', `Unsupported event. Expected one of: ${[...SESSION_EVENT_NAMES].join(', ')}.`);
  }
  return [...new Set(events)];
}

function normalizeWatchTimeout(value) {
  const timeout = value === undefined || value === null ? DEFAULT_WATCH_TIMEOUT : Number(value);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_WATCH_TIMEOUT) {
    throw new BrowserToolError('INVALID_WATCH_TIMEOUT', `watch timeout must be an integer from 1 to ${MAX_WATCH_TIMEOUT} milliseconds.`);
  }
  return timeout;
}

function normalizeCoalesceMs(value) {
  const coalesceMs = value === undefined || value === null ? 100 : Number(value);
  if (!Number.isInteger(coalesceMs) || coalesceMs < 0 || coalesceMs > 5000) {
    throw new BrowserToolError('INVALID_COALESCE', 'coalesceMs must be an integer from 0 to 5000 milliseconds.');
  }
  return coalesceMs;
}

function appendBounded(collection, value, limit = MAX_SESSION_DIAGNOSTICS) {
  collection.push(value);
  if (collection.length > limit) collection.splice(0, collection.length - limit);
}

function normalizeTraceMode(value) {
  if (value === true) return 'on-failure';
  if (!value || value === false) return 'off';
  const mode = String(value).toLowerCase();
  if (!TRACE_MODES.has(mode)) throw new Error(`Unknown trace mode: ${mode}. Expected off, on, or on-failure.`);
  return mode;
}

function safeArtifactFilename(value, fallback) {
  const name = String(value || fallback);
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new Error('Artifact filenames must be simple filenames without path separators.');
  }
  return name;
}

function validateViewport(viewport) {
  if (!viewport || !Number.isInteger(viewport.width) || !Number.isInteger(viewport.height)
    || viewport.width < 1 || viewport.height < 1
    || viewport.width > MAX_VIEWPORT_DIMENSION || viewport.height > MAX_VIEWPORT_DIMENSION) {
    throw new BrowserToolError('INVALID_VIEWPORT', `Invalid viewport. Width and height must be integers from 1 to ${MAX_VIEWPORT_DIMENSION}.`);
  }
  return viewport;
}

function normalizePresetList(presets, fallback = ['desktop', 'mobile']) {
  const values = Array.isArray(presets) ? presets : typeof presets === 'string' ? presets.split(',') : fallback;
  const normalized = values.map(value => String(value).trim()).filter(Boolean);
  const expanded = normalized.length === 1 && normalized[0] === 'all'
    ? ['desktop', 'laptop', 'tablet', 'tablet-landscape', 'mobile', 'mobile-small']
    : normalized;
  return [...new Set(expanded)];
}

function selectOptionDescriptor(options) {
  if (options.value !== undefined) return typeof options.value === 'number' ? String(options.value) : options.value;
  if (options.label !== undefined) return { label: String(options.label) };
  if (options.index !== undefined) {
    const index = Number(options.index);
    if (!Number.isInteger(index) || index < 0) throw new BrowserToolError('INVALID_SELECT', 'select index must be a non-negative integer.');
    return { index };
  }
  throw new BrowserToolError('INVALID_SELECT', 'select requires value, label, or index.');
}

async function waitForReadiness(page, options = {}) {
  const { readySelector = null, readyTimeout = DEFAULT_PAGE_READY_TIMEOUT, delay = 0 } = options;
  const timeoutMs = Number(readyTimeout);
  const delayMs = Number(delay);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new BrowserToolError('INVALID_READY_TIMEOUT', 'Ready timeout must be a positive number of milliseconds.');
  if (!Number.isFinite(delayMs) || delayMs < 0) throw new BrowserToolError('INVALID_DELAY', 'Delay must be a non-negative number of milliseconds.');
  if (readySelector) await page.waitForSelector(readySelector, { state: 'visible', timeout: timeoutMs });
  if (delayMs > 0) await page.waitForTimeout(delayMs);
}

async function waitForVisualStability(page, options = {}) {
  const maxWait = Math.max(250, Math.min(Number(options.timeout) || DEFAULT_VISUAL_STABILITY_TIMEOUT, 30000));
  await page.evaluate(async (timeoutMs) => {
    const waitForImage = image => {
      if (image.complete) return image.decode ? image.decode().catch(() => {}) : Promise.resolve();
      return new Promise(resolve => {
        let timer;
        const done = () => {
          clearTimeout(timer);
          image.removeEventListener('load', done);
          image.removeEventListener('error', done);
          resolve();
        };
        timer = setTimeout(done, timeoutMs);
        image.addEventListener('load', done, { once: true });
        image.addEventListener('error', done, { once: true });
      });
    };

    const fonts = document.fonts?.ready || Promise.resolve();
    const images = Array.from(document.images).slice(0, 200).map(waitForImage);
    await Promise.race([
      Promise.all([fonts, ...images]),
      new Promise(resolve => setTimeout(resolve, timeoutMs))
    ]);
  }, maxWait);
}

async function prepareVisualCapture(page, options = {}) {
  const {
    readySelector = null,
    readyTimeout = DEFAULT_PAGE_READY_TIMEOUT,
    delay = 0,
    freezeAnimations = true,
    visualStabilityTimeout = DEFAULT_VISUAL_STABILITY_TIMEOUT
  } = options;
  if (freezeAnimations) await page.addStyleTag({ content: VISUAL_STABILITY_CSS }).catch(() => {});
  await waitForReadiness(page, { readySelector, readyTimeout, delay });
  await waitForVisualStability(page, { timeout: visualStabilityTimeout });
}

function normalizeDialogSpec(value) {
  const raw = value === true ? {} : typeof value === 'string' ? { type: value } : (value || {});
  const type = String(raw.type || raw.action || raw.disposition || 'accept').toLowerCase();
  if (!['accept', 'dismiss'].includes(type)) throw new BrowserToolError('INVALID_DIALOG', `Dialog action must be accept or dismiss, received: ${type}`);
  return {
    type,
    promptText: raw.promptText ?? raw.text ?? undefined,
    required: raw.required !== false
  };
}

function armDialogHandler(page, spec, onSeen = null) {
  let seen = false;
  let handlerError = null;
  let handled = Promise.resolve();
  const handler = (dialog) => {
    seen = true;
    onSeen?.(dialog);
    handled = (spec.type === 'dismiss' ? dialog.dismiss() : dialog.accept(spec.promptText))
      .catch(err => { handlerError = err; });
  };
  page.on('dialog', handler);
  return {
    get seen() { return seen; },
    async finish() {
      if (seen) await handled;
      page.off('dialog', handler);
      if (handlerError) throw handlerError;
      if (spec.required && !seen) throw new BrowserToolError('DIALOG_NOT_OPENED', `Expected a ${spec.type} dialog, but the next action did not open one.`);
    }
  };
}

function normalizePermissionList(value) {
  const permissions = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const normalized = permissions.map(permission => String(permission).trim()).filter(Boolean);
  if (normalized.length === 0) throw new BrowserToolError('INVALID_PERMISSIONS', 'permissions requires at least one permission name.');
  return [...new Set(normalized)];
}

function resolvePermissionOrigin(value) {
  const resolved = resolveWorkflowUrl(value);
  if (!isHttpUrl(resolved)) throw new BrowserToolError('INVALID_PERMISSION_ORIGIN', 'Permission grants require an http(s) origin.');
  return new URL(resolved).origin;
}

async function saveDownloadArtifact(download, options = {}) {
  const suggested = String(download.suggestedFilename?.() || 'download.bin').replaceAll('\\', '/');
  const suggestedName = safeArtifactFilename(path.posix.basename(suggested), 'download.bin');
  const requestedPath = options.path || options.outputPath;
  const destination = requestedPath
    ? path.resolve(process.cwd(), requestedPath)
    : path.resolve(process.cwd(), options.dir || './downloads', suggestedName);
  const safeDestination = options.safeMode ? assertPathWithinWorkspace(destination) : destination;
  await fs.mkdir(path.dirname(safeDestination), { recursive: true });
  await download.saveAs(safeDestination);
  return safeDestination;
}

async function downloadFromSelector(page, scope, args = {}) {
  if (!args.selector) throw new BrowserToolError('MISSING_TARGET', 'download requires selector for the control that starts the download.');
  const timeout = Number(args.timeout) || DEFAULT_ACTION_TIMEOUT;
  const downloadPromise = page.waitForEvent('download', { timeout });
  const clickPromise = scope
    ? scope.locator(args.selector).click({ timeout, force: Boolean(args.force) })
    : page.locator(args.selector).click({ timeout, force: Boolean(args.force) });
  const [download] = await Promise.all([downloadPromise, clickPromise]);
  return saveDownloadArtifact(download, { path: args.path || args.outputPath, dir: args.dir || './downloads', safeMode: Boolean(args.safeMode) });
}

function resolveWorkflowUrl(value) {
  if (typeof value !== 'string' || !value.includes('{{cwd}}')) return value;
  const cwdPath = pathToFileURL(process.cwd()).toString().replace(/\/$/, '');
  return value.replaceAll('file://{{cwd}}', cwdPath);
}

async function readWorkflowFile(filePath) {
  const resolvedPath = path.resolve(process.cwd(), filePath);
  const stat = await fs.stat(resolvedPath).catch(() => null);
  if (!stat || !stat.isFile()) throw new BrowserToolError('WORKFLOW_NOT_FOUND', `Workflow file not found: ${resolvedPath}`);
  if (stat.size > MAX_WORKFLOW_FILE_BYTES) throw new BrowserToolError('WORKFLOW_TOO_LARGE', `Workflow file cannot exceed ${MAX_WORKFLOW_FILE_BYTES} bytes.`);
  let content;
  try {
    content = await fs.readFile(resolvedPath, 'utf-8');
  } catch {
    throw new BrowserToolError('WORKFLOW_READ_FAILED', `Unable to read workflow file: ${resolvedPath}`);
  }
  try {
    return JSON.parse(content);
  } catch {
    throw new BrowserToolError('INVALID_WORKFLOW_JSON', `Workflow file is not valid JSON: ${resolvedPath}`);
  }
}

async function readLocatorText(locator, redact = false) {
  return locator.evaluate((element, withRedaction) => {
    if (withRedaction && element.closest('input[type="password"], [data-sensitive], .sensitive-data')) return '[redacted]';
    return element.textContent?.trim() || '';
  }, redact);
}

function normalizeOutputLimit(value, fallback = DEFAULT_MAX_OUTPUT_CHARS) {
  if (value === undefined || value === null || value === false) return fallback;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 512 || limit > 10_000_000) {
    throw new BrowserToolError('INVALID_OUTPUT_LIMIT', 'maxOutputChars must be an integer from 512 to 10000000.');
  }
  return limit;
}

function normalizeRequestId(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new BrowserToolError('INVALID_REQUEST_ID', 'requestId must be a string or number.');
  }
  const requestId = String(value);
  if (requestId.length > 100) throw new BrowserToolError('INVALID_REQUEST_ID', 'requestId must be at most 100 characters.');
  return requestId;
}

function normalizeSafetyMode(options = {}) {
  const safeRequested = options.safeMode === true || options.safe === true;
  const unsafeRequested = options.unsafe === true;
  if (safeRequested && unsafeRequested) throw new BrowserToolError('CONFLICTING_SAFETY_OPTIONS', 'safe and unsafe modes cannot be enabled together.');
  const requested = options.safetyMode || (safeRequested ? 'safe' : unsafeRequested ? 'unsafe' : 'standard');
  const mode = String(requested).toLowerCase();
  if (!SAFETY_MODES.has(mode)) throw new BrowserToolError('INVALID_SAFETY_MODE', 'safetyMode must be standard, safe, or unsafe.');
  return mode;
}

function normalizeAllowedHosts(value) {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const hosts = values.map(host => String(host).trim().toLowerCase()).filter(Boolean);
  if (hosts.length > 100) throw new BrowserToolError('INVALID_HOST_ALLOWLIST', 'allowedHosts cannot contain more than 100 entries.');
  for (const host of hosts) {
    if (!/^\*?\.?[a-z0-9.-]+(?::\d+)?$/.test(host)) throw new BrowserToolError('INVALID_HOST_ALLOWLIST', `Invalid allowed host: ${host}`);
  }
  return [...new Set(hosts)];
}

function normalizeIgnoreUrls(value) {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const patterns = values.map(pattern => String(pattern).trim()).filter(Boolean);
  if (patterns.length > 100) throw new BrowserToolError('INVALID_IGNORE_URLS', 'ignoreUrls cannot contain more than 100 entries.');
  if (patterns.some(pattern => pattern.length > 200)) throw new BrowserToolError('INVALID_IGNORE_URLS', 'ignoreUrls entries cannot exceed 200 characters.');
  return [...new Set(patterns)];
}

function urlMatchesPattern(url, pattern) {
  if (!pattern.includes('*')) return url.includes(pattern);
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(escaped, 'i').test(url);
}

function shouldIgnoreUrl(url, patterns) {
  return patterns.some(pattern => urlMatchesPattern(url, pattern));
}

function hostMatchesAllowlist(hostname, host, allowedHosts) {
  return allowedHosts.some(allowed => {
    const normalized = allowed.replace(/^\*\.?/, '');
    const separator = normalized.lastIndexOf(':');
    const patternHost = separator > -1 ? normalized.slice(0, separator) : normalized;
    const patternPort = separator > -1 ? normalized.slice(separator + 1) : null;
    const exactMatch = patternPort ? host === normalized : hostname === patternHost;
    const wildcardMatch = allowed.startsWith('*.')
      && hostname.endsWith(`.${patternHost}`)
      && (!patternPort || host.endsWith(`:${patternPort}`));
    return exactMatch || wildcardMatch;
  });
}

function assertNavigationAllowed(url, baseOrigin, safetyMode, allowedHosts) {
  if (safetyMode === 'unsafe') return;
  if (!isHttpUrl(url)) {
    if (safetyMode === 'safe' && typeof url === 'string' && url.startsWith('file:')) {
      try {
        assertPathWithinWorkspace(fileURLToPath(new URL(url)));
      } catch (error) {
        if (error instanceof BrowserToolError) throw new BrowserToolError('NAVIGATION_BLOCKED', 'Safe mode only permits file navigation inside the current workspace.');
        throw new BrowserToolError('INVALID_URL', 'Invalid file navigation URL.');
      }
    }
    return;
  }
  const parsed = new URL(url);
  if (baseOrigin && parsed.origin === baseOrigin) return;
  if (hostMatchesAllowlist(parsed.hostname, parsed.host, allowedHosts)) return;
  if (allowedHosts.length > 0 || safetyMode === 'safe') {
    throw new BrowserToolError('NAVIGATION_BLOCKED', `Navigation to ${parsed.origin} is not allowed. Add the host to allowedHosts or use safetyMode=standard.`);
  }
}

function assertInitialNavigationAllowed(url, safetyMode, allowedHosts) {
  const baseOrigin = isHttpUrl(url) ? new URL(url).origin : null;
  assertNavigationAllowed(url, baseOrigin, safetyMode, allowedHosts);
}

function assertFinalNavigationAllowed(page, initialUrl, safetyMode, allowedHosts) {
  const baseOrigin = isHttpUrl(initialUrl) ? new URL(initialUrl).origin : null;
  assertNavigationAllowed(page.url(), baseOrigin, safetyMode, allowedHosts);
}

function assertPathWithinWorkspace(targetPath) {
  const workspace = path.resolve(process.cwd());
  const resolved = path.resolve(targetPath);
  const relative = path.relative(workspace, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new BrowserToolError('UNSAFE_PATH', 'Safe mode only permits artifact paths inside the current workspace.');
  }

  // A lexical path check is insufficient when a workspace contains a symlink
  // or junction that points outside it. Validate the existing path (or its
  // nearest existing parent) against the real workspace before writing.
  let realWorkspace;
  try {
    realWorkspace = realpathSync.native(workspace);
  } catch (error) {
    throw new BrowserToolError('UNSAFE_PATH', `Unable to validate the workspace path: ${errorMessage(error)}`);
  }
  let probe = resolved;
  while (true) {
    try {
      const realProbe = realpathSync.native(probe);
      const realRelative = path.relative(realWorkspace, realProbe);
      if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
        throw new BrowserToolError('UNSAFE_PATH', 'Safe mode rejects paths that resolve outside the current workspace.');
      }
      break;
    } catch (error) {
      if (error instanceof BrowserToolError) throw error;
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
        throw new BrowserToolError('UNSAFE_PATH', `Unable to validate safe path: ${errorMessage(error)}`);
      }
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  return resolved;
}

function serializeOutput(value, maxChars = DEFAULT_MAX_OUTPUT_CHARS) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return JSON.stringify({ status: 'output_empty', outputTruncated: false });
  if (serialized.length <= maxChars) return serialized;
  const metadata = value && typeof value === 'object' ? Object.fromEntries(
    ['requestId', 'ok', 'op', 'sessionId', 'generation', 'action', 'code', 'protocolVersion']
      .filter(key => Object.prototype.hasOwnProperty.call(value, key))
      .map(key => [key, value[key]])
  ) : {};
  if (value && typeof value === 'object' && typeof value.status === 'string') metadata.resultStatus = value.status;
  const bounded = {
    ...metadata,
    status: 'output_truncated',
    outputTruncated: true,
    maxOutputChars: maxChars,
    originalOutputChars: serialized.length,
    preview: serialized.slice(0, Math.max(0, maxChars - 180))
  };
  let boundedJson = JSON.stringify(bounded);
  while (boundedJson.length > maxChars && bounded.preview.length > 0) {
    bounded.preview = bounded.preview.slice(0, Math.max(0, bounded.preview.length - (boundedJson.length - maxChars)));
    boundedJson = JSON.stringify(bounded);
  }
  return boundedJson;
}

function printJson(value, maxChars = DEFAULT_MAX_OUTPUT_CHARS) {
  // Agent output must be compact by default. Humans can pipe it through a
  // formatter when needed, while compact output materially reduces context.
  console.log(serializeOutput(value, maxChars));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeUrl(value) {
  try {
    const parsed = new URL(value);
    parsed.username = '';
    parsed.password = '';
    for (const key of parsed.searchParams.keys()) {
      if (/(token|secret|password|passwd|auth|session|cookie|key|code)/i.test(key)) parsed.searchParams.set(key, '[redacted]');
    }
    parsed.hash = '';
    return parsed.toString().slice(0, 320);
  } catch {
    return redactSensitiveText(value).slice(0, 320);
  }
}

function compactValue(value, maxChars = 1200) {
  if (typeof value === 'string') return value.slice(0, maxChars);
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return null;
    if (serialized.length <= maxChars) return value;
    return { truncated: true, preview: serialized.slice(0, maxChars) };
  } catch {
    return String(value).slice(0, maxChars);
  }
}

async function collectAgentSnapshot(page, options = {}) {
  const itemLimit = Math.max(1, Math.min(Number(options.maxItems) || DEFAULT_AGENT_ITEM_LIMIT, 200));
  const textLimit = Math.max(100, Math.min(Number(options.maxText) || DEFAULT_AGENT_TEXT_LIMIT, 4000));
  const includeGeometry = Boolean(options.includeGeometry);
  const redact = Boolean(options.redact);
  const view = options.view === 'controls' ? 'controls' : 'standard';

  const snapshot = await page.evaluate(({ itemLimit: limit, textLimit: textMax, includeGeometry: withGeometry, redact: withRedaction, view: viewMode }) => {
    const normalize = (value, max = textMax) => (value || '').replace(/\s+/g, ' ').trim().slice(0, max);
    const sensitive = (element) => element.matches('input[type="password"], [data-sensitive], .sensitive-data')
      || Boolean(element.closest('[data-sensitive], .sensitive-data'));
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
        && style.opacity !== '0' && !element.closest('[aria-hidden="true"]');
    };
    const uniqueSelector = (element) => {
      if (element.id) return `#${CSS.escape(element.id)}`;
      const path = [];
      let current = element;
      while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
        const tag = current.tagName.toLowerCase();
        const siblings = current.parentElement ? Array.from(current.parentElement.children).filter(child => child.tagName === current.tagName) : [];
        const index = siblings.indexOf(current) + 1;
        path.unshift(`${tag}:nth-of-type(${index})`);
        current = current.parentElement;
      }
      return path.join(' > ');
    };
    const accessibleName = (element) => {
      if (withRedaction && sensitive(element)) return '[redacted]';
      const aria = element.getAttribute('aria-label');
      if (aria) return normalize(aria, 120);
      const labelledBy = element.getAttribute('aria-labelledby');
      if (labelledBy) {
        const labelText = labelledBy.split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ');
        if (labelText.trim()) return normalize(labelText, 120);
      }
      if (element.id) {
        const label = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
        if (label) return normalize(label.textContent, 120);
      }
      const wrappingLabel = element.closest('label');
      if (wrappingLabel) return normalize(wrappingLabel.textContent, 120);
      // HTML accessible-name spec: submit/button/reset inputs are named by
      // their value attribute. Matching Playwright's getByRole naming here
      // keeps snapshot identities aligned with semantic re-resolution.
      const inputType = (element.getAttribute('type') || '').toLowerCase();
      if (element.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes(inputType)) {
        return normalize(element.getAttribute('value') || element.value || element.id || '', 120);
      }
      return normalize(element.getAttribute('placeholder') || element.textContent || element.getAttribute('alt') || element.getAttribute('name') || element.id || '', 120);
    };
    const roleFor = (element) => {
      const explicit = element.getAttribute('role');
      if (explicit) return explicit;
      const tag = element.tagName.toLowerCase();
      if (tag === 'a') return 'link';
      if (tag === 'button') return 'button';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'select') return 'combobox';
      if (tag === 'summary') return 'button';
      if (tag === 'input') {
        const type = (element.getAttribute('type') || 'text').toLowerCase();
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'submit' || type === 'button') return 'button';
        return type === 'search' ? 'searchbox' : 'textbox';
      }
      if (element.isContentEditable) return 'textbox';
      return tag;
    };
    const stateFor = (element) => {
      const state = {};
      if ('disabled' in element) state.disabled = Boolean(element.disabled);
      if ('checked' in element && typeof element.checked === 'boolean') state.checked = element.checked;
      if (element.hasAttribute('aria-expanded')) state.expanded = element.getAttribute('aria-expanded') === 'true';
      if (element.hasAttribute('aria-selected')) state.selected = element.getAttribute('aria-selected') === 'true';
      const type = (element.getAttribute('type') || '').toLowerCase();
      if ((!withRedaction || !sensitive(element)) && type !== 'password' && 'value' in element && element.value) state.value = normalize(element.value, 120);
      if ((!withRedaction || !sensitive(element)) && element.tagName.toLowerCase() === 'select') state.value = normalize(element.value, 120);
      return state;
    };

    const selector = 'button, a[href], input:not([type="hidden"]), textarea, select, summary, iframe, canvas, [role], [contenteditable="true"]';
    const candidates = Array.from(document.querySelectorAll(selector)).filter(visible);
    // Single pass for semantic disambiguation. Roles and names are computed
    // once per element; the running map tracks occurrences so each element
    // gets its nth index and the total count for its role+name identity. The
    // identity count lets ref recovery detect ambiguity after a re-render.
    const limited = candidates.slice(0, limit);
    const roles = [];
    const names = [];
    const semanticKeys = [];
    for (const element of limited) {
      const role = roleFor(element);
      const name = accessibleName(element);
      roles.push(role);
      names.push(name);
      semanticKeys.push(`${role}\u0000${name}`);
    }
    const semanticTotals = new Map();
    for (const key of semanticKeys) semanticTotals.set(key, (semanticTotals.get(key) || 0) + 1);
    const semanticProgress = new Map();
    const elements = limited.map((element, index) => {
      const rect = element.getBoundingClientRect();
      const role = roles[index];
      const name = names[index];
      const sameSemanticIndex = semanticProgress.get(semanticKeys[index]) || 0;
      semanticProgress.set(semanticKeys[index], sameSemanticIndex + 1);
      const item = {
        ref: `e${index + 1}`,
        tag: element.tagName.toLowerCase(),
        role,
        name,
        state: stateFor(element),
        selector: uniqueSelector(element),
        locator: {
          role,
          ...(name ? { name } : {}),
          nth: sameSemanticIndex,
          count: semanticTotals.get(semanticKeys[index]),
          // Identity fingerprint: when the element has an id, recovery verifies
          // the re-matched element still carries it, so a same-name element
          // with a different identity can never be acted on silently.
          ...(element.id ? { fid: `${element.tagName.toLowerCase()}#${element.id}` } : {})
        }
      };
      if (withGeometry) item.rect = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
      return item;
    });

    const headings = viewMode === 'controls' ? [] : Array.from(document.querySelectorAll('h1, h2, h3')).filter(visible).slice(0, 15).map(heading => ({
      level: heading.tagName.toLowerCase(),
      text: withRedaction && sensitive(heading) ? '[redacted]' : normalize(heading.textContent, 180)
    }));
    const landmarks = viewMode === 'controls' ? [] : Array.from(document.querySelectorAll('main, nav, aside, header, footer, dialog, form')).filter(visible).slice(0, 12).map(element => ({
      role: element.getAttribute('role') || element.tagName.toLowerCase(),
      name: accessibleName(element)
    }));

    return {
      title: document.title,
      url: location.href,
      view: viewMode,
      headings,
      landmarks,
      text: viewMode === 'controls' ? '' : (() => {
        if (!withRedaction || !document.body) return normalize(document.body?.innerText, textMax);
        const clone = document.body.cloneNode(true);
        clone.querySelectorAll('input[type="password"], [data-sensitive], .sensitive-data').forEach(element => {
          element.textContent = '[redacted]';
          if ('value' in element) element.value = '[redacted]';
        });
        return normalize(clone.innerText || clone.textContent, textMax);
      })(),
      totalInteractive: candidates.length,
      truncated: candidates.length > limit,
      elements
    };
  }, { itemLimit, textLimit, includeGeometry, redact, view });

  const refs = new Map(snapshot.elements.map(element => [element.ref, {
    selector: element.selector,
    locator: element.locator
  }]));
  const elements = snapshot.elements.map(({ selector, ...element }) => element);
  return { ...snapshot, elements, refs };
}

function publicAgentSnapshot(snapshot) {
  const { refs, ...publicSnapshot } = snapshot;
  return publicSnapshot;
}

function snapshotsEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function buildAgentSnapshotDelta(previous, current) {
  const previousElements = new Map(previous.elements.map(element => [element.ref, element]));
  const currentElements = new Map(current.elements.map(element => [element.ref, element]));
  const added = current.elements.filter(element => !previousElements.has(element.ref));
  const changed = current.elements.filter(element => {
    const before = previousElements.get(element.ref);
    return before && !snapshotsEqual(before, element);
  });
  const removed = previous.elements
    .filter(element => !currentElements.has(element.ref))
    .map(element => element.ref);
  const page = {};
  for (const key of ['title', 'url', 'headings', 'landmarks', 'text', 'totalInteractive', 'truncated']) {
    if (!snapshotsEqual(previous[key], current[key])) page[key] = current[key];
  }
  return {
    page,
    elements: {
      added,
      changed,
      removed
    }
  };
}

function normalizeSessionLimit(value) {
  const limit = value === undefined || value === null ? DEFAULT_MAX_AGENT_SESSIONS : Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new BrowserToolError('INVALID_SESSION_LIMIT', 'maxSessions must be an integer from 1 to 100.');
  }
  return limit;
}

function normalizeSessionIdleTimeout(value) {
  const timeout = value === undefined || value === null ? DEFAULT_SESSION_IDLE_TIMEOUT : Number(value);
  if (!Number.isInteger(timeout) || timeout < 0 || timeout > 24 * 60 * 60 * 1000) {
    throw new BrowserToolError('INVALID_SESSION_TIMEOUT', 'idleTimeout must be 0 or an integer from 1 to 86400000 milliseconds.');
  }
  return timeout;
}

async function disposeAgentSession(session) {
  activeAgentSessions.delete(session.id);
  recentlyDisposedSessions.set(session.id, Date.now());
  if (recentlyDisposedSessions.size > 200) {
    const oldest = recentlyDisposedSessions.keys().next().value;
    recentlyDisposedSessions.delete(oldest);
  }
  for (const watcher of session.watchers.values()) {
    watcher.active = false;
    await cancelPageWatch(watcher.page, watcher.id);
  }
  session.watchers.clear();
  session.subscriptions.clear();
  session.eventSink = null;
  await session.context.close().catch(() => {});
  await session.browser.close().catch(() => {});
}

async function expireIdleSessions() {
  const now = Date.now();
  for (const session of Array.from(activeAgentSessions.values())) {
    if (session.idleTimeoutMs > 0 && now - session.lastActivityAt >= session.idleTimeoutMs) {
      await disposeAgentSession(session);
    }
  }
}

function emitSessionEvent(session, event, data = {}) {
  if (!session.eventSink || session.subscriptions.size === 0) return;
  const eventId = String(++session.eventSequence);
  const now = Date.now();
  for (const subscription of session.subscriptions.values()) {
    if (!subscription.events.includes('all') && !subscription.events.includes(event)) continue;
    if (subscription.coalesceMs > 0
      && subscription.lastEvent === event
      && now - subscription.lastEventAt < subscription.coalesceMs) continue;
    subscription.lastEvent = event;
    subscription.lastEventAt = now;
    try {
      session.eventSink({
        type: 'event',
        eventId,
        sessionId: session.id,
        event,
        generation: session.generation,
        data: compactValue(data, 1500)
      }, session.maxOutputChars);
    } catch {}
  }
}

function normalizeSubscriptionId(value, fallback) {
  return normalizeRequestId(value, fallback);
}

function normalizeWatcherId(value, fallback) {
  return normalizeRequestId(value, fallback);
}

function watchConditionOnPage(page, spec) {
  return page.evaluate(async ({ registryKey, watcherId, selector, state, containsText, equalsText, timeoutMs }) => {
    const registry = globalThis[registryKey] || (globalThis[registryKey] = new Map());
    const previous = registry.get(watcherId);
    if (previous) previous.cancel();
    return await new Promise(resolve => {
      let finished = false;
      let timer = null;
      let observer = null;
      let checkQueued = false;
      const finish = (matched, reason, error = null) => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        observer?.disconnect();
        document.removeEventListener('input', check, true);
        document.removeEventListener('change', check, true);
        registry.delete(watcherId);
        const element = (() => {
          try { return document.querySelector(selector); } catch { return null; }
        })();
        resolve({
          matched,
          reason,
          text: element?.textContent?.trim()?.slice(0, 500) || '',
          error: error ? String(error).slice(0, 300) : undefined
        });
      };
      const isVisible = element => {
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      };
      const check = () => {
        try {
          const element = document.querySelector(selector);
          const stateMatches = state === 'attached' ? Boolean(element)
            : state === 'detached' ? !element
              : state === 'hidden' ? !isVisible(element)
                : isVisible(element);
          const text = element?.textContent?.trim() || '';
          const textMatches = (containsText === undefined || text.includes(containsText))
            && (equalsText === undefined || text === equalsText);
          if (stateMatches && textMatches) finish(true, 'matched');
        } catch (error) {
          finish(false, 'error', error?.message || error);
        }
      };
      const scheduleCheck = () => {
        if (checkQueued) return;
        checkQueued = true;
        queueMicrotask(() => {
          checkQueued = false;
          check();
        });
      };
      observer = new MutationObserver(scheduleCheck);
      observer.observe(document.documentElement || document, { subtree: true, childList: true, attributes: true, characterData: true });
      document.addEventListener('input', scheduleCheck, true);
      document.addEventListener('change', scheduleCheck, true);
      registry.set(watcherId, { cancel: () => finish(false, 'cancelled') });
      timer = setTimeout(() => finish(false, 'timeout'), timeoutMs);
      check();
    });
  }, { registryKey: WATCH_REGISTRY_KEY, ...spec });
}

async function cancelPageWatch(page, watcherId) {
  await page.evaluate(({ registryKey, watcherId: id }) => {
    globalThis[registryKey]?.get(id)?.cancel();
  }, { registryKey: WATCH_REGISTRY_KEY, watcherId }).catch(() => {});
}

export function subscribeAgentSession(options = {}) {
  const session = getAgentSession(options.sessionId);
  if (session.subscriptions.size >= MAX_SESSION_SUBSCRIPTIONS) {
    throw new BrowserToolError('SUBSCRIPTION_LIMIT', `A session cannot have more than ${MAX_SESSION_SUBSCRIPTIONS} subscriptions.`);
  }
  const subscriptionId = normalizeSubscriptionId(options.subscriptionId, `sub-${Date.now()}-${session.nextSubscriptionId++}`);
  if (session.subscriptions.has(subscriptionId)) throw new BrowserToolError('SUBSCRIPTION_EXISTS', `Subscription already exists: ${subscriptionId}`);
  const subscription = {
    id: subscriptionId,
    events: normalizeEventList(options.events),
    coalesceMs: normalizeCoalesceMs(options.coalesceMs ?? options['coalesce-ms']),
    lastEvent: null,
    lastEventAt: 0
  };
  session.subscriptions.set(subscriptionId, subscription);
  return { sessionId: session.id, subscriptionId, status: 'subscribed', events: subscription.events, coalesceMs: subscription.coalesceMs };
}

export function unsubscribeAgentSession(options = {}) {
  const session = getAgentSession(options.sessionId);
  const subscriptionId = normalizeSubscriptionId(options.subscriptionId, '');
  if (!session.subscriptions.delete(subscriptionId)) throw new BrowserToolError('SUBSCRIPTION_NOT_FOUND', `Unknown subscription: ${subscriptionId}`);
  return { sessionId: session.id, subscriptionId, status: 'unsubscribed' };
}

export async function watchAgentSession(options = {}) {
  const session = getAgentSession(options.sessionId);
  const page = session.page;
  if (!page || page.isClosed()) throw new BrowserToolError('SESSION_NO_PAGE', `Agent session has no open page: ${session.id}`);
  if (session.watchers.size >= MAX_SESSION_WATCHERS) {
    throw new BrowserToolError('WATCHER_LIMIT', `A session cannot have more than ${MAX_SESSION_WATCHERS} watchers.`);
  }
  const watcherId = normalizeWatcherId(options.watcherId, `watch-${Date.now()}-${session.nextWatcherId++}`);
  if (session.watchers.has(watcherId)) throw new BrowserToolError('WATCHER_EXISTS', `Watcher already exists: ${watcherId}`);
  const selector = requireString(options.selector, 'MISSING_TARGET', 'watch selector');
  const state = options.state || 'visible';
  if (!['attached', 'detached', 'visible', 'hidden'].includes(state)) throw new BrowserToolError('INVALID_WATCH_STATE', 'watch state must be attached, detached, visible, or hidden.');
  const timeoutMs = normalizeWatchTimeout(options.timeout ?? options.timeoutMs ?? options['timeout-ms']);
  if (options.containsText !== undefined) requireString(options.containsText, 'INVALID_WATCH', 'watch containsText');
  if (options.equalsText !== undefined) requireString(options.equalsText, 'INVALID_WATCH', 'watch equalsText');
  const watcher = { id: watcherId, page, active: true, promise: null };
  session.watchers.set(watcherId, watcher);
  watcher.promise = watchConditionOnPage(page, {
    watcherId,
    selector,
    state,
    containsText: options.containsText,
    equalsText: options.equalsText,
    timeoutMs
  }).then(result => {
    if (!watcher.active || !session.watchers.has(watcherId)) return;
    session.watchers.delete(watcherId);
    const event = result.matched ? 'watch.matched' : result.reason === 'timeout' ? 'watch.timeout' : 'watch.error';
    emitSessionEvent(session, event, { watcherId, selector, state, ...result });
  }).catch(error => {
    if (!watcher.active || !session.watchers.has(watcherId)) return;
    session.watchers.delete(watcherId);
    emitSessionEvent(session, 'watch.error', { watcherId, selector, state, error: errorMessage(error) });
  });
  return { sessionId: session.id, watcherId, status: 'watching', selector, state, timeoutMs };
}

export async function unwatchAgentSession(options = {}) {
  const session = getAgentSession(options.sessionId);
  const watcherId = normalizeWatcherId(options.watcherId, '');
  const watcher = session.watchers.get(watcherId);
  if (!watcher) throw new BrowserToolError('WATCHER_NOT_FOUND', `Unknown watcher: ${watcherId}`);
  watcher.active = false;
  session.watchers.delete(watcherId);
  await cancelPageWatch(watcher.page, watcherId);
  return { sessionId: session.id, watcherId, status: 'unwatched' };
}

// Coalesce consecutive identical diagnostics so a page that logs the same
// error 50 times costs one bounded entry (with a count) instead of 50
// entries. Evidence is preserved; only repetition is collapsed.
function appendDiagnosticCoalesced(collection, diagnostic, matchKeys) {
  const last = collection[collection.length - 1];
  if (last && matchKeys.every(key => last[key] === diagnostic[key])) {
    last.count = (last.count || 1) + 1;
    if (collection.length > MAX_SESSION_DIAGNOSTICS) collection.splice(0, collection.length - MAX_SESSION_DIAGNOSTICS);
    return;
  }
  appendBounded(collection, { ...diagnostic, count: 1 });
}

function attachSessionDiagnostics(session, page) {
  if (session.instrumentedPages.has(page)) return;
  session.instrumentedPages.add(page);
  page.on('framenavigated', frame => {
    if (frame !== page.mainFrame()) return;
    try {
      assertNavigationAllowed(frame.url(), session.navigationOrigin, session.safetyMode, session.allowedHosts);
      if (!session.navigationOrigin && isHttpUrl(frame.url())) session.navigationOrigin = new URL(frame.url()).origin;
      if (!shouldIgnoreUrl(frame.url(), session.ignoreUrls)) emitSessionEvent(session, 'navigation', { url: sanitizeUrl(frame.url()) });
    } catch (error) {
      const diagnostic = { type: 'navigation-blocked', code: errorCode(error), text: errorMessage(error), url: sanitizeUrl(frame.url()) };
      appendBounded(session.consoleErrors, diagnostic);
      emitSessionEvent(session, 'navigation.blocked', diagnostic);
      void page.close().catch(() => {});
    }
  });
  page.on('console', message => {
    if (shouldIgnoreUrl(page.url(), session.ignoreUrls)) return;
    const diagnostic = { type: message.type(), text: redactSensitiveText(message.text()).slice(0, 300), url: sanitizeUrl(page.url()) };
    if (message.type() === 'error') {
      appendDiagnosticCoalesced(session.consoleErrors, diagnostic, ['type', 'text', 'url']);
      emitSessionEvent(session, 'console.error', diagnostic);
    } else if (isConsoleWarningType(message.type())) {
      appendDiagnosticCoalesced(session.consoleWarnings, diagnostic, ['type', 'text', 'url']);
      emitSessionEvent(session, 'console.warning', diagnostic);
    }
  });
  page.on('pageerror', error => {
    if (shouldIgnoreUrl(page.url(), session.ignoreUrls)) return;
    const diagnostic = { type: 'uncaught-error', text: redactSensitiveText(error.message).slice(0, 300), url: sanitizeUrl(page.url()) };
    appendDiagnosticCoalesced(session.consoleErrors, diagnostic, ['type', 'text', 'url']);
    emitSessionEvent(session, 'console.error', diagnostic);
  });
  page.on('response', response => {
    if (shouldIgnoreUrl(response.url(), session.ignoreUrls)) return;
    if (response.status() >= 400) {
      const diagnostic = { method: response.request().method(), status: response.status(), url: sanitizeUrl(response.url()) };
      appendDiagnosticCoalesced(session.networkErrors, diagnostic, ['method', 'status', 'url']);
      emitSessionEvent(session, 'network.error', diagnostic);
    }
  });
  page.on('requestfailed', request => {
    if (shouldIgnoreUrl(request.url(), session.ignoreUrls)) return;
    const diagnostic = {
      method: request.method(),
      url: sanitizeUrl(request.url()),
      failure: redactSensitiveText(request.failure()?.errorText || 'request failed').slice(0, 300)
    };
    appendDiagnosticCoalesced(session.requestFailures, diagnostic, ['method', 'url', 'failure']);
    emitSessionEvent(session, 'request.failed', diagnostic);
  });
  page.on('crash', () => emitSessionEvent(session, 'page.crash', { url: sanitizeUrl(page.url()) }));
  page.on('close', () => emitSessionEvent(session, 'page.closed', { url: sanitizeUrl(page.url()) }));
  if (session.redact) page.on('framenavigated', frame => {
    if (frame === page.mainFrame()) void applyRedaction(page);
  });
}

function takeSessionDiagnostics(session) {
  const consoleErrors = session.consoleErrors.splice(0);
  const consoleWarnings = session.consoleWarnings.splice(0);
  const networkErrors = session.networkErrors.splice(0);
  const requestFailures = session.requestFailures.splice(0);
  return {
    consoleErrors: consoleErrors.length > 0 ? consoleErrors : undefined,
    consoleWarnings: consoleWarnings.length > 0 ? consoleWarnings : undefined,
    networkErrors: networkErrors.length > 0 ? networkErrors : undefined,
    requestFailures: requestFailures.length > 0 ? requestFailures : undefined
  };
}

function getAgentSession(sessionId) {
  const session = activeAgentSessions.get(sessionId);
  if (!session) throw new BrowserToolError('SESSION_NOT_FOUND', `Unknown agent session: ${sessionId}`);
  if (session.idleTimeoutMs > 0 && Date.now() - session.lastActivityAt >= session.idleTimeoutMs) {
    void disposeAgentSession(session);
    throw new BrowserToolError('SESSION_EXPIRED', `Agent session expired after ${session.idleTimeoutMs}ms of inactivity.`);
  }
  session.lastActivityAt = Date.now();
  return session;
}

async function resolveAgentRef(page, reference, options = {}) {
  // Bounded re-check window. The original implementation returned a locator it
  // had already proven was dead (count === 0), so the action then burned the
  // full action timeout (8s default) before failing with a generic
  // TimeoutError. We instead wait briefly for re-attachment and, when the ref
  // is truly stale, fail fast with a machine-readable STALE_REF error that
  // carries the evidence an agent needs to recover (re-observe).
  const refWaitMs = Number.isFinite(Number(options.refWaitMs)) ? Math.max(0, Number(options.refWaitMs)) : 1000;
  const candidates = [];
  if (reference?.selector) {
    const selector = reference.selector;
    candidates.push({
      describe: `selector "${selector}"`,
      build: () => page.locator(selector).first()
    });
  }
  const semantic = reference?.locator;
  if (semantic?.role) {
    const role = semantic.role;
    const nth = Number(semantic.nth) || 0;
    const roleOptions = semantic.name ? { name: semantic.name, exact: true } : {};
    candidates.push({
      describe: `role=${role}${semantic.name ? ` name="${semantic.name}"` : ''} nth=${nth}`,
      build: () => page.getByRole(role, roleOptions).nth(nth)
    });
  }

  const tried = [];
  for (const candidate of candidates) {
    try {
      const locator = candidate.build();
      await locator.waitFor({ state: 'attached', timeout: refWaitMs });
      return locator;
    } catch (error) {
      tried.push({
        target: candidate.describe,
        resolved: false,
        reason: error?.name === 'TimeoutError' ? `not attached within ${refWaitMs}ms` : errorMessage(error)
      });
    }
  }

  throw new BrowserToolError('STALE_REF', 'Referenced element is no longer attached. Observe again to refresh refs.', {
    tried,
    hint: 'Refs are invalidated after every act. Send observe (mode "delta" is cheaper), then act using a ref from the fresh observation.'
  });
}

// Attempt a semantic re-match of a stale ref using the identity recorded at
// observation time (role + name + nth + identity count). Recovery only
// succeeds when the semantic group size is unchanged, so a re-render that
// added or removed sibling controls can never silently redirect the action.
// Returns the locator or null; never throws.
async function recoverAgentRef(page, identity, options = {}) {
  const semantic = identity?.locator;
  if (!semantic?.role) return null;
  const refWaitMs = Number.isFinite(Number(options.refWaitMs)) ? Math.max(0, Number(options.refWaitMs)) : 1000;
  try {
    const roleOptions = semantic.name ? { name: semantic.name, exact: true } : {};
    const matches = page.getByRole(semantic.role, roleOptions);
    const currentCount = await matches.count();
    if (semantic.count !== undefined && currentCount !== semantic.count) return null;
    const nth = Number(semantic.nth) || 0;
    if (currentCount < nth + 1) return null;
    const locator = matches.nth(nth);
    await locator.waitFor({ state: 'attached', timeout: refWaitMs });
    if (semantic.fid) {
      const fingerprint = await locator.evaluate(el => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}`).catch(() => null);
      if (fingerprint !== semantic.fid) return null;
    }
    return locator;
  } catch {
    return null;
  }
}

export async function observeAgentSession(options = {}) {
  const session = getAgentSession(options.sessionId);
  const page = session.page;
  if (!page || page.isClosed()) throw new Error(`Agent session has no open page: ${session.id}`);
  const mode = options.mode || 'full';
  if (mode !== 'full' && mode !== 'delta') throw new BrowserToolError('INVALID_OBSERVE_MODE', 'observe mode must be full or delta.');
  if (options.view !== undefined && !['standard', 'controls'].includes(options.view)) throw new BrowserToolError('INVALID_OBSERVE_VIEW', 'observe view must be standard or controls.');
  let requestedSince = null;
  if (options.since !== undefined) {
    requestedSince = Number(options.since);
    if (!Number.isInteger(requestedSince) || requestedSince < 0) throw new BrowserToolError('INVALID_OBSERVE_BASELINE', 'observe since must be a non-negative integer generation.');
  }
  const previousSnapshot = session.lastSnapshot;
  const previousGeneration = session.lastSnapshotGeneration;
  const maxItems = normalizeAgentLimit(options.maxItems ?? options['max-items'] ?? session.maxItems, 'maxItems', 1, 200) ?? session.maxItems;
  const maxText = normalizeAgentLimit(options.maxText ?? options['max-text'] ?? session.maxText, 'maxText', 100, 4000) ?? session.maxText;
  const snapshot = await collectAgentSnapshot(page, {
    ...options,
    maxItems,
    maxText,
    redact: session.redact
  });
  session.refs = snapshot.refs;
  // refHistory keeps the semantic identity of the most recent observation's
  // refs alive after act clears session.refs, so stale-ref recovery (R1) can
  // re-match an element by role+name+nth+count instead of forcing a full
  // observe round trip. Cleared whenever the active page changes.
  session.refHistory = new Map(snapshot.refs);
  session.generation += 1;
  session.lastSnapshot = snapshot;
  session.lastSnapshotGeneration = session.generation;
  const diagnostics = takeSessionDiagnostics(session);
  if (mode === 'delta' && previousSnapshot && (requestedSince === null || requestedSince === previousGeneration)) {
    const delta = buildAgentSnapshotDelta(previousSnapshot, snapshot);
    if (delta.page.url) delta.page.url = sanitizeUrl(delta.page.url);
    return {
      sessionId: session.id,
      generation: session.generation,
      mode: 'delta',
      safetyMode: session.safetyMode,
      since: previousGeneration,
      ...delta,
      diagnostics
    };
  }
  return {
    sessionId: session.id,
    generation: session.generation,
    mode: 'full',
    safetyMode: session.safetyMode,
    ...(mode === 'delta' ? { deltaFallbackReason: previousSnapshot ? 'baseline_mismatch' : 'no_baseline' } : {}),
    ...publicAgentSnapshot(snapshot),
    url: sanitizeUrl(snapshot.url),
    diagnostics
  };
}

export async function createAgentSession(options = {}) {
  const sessionId = String(options.sessionId || options.id || `agent-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  if (sessionId.length > 100) throw new BrowserToolError('INVALID_SESSION_ID', 'sessionId must be at most 100 characters.');
  const maxSessions = normalizeSessionLimit(options.maxSessions);
  if (activeAgentSessions.has(sessionId)) throw new BrowserToolError('SESSION_EXISTS', `Agent session already exists: ${sessionId}`);
  if (activeAgentSessions.size >= maxSessions) throw new BrowserToolError('SESSION_LIMIT', `Maximum active agent sessions reached (${maxSessions}).`);
  const url = resolveWorkflowUrl(options.url);
  if (!url) throw new BrowserToolError('MISSING_URL', 'URL is required.');
  const idleTimeoutMs = normalizeSessionIdleTimeout(options.idleTimeout);
  const safetyMode = normalizeSafetyMode(options);
  const allowedHosts = normalizeAllowedHosts(options.allowedHosts || options['allowed-hosts']);
  const ignoreUrls = normalizeIgnoreUrls(options.ignoreUrls || options['ignore-urls'] || options.ignoreUrl || options['ignore-url']);
  assertInitialNavigationAllowed(url, safetyMode, allowedHosts);
  const maxItems = normalizeAgentLimit(options.maxItems ?? options['max-items'] ?? DEFAULT_AGENT_ITEM_LIMIT, 'maxItems', 1, 200);
  const maxText = normalizeAgentLimit(options.maxText ?? options['max-text'] ?? DEFAULT_AGENT_TEXT_LIMIT, 'maxText', 100, 4000);

  const presetConfig = VIEWPORT_PRESETS[options.preset] || VIEWPORT_PRESETS.desktop;
  const requestedViewport = options.viewport || presetConfig.viewport;
  validateViewport(requestedViewport);
  const contextOptions = {
    viewport: requestedViewport,
    isMobile: options.viewport ? Boolean(options.isMobile) : presetConfig.isMobile,
    hasTouch: options.viewport ? Boolean(options.hasTouch) : presetConfig.hasTouch,
    deviceScaleFactor: options.deviceScaleFactor || presetConfig.deviceScaleFactor || 1
  };
  if (options.authStatePath) contextOptions.storageState = path.resolve(process.cwd(), options.authStatePath);
  const parsedGeo = parseGeo(options.geo);
  if (parsedGeo) { contextOptions.geolocation = parsedGeo; contextOptions.permissions = ['geolocation']; }
  if (options.timezone) contextOptions.timezoneId = options.timezone;

  const { browser, channelUsed } = await launchResilientBrowser({
    headless: options.headless !== false
  });
  let context;
  let page;
  try {
    context = await browser.newContext(contextOptions);
    page = await context.newPage();
    if (options.permissions) {
      await context.grantPermissions(normalizePermissionList(options.permissions), {
        origin: resolvePermissionOrigin(options.permissionOrigin || url)
      });
    }
  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }
  const session = {
    id: sessionId,
    browser,
    context,
    page,
    channelUsed,
    redact: Boolean(options.redact),
    token: options.token || null,
    cookie: options.cookie || null,
    network: options.network || null,
    safetyMode,
    allowedHosts,
    ignoreUrls,
    navigationOrigin: isHttpUrl(url) ? new URL(url).origin : null,
    readySelector: options.readySelector || null,
    readyTimeout: options.readyTimeout ?? DEFAULT_PAGE_READY_TIMEOUT,
    delay: options.delay ?? 0,
    waitUntil: options.waitUntil || 'domcontentloaded',
    maxItems,
    maxText,
    maxOutputChars: normalizeOutputLimit(options.maxOutputChars),
    maxSessions,
    idleTimeoutMs,
    lastActivityAt: Date.now(),
    lastSnapshot: null,
    lastSnapshotGeneration: 0,
    pendingDialog: null,
    eventSink: typeof options.eventSink === 'function' ? options.eventSink : null,
    subscriptions: new Map(),
    watchers: new Map(),
    eventSequence: 0,
    nextSubscriptionId: 1,
    nextWatcherId: 1,
    origin: url,
    authOrigin: url,
    refs: new Map(),
    refHistory: new Map(),
    autoRecoverRefs: options.autoRecoverRefs === false ? false : true,
    allowEvaluate: Boolean(options.allowEvaluate),
    generation: 0,
    instrumentedPages: new WeakSet(),
    consoleErrors: [],
    consoleWarnings: [],
    networkErrors: [],
    requestFailures: []
  };
  activeAgentSessions.set(sessionId, session);

  attachSessionDiagnostics(session, page);
  context.on('page', newPage => {
    const previousPage = session.page;
    session.page = newPage;
    session.refs.clear();
    session.refHistory.clear();
    attachSessionDiagnostics(session, newPage);
    emitSessionEvent(session, 'page.opened', {
      url: sanitizeUrl(newPage.url()),
      tabIndex: context.pages().indexOf(newPage),
      activePageSwitched: true,
      previousUrl: previousPage ? sanitizeUrl(previousPage.url()) : null
    });
    void configureContextFeatures(context, newPage, {
      network: session.network,
      redact: session.redact,
      token: session.token,
      cookie: session.cookie,
      url: session.authOrigin
    }).catch(err => {
      appendBounded(session.consoleErrors, { type: 'browser-tool-error', text: errorMessage(err), url: sanitizeUrl(newPage.url()) });
    });
  });

  try {
    await configureContextFeatures(context, page, {
      network: session.network,
      redact: session.redact,
      token: session.token,
      cookie: session.cookie,
      url: session.authOrigin
    });
    await page.goto(url, { waitUntil: session.waitUntil, timeout: options.timeout || 35000 });
    if (session.redact) await applyRedaction(page);
    await waitForReadiness(page, {
      readySelector: session.readySelector,
      readyTimeout: session.readyTimeout,
      delay: session.delay
    });
    return await observeAgentSession({ sessionId, maxItems: options.maxItems, maxText: options.maxText, view: options.view });
  } catch (err) {
    await closeAgentSession({ sessionId }).catch(() => {});
    throw err;
  }
}

// Post-hoc transparency: describes the element an act actually resolved to,
// so the agent can verify it hit the intended target.
function describeActedOn(ref, identity, selector) {
  if (identity) {
    return {
      ...(ref ? { ref } : {}),
      ...(identity.selector ? { selector: identity.selector } : {}),
      ...(identity.locator ? {
        role: identity.locator.role,
        ...(identity.locator.name ? { name: identity.locator.name } : {}),
        nth: identity.locator.nth
      } : {})
    };
  }
  return selector ? { selector } : null;
}

export async function actAgentSession(options = {}) {
  const session = getAgentSession(options.sessionId);
  const page = session.page;
  if (!page || page.isClosed()) throw new Error(`Agent session has no open page: ${session.id}`);
  const action = requireString(options.action, 'INVALID_ACTION', 'act action');
  const allowedActions = session.allowEvaluate ? new Set([...AGENT_ACTIONS, 'evaluate']) : AGENT_ACTIONS;
  if (!allowedActions.has(action)) {
    const hint = action === 'evaluate' && !session.allowEvaluate
      ? ' evaluate requires the session to be opened with allowEvaluate: true.'
      : '';
    throw new BrowserToolError('UNSUPPORTED_ACTION', `Unsupported agent action: "${action}".${hint}`, { action });
  }
  if (['click', 'fill', 'type', 'check', 'uncheck', 'select', 'selectOption', 'hover', 'assert'].includes(action)
    && !options.ref && !options.selector) throw new BrowserToolError('MISSING_TARGET', `${action} requires ref or selector.`);
  const timeout = Number(options.timeout) || DEFAULT_ACTION_TIMEOUT;
  const reference = options.ref ? session.refs.get(options.ref) : null;
  let target = null;
  let refRecovered = null;
  let actedOn = null;
  if (options.ref && !reference) {
    // Refs were invalidated (e.g. by a previous act). Try semantic recovery
    // from the recorded identity before failing; recovery is count-guarded so
    // it can never resolve to a different element than the one observed.
    const identity = session.refHistory.get(options.ref) || null;
    if (options.recoverRef === false || !session.autoRecoverRefs || !identity) {
      throw new BrowserToolError('STALE_REF', `Unknown or stale element ref: ${options.ref}. Observe again.`);
    }
    const recovered = await recoverAgentRef(page, identity, { refWaitMs: options.refWaitMs });
    if (!recovered) throw new BrowserToolError('STALE_REF', `Unknown or stale element ref: ${options.ref}. Observe again.`);
    target = recovered;
    refRecovered = { ref: options.ref, locator: { role: identity.locator.role, ...(identity.locator.name ? { name: identity.locator.name } : {}), nth: identity.locator.nth } };
    actedOn = describeActedOn(options.ref, identity, null);
  } else if (reference) {
    try {
      target = await resolveAgentRef(page, reference, { refWaitMs: options.refWaitMs });
    } catch (staleError) {
      if (options.recoverRef === false || !session.autoRecoverRefs) throw staleError;
      const recovered = await recoverAgentRef(page, reference, { refWaitMs: options.refWaitMs });
      if (!recovered) throw staleError;
      target = recovered;
      refRecovered = { ref: options.ref, locator: { role: reference.locator.role, ...(reference.locator.name ? { name: reference.locator.name } : {}), nth: reference.locator.nth } };
    }
    actedOn = describeActedOn(options.ref, reference, null);
  } else {
    target = options.selector ? page.locator(options.selector).first() : null;
    actedOn = describeActedOn(null, null, options.selector);
  }
  let actionResult = null;
  let dialogAttempt = null;
  if (session.pendingDialog && action !== 'dialog') {
    dialogAttempt = armDialogHandler(page, session.pendingDialog, dialog => emitSessionEvent(session, 'dialog', {
      type: dialog.type(),
      message: redactSensitiveText(dialog.message()).slice(0, 500),
      defaultValue: redactSensitiveText(dialog.defaultValue()).slice(0, 200)
    }));
    session.pendingDialog = null;
  }

  try {
    switch (action) {
    case 'click':
      if (!target) throw new Error('click requires ref or selector.');
      await target.click({ timeout, force: Boolean(options.force), position: options.position });
      break;
    case 'fill':
      if (!target) throw new Error('fill requires ref or selector.');
      await target.fill(String(options.text ?? options.value ?? ''), { timeout });
      break;
    case 'type':
      if (!target) throw new Error('type requires ref or selector.');
      if (options.clear !== false) await target.fill('', { timeout });
      await target.pressSequentially(String(options.text ?? options.value ?? ''), { timeout, delay: Number(options.delay) || 0 });
      break;
    case 'check':
      if (!target) throw new Error('check requires ref or selector.');
      await target.check({ timeout });
      break;
    case 'uncheck':
      if (!target) throw new Error('uncheck requires ref or selector.');
      await target.uncheck({ timeout });
      break;
    case 'select':
    case 'selectOption':
      if (!target) throw new Error('select requires ref or selector.');
      await target.selectOption(selectOptionDescriptor(options), { timeout });
      break;
    case 'hover':
      if (!target) throw new Error('hover requires ref or selector.');
      await target.hover({ timeout });
      break;
    case 'press':
      if (target) await target.press(options.key || 'Enter', { timeout });
      else await page.keyboard.press(options.key || 'Enter');
      break;
    case 'scroll':
      if (target) await target.scrollIntoViewIfNeeded({ timeout });
      else if (options.position === 'top') await page.evaluate(() => window.scrollTo(0, 0));
      else await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      break;
    case 'navigate':
    case 'goto':
      if (!options.url) throw new Error('navigate requires url.');
      {
        const nextUrl = resolveWorkflowUrl(options.url);
        assertNavigationAllowed(nextUrl, session.navigationOrigin, session.safetyMode, session.allowedHosts);
        await page.goto(nextUrl, { waitUntil: options.waitUntil || session.waitUntil, timeout: Number(options.navigationTimeout) || 35000 });
        if (session.redact) await applyRedaction(page);
        await waitForReadiness(page, {
          readySelector: options.readySelector ?? session.readySelector,
          readyTimeout: options.readyTimeout ?? session.readyTimeout,
          delay: options.delay ?? session.delay
        });
        session.origin = nextUrl;
        if (!session.navigationOrigin && isHttpUrl(nextUrl)) session.navigationOrigin = new URL(nextUrl).origin;
      }
      break;
    case 'wait':
      if (target) await target.waitFor({ state: options.state || 'visible', timeout });
      else if (options.url) await page.waitForURL(options.url, { timeout });
      else await page.waitForTimeout(Number(options.ms || options.time) || 500);
      break;
    case 'assert': {
      if (!target) throw new Error('assert requires ref or selector.');
      const text = await readLocatorText(target, session.redact);
      if (options.containsText && !text.includes(options.containsText)) throw new Error(`Text mismatch: expected "${options.containsText}", found "${text.slice(0, 200)}"`);
      if (options.equalsText && text !== options.equalsText) throw new Error(`Text mismatch: expected "${options.equalsText}", found "${text.slice(0, 200)}"`);
      break;
    }
    case 'dialog':
      session.pendingDialog = normalizeDialogSpec(options.dialog ?? {
        type: options.type || options.disposition || 'accept',
        promptText: options.promptText ?? options.text,
        required: options.required
      });
      break;
    case 'download':
      actionResult = { downloadPath: await downloadFromSelector(page, null, { ...options, safeMode: session.safetyMode === 'safe' }) };
      emitSessionEvent(session, 'download', actionResult);
      break;
    case 'permissions': {
      if (options.clear) {
        await session.context.clearPermissions();
        actionResult = { permissions: [] };
      } else {
        const permissions = normalizePermissionList(options.permissions || options.permission);
        const origin = resolvePermissionOrigin(options.origin || session.origin || page.url());
        assertNavigationAllowed(origin, session.navigationOrigin, session.safetyMode, session.allowedHosts);
        await session.context.grantPermissions(permissions, { origin });
        actionResult = { permissions, permissionOrigin: origin };
      }
      break;
    }
    case 'screenshot': {
      const requestedOutputPath = path.resolve(process.cwd(), options.outputPath || options.path || `./screenshots/session-${Date.now()}.png`);
      const outputPath = session.safetyMode === 'safe' ? assertPathWithinWorkspace(requestedOutputPath) : requestedOutputPath;
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await prepareVisualCapture(page, {
        readySelector: options.readySelector || null,
        readyTimeout: options.readyTimeout || DEFAULT_PAGE_READY_TIMEOUT,
        delay: options.delay === undefined ? 0 : options.delay,
        freezeAnimations: options.freezeAnimations !== false,
        visualStabilityTimeout: options.visualStabilityTimeout || DEFAULT_VISUAL_STABILITY_TIMEOUT
      });
      if (target) await target.screenshot({ path: outputPath });
      else await page.screenshot({ path: outputPath, fullPage: Boolean(options.fullPage) });
      actionResult = { screenshotPath: outputPath };
      break;
    }
    case 'evaluate': {
      if (session.safetyMode === 'safe') throw new BrowserToolError('UNSAFE_ACTION', 'evaluate is disabled in safetyMode=safe.');
      const evaluationFn = typeof options.fn === 'string' ? options.fn : null;
      const evaluationScript = typeof options.script === 'string' ? options.script : null;
      if (!evaluationFn && !evaluationScript) throw new Error('evaluate requires fn or script.');
      const evaluated = await page.evaluate(payload => {
        if (payload.fn) return Function(`return (${payload.fn})`)()(payload.arg);
        return Function(payload.script)(payload.arg);
      }, { fn: evaluationFn, script: evaluationScript, arg: options.arg ?? null });
      actionResult = { result: compactValue(evaluated) };
      break;
    }
    default:
      throw new Error(`Unsupported agent action: ${action}`);
    }
  } finally {
    if (dialogAttempt) await dialogAttempt.finish();
  }

  session.refs.clear();
  session.generation += 1;
  const result = {
    sessionId: session.id,
    status: 'ok',
    action,
    safetyMode: session.safetyMode,
    url: sanitizeUrl(page.url()),
    title: await page.title().catch(() => ''),
    generation: session.generation,
    requiresObserve: true,
    ...(refRecovered ? { refRecovered } : {}),
    ...(actedOn ? { actedOn } : {}),
    ...actionResult,
    diagnostics: takeSessionDiagnostics(session)
  };
  if (options.observe) result.observation = await observeAgentSession({ sessionId: session.id, maxItems: options.maxItems ?? options['max-items'], maxText: options.maxText ?? options['max-text'] });
  return result;
}

export async function closeAgentSession(options = {}) {
  const session = activeAgentSessions.get(options.sessionId);
  if (!session) {
    // Idempotent cleanup: an agent that already saw SESSION_EXPIRED (or closed
    // the session twice) should not fail its own cleanup step. Never-existing
    // session ids still error so typos stay diagnosable.
    const requestedId = options.sessionId === undefined || options.sessionId === null ? '' : String(options.sessionId);
    if (requestedId && recentlyDisposedSessions.has(requestedId)) {
      return { sessionId: requestedId, status: 'closed', alreadyClosed: true };
    }
    throw new BrowserToolError('SESSION_NOT_FOUND', `Unknown agent session: ${options.sessionId}`);
  }
  await disposeAgentSession(session);
  return { sessionId: session.id, status: 'closed' };
}

// Session discovery. After a crash or reconnect, an agent had no way to learn
// which sessions still exist; it could only discover them by triggering
// SESSION_EXISTS / SESSION_NOT_FOUND errors. This is additive and read-only.
export function listAgentSessions() {
  const now = Date.now();
  return Array.from(activeAgentSessions.values()).map(session => ({
    sessionId: session.id,
    url: sanitizeUrl(session.page && !session.page.isClosed() ? session.page.url() : session.origin),
    channelUsed: session.channelUsed,
    safetyMode: session.safetyMode,
    generation: session.generation,
    idleTimeoutMs: session.idleTimeoutMs,
    msSinceLastActivity: now - session.lastActivityAt,
    expiresInMillis: session.idleTimeoutMs > 0 ? Math.max(0, session.idleTimeoutMs - (now - session.lastActivityAt)) : null,
    subscriptions: session.subscriptions.size,
    watchers: session.watchers.size
  }));
}

// Batch execution of several act actions in one round trip (R3). Steps run
// sequentially on the session's active page; refs recorded by the last
// observation stay usable for the first step (and later steps when ref
// recovery succeeds), but selectors are the reliable way to address elements
// across steps because refs are invalidated after every act. Default behavior
// is stop-on-first-error with per-step evidence, so the agent always knows
// exactly which step failed and why.
export async function batchAgentSession(options = {}) {
  const session = getAgentSession(options.sessionId);
  const steps = options.steps;
  if (!Array.isArray(steps) || steps.length === 0) throw new BrowserToolError('INVALID_BATCH', 'batch steps must be a non-empty array.');
  if (steps.length > MAX_BATCH_STEPS) throw new BrowserToolError('BATCH_TOO_LARGE', `batch cannot contain more than ${MAX_BATCH_STEPS} steps.`);
  const stopOnError = options.stopOnError !== false;
  const observeAfter = ['none', 'delta', 'full'].includes(options.observeAfter) ? options.observeAfter : 'none';
  const mergedDiagnostics = { consoleErrors: [], consoleWarnings: [], networkErrors: [], requestFailures: [] };
  const stepResults = [];
  let failedStep = null;
  let passedSteps = 0;

  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      throw new BrowserToolError('INVALID_BATCH_STEP', `batch step ${index + 1} must be a JSON object.`);
    }
    try {
      const actResult = await actAgentSession({ ...step, sessionId: session.id, refWaitMs: options.refWaitMs });
      passedSteps += 1;
      const { diagnostics, ...actBody } = actResult;
      for (const key of Object.keys(mergedDiagnostics)) {
        mergedDiagnostics[key].push(...(diagnostics?.[key] || []));
        if (mergedDiagnostics[key].length > MAX_SESSION_DIAGNOSTICS) mergedDiagnostics[key].splice(0, mergedDiagnostics[key].length - MAX_SESSION_DIAGNOSTICS);
      }
      const entry = { index, action: actBody.action, status: 'ok', url: actBody.url, title: actBody.title, generation: actBody.generation };
      for (const key of ['downloadPath', 'screenshotPath', 'permissions', 'permissionOrigin', 'result']) {
        if (actBody[key] !== undefined) entry[key] = actBody[key];
      }
      if (actBody.refRecovered) entry.refRecovered = actBody.refRecovered;
      stepResults.push(entry);
    } catch (error) {
      failedStep = index;
      stepResults.push({
        index,
        action: step.action,
        status: 'error',
        code: errorCode(error),
        error: errorMessage(error)
      });
      if (stopOnError) break;
    }
  }

  const result = {
    sessionId: session.id,
    op: 'batch',
    status: failedStep === null ? 'ok' : (passedSteps > 0 ? 'partial' : 'error'),
    safetyMode: session.safetyMode,
    totalSteps: steps.length,
    passedSteps,
    ...(failedStep !== null ? { failedStep } : {}),
    url: sanitizeUrl(session.page && !session.page.isClosed() ? session.page.url() : ''),
    title: await session.page?.title().catch(() => '') || '',
    generation: session.generation,
    requiresObserve: true,
    steps: stepResults,
    diagnostics: {
      consoleErrors: mergedDiagnostics.consoleErrors.length > 0 ? mergedDiagnostics.consoleErrors : undefined,
      consoleWarnings: mergedDiagnostics.consoleWarnings.length > 0 ? mergedDiagnostics.consoleWarnings : undefined,
      networkErrors: mergedDiagnostics.networkErrors.length > 0 ? mergedDiagnostics.networkErrors : undefined,
      requestFailures: mergedDiagnostics.requestFailures.length > 0 ? mergedDiagnostics.requestFailures : undefined
    }
  };
  if (observeAfter !== 'none') {
    result.observation = await observeAgentSession({ sessionId: session.id, mode: observeAfter === 'delta' ? 'delta' : 'full' });
  }
  return result;
}

// Tab management for sessions (R6). Pages opened by the site (popups,
// window.open) already become the active page; this operation makes that
// visible and controllable instead of surprising.
export async function tabsAgentSession(options = {}) {
  const session = getAgentSession(options.sessionId);
  const pages = session.context.pages();
  const tabAction = options.action || 'list';

  if (tabAction === 'list') {
    const activeIndex = pages.indexOf(session.page);
    return {
      sessionId: session.id,
      action: 'list',
      activeIndex,
      tabs: pages.map((page, index) => ({ index, url: sanitizeUrl(page.url()), active: page === session.page }))
    };
  }

  const index = Number(options.index);
  if (!Number.isInteger(index) || index < 0 || index >= pages.length) {
    throw new BrowserToolError('INVALID_TAB_INDEX', `tab index must be an integer from 0 to ${pages.length - 1}.`);
  }

  if (tabAction === 'switch') {
    const previousPage = session.page;
    session.page = pages[index];
    if (session.page !== previousPage) {
      session.refs.clear();
      session.refHistory.clear();
      session.generation += 1;
      attachSessionDiagnostics(session, session.page);
    }
    return {
      sessionId: session.id,
      action: 'switch',
      switchedTo: index,
      url: sanitizeUrl(session.page.url()),
      generation: session.generation,
      requiresObserve: true
    };
  }

  // close
  if (pages[index] === session.page) {
    throw new BrowserToolError('INVALID_TAB_ACTION', 'cannot close the active tab; switch to another tab first.');
  }
  await pages[index].close().catch(() => {});
  return { sessionId: session.id, action: 'close', closedIndex: index, remainingTabs: session.context.pages().length };
}

export async function serveAgentSessions(defaultOptions = {}) {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const defaultOutputLimit = normalizeOutputLimit(defaultOptions.maxOutputChars);
  const output = (value, maxOutputChars = defaultOutputLimit) => process.stdout.write(`${serializeOutput(value, maxOutputChars)}\n`);
  let requestSequence = 0;
  const reaper = setInterval(() => { void expireIdleSessions(); }, 60_000);
  reaper.unref?.();
  const closeOnSignal = () => input.close();
  process.once('SIGINT', closeOnSignal);
  process.once('SIGTERM', closeOnSignal);
  try {
    for await (const line of input) {
      if (!line.trim()) continue;
      let request = null;
      let requestId = String(++requestSequence);
      let requestOutputLimit = defaultOutputLimit;
      try {
        if (line.length > MAX_SESSION_REQUEST_CHARS) {
          throw new BrowserToolError('REQUEST_TOO_LARGE', `Session request cannot exceed ${MAX_SESSION_REQUEST_CHARS} characters.`);
        }
        try {
          request = JSON.parse(line);
        } catch {
          throw new BrowserToolError('INVALID_JSON', 'Session input must be one valid JSON object per line.');
        }
        if (!request || typeof request !== 'object' || Array.isArray(request)) {
          throw new BrowserToolError('INVALID_REQUEST', 'Each session request must be a JSON object.');
        }
        requestId = normalizeRequestId(request.requestId, requestId);
        requestOutputLimit = Math.min(defaultOutputLimit, normalizeOutputLimit(request.maxOutputChars ?? request['max-output-chars'], defaultOutputLimit));
        const operation = validateSessionRequest(request);
        if (operation === 'capabilities') {
          output({ requestId, ok: true, ...getCapabilities() }, requestOutputLimit);
          continue;
        }
        if (operation === 'sessions') {
          output({
            requestId,
            ok: true,
            activeSessions: activeAgentSessions.size,
            sessions: listAgentSessions()
          }, requestOutputLimit);
          continue;
        }
        if (operation === 'quit' || operation === 'exit') {
          for (const session of Array.from(activeAgentSessions.values())) await disposeAgentSession(session);
          output({ requestId, ok: true, status: 'stopped' }, requestOutputLimit);
          break;
        }
        let result;
        if (operation === 'open') {
          const openOptions = { ...defaultOptions, ...request, sessionId: request.sessionId || request.id };
          if (defaultOptions.maxSessions !== undefined) openOptions.maxSessions = defaultOptions.maxSessions;
          if (defaultOptions.idleTimeout !== undefined) openOptions.idleTimeout = defaultOptions.idleTimeout;
          if (defaultOptions.maxItems !== undefined) openOptions.maxItems = Math.min(Number(defaultOptions.maxItems), Number(request.maxItems ?? request['max-items'] ?? defaultOptions.maxItems));
          if (defaultOptions.maxText !== undefined) openOptions.maxText = Math.min(Number(defaultOptions.maxText), Number(request.maxText ?? request['max-text'] ?? defaultOptions.maxText));
          if (defaultOptions.maxOutputChars !== undefined) openOptions.maxOutputChars = defaultOptions.maxOutputChars;
          if (defaultOptions.safetyMode === 'safe' || defaultOptions.safetyMode === 'unsafe') openOptions.safetyMode = defaultOptions.safetyMode;
          if (Array.isArray(defaultOptions.allowedHosts) && defaultOptions.allowedHosts.length > 0) openOptions.allowedHosts = defaultOptions.allowedHosts;
          if (defaultOptions.redact === true) openOptions.redact = true;
          openOptions.eventSink = (event, maxChars) => output(event, Math.min(defaultOutputLimit, normalizeOutputLimit(maxChars, defaultOutputLimit)));
          result = await createAgentSession(openOptions);
        }
        else if (operation === 'observe') result = await observeAgentSession(request);
        else if (operation === 'act') result = await actAgentSession(request);
        else if (operation === 'batch') result = await batchAgentSession(request);
        else if (operation === 'tabs') result = await tabsAgentSession(request);
        else if (operation === 'subscribe') result = subscribeAgentSession(request);
        else if (operation === 'unsubscribe') result = unsubscribeAgentSession(request);
        else if (operation === 'watch') result = await watchAgentSession(request);
        else if (operation === 'unwatch') result = await unwatchAgentSession(request);
        else if (operation === 'close') result = await closeAgentSession(request);
        else throw new BrowserToolError('UNSUPPORTED_OPERATION', `Unsupported session operation: ${operation}`);
        output({ requestId, ok: true, ...result }, requestOutputLimit);
      } catch (err) {
        output({
          requestId,
          ok: false,
          status: 'error',
          op: request && typeof request === 'object' ? request.op || request.action : undefined,
          sessionId: request && typeof request === 'object' ? request.sessionId || request.id : undefined,
          code: errorCode(err),
          error: errorMessage(err),
          details: errorDetails(err)
        }, requestOutputLimit);
      }
    }
  } finally {
    process.off('SIGINT', closeOnSignal);
    process.off('SIGTERM', closeOnSignal);
    clearInterval(reaper);
    for (const session of Array.from(activeAgentSessions.values())) await disposeAgentSession(session).catch(() => {});
  }
}

// ==========================================
// 3. MOBILE OVERFLOW & LAYOUT BUG HUNTER (layout)
// ==========================================
export async function huntLayoutBugs(options) {
  const { url, browser: providedBrowser = null, channelUsed: providedChannelUsed = null, headless = true, waitUntil = 'domcontentloaded', viewport = { width: 390, height: 844 }, authStatePath = null, token = null, cookie = null, network = null, geo = null, timezone = null, redact = false, safetyMode = null, safeMode = false, unsafe = false, allowedHosts = [], readySelector = null, readyTimeout = DEFAULT_PAGE_READY_TIMEOUT, delay = 0, tapTargetMinimum = 28 } = options;
  if (!url) throw new Error('URL is required.');
  const targetUrl = resolveWorkflowUrl(url);
  const normalizedSafetyMode = normalizeSafetyMode({ safetyMode, safeMode, unsafe });
  const normalizedAllowedHosts = normalizeAllowedHosts(allowedHosts);
  assertInitialNavigationAllowed(targetUrl, normalizedSafetyMode, normalizedAllowedHosts);

  validateViewport(viewport);
  const minimumTapTarget = Number(tapTargetMinimum);
  if (!Number.isFinite(minimumTapTarget) || minimumTapTarget < 1 || minimumTapTarget > 1000) throw new Error('Tap-target minimum must be between 1 and 1000 pixels.');
  const browserInfo = await resolveBrowser({ browser: providedBrowser, channelUsed: providedChannelUsed, headless });
  const { browser, channelUsed, ownsBrowser } = browserInfo;
  let context = null;
  try {
    const contextOptions = { viewport, isMobile: true, hasTouch: true };
    if (authStatePath) contextOptions.storageState = path.resolve(process.cwd(), authStatePath);
    const parsedGeo = parseGeo(geo);
    if (parsedGeo) { contextOptions.geolocation = parsedGeo; contextOptions.permissions = ['geolocation']; }
    if (timezone) contextOptions.timezoneId = timezone;
    context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    await configureContextFeatures(context, page, { network, token, cookie, redact, url: targetUrl });
    await page.goto(targetUrl, { waitUntil, timeout: 35000 });
    assertFinalNavigationAllowed(page, targetUrl, normalizedSafetyMode, normalizedAllowedHosts);
    await waitForReadiness(page, { readySelector, readyTimeout, delay });

    const report = await page.evaluate((minimumTapTarget) => {
      const docWidth = document.documentElement.scrollWidth;
      const viewWidth = window.innerWidth;
      const hasHorizontalOverflow = docWidth > viewWidth;

      const overflowingElements = [];
      const smallTapTargets = [];

      const all = Array.from(document.querySelectorAll('*'));
      all.forEach(el => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);

        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' || el.getAttribute('aria-hidden') === 'true' || rect.width === 0 || rect.height === 0) return;

        // Check horizontal overflow
        if (rect.right > viewWidth + 2 || rect.left < -2) {
          overflowingElements.push({
            tag: el.tagName.toLowerCase(),
            id: el.id ? `#${el.id}` : undefined,
            className: el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/)[0]}` : undefined,
            overflowPx: Math.round(Math.max(rect.right - viewWidth, -rect.left)),
            direction: rect.right > viewWidth + 2 ? 'right' : 'left',
            elementWidth: Math.round(rect.width)
          });
        }

        // Check small tap targets on interactive items
        const isClickable = el.tagName === 'BUTTON' || (el.tagName === 'A' && el.hasAttribute('href'))
          || ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName) || el.tagName === 'SUMMARY'
          || el.getAttribute('role') === 'button' || el.getAttribute('role') === 'link';
        if (isClickable && (rect.width < minimumTapTarget || rect.height < minimumTapTarget)) {
          smallTapTargets.push({
            tag: el.tagName.toLowerCase(),
            text: el.textContent?.trim()?.slice(0, 30),
            size: `${Math.round(rect.width)}x${Math.round(rect.height)}px`
          });
        }
      });

      return {
        viewportTested: `${viewWidth}x${window.innerHeight}`,
        hasHorizontalOverflow,
        documentScrollWidth: `${docWidth}px`,
        overflowingElementsCount: overflowingElements.length,
        overflowingElements: overflowingElements.slice(0, 8),
        smallTapTargetsCount: smallTapTargets.length,
        smallTapTargets: smallTapTargets.slice(0, 8)
      };
    }, minimumTapTarget);

    return { url: sanitizeUrl(targetUrl), channelUsed, tapTargetMinimum: minimumTapTarget, ...report };
  } finally {
    if (context) await context.close().catch(() => {});
    if (ownsBrowser) await browser.close();
  }
}

// ==========================================
// 4. BOUNDED INTERACTIVE MAP (map)
// ==========================================
export async function mapInteractiveElements(options) {
  const { url, browser: providedBrowser = null, channelUsed: providedChannelUsed = null, headless = true, authStatePath = null, waitUntil = 'domcontentloaded', token = null, cookie = null, network = null, geo = null, timezone = null, redact = false, safetyMode = null, safeMode = false, unsafe = false, allowedHosts = [], maxItems = DEFAULT_AGENT_ITEM_LIMIT, maxText = DEFAULT_AGENT_TEXT_LIMIT, readySelector = null, readyTimeout = DEFAULT_PAGE_READY_TIMEOUT, delay = 0 } = options;
  if (!url) throw new Error('URL is required.');
  const targetUrl = resolveWorkflowUrl(url);
  const normalizedSafetyMode = normalizeSafetyMode({ safetyMode, safeMode, unsafe });
  const normalizedAllowedHosts = normalizeAllowedHosts(allowedHosts);
  assertInitialNavigationAllowed(targetUrl, normalizedSafetyMode, normalizedAllowedHosts);
  const agentMaxItems = normalizeAgentLimit(maxItems, 'maxItems', 1, 200) ?? DEFAULT_AGENT_ITEM_LIMIT;
  const agentMaxText = normalizeAgentLimit(maxText, 'maxText', 100, 4000) ?? DEFAULT_AGENT_TEXT_LIMIT;

  const browserInfo = await resolveBrowser({ browser: providedBrowser, channelUsed: providedChannelUsed, headless });
  const { browser, channelUsed, ownsBrowser } = browserInfo;
  let context = null;
  try {
    const contextOptions = { viewport: { width: 1440, height: 900 } };
    if (authStatePath) contextOptions.storageState = path.resolve(process.cwd(), authStatePath);
    const parsedGeo = parseGeo(geo);
    if (parsedGeo) { contextOptions.geolocation = parsedGeo; contextOptions.permissions = ['geolocation']; }
    if (timezone) contextOptions.timezoneId = timezone;

    context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    await configureContextFeatures(context, page, { network, redact, token, cookie, url: targetUrl });
    await page.goto(targetUrl, { waitUntil, timeout: 35000 });
    assertFinalNavigationAllowed(page, targetUrl, normalizedSafetyMode, normalizedAllowedHosts);
    if (redact) await applyRedaction(page);
    await waitForReadiness(page, { readySelector, readyTimeout, delay });

    const snapshot = await collectAgentSnapshot(page, { maxItems: agentMaxItems, maxText: agentMaxText, redact });
    const elements = snapshot.elements.map((element, index) => ({
      id: index + 1,
      ref: element.ref,
      tag: element.tag,
      role: element.role,
      type: element.role,
      label: element.name,
      state: element.state,
      selector: snapshot.refs.get(element.ref)?.selector,
      locator: element.locator,
      isIframe: element.role === 'iframe',
      isCanvas: element.role === 'canvas'
    }));

    return {
      url: sanitizeUrl(targetUrl),
      channelUsed,
      title: snapshot.title,
      headings: snapshot.headings,
      landmarks: snapshot.landmarks,
      text: snapshot.text,
      totalElements: snapshot.totalInteractive,
      returnedElements: elements.length,
      truncated: snapshot.truncated,
      elements
    };
  } finally {
    if (context) await context.close().catch(() => {});
    if (ownsBrowser) await browser.close();
  }
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  let firstError = null;
  const workerCount = Math.min(items.length, Math.max(1, limit));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      if (firstError) return;
      const index = nextIndex++;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index]);
      } catch (err) {
        firstError = err;
        return;
      }
    }
  });
  await Promise.all(workers);
  if (firstError) throw firstError;
  return results;
}

// ==========================================
// 5. RESPONSIVE VISUAL EVIDENCE (screenshot)
// ==========================================
export async function captureResponsiveScreenshots(options) {
  const {
    url,
    outputDir = './screenshots',
    outputFilename = null,
    presets = ['desktop'],
    customSizes = [],
    fullPage = false,
    selector = null,
    clip = null,
    hover = null,
    delay = 0,
    colorScheme = 'no-preference',
    headless = true,
    recordVideo = false,
    videoDir = './recordings',
    concurrency = true,
    maxConcurrency = DEFAULT_SCREENSHOT_CONCURRENCY,
    authStatePath = null,
    network = null,
    redact = false,
    waitUntil = 'domcontentloaded',
    token = null,
    cookie = null,
    geo = null,
    timezone = null,
    freezeAnimations = true,
    visualStabilityTimeout = DEFAULT_VISUAL_STABILITY_TIMEOUT,
    safetyMode = null,
    safeMode = false,
    unsafe = false,
    allowedHosts = [],
    readySelector = null,
    readyTimeout = DEFAULT_PAGE_READY_TIMEOUT,
    browser: providedBrowser = null,
    channelUsed: providedChannelUsed = null
  } = options;

  if (!url) throw new Error('URL is required.');
  const targetUrl = resolveWorkflowUrl(url);
  const normalizedSafetyMode = normalizeSafetyMode({ safetyMode, safeMode, unsafe });
  const normalizedAllowedHosts = normalizeAllowedHosts(allowedHosts);
  assertInitialNavigationAllowed(targetUrl, normalizedSafetyMode, normalizedAllowedHosts);

  const resolvedOutputDir = normalizedSafetyMode === 'safe'
    ? assertPathWithinWorkspace(path.resolve(process.cwd(), outputDir))
    : path.resolve(process.cwd(), outputDir);
  await fs.mkdir(resolvedOutputDir, { recursive: true });

  let resolvedVideoDir = null;
  if (recordVideo) {
    resolvedVideoDir = normalizedSafetyMode === 'safe'
      ? assertPathWithinWorkspace(path.resolve(process.cwd(), videoDir))
      : path.resolve(process.cwd(), videoDir);
    await fs.mkdir(resolvedVideoDir, { recursive: true });
  }

  const targetConfigs = [];
  const presetList = normalizePresetList(presets, ['desktop']);

  const invalidPresets = presetList.filter(p => p && !VIEWPORT_PRESETS[p]);
  if (invalidPresets.length > 0) throw new Error(`Unknown viewport preset(s): ${invalidPresets.join(', ')}`);

  for (const p of presetList) {
    if (VIEWPORT_PRESETS[p]) targetConfigs.push(VIEWPORT_PRESETS[p]);
  }

  for (const c of customSizes) {
    const customViewport = { width: Number(c.width), height: Number(c.height) };
    validateViewport(customViewport);
    targetConfigs.push({
      name: safeArtifactFilename(c.name || `custom-${customViewport.width}x${customViewport.height}`, 'custom-view'),
      viewport: customViewport,
      isMobile: Boolean(c.isMobile),
      hasTouch: Boolean(c.hasTouch)
    });
  }

  if (targetConfigs.length === 0) targetConfigs.push(VIEWPORT_PRESETS.desktop);

  const themesToTest = colorScheme === 'both' ? ['light', 'dark'] : [colorScheme];
  if (!['no-preference', 'light', 'dark', 'both'].includes(colorScheme)) throw new Error(`Unknown color scheme: ${colorScheme}`);
  const concurrencyLimit = Math.max(1, Math.min(Number(maxConcurrency) || DEFAULT_SCREENSHOT_CONCURRENCY, 16));

  const browserInfo = await resolveBrowser({ browser: providedBrowser, channelUsed: providedChannelUsed, headless });
  const { browser, channelUsed, ownsBrowser } = browserInfo;

  const processConfig = async (config, currentTheme) => {
    const contextOptions = {
      viewport: config.viewport,
      isMobile: config.isMobile,
      hasTouch: config.hasTouch,
      deviceScaleFactor: config.deviceScaleFactor || 1,
      colorScheme: currentTheme !== 'no-preference' ? currentTheme : undefined
    };

    if (authStatePath) contextOptions.storageState = path.resolve(process.cwd(), authStatePath);
    if (recordVideo) contextOptions.recordVideo = { dir: resolvedVideoDir, size: config.viewport };
    const parsedGeo = parseGeo(geo);
    if (parsedGeo) { contextOptions.geolocation = parsedGeo; contextOptions.permissions = ['geolocation']; }
    if (timezone) contextOptions.timezoneId = timezone;

    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    try {
      await configureContextFeatures(context, page, { network, redact, token, cookie, url: targetUrl });
      await page.goto(targetUrl, { waitUntil, timeout: 35000 });
      assertFinalNavigationAllowed(page, targetUrl, normalizedSafetyMode, normalizedAllowedHosts);
      if (redact) await applyRedaction(page);
      await prepareVisualCapture(page, { readySelector, readyTimeout, delay, freezeAnimations, visualStabilityTimeout });
      if (hover) {
        await page.hover(hover).catch(() => {});
        await waitForVisualStability(page, { timeout: visualStabilityTimeout });
      }

      const timestamp = Date.now();
      const sanitizedUrl = sanitizeUrl(targetUrl).replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30);
      const themeSuffix = colorScheme === 'both' ? `-${currentTheme}` : '';
      const requestedFilename = outputFilename ? safeArtifactFilename(outputFilename, 'capture.png') : null;
      const filename = requestedFilename
        ? (targetConfigs.length > 1 ? `${path.parse(requestedFilename).name}-${safeArtifactFilename(config.name, 'view')}${themeSuffix}${path.parse(requestedFilename).ext || '.png'}` : requestedFilename)
        : `${sanitizedUrl}-${config.name}${themeSuffix}-${timestamp}.png`;

      const finalPath = path.join(resolvedOutputDir, filename);
      const parsedClip = parseClip(clip);

      if (selector) {
        const element = await page.waitForSelector(selector, { timeout: 10000 });
        await element.screenshot({ path: finalPath });
      } else if (parsedClip) {
        await page.screenshot({ path: finalPath, clip: parsedClip });
      } else {
        await page.screenshot({ path: finalPath, fullPage });
      }

      let recordedVideoPath = null;
      if (recordVideo && page.video()) {
        const video = page.video();
        const videoFinalPath = path.join(resolvedVideoDir, `${sanitizedUrl}-${config.name}${themeSuffix}-${timestamp}.webm`);
        await page.close();
        await context.close();
        const origVideoPath = await video.path();
        await fs.rename(origVideoPath, videoFinalPath).catch(async () => {
          await fs.copyFile(origVideoPath, videoFinalPath);
          await fs.unlink(origVideoPath).catch(() => {});
        });
        recordedVideoPath = videoFinalPath;
      } else {
        await context.close();
      }

      return { name: `${config.name}${themeSuffix}`, viewport: config.viewport, path: finalPath, videoPath: recordedVideoPath };
    } catch (err) {
      await context.close().catch(() => {});
      throw err;
    }
  };

  try {
    const tasks = [];
    for (const config of targetConfigs) {
      for (const t of themesToTest) {
        tasks.push({ config, theme: t });
      }
    }

    const results = await mapWithConcurrency(tasks, concurrency ? concurrencyLimit : 1, task => processConfig(task.config, task.theme));

    return {
      channelUsed,
      totalCaptured: results.length,
      files: results.map(r => ({ name: r.name, viewport: r.viewport, path: r.path })),
      videos: results.map(r => r.videoPath).filter(Boolean)
    };
  } finally {
    if (ownsBrowser) await browser.close();
  }
}

// ==========================================
// 6. DIAGNOSTIC & PROBE ENGINE
// ==========================================
export async function probeUrl(options) {
  const {
    url,
    delay = 0,
    headless = true,
    takeScreenshot = false,
    outputDir = './screenshots',
    recordVideo = false,
    videoDir = './recordings',
    auditA11y = true,
    redact = false,
    authStatePath = null,
    network = null,
    waitUntil = 'domcontentloaded',
    token = null,
    cookie = null,
    geo = null,
    timezone = null,
    hover = null,
    ignoreUrls = [],
    safetyMode = null,
    safeMode = false,
    unsafe = false,
    allowedHosts = [],
    viewport = { width: 1440, height: 900 },
    isMobile = false,
    hasTouch = false,
    deviceScaleFactor = 1,
    freezeAnimations = true,
    visualStabilityTimeout = DEFAULT_VISUAL_STABILITY_TIMEOUT,
    readySelector = null,
    readyTimeout = DEFAULT_PAGE_READY_TIMEOUT,
    browser: providedBrowser = null,
    channelUsed: providedChannelUsed = null
  } = options;

  if (!url) throw new Error('URL is required.');
  const targetUrl = resolveWorkflowUrl(url);
  const ignoredUrls = normalizeIgnoreUrls(ignoreUrls);
  const normalizedSafetyMode = normalizeSafetyMode({ safetyMode, safeMode, unsafe });
  const normalizedAllowedHosts = normalizeAllowedHosts(allowedHosts);
  assertInitialNavigationAllowed(targetUrl, normalizedSafetyMode, normalizedAllowedHosts);
  if (normalizedSafetyMode === 'safe') {
    if (takeScreenshot) assertPathWithinWorkspace(path.resolve(process.cwd(), outputDir));
    if (recordVideo) assertPathWithinWorkspace(path.resolve(process.cwd(), videoDir));
  }

  const consoleErrors = [];
  const consoleWarnings = [];
  const networkErrors = [];
  const requestFailures = [];
  let requestCount = 0;

  validateViewport(viewport);
  const browserInfo = await resolveBrowser({ browser: providedBrowser, channelUsed: providedChannelUsed, headless });
  const { browser, channelUsed, ownsBrowser } = browserInfo;
  let context = null;

  try {
    const contextOptions = { viewport, isMobile, hasTouch, deviceScaleFactor };
    if (authStatePath) contextOptions.storageState = path.resolve(process.cwd(), authStatePath);
    const parsedGeo = parseGeo(geo);
    if (parsedGeo) { contextOptions.geolocation = parsedGeo; contextOptions.permissions = ['geolocation']; }
    if (timezone) contextOptions.timezoneId = timezone;

    let resolvedVideoDir = null;
    if (recordVideo) {
      resolvedVideoDir = path.resolve(process.cwd(), videoDir);
      await fs.mkdir(resolvedVideoDir, { recursive: true });
      contextOptions.recordVideo = { dir: resolvedVideoDir, size: viewport };
    }

    context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    await configureContextFeatures(context, page, { network, redact, token, cookie, url: targetUrl });

    page.on('console', (msg) => {
      if (shouldIgnoreUrl(page.url(), ignoredUrls)) return;
      const type = msg.type();
      const entry = { type, text: redactSensitiveText(msg.text()).slice(0, 300), url: sanitizeUrl(page.url()) };
      if (type === 'error') appendBounded(consoleErrors, entry);
      else if (isConsoleWarningType(type)) appendBounded(consoleWarnings, entry);
    });

    page.on('pageerror', (err) => {
      if (shouldIgnoreUrl(page.url(), ignoredUrls)) return;
      appendBounded(consoleErrors, { type: 'uncaught-error', text: redactSensitiveText(err.message).slice(0, 300), url: sanitizeUrl(page.url()) });
    });

    page.on('request', () => { requestCount++; });
    page.on('response', (res) => {
      if (shouldIgnoreUrl(res.url(), ignoredUrls)) return;
      if (res.status() >= 400) appendBounded(networkErrors, { method: res.request().method(), resourceType: res.request().resourceType(), url: sanitizeUrl(res.url()), status: res.status(), statusText: res.statusText() });
    });
    page.on('requestfailed', request => {
      if (shouldIgnoreUrl(request.url(), ignoredUrls)) return;
      appendBounded(requestFailures, { method: request.method(), resourceType: request.resourceType(), url: sanitizeUrl(request.url()), failure: redactSensitiveText(request.failure()?.errorText || 'request failed').slice(0, 300) });
    });

    const startTime = Date.now();
    const response = await page.goto(targetUrl, { waitUntil, timeout: 35000 });
    const loadTimeMs = Date.now() - startTime;
    assertFinalNavigationAllowed(page, targetUrl, normalizedSafetyMode, normalizedAllowedHosts);

    if (redact) await applyRedaction(page);
    if (takeScreenshot || hover) await prepareVisualCapture(page, { readySelector, readyTimeout, delay, freezeAnimations, visualStabilityTimeout });
    else await waitForReadiness(page, { readySelector, readyTimeout, delay });
    if (hover) {
      await page.hover(hover).catch(() => {});
      await waitForVisualStability(page, { timeout: visualStabilityTimeout });
    }

    const diagnostics = await page.evaluate((runA11y) => {
      const perf = window.performance?.timing;
      const meta = {
        title: document.title,
        description: document.querySelector('meta[name="description"]')?.getAttribute('content') || null
      };

      const a11yIssues = [];
      if (runA11y) {
        document.querySelectorAll('img:not([alt])').forEach(img => {
          a11yIssues.push({ type: 'missing-alt', element: img.id || img.className || 'img' });
        });
        document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"])').forEach(input => {
          const hasLabel = (input.id && document.querySelector(`label[for="${CSS.escape(input.id)}"]`)) || input.closest('label');
          const hasAria = input.getAttribute('aria-label') || input.getAttribute('aria-labelledby');
          if (!hasLabel && !hasAria) {
            a11yIssues.push({ type: 'unlabelled-input', element: input.name || input.id || input.type });
          }
        });
        document.querySelectorAll('button').forEach(btn => {
          if (!btn.textContent?.trim() && !btn.getAttribute('aria-label')) {
            a11yIssues.push({ type: 'empty-button', element: btn.className || 'button' });
          }
        });
      }

      return {
        timing: perf ? {
          ttfb: perf.responseStart - perf.requestStart,
          domReady: perf.domContentLoadedEventEnd - perf.navigationStart,
          loadComplete: perf.loadEventEnd - perf.navigationStart
        } : {},
        meta,
        headingsCount: document.querySelectorAll('h1, h2, h3').length,
        linksCount: document.querySelectorAll('a').length,
        imagesCount: document.querySelectorAll('img').length,
        brokenImages: Array.from(document.querySelectorAll('img')).filter(img => img.complete && img.naturalWidth === 0).length,
        a11y: {
          totalIssues: a11yIssues.length,
          issues: a11yIssues.slice(0, 10)
        }
      };
    }, auditA11y);

    let screenshotPath = null;
    if (takeScreenshot) {
      const resolvedDir = normalizedSafetyMode === 'safe'
        ? assertPathWithinWorkspace(path.resolve(process.cwd(), outputDir))
        : path.resolve(process.cwd(), outputDir);
      await fs.mkdir(resolvedDir, { recursive: true });
      screenshotPath = path.join(resolvedDir, `probe-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath });
    }

    let videoPath = null;
    if (recordVideo && page.video()) {
      const video = page.video();
      videoPath = path.join(resolvedVideoDir, `probe-${Date.now()}.webm`);
      await page.close();
      await context.close();
      const origVideo = await video.path();
      await fs.rename(origVideo, videoPath).catch(async () => {
        await fs.copyFile(origVideo, videoPath);
        await fs.unlink(origVideo).catch(() => {});
      });
    } else {
      await context.close();
    }

    return {
      url: sanitizeUrl(targetUrl),
      httpStatus: response ? response.status() : null,
      channelUsed,
      loadTimeMs,
      diagnostics,
      consoleLogs: { totalErrors: consoleErrors.length, totalWarnings: consoleWarnings.length, errors: consoleErrors, warnings: consoleWarnings },
      network: { totalRequests: requestCount, errors: networkErrors, requestFailures },
      screenshotPath,
      videoPath
    };
  } finally {
    if (context) await context.close().catch(() => {});
    if (ownsBrowser) await browser.close();
  }
}

// ==========================================
// 7. ADVANCED BEHAVIORAL WORKFLOW RUNNER
// ==========================================
export async function runWorkflow(options) {
  const {
    steps = [],
    preset = 'desktop',
    customViewport = null,
    headless = true,
    slowMo = 0,
    recordVideo = false,
    saveSnapshots = false,
    videoDir = './recordings',
    videoFilename = null,
    authStatePath = null,
    saveStatePath = null,
    network = null,
    redact = false,
    waitUntil = 'domcontentloaded',
    token = null,
    cookie = null,
    geo = null,
    timezone = null,
    permissions = null,
    permissionOrigin = null,
    safetyMode = null,
    safeMode = false,
    unsafe = false,
    allowedHosts = [],
    ignoreUrls = [],
    readySelector = null,
    readyTimeout = DEFAULT_PAGE_READY_TIMEOUT,
    delay = 0,
    trace = 'off',
    traceDir = './traces',
    retrySideEffects = false,
    allowSensitiveTrace = false,
    freezeAnimations = true,
    visualStabilityTimeout = DEFAULT_VISUAL_STABILITY_TIMEOUT,
    browser: providedBrowser = null,
    channelUsed: providedChannelUsed = null
  } = options;

  const retryCounts = validateWorkflowSteps(steps);
  const normalizedSafetyMode = normalizeSafetyMode({ safetyMode, safeMode, unsafe });
  const normalizedAllowedHosts = normalizeAllowedHosts(allowedHosts);
  const ignoredUrls = normalizeIgnoreUrls(ignoreUrls);

  if (!customViewport && !VIEWPORT_PRESETS[preset]) throw new Error(`Unknown viewport preset: ${preset}`);
  const deviceConfig = customViewport
    ? { viewport: validateViewport(customViewport) }
    : VIEWPORT_PRESETS[preset];

  const traceMode = normalizeTraceMode(trace);
  if (redact && traceMode !== 'off' && !allowSensitiveTrace) {
    throw new Error('Tracing with redaction is disabled by default because trace archives can contain raw DOM and network data. Set allowSensitiveTrace=true only for a controlled, confidential run.');
  }
  const resolvedTraceDir = path.resolve(process.cwd(), traceDir);
  const resolvedSaveStatePath = saveStatePath ? path.resolve(process.cwd(), saveStatePath) : null;
  if (normalizedSafetyMode === 'safe') {
    if (recordVideo) assertPathWithinWorkspace(path.resolve(process.cwd(), videoDir));
    if (traceMode !== 'off') assertPathWithinWorkspace(resolvedTraceDir);
    if (resolvedSaveStatePath) assertPathWithinWorkspace(resolvedSaveStatePath);
  }
  const browserInfo = await resolveBrowser({ browser: providedBrowser, channelUsed: providedChannelUsed, headless, slowMo });
  const { browser, channelUsed, ownsBrowser } = browserInfo;

  const stepResults = [];
  const behavioralWarnings = [];
  const consoleErrors = [];
  const consoleWarnings = [];
  const networkErrors = [];
  const requestFailures = [];
  const extractedData = {};
  let fatalError = null;
  const firstHttpNavigationStep = steps.find(step => step && (step.action === 'navigate' || step.action === 'goto') && isHttpUrl(resolveWorkflowUrl(step.url)));
  const workflowOriginUrl = firstHttpNavigationStep ? resolveWorkflowUrl(firstHttpNavigationStep.url) : null;
  let navigationOrigin = workflowOriginUrl ? new URL(workflowOriginUrl).origin : null;

  let resolvedVideoDir = null;
  if (recordVideo) {
    resolvedVideoDir = normalizedSafetyMode === 'safe'
      ? assertPathWithinWorkspace(path.resolve(process.cwd(), videoDir))
      : path.resolve(process.cwd(), videoDir);
    await fs.mkdir(resolvedVideoDir, { recursive: true });
  }

  let cleanupContext = null;
  let cleanupTraceStarted = false;
  try {
    const contextOptions = {
      viewport: deviceConfig.viewport,
      isMobile: deviceConfig.isMobile,
      hasTouch: deviceConfig.hasTouch,
      deviceScaleFactor: deviceConfig.deviceScaleFactor || 1
    };

    if (authStatePath) contextOptions.storageState = path.resolve(process.cwd(), authStatePath);
    if (recordVideo) contextOptions.recordVideo = { dir: resolvedVideoDir, size: deviceConfig.viewport };
    const parsedGeo = parseGeo(geo);
    if (parsedGeo) { contextOptions.geolocation = parsedGeo; contextOptions.permissions = ['geolocation']; }
    if (timezone) contextOptions.timezoneId = timezone;

    const context = await browser.newContext(contextOptions);
    cleanupContext = context;
    let activePage = await context.newPage();
    if (permissions) {
      await context.grantPermissions(normalizePermissionList(permissions), {
        origin: resolvePermissionOrigin(permissionOrigin || workflowOriginUrl)
      });
    }
    await configureContextFeatures(context, activePage, { network, redact, token, cookie, url: workflowOriginUrl });

    let traceStarted = false;
    let tracePath = null;
    let traceError = null;
    if (traceMode !== 'off') {
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      traceStarted = true;
      cleanupTraceStarted = true;
    }

    const attachWorkflowDiagnostics = (page) => {
      page.on('framenavigated', frame => {
        if (frame !== page.mainFrame()) return;
        try {
          assertNavigationAllowed(frame.url(), navigationOrigin, normalizedSafetyMode, normalizedAllowedHosts);
          if (!navigationOrigin && isHttpUrl(frame.url())) navigationOrigin = new URL(frame.url()).origin;
        } catch (error) {
          appendBounded(consoleErrors, { type: 'navigation-blocked', code: errorCode(error), text: errorMessage(error), url: sanitizeUrl(frame.url()) });
          void page.close().catch(() => {});
        }
      });
      page.on('console', (msg) => {
        if (shouldIgnoreUrl(page.url(), ignoredUrls)) return;
        const diagnostic = { type: msg.type(), text: redactSensitiveText(msg.text()).slice(0, 300), url: sanitizeUrl(page.url()) };
        if (msg.type() === 'error') appendBounded(consoleErrors, diagnostic);
        else if (isConsoleWarningType(msg.type())) appendBounded(consoleWarnings, diagnostic);
      });
      page.on('pageerror', (err) => {
        if (shouldIgnoreUrl(page.url(), ignoredUrls)) return;
        appendBounded(consoleErrors, { type: 'uncaught-exception', text: redactSensitiveText(err.message).slice(0, 300), url: sanitizeUrl(page.url()) });
      });
      page.on('response', (res) => {
        if (shouldIgnoreUrl(res.url(), ignoredUrls)) return;
        if (res.status() >= 400) appendBounded(networkErrors, { method: res.request().method(), resourceType: res.request().resourceType(), url: sanitizeUrl(res.url()), status: res.status() });
      });
      page.on('requestfailed', request => {
        if (shouldIgnoreUrl(request.url(), ignoredUrls)) return;
        appendBounded(requestFailures, { method: request.method(), resourceType: request.resourceType(), url: sanitizeUrl(request.url()), failure: redactSensitiveText(request.failure()?.errorText || 'request failed').slice(0, 300) });
      });
      if (redact) page.on('framenavigated', frame => {
        if (frame === page.mainFrame()) void applyRedaction(page);
      });
    };
    attachWorkflowDiagnostics(activePage);

    context.on('page', (newPage) => {
      void (async () => {
        activePage = newPage;
        attachWorkflowDiagnostics(newPage);
        await newPage.waitForLoadState().catch(() => {});
        await configureContextFeatures(context, newPage, { network, redact, token, cookie, url: workflowOriginUrl });
        if (redact) await applyRedaction(newPage);
      })().catch(err => {
        appendBounded(consoleErrors, { type: 'browser-tool-error', text: errorMessage(err).slice(0, 300), url: sanitizeUrl(newPage.url()) });
      });
    });

    let pendingDialog = null;
    let pendingDialogStep = null;
    let pendingDialogSoft = false;
    for (let i = 0; i < steps.length; i++) {
      if (fatalError) break;
      const step = steps[i];
      const index = i + 1;
      const { action, soft = false, optional = false, description = '', frame = null, ...args } = step;
      const retries = retryCounts[i];
      const isSoft = soft || optional;

      let attempt = 0;
      let lastError = null;
      let stepPassed = false;

      while (attempt <= retries && !stepPassed) {
        attempt++;
        let dialogAttempt = null;
        try {
          if (pendingDialog && action === 'dialog') {
            if (pendingDialog.required !== false) {
              throw new Error(`Dialog step ${pendingDialogStep} must be followed by the action that opens the dialog.`);
            }
            pendingDialog = null;
            pendingDialogStep = null;
            pendingDialogSoft = false;
          }
          if (pendingDialog && action !== 'dialog') dialogAttempt = armDialogHandler(activePage, pendingDialog);
          const target = resolveTargetScope(activePage, frame);

          switch (action) {
            case 'navigate':
            case 'goto':
              {
                const nextUrl = resolveWorkflowUrl(args.url);
                assertNavigationAllowed(nextUrl, navigationOrigin, normalizedSafetyMode, normalizedAllowedHosts);
                await activePage.goto(nextUrl, { waitUntil: args.waitUntil || waitUntil, timeout: Number(args.timeout) || 35000 });
                if (!navigationOrigin && isHttpUrl(nextUrl)) navigationOrigin = new URL(nextUrl).origin;
              }
              if (redact) await applyRedaction(activePage);
              await waitForReadiness(activePage, {
                readySelector: args.readySelector || readySelector,
                readyTimeout: args.readyTimeout || readyTimeout,
                delay: args.delay === undefined ? delay : args.delay
              });
              stepResults.push({ step: index, action, status: 'ok', description });
              stepPassed = true;
              break;

            case 'upload':
            case 'setInputFiles': {
              const fileList = Array.isArray(args.files) ? args.files : [args.files || args.file || args.path];
              const resolvedFiles = fileList.map(f => {
                const resolved = path.resolve(process.cwd(), f);
                return normalizedSafetyMode === 'safe' ? assertPathWithinWorkspace(resolved) : resolved;
              });
              await target.locator(args.selector).setInputFiles(resolvedFiles);
              stepResults.push({ step: index, action, status: 'ok', description: `Uploaded ${resolvedFiles.length} file(s)` });
              stepPassed = true;
              break;
            }

            case 'dragAndDrop':
            case 'drag': {
              const dragOpts = { timeout: args.timeout || 8000 };
              if (args.sourcePosition) dragOpts.sourcePosition = args.sourcePosition;
              if (args.targetPosition) dragOpts.targetPosition = args.targetPosition;
              if (frame) await target.locator(args.source || args.from).dragTo(target.locator(args.target || args.to), dragOpts);
              else await activePage.dragAndDrop(args.source || args.from, args.target || args.to, dragOpts);
              stepResults.push({ step: index, action, status: 'ok', description: `Dragged ${args.source} to ${args.target}` });
              stepPassed = true;
              break;
            }

            case 'switchTab': {
              const pages = context.pages();
              const tabIdx = args.index ?? (pages.length - 1);
              if (!pages[tabIdx]) throw new Error(`Tab index ${tabIdx} does not exist; ${pages.length} tab(s) open.`);
              activePage = pages[tabIdx];
              await activePage.bringToFront();
              stepResults.push({ step: index, action, status: 'ok', description: `Switched to tab ${tabIdx}` });
              stepPassed = true;
              break;
            }

            case 'mockRoute':
            case 'mockApi': {
              const routePattern = args.url || args.pattern || '**/*';
              await activePage.route(routePattern, async (route) => {
                if (args.abort) {
                  await route.abort();
                } else {
                  if (args.delay) await new Promise(r => setTimeout(r, args.delay));
                  await route.fulfill({
                    status: args.status || 200,
                    contentType: args.contentType || 'application/json',
                    body: typeof args.body === 'object' ? JSON.stringify(args.body) : String(args.body || '{}'),
                    headers: args.headers || {}
                  });
                }
              });
              stepResults.push({ step: index, action, status: 'ok', description: `Mocked ${routePattern}` });
              stepPassed = true;
              break;
            }

            case 'saveState': {
              const requestedPath = path.resolve(process.cwd(), args.path || saveStatePath || './auth.json');
              const targetPath = normalizedSafetyMode === 'safe' ? assertPathWithinWorkspace(requestedPath) : requestedPath;
              await fs.mkdir(path.dirname(targetPath), { recursive: true });
              await context.storageState({ path: targetPath });
              stepResults.push({ step: index, action, status: 'ok', description: `Saved auth state to ${targetPath}` });
              stepPassed = true;
              break;
            }

            case 'dialog': {
              pendingDialog = normalizeDialogSpec(args.dialog ?? {
                type: args.type || args.disposition || 'accept',
                promptText: args.promptText ?? args.text,
                required: args.required
              });
              pendingDialogStep = index;
              pendingDialogSoft = isSoft;
              stepResults.push({ step: index, action, status: 'ok', description, dialog: pendingDialog.type });
              stepPassed = true;
              break;
            }

            case 'download': {
              const downloadPath = await downloadFromSelector(activePage, frame ? target : null, { ...args, safeMode: normalizedSafetyMode === 'safe' });
              stepResults.push({ step: index, action, status: 'ok', description, downloadPath });
              stepPassed = true;
              break;
            }

            case 'permissions': {
              if (args.clear) {
                await context.clearPermissions();
                stepResults.push({ step: index, action, status: 'ok', description, permissions: [] });
              } else {
                const granted = normalizePermissionList(args.permissions || args.permission);
                const origin = resolvePermissionOrigin(args.origin || workflowOriginUrl || activePage.url());
                assertNavigationAllowed(origin, navigationOrigin, normalizedSafetyMode, normalizedAllowedHosts);
                await context.grantPermissions(granted, { origin });
                stepResults.push({ step: index, action, status: 'ok', description, permissions: granted, permissionOrigin: origin });
              }
              stepPassed = true;
              break;
            }

            case 'click': {
              const clickOpts = { timeout: args.timeout || 8000, force: Boolean(args.force) };
              if (args.position || (args.x !== undefined && args.y !== undefined)) {
                clickOpts.position = args.position || { x: Number(args.x), y: Number(args.y) };
              }
              if (frame) {
                await target.locator(args.selector).click(clickOpts);
              } else {
                await activePage.click(args.selector, clickOpts);
              }
              stepResults.push({ step: index, action, status: 'ok', description });
              stepPassed = true;
              break;
            }

            case 'fill':
              if (frame) {
                if (args.clear !== false) await target.locator(args.selector).fill('');
                await target.locator(args.selector).fill(String(args.text ?? args.value ?? ''));
              } else {
                if (args.clear !== false) await activePage.fill(args.selector, '');
                if (args.delay) await activePage.type(args.selector, String(args.text ?? args.value ?? ''), { delay: args.delay });
                else await activePage.fill(args.selector, String(args.text ?? args.value ?? ''));
              }
              stepResults.push({ step: index, action, status: 'ok', description });
              stepPassed = true;
              break;

            case 'type':
              if (frame) {
                const locator = target.locator(args.selector);
                if (args.clear !== false) await locator.fill('');
                await locator.pressSequentially(String(args.text ?? args.value ?? ''), { delay: Number(args.delay) || 0, timeout: Number(args.timeout) || 8000 });
              } else {
                if (args.clear !== false) await activePage.fill(args.selector, '');
                await activePage.locator(args.selector).pressSequentially(String(args.text ?? args.value ?? ''), { delay: Number(args.delay) || 0, timeout: Number(args.timeout) || 8000 });
              }
              stepResults.push({ step: index, action, status: 'ok', description });
              stepPassed = true;
              break;

            case 'check':
              if (frame) await target.locator(args.selector).check();
              else await activePage.check(args.selector);
              stepResults.push({ step: index, action, status: 'ok', description });
              stepPassed = true;
              break;

            case 'uncheck':
              if (frame) await target.locator(args.selector).uncheck();
              else await activePage.uncheck(args.selector);
              stepResults.push({ step: index, action, status: 'ok', description });
              stepPassed = true;
              break;

            case 'select':
            case 'selectOption':
              {
                const selectValue = selectOptionDescriptor(args);
                if (frame) await target.locator(args.selector).selectOption(selectValue);
                else await activePage.selectOption(args.selector, selectValue);
              }
              stepResults.push({ step: index, action, status: 'ok', description });
              stepPassed = true;
              break;

            case 'press':
              if (frame) await target.locator(args.selector || 'body').press(args.key || 'Enter');
              else if (args.selector) await activePage.locator(args.selector).press(args.key || 'Enter');
              else await activePage.keyboard.press(args.key || 'Enter');
              stepResults.push({ step: index, action, status: 'ok', description });
              stepPassed = true;
              break;

            case 'hover':
              if (frame) await target.locator(args.selector).hover();
              else await activePage.hover(args.selector);
              stepResults.push({ step: index, action, status: 'ok', description });
              stepPassed = true;
              break;

            case 'scroll':
              if (args.selector && frame) await target.locator(args.selector).scrollIntoViewIfNeeded();
              else if (args.selector) await activePage.locator(args.selector).scrollIntoViewIfNeeded();
              else if (args.position === 'bottom') await activePage.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
              else if (args.position === 'top') await activePage.evaluate(() => window.scrollTo(0, 0));
              else await activePage.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
              stepResults.push({ step: index, action, status: 'ok', description });
              stepPassed = true;
              break;

            case 'wait':
              if (args.selector) {
                if (frame) await target.locator(args.selector).waitFor({ state: args.state || 'visible', timeout: args.timeout || 8000 });
                else await activePage.waitForSelector(args.selector, { state: args.state || 'visible', timeout: args.timeout || 8000 });
              } else if (args.url) {
                await activePage.waitForURL(args.url, { timeout: args.timeout || 8000 });
              } else {
                await activePage.waitForTimeout(args.ms || args.time || 500);
              }
              stepResults.push({ step: index, action, status: 'ok', description });
              stepPassed = true;
              break;

            case 'assert': {
              const timeout = args.timeout || 5000;
              let text;
              if (frame) {
                const locator = target.locator(args.selector);
                await locator.waitFor({ timeout });
                text = await readLocatorText(locator, redact);
              } else {
                const locator = activePage.locator(args.selector);
                await locator.waitFor({ timeout });
                text = await readLocatorText(locator, redact);
              }

              if (args.containsText && !text.includes(args.containsText)) {
                throw new Error(`Text mismatch: expected "${args.containsText}", found "${text}"`);
              }
              if (args.equalsText && text !== args.equalsText) {
                throw new Error(`Text mismatch: expected "${args.equalsText}", found "${text}"`);
              }
              stepResults.push({ step: index, action, status: 'ok', description, verifiedText: text });
              stepPassed = true;
              break;
            }

            case 'scrape':
            case 'getText': {
              let text;
              if (frame) {
                text = await readLocatorText(target.locator(args.selector), redact);
              } else {
                const locator = activePage.locator(args.selector);
                await locator.waitFor({ state: 'attached', timeout: args.timeout || 6000 });
                text = await readLocatorText(locator, redact);
              }
              const key = args.saveAs || `data_step_${index}`;
              extractedData[key] = compactValue(text || '', 2000);
              stepResults.push({ step: index, action, status: 'ok', description, text: compactValue(text || '', 500) });
              stepPassed = true;
              break;
            }

            case 'screenshot': {
              const requestedOutPath = path.resolve(process.cwd(), args.outputPath || args.path || `./screenshots/step-${index}-${Date.now()}.png`);
              const outPath = normalizedSafetyMode === 'safe' ? assertPathWithinWorkspace(requestedOutPath) : requestedOutPath;
              await fs.mkdir(path.dirname(outPath), { recursive: true });
              await prepareVisualCapture(activePage, {
                readySelector: args.readySelector || readySelector,
                readyTimeout: args.readyTimeout || readyTimeout,
                delay: args.delay === undefined ? 0 : args.delay,
                freezeAnimations: args.freezeAnimations === undefined ? freezeAnimations : Boolean(args.freezeAnimations),
                visualStabilityTimeout: args.visualStabilityTimeout || visualStabilityTimeout
              });
              if (args.selector) {
                if (frame) await target.locator(args.selector).screenshot({ path: outPath, timeout: Number(args.timeout) || 10000 });
                else {
                  const el = await activePage.waitForSelector(args.selector, { timeout: Number(args.timeout) || 10000 });
                  await el.screenshot({ path: outPath });
                }
              } else if (args.clip) {
                await activePage.screenshot({ path: outPath, clip: parseClip(args.clip) });
              } else {
                await activePage.screenshot({ path: outPath, fullPage: Boolean(args.fullPage) });
              }
              stepResults.push({ step: index, action, status: 'ok', description, screenshotPath: outPath });
              stepPassed = true;
              break;
            }

            case 'evaluate': {
              if (normalizedSafetyMode === 'safe') throw new BrowserToolError('UNSAFE_ACTION', 'evaluate is disabled in safetyMode=safe. Use safetyMode=standard only for trusted workflows.');
              let res;
              if (frame) {
                res = await target.locator('body').evaluate((element, payload) => {
                  if (payload.fn) return Function(`return (${payload.fn})`)()(element, payload.arg);
                  if (payload.script) return Function(payload.script)(element, payload.arg);
                  throw new Error('evaluate requires fn or script.');
                }, { fn: typeof args.fn === 'string' ? args.fn : null, script: typeof args.script === 'string' ? args.script : null, arg: args.arg });
              } else if (typeof args.fn === 'function') {
                res = await activePage.evaluate(args.fn, args.arg);
              } else if (typeof args.fn === 'string') {
                res = await activePage.evaluate(({ source, arg }) => Function(`return (${source})`)()(arg), { source: args.fn, arg: args.arg });
              } else if (typeof args.script === 'string') {
                res = await activePage.evaluate(args.script);
              } else {
                throw new Error('evaluate requires fn or script.');
              }
              stepResults.push({ step: index, action, status: 'ok', description, result: compactValue(res) });
              stepPassed = true;
              break;
            }

            default:
              throw new Error(`Unsupported action: "${action}"`);
          }
          if (dialogAttempt) {
            await dialogAttempt.finish();
            pendingDialog = null;
            pendingDialogStep = null;
            pendingDialogSoft = false;
          }
        } catch (err) {
          if (dialogAttempt) await dialogAttempt.finish().catch(() => {});
          lastError = err;
          const canRetry = attempt <= retries && (retrySideEffects || !NON_IDEMPOTENT_WORKFLOW_ACTIONS.has(action));
          if (canRetry) await activePage.waitForTimeout(300);
          else break;
        }
      }

      if (!stepPassed) {
        const stepError = lastError || new Error(`Step ${index} failed without an error.`);
        let snapshotPath = null;
        if (saveSnapshots) {
          const requestedSnapshotPath = path.resolve(process.cwd(), `./screenshots/warning-step-${index}-${Date.now()}.png`);
          snapshotPath = normalizedSafetyMode === 'safe'
            ? assertPathWithinWorkspace(requestedSnapshotPath)
            : requestedSnapshotPath;
          await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
          await prepareVisualCapture(activePage, { freezeAnimations, visualStabilityTimeout }).catch(() => {});
          await activePage.screenshot({ path: snapshotPath }).catch(() => {});
        }

        if (isSoft) {
          const warningInfo = {
            step: index,
            action,
            description: description || `Soft check step ${index}`,
            code: errorCode(stepError),
            error: errorMessage(stepError),
            snapshot: snapshotPath
          };
          behavioralWarnings.push(warningInfo);
          stepResults.push({ step: index, action, status: 'warning', ...warningInfo });
        } else {
          stepResults.push({ step: index, action, status: 'error', code: errorCode(stepError), error: errorMessage(stepError), description, snapshot: snapshotPath });
          fatalError = stepError;
          break;
        }
      }
    }

    if (pendingDialog && !fatalError && pendingDialog.required !== false) {
      const pendingDialogError = new Error(`Expected a ${pendingDialog.type} dialog after step ${pendingDialogStep}, but the workflow ended before an action opened it.`);
      const pendingDialogResult = stepResults.find(result => result.step === pendingDialogStep && result.action === 'dialog' && result.status === 'ok');
      if (pendingDialogResult) {
        pendingDialogResult.status = pendingDialogSoft ? 'warning' : 'error';
        pendingDialogResult.code = errorCode(pendingDialogError);
        pendingDialogResult.error = errorMessage(pendingDialogError);
      }
      if (pendingDialogSoft) {
        behavioralWarnings.push({
          step: pendingDialogStep,
          action: 'dialog',
          description: `Expected a ${pendingDialog.type} dialog`,
          code: errorCode(pendingDialogError),
          error: errorMessage(pendingDialogError)
        });
      } else {
        fatalError = pendingDialogError;
      }
      pendingDialog = null;
      pendingDialogStep = null;
      pendingDialogSoft = false;
    } else if (pendingDialog && !fatalError) {
      pendingDialog = null;
      pendingDialogStep = null;
      pendingDialogSoft = false;
    }

    const workflowStatus = fatalError ? 'failed' : behavioralWarnings.length > 0 ? 'warning' : 'passed';
    if (traceStarted) {
      const shouldSaveTrace = traceMode === 'on' || workflowStatus !== 'passed';
      try {
        if (shouldSaveTrace) {
          await fs.mkdir(resolvedTraceDir, { recursive: true });
          tracePath = path.join(resolvedTraceDir, `workflow-${Date.now()}.zip`);
          await context.tracing.stop({ path: tracePath });
        } else {
          await context.tracing.stop();
        }
      } catch (err) {
        traceError = errorMessage(err);
      } finally {
        cleanupTraceStarted = false;
      }
    }

    if (saveStatePath) {
      const targetState = normalizedSafetyMode === 'safe'
        ? assertPathWithinWorkspace(resolvedSaveStatePath)
        : resolvedSaveStatePath;
      await fs.mkdir(path.dirname(targetState), { recursive: true });
      await context.storageState({ path: targetState });
    }

    let finalVideoPath = null;
    const finalVideoPaths = [];
    if (recordVideo) {
      const pageVideos = context.pages()
        .map((page, index) => ({ page, index, video: page.video() }))
        .filter(item => item.video);
      const configuredVideoName = safeArtifactFilename(videoFilename, `workflow-${Date.now()}.webm`);
      const configuredExtension = path.extname(configuredVideoName) || '.webm';
      const configuredStem = path.basename(configuredVideoName, path.extname(configuredVideoName));
      for (const item of pageVideos) await item.page.close().catch(() => {});
      await context.close();
      cleanupContext = null;
      for (const item of pageVideos) {
        const originalVideoPath = await item.video.path();
        const filename = pageVideos.length === 1
          ? configuredVideoName
          : `${configuredStem}-tab-${item.index + 1}${configuredExtension}`;
        const destination = path.join(resolvedVideoDir, filename);
        await fs.rename(originalVideoPath, destination).catch(async () => {
          await fs.copyFile(originalVideoPath, destination);
          await fs.unlink(originalVideoPath).catch(() => {});
        });
        finalVideoPaths.push(destination);
      }
      finalVideoPath = finalVideoPaths[0] || null;
    } else {
      await context.close();
      cleanupContext = null;
    }

    return {
      status: workflowStatus,
      channelUsed,
      safetyMode: normalizedSafetyMode,
      totalSteps: steps.length,
      passedSteps: stepResults.filter(s => s.status === 'ok').length,
      stepResults,
      errorCode: fatalError ? errorCode(fatalError) : undefined,
      error: fatalError ? errorMessage(fatalError) : undefined,
      behavioralWarnings: behavioralWarnings.length > 0 ? behavioralWarnings : undefined,
      liveDiagnostics: {
        consoleErrors: consoleErrors.length > 0 ? consoleErrors : undefined,
        consoleWarnings: consoleWarnings.length > 0 ? consoleWarnings : undefined,
        networkErrors: networkErrors.length > 0 ? networkErrors : undefined,
        requestFailures: requestFailures.length > 0 ? requestFailures : undefined
      },
      extractedData: Object.keys(extractedData).length > 0 ? extractedData : undefined,
      videoPath: finalVideoPath || undefined,
      videoPaths: finalVideoPaths.length > 0 ? finalVideoPaths : undefined,
      tracePath: tracePath || undefined,
      traceError: traceError || undefined
    };
  } finally {
    if (cleanupTraceStarted && cleanupContext) {
      try {
        await fs.mkdir(resolvedTraceDir, { recursive: true });
        await cleanupContext.tracing.stop({ path: path.join(resolvedTraceDir, `workflow-error-${Date.now()}.zip`) });
      } catch {}
    }
    if (cleanupContext) await cleanupContext.close().catch(() => {});
    if (ownsBrowser) await browser.close();
  }
}

// ==========================================
// 8. FULL QA & STANDALONE HTML REPORT
// ==========================================
export async function runFullQA(options = {}) {
  const {
    frontendUrl = 'http://localhost:5173',
    mode = 'standard',
    presets = null,
    testWorkflow = null,
    headless = true,
    authStatePath = null,
    network = null,
    waitUntil = 'domcontentloaded',
    token = null,
    cookie = null,
    geo = null,
    timezone = null,
    redact = false,
    safetyMode = null,
    safeMode = false,
    unsafe = false,
    allowedHosts = [],
    ignoreUrls = [],
    json = false,
    maxA11yIssues = 0,
    maxNetworkErrors = 0,
    maxConsoleErrors = 0,
    maxSmallTapTargets = null,
    tapTargetMinimum = 28,
    allowHorizontalOverflow = false,
    checkLayout = null,
    readySelector = null,
    readyTimeout = DEFAULT_PAGE_READY_TIMEOUT,
    maxConcurrency = DEFAULT_SCREENSHOT_CONCURRENCY,
    trace = 'off',
    traceDir = './traces',
    allowSensitiveTrace = false,
    freezeAnimations = true,
    visualStabilityTimeout = DEFAULT_VISUAL_STABILITY_TIMEOUT
  } = options;

  if (!QA_PRESET_MODES[mode] && presets === null) throw new Error(`Unknown QA mode: ${mode}. Expected smoke, standard, or release.`);
  const selectedPresets = normalizePresetList(presets ?? QA_PRESET_MODES[mode]);
  const probePreset = VIEWPORT_PRESETS[selectedPresets[0]] || VIEWPORT_PRESETS.desktop;
  const targetFrontendUrl = resolveWorkflowUrl(frontendUrl);
  const layoutEnabled = checkLayout === null
    ? (mode !== 'smoke' || selectedPresets.some(name => ['mobile', 'mobile-small', 'tablet', 'tablet-landscape'].includes(name)))
    : Boolean(checkLayout);
  const qaStepCount = 2 + (layoutEnabled ? 1 : 0) + (testWorkflow ? 1 : 0);
  const a11yIssueLimit = normalizeNonNegativeInteger(maxA11yIssues, 'maxA11yIssues');
  const networkErrorLimit = normalizeNonNegativeInteger(maxNetworkErrors, 'maxNetworkErrors');
  const consoleErrorLimit = normalizeNonNegativeInteger(maxConsoleErrors, 'maxConsoleErrors');
  const smallTapTargetLimit = maxSmallTapTargets === null
    ? null
    : normalizeNonNegativeInteger(maxSmallTapTargets, 'maxSmallTapTargets');
  const normalizedSafetyMode = normalizeSafetyMode({ safetyMode, safeMode, unsafe });
  const normalizedAllowedHosts = normalizeAllowedHosts(allowedHosts);
  const normalizedIgnoreUrls = normalizeIgnoreUrls(ignoreUrls);
  assertInitialNavigationAllowed(targetFrontendUrl, normalizedSafetyMode, normalizedAllowedHosts);

  const log = (...args) => { if (!json) console.log(...args); };
  const logError = (...args) => { if (!json) console.error(...args); };
  log(`\n=== Running Automated Full-App QA Suite ===\n`);

  let sharedBrowserInfo;
  let browserCheck;
  try {
    sharedBrowserInfo = await resolveBrowser({ headless });
    browserCheck = {
      status: 'ok',
      channelUsed: sharedBrowserInfo.channelUsed,
      browserVersion: sharedBrowserInfo.browser.version(),
      attempts: sharedBrowserInfo.attempts || []
    };
  } catch (err) {
    const reason = errorMessage(err);
    browserCheck = {
      status: 'error',
      channelUsed: null,
      browserVersion: null,
      attempts: err.attempts || [],
      installHint: 'Run "npm run browsers:install", then run the doctor again.',
      error: reason
    };
    logError(`  -> Browser Preflight Failed: ${reason}`);
    const preflightFailure = {
      passed: false,
      mode,
      presets: selectedPresets,
      browser: browserCheck,
      quality: {
        browser: { healthy: false, reason },
        probe: { healthy: false, reason },
        responsive: { healthy: false, reason },
        layout: layoutEnabled ? { healthy: false, reason } : { healthy: true, skipped: true },
        workflow: testWorkflow ? false : true
      },
      probe: { error: reason },
      responsive: { error: reason },
      layout: layoutEnabled ? { error: reason } : null,
      workflow: testWorkflow ? { error: reason } : null
    };
    return preflightFailure;
  }

  try {
  log(`[QA Step 1/${qaStepCount}] Probing Frontend (${sanitizeUrl(targetFrontendUrl)})...`);
  let probeResult;
  try {
    probeResult = await probeUrl({
      url: targetFrontendUrl,
      takeScreenshot: false,
      headless,
      browser: sharedBrowserInfo.browser,
      channelUsed: sharedBrowserInfo.channelUsed,
      authStatePath,

      network,
      waitUntil,
      token,
      cookie,
      geo,
      timezone,
      redact,
      freezeAnimations,
      visualStabilityTimeout,
      viewport: probePreset.viewport,
      isMobile: Boolean(probePreset.isMobile),
      hasTouch: Boolean(probePreset.hasTouch),
      deviceScaleFactor: probePreset.deviceScaleFactor || 1,
      readySelector,
      readyTimeout,
      ignoreUrls: normalizedIgnoreUrls,
      safetyMode: normalizedSafetyMode,
      allowedHosts: normalizedAllowedHosts
    });
    log(`  -> HTTP Status: ${probeResult.httpStatus} | Load: ${probeResult.loadTimeMs}ms | A11y Issues: ${probeResult.diagnostics.a11y.totalIssues}`);
  } catch (err) {
    probeResult = { error: errorMessage(err) };
    logError(`  -> Probe Failed: ${errorMessage(err)}`);
  }

  log(`[QA Step 2/${qaStepCount}] Checking Responsive Render on [${selectedPresets.join(', ')}]...`);
  let responsiveResult;
  try {
    responsiveResult = await captureResponsiveScreenshots({
      url: targetFrontendUrl,
      headless,
      browser: sharedBrowserInfo.browser,
      channelUsed: sharedBrowserInfo.channelUsed,
      presets: selectedPresets,
      delay: 0,

      maxConcurrency,
      authStatePath,
      network,
      waitUntil,
      token,
      cookie,
      geo,
      timezone,
      redact,
      safetyMode: normalizedSafetyMode,
      allowedHosts: normalizedAllowedHosts,
      freezeAnimations,
      visualStabilityTimeout,
      readySelector,
      readyTimeout
    });
    log(`  -> Rendered ${responsiveResult.totalCaptured} viewports cleanly.`);
  } catch (err) {
    responsiveResult = { error: errorMessage(err) };
    logError(`  -> Responsive Check Failed: ${errorMessage(err)}`);
  }

  let layoutResult = null;
  if (layoutEnabled) {
    const layoutPresetName = selectedPresets.find(name => ['mobile', 'mobile-small', 'tablet', 'tablet-landscape'].includes(name)) || 'mobile';
    const layoutPreset = VIEWPORT_PRESETS[layoutPresetName] || VIEWPORT_PRESETS.mobile;
    log(`[QA Step 3/${qaStepCount}] Checking mobile layout (${layoutPresetName})...`);
    try {
      layoutResult = await huntLayoutBugs({
        url: targetFrontendUrl,
        headless,
        browser: sharedBrowserInfo.browser,
        channelUsed: sharedBrowserInfo.channelUsed,

        viewport: layoutPreset.viewport,
        authStatePath,
        network,
        token,
        cookie,
        geo,
        timezone,
        redact,
        readySelector,
        readyTimeout,
        delay: 0,
        tapTargetMinimum,
        safetyMode: normalizedSafetyMode,
        allowedHosts: normalizedAllowedHosts
      });
      log(`  -> Overflow: ${layoutResult.hasHorizontalOverflow ? 'YES' : 'NONE'} | Small tap targets: ${layoutResult.smallTapTargetsCount}`);
    } catch (err) {
      layoutResult = { error: errorMessage(err) };
      logError(`  -> Layout Check Failed: ${errorMessage(err)}`);
    }
  }

  let workflowResult = null;
  if (testWorkflow) {
    log(`[QA Step ${layoutEnabled ? 4 : 3}/${qaStepCount}] Running Behavioral Flow (${testWorkflow})...`);
    try {
      const wf = await readWorkflowFile(testWorkflow);
      workflowResult = await runWorkflow({
        ...wf,
        headless,
        browser: sharedBrowserInfo.browser,
        channelUsed: sharedBrowserInfo.channelUsed,
        authStatePath,

        network,
        waitUntil,
        token,
        cookie,
        geo,
        timezone,
        redact: redact || Boolean(wf.redact),
        safetyMode: normalizedSafetyMode,
        allowedHosts: normalizedAllowedHosts,
        ignoreUrls: normalizedIgnoreUrls,
        readySelector,
        readyTimeout,
        delay: 0,
        trace: trace === 'off' ? (wf.trace || 'off') : trace,
        traceDir: traceDir === './traces' ? (wf.traceDir || traceDir) : traceDir,
        allowSensitiveTrace: allowSensitiveTrace || Boolean(wf.allowSensitiveTrace),
        freezeAnimations: freezeAnimations && wf.freezeAnimations !== false,
        visualStabilityTimeout
      });
      log(`  -> Flow Status: ${workflowResult.status.toUpperCase()} (${workflowResult.passedSteps}/${workflowResult.totalSteps} steps passed)`);
    } catch (err) {
      workflowResult = { error: errorMessage(err) };
      logError(`  -> Flow Failed: ${errorMessage(err)}`);
    }
  }

  const probeQuality = probeResult.error ? {
    healthy: false,
    reason: probeResult.error
  } : {
    healthy: Number(probeResult.httpStatus) >= 200 && Number(probeResult.httpStatus) < 400
      && probeResult.consoleLogs.totalErrors <= consoleErrorLimit
      && probeResult.network.errors.length + probeResult.network.requestFailures.length <= networkErrorLimit
      && probeResult.diagnostics.a11y.totalIssues <= a11yIssueLimit
      && probeResult.diagnostics.brokenImages === 0,
    httpStatus: probeResult.httpStatus,
    consoleErrors: probeResult.consoleLogs.totalErrors,
    networkErrors: probeResult.network.errors.length + probeResult.network.requestFailures.length,
    a11yIssues: probeResult.diagnostics.a11y.totalIssues,
    brokenImages: probeResult.diagnostics.brokenImages
  };
  const responsiveQuality = responsiveResult.error ? { healthy: false, reason: responsiveResult.error } : { healthy: responsiveResult.totalCaptured > 0, captured: responsiveResult.totalCaptured };
  const layoutQuality = !layoutEnabled
    ? { healthy: true, skipped: true }
    : layoutResult?.error
      ? { healthy: false, reason: layoutResult.error }
      : {
          healthy: Boolean(layoutResult)
            && (allowHorizontalOverflow || !layoutResult.hasHorizontalOverflow)
            && (smallTapTargetLimit === null || layoutResult.smallTapTargetsCount <= smallTapTargetLimit),
          horizontalOverflow: layoutResult?.hasHorizontalOverflow || false,
          smallTapTargets: layoutResult?.smallTapTargetsCount || 0,
          smallTapTargetsEnforced: smallTapTargetLimit !== null
        };
  const workflowConsoleErrors = workflowResult?.liveDiagnostics?.consoleErrors?.length || 0;
  const workflowNetworkErrors = (workflowResult?.liveDiagnostics?.networkErrors?.length || 0)
    + (workflowResult?.liveDiagnostics?.requestFailures?.length || 0);
  const workflowQuality = !workflowResult || (
    !workflowResult.error
    && workflowResult.status === 'passed'
    && workflowConsoleErrors <= consoleErrorLimit
    && workflowNetworkErrors <= networkErrorLimit
  );
  const overallPassed = probeQuality.healthy && responsiveQuality.healthy && layoutQuality.healthy && workflowQuality;

  log(`\n================ QA SCORECARD ================`);
  log(`Overall Result: ${overallPassed ? 'PASSED ✅' : 'ATTENTION NEEDED ⚠️'}`);
  log(`Frontend Health: ${probeQuality.healthy ? 'OK (Status ' + probeResult.httpStatus + ')' : 'FAILED ❌'}`);
  log(`Responsive Rendering: ${responsiveQuality.healthy ? 'OK (' + responsiveResult.totalCaptured + ' viewports)' : 'FAILED ❌'}`);
  if (layoutEnabled) log(`Mobile Layout: ${layoutQuality.healthy ? 'OK' : 'FAILED ❌'}`);
  if (workflowResult) log(`Behavioral Flow: ${workflowResult.error ? 'FAILED ❌' : workflowResult.status.toUpperCase()}`);

  return { passed: overallPassed, browser: browserCheck, mode, presets: selectedPresets, quality: { browser: { healthy: true, channelUsed: browserCheck.channelUsed }, probe: probeQuality, responsive: responsiveQuality, layout: layoutQuality, workflow: workflowQuality }, probe: probeResult, responsive: responsiveResult, layout: layoutResult, workflow: workflowResult };
  } finally {
    await sharedBrowserInfo.browser.close().catch(() => {});
  }
}

// ==========================================
// 9. VISUAL DIFF
// ==========================================
export async function compareVisualDiff(options) {
  const { url, baselinePath, threshold = 0.05, outputDiffPath = './screenshots/visual-diff.png', headless = true, waitUntil = 'domcontentloaded', authStatePath = null, token = null, cookie = null, redact = false, preset = 'desktop', customViewport = null, network = null, geo = null, timezone = null, safetyMode = null, safeMode = false, unsafe = false, allowedHosts = [], readySelector = null, readyTimeout = DEFAULT_PAGE_READY_TIMEOUT, delay = 0, freezeAnimations = true, visualStabilityTimeout = DEFAULT_VISUAL_STABILITY_TIMEOUT, browser: providedBrowser = null, channelUsed: providedChannelUsed = null } = options;
  if (!url || !baselinePath) throw new Error('URL and --baseline path required.');
  const targetUrl = resolveWorkflowUrl(url);
  const normalizedSafetyMode = normalizeSafetyMode({ safetyMode, safeMode, unsafe });
  const normalizedAllowedHosts = normalizeAllowedHosts(allowedHosts);
  assertInitialNavigationAllowed(targetUrl, normalizedSafetyMode, normalizedAllowedHosts);
  const numericThreshold = Number(threshold);
  if (!Number.isFinite(numericThreshold) || numericThreshold < 0 || numericThreshold > 1) throw new Error('Visual diff threshold must be a number from 0 to 1.');
  if (!customViewport && !VIEWPORT_PRESETS[preset]) throw new Error(`Unknown viewport preset: ${preset}`);

  const resolvedBaseline = path.resolve(process.cwd(), baselinePath);
  if (normalizedSafetyMode === 'safe') {
    assertPathWithinWorkspace(resolvedBaseline);
    assertPathWithinWorkspace(path.resolve(process.cwd(), outputDiffPath));
  }
  const baselineBuffer = await fs.readFile(resolvedBaseline);
  const baselineHash = crypto.createHash('sha256').update(baselineBuffer).digest('hex');

  const selectedPreset = VIEWPORT_PRESETS[preset] || VIEWPORT_PRESETS.desktop;
  const viewport = validateViewport(customViewport || selectedPreset.viewport);
  const browserInfo = await resolveBrowser({ browser: providedBrowser, channelUsed: providedChannelUsed, headless });
  const { browser, channelUsed, ownsBrowser } = browserInfo;
  let context = null;
  try {
    const contextOptions = { viewport, deviceScaleFactor: customViewport ? 1 : (selectedPreset.deviceScaleFactor || 1) };
    if (selectedPreset.isMobile && !customViewport) { contextOptions.isMobile = true; contextOptions.hasTouch = true; }
    if (authStatePath) contextOptions.storageState = path.resolve(process.cwd(), authStatePath);
    const parsedGeo = parseGeo(geo);
    if (parsedGeo) { contextOptions.geolocation = parsedGeo; contextOptions.permissions = ['geolocation']; }
    if (timezone) contextOptions.timezoneId = timezone;
    context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    await configureContextFeatures(context, page, { network, token, cookie, redact, geo, timezone, url: targetUrl });
    await page.goto(targetUrl, { waitUntil, timeout: 30000 });
    assertFinalNavigationAllowed(page, targetUrl, normalizedSafetyMode, normalizedAllowedHosts);
    if (redact) await applyRedaction(page);
    await prepareVisualCapture(page, { readySelector, readyTimeout, delay, freezeAnimations, visualStabilityTimeout });

    const currentBuffer = await page.screenshot();
    const currentHash = crypto.createHash('sha256').update(currentBuffer).digest('hex');

    const comparison = await page.evaluate(async ({ baseline, current, pixelThreshold }) => {
      const loadImage = (data) => new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('Unable to decode screenshot data.'));
        image.src = `data:image/png;base64,${data}`;
      });
      const [baselineImage, currentImage] = await Promise.all([loadImage(baseline), loadImage(current)]);
      if (baselineImage.width !== currentImage.width || baselineImage.height !== currentImage.height) {
        return { match: false, exactHashMatch: false, differentPixels: 1, totalPixels: 1, pixelDiffPercent: '100.00%', diffDataUrl: null, dimensions: { baseline: [baselineImage.width, baselineImage.height], current: [currentImage.width, currentImage.height] } };
      }
      const width = currentImage.width;
      const height = currentImage.height;
      const canvas = document.createElement('canvas');
      const diffCanvas = document.createElement('canvas');
      canvas.width = diffCanvas.width = width;
      canvas.height = diffCanvas.height = height;
      const baselineContext = canvas.getContext('2d', { willReadFrequently: true });
      const currentContext = diffCanvas.getContext('2d', { willReadFrequently: true });
      baselineContext.drawImage(baselineImage, 0, 0);
      currentContext.drawImage(currentImage, 0, 0);
      const baselinePixels = baselineContext.getImageData(0, 0, width, height).data;
      const currentPixels = currentContext.getImageData(0, 0, width, height).data;
      const diffPixels = currentContext.createImageData(width, height);
      let differentPixels = 0;
      for (let index = 0; index < currentPixels.length; index += 4) {
        const difference = Math.max(
          Math.abs(baselinePixels[index] - currentPixels[index]),
          Math.abs(baselinePixels[index + 1] - currentPixels[index + 1]),
          Math.abs(baselinePixels[index + 2] - currentPixels[index + 2]),
          Math.abs(baselinePixels[index + 3] - currentPixels[index + 3])
        );
        if (difference > 16) {
          differentPixels += 1;
          diffPixels.data[index] = 220;
          diffPixels.data[index + 1] = 38;
          diffPixels.data[index + 2] = 38;
          diffPixels.data[index + 3] = 255;
        } else {
          const gray = Math.round((currentPixels[index] + currentPixels[index + 1] + currentPixels[index + 2]) / 3);
          diffPixels.data[index] = gray;
          diffPixels.data[index + 1] = gray;
          diffPixels.data[index + 2] = gray;
          diffPixels.data[index + 3] = 110;
        }
      }
      currentContext.putImageData(diffPixels, 0, 0);
      const totalPixels = width * height;
      const pixelDiffPercent = (differentPixels / totalPixels) * 100;
      return { match: pixelDiffPercent <= pixelThreshold * 100, differentPixels, totalPixels, pixelDiffPercent: pixelDiffPercent.toFixed(2) + '%', diffDataUrl: currentContext.canvas.toDataURL('image/png'), dimensions: { baseline: [width, height], current: [width, height] } };
    }, { baseline: baselineBuffer.toString('base64'), current: currentBuffer.toString('base64'), pixelThreshold: numericThreshold });

    let diffSavedTo = null;
    if (!comparison.match && comparison.diffDataUrl) {
      const resolvedDiff = normalizedSafetyMode === 'safe'
        ? assertPathWithinWorkspace(path.resolve(process.cwd(), outputDiffPath))
        : path.resolve(process.cwd(), outputDiffPath);
      await fs.mkdir(path.dirname(resolvedDiff), { recursive: true });
      const base64Diff = comparison.diffDataUrl.replace(/^data:image\/png;base64,/, '');
      await fs.writeFile(resolvedDiff, Buffer.from(base64Diff, 'base64'));
      diffSavedTo = resolvedDiff;
    }

    return {
      channelUsed,
      match: comparison.match,
      exactHashMatch: baselineHash === currentHash,
      differentPixels: comparison.differentPixels,
      totalPixels: comparison.totalPixels,
      pixelDiffPercent: comparison.pixelDiffPercent,
      sizeDiffPercent: comparison.pixelDiffPercent,
      dimensions: comparison.dimensions,
      baseline: resolvedBaseline,
      diffSavedTo
    };
  } finally {
    if (context) await context.close().catch(() => {});
    if (ownsBrowser) await browser.close();
  }
}

export async function cleanArtifacts(options = {}) {
  const dirs = ['./screenshots', './recordings', './traces'];
  const force = Boolean(options.force);
  const toolFile = /^(probe|component|visual-diff|step-|warning-step-|workflow-|behavioral-|https?_|file_|localhost|127_|session-)/i;
  let removedCount = 0;
  const skipped = [];
  for (const d of dirs) {
    const abs = path.resolve(process.cwd(), d);
    try {
      const files = await fs.readdir(abs);
      for (const f of files) {
        if (!force && !toolFile.test(f)) {
          skipped.push(path.join(abs, f));
          continue;
        }
        try {
          const target = path.join(abs, f);
          const stat = await fs.stat(target);
          if (stat.isDirectory()) {
            if ((await fs.readdir(target)).length === 0) {
              await fs.rmdir(target);
              removedCount++;
            } else {
              skipped.push(target);
            }
            continue;
          }
          if (!stat.isFile()) { skipped.push(target); continue; }
          await fs.unlink(target);
          removedCount++;
        } catch {
          skipped.push(path.join(abs, f));
        }
      }
    } catch {}
  }
  return { removedCount, skippedCount: skipped.length, skipped };
}

// ==========================================
// 10. CLI PARSER & RUNNER
// ==========================================
function parseCliArgs(args) {
  const options = {};
  const positional = [];
  const parseValue = (key, value) => {
    if ((CLI_BOOLEAN_OPTIONS.has(key) || key === 'safe-mode') && (value === 'true' || value === 'false')) return value === 'true';
    // Keep all non-boolean CLI values as strings. Paths, selectors, cookies,
    // and tokens can be numeric-looking values; coercing them loses data.
    return value;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        const key = arg.slice(2, eq);
        const val = arg.slice(eq + 1);
        options[key] = parseValue(key, val);
      } else {
        const key = arg.slice(2);
        const next = args[i + 1];
        if (next && !next.startsWith('--')) {
          options[key] = parseValue(key, next);
          i++;
        } else {
          options[key] = true;
        }
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, options };
}

function showHelp() {
  console.log(`
Browser Tool — bounded browser automation for agents

COMMANDS:
  capabilities [--json]         Show protocol, actions, events, and limits without launching a browser
  serve | session               Keep browser sessions alive over JSONL stdin/stdout
  doctor                       Verify the bundled browser launches
  map <url> [options]           One-shot bounded semantic map with stable refs
  probe <url> [options]         Health, console, network, and accessibility checks
  qa <url> [options]            Probe + responsive captures + optional workflow
  interact <workflow.json>      Execute a repeatable multi-step browser flow
  screenshot <url> [options]    Capture responsive visual evidence
  diff <url> [options]          Compare a render against a PNG baseline
  layout <url> [options]        Check mobile overflow and small tap targets
  clean [--all]                 Remove tool artifacts safely
  presets                       List supported viewport and network presets

COMMON OPTIONS:
  --json                        Compact JSON output for agent ingestion
  --auth=<path>                 Reuse saved cookies/localStorage state
  --save-state=<path>           Save workflow browser state
  --token=<value>               Scope Authorization to the target origin
  --cookie=<str>                Add cookies for the target URL
  --network=<profile>           Throttle: slow-3g, fast-3g, or offline
  --geo=<lat,lng>               Simulate geolocation
  --timezone=<id>               Simulate timezone
  --permissions=<list>          Grant permissions such as geolocation (workflow/session)
  --permission-origin=<url>     Scope explicit permission grants to one HTTP origin
  --redact                      Hide sensitive fields in visual artifacts
  --wait-until=<state>          domcontentloaded (default), load, or networkidle
  --ready=<css>                 Wait for a visible readiness selector before capture/probe
  --delay=<ms>                  Optional explicit delay after readiness (default: 0)
  --visual-stability-timeout=<ms>  Max wait for fonts/images before visual capture
  --preset=<name|all>           desktop, laptop, tablet, tablet-landscape, mobile, or all
  --max-items=<n>               Limit observed controls (default: 40)
  --max-text=<n>                Limit observed page text (default: 700)
  --max-output-chars=<n>        Cap one JSON response (default: 20000)
  --safety-mode=<mode>          standard, safe, or unsafe (all browser commands)
  --safe                        Alias for --safety-mode=safe
  --allowed-hosts=<list>        Comma-separated navigation allowlist
  --ignore-urls=<list>          Comma-separated diagnostic URL patterns to ignore
  --max-sessions=<n>            Persistent session limit (default: 8)
  --idle-timeout=<ms>           Close idle sessions (default: 1800000; 0 disables)

VISUAL OPTIONS:
  --selector=<css>              Capture one element
  --clip=x,y,w,h                Capture a region
  --hover=<css>                 Hover before capture
  --theme=<name>                light, dark, or both
  --size=WIDTHxHEIGHT           Custom screenshot or diff resolution
  --max-concurrency=<n>         Limit simultaneous screenshot contexts (default: 2)
  --no-freeze                   Keep page animations/transitions running during captures
  --record                      Save video while capturing
  --trace[=<mode>]              Workflow trace: on, on-failure, or off (default: off)
  --trace-dir=<path>            Directory for workflow trace archives
  --allow-sensitive-trace        Explicitly allow traces when --redact is enabled
  --retry-side-effects          Allow retries for clicks, uploads, evaluate, and other side effects

QA OPTIONS:
  --workflow=<path>             Behavioral workflow to include in qa
  --mode=<name>                 QA scope: smoke (desktop), standard (desktop+mobile), release (all presets)
  --max-a11y-issues=<n>         Allowed accessibility findings
  --max-network-errors=<n>      Allowed HTTP/request failures
  --max-console-errors=<n>      Allowed console errors
  --max-small-tap-targets=<n>   Fail QA above this many small mobile targets (report-only by default)
  --skip-layout                 Skip the mobile layout check
  --allow-overflow              Allow horizontal overflow in QA

WORKFLOW OPTIONS:
  --allow-warnings               Keep a warning workflow exit code at zero

SESSION INPUT (one JSON object per line):
  {"requestId":"0","op":"capabilities"}
  {"requestId":"1","op":"open","sessionId":"app","url":"http://localhost:5173"}
  {"requestId":"2","op":"subscribe","sessionId":"app","events":["navigation"]}
  {"requestId":"3","op":"watch","sessionId":"app","selector":"#status","containsText":"Saved"}
  {"requestId":"4","op":"observe","sessionId":"app","mode":"delta"}
  {"requestId":"5","op":"act","sessionId":"app","action":"click","ref":"e1"}
  {"requestId":"6","op":"close","sessionId":"app"}
  {"requestId":"7","op":"quit"}
`);
}

async function cliMain() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.length === 0 || rawArgs.includes('--help') || rawArgs.includes('-h')) {
    showHelp();
    return;
  }

  const { positional, options } = parseCliArgs(rawArgs);
  const command = positional[0];
  const readySelector = options.ready || options['ready-selector'] || null;
  const readyTimeout = options['ready-timeout'] || DEFAULT_PAGE_READY_TIMEOUT;
  const freezeAnimations = options['no-freeze'] !== true;
  const safetyModeOptionProvided = options.safetyMode !== undefined || options['safety-mode'] !== undefined || options.safe === true || options['safe-mode'] === true || options.unsafe === true;
  let outputLimit = DEFAULT_MAX_OUTPUT_CHARS;
  let safetyMode = 'standard';
  let allowedHosts = [];
  let ignoreUrls = [];

  try {
    outputLimit = normalizeOutputLimit(options.maxOutputChars ?? options['max-output-chars']);
    const printCliJson = value => printJson(value, outputLimit);
    safetyMode = normalizeSafetyMode({
      safetyMode: options.safetyMode ?? options['safety-mode'],
      safe: options.safe === true || options['safe-mode'] === true,
      unsafe: options.unsafe === true
    });
    allowedHosts = normalizeAllowedHosts(options.allowedHosts ?? options['allowed-hosts']);
    ignoreUrls = normalizeIgnoreUrls(options.ignoreUrls ?? options['ignore-urls'] ?? options.ignoreUrl ?? options['ignore-url']);
    if (command === 'capabilities') {
      if (options.json) printCliJson(getCapabilities());
      else console.log(JSON.stringify(getCapabilities(), null, 2));
      return;
    }
    if (command === 'serve' || command === 'session') {
      await serveAgentSessions({
        headless: options.headless !== false,

        authStatePath: options.auth || null,
        token: options.token || null,
        cookie: options.cookie || null,
        network: options.network || null,
        geo: options.geo || null,
        timezone: options.timezone || null,
        waitUntil: options.waitUntil || options['wait-until'] || 'domcontentloaded',
        readySelector,
        readyTimeout,
        delay: options.delay === undefined ? 0 : Number(options.delay),
        maxItems: options.maxItems ?? options['max-items'] ?? DEFAULT_AGENT_ITEM_LIMIT,
        maxText: options.maxText ?? options['max-text'] ?? DEFAULT_AGENT_TEXT_LIMIT,
        maxOutputChars: outputLimit,
        maxSessions: options.maxSessions ?? options['max-sessions'] ?? DEFAULT_MAX_AGENT_SESSIONS,
        idleTimeout: options.idleTimeout ?? options['idle-timeout'] ?? DEFAULT_SESSION_IDLE_TIMEOUT,
        safetyMode: safetyModeOptionProvided ? safetyMode : undefined,
        allowedHosts: allowedHosts.length > 0 ? allowedHosts : undefined,
        ignoreUrls,
        redact: Boolean(options.redact),
        permissions: options.permissions || null,
        permissionOrigin: options['permission-origin'] || null
      });
      return;
    }

    if (command === 'doctor') {
      const result = await checkBrowserAvailability({
        headless: options.headless !== false
      });
      if (options.json) printCliJson(result);
      else if (result.status === 'ok') console.log(`Browser ready: ${result.channelUsed} (${result.browserVersion})`);
      else {
        console.error('Bundled Chromium is not usable.');
        result.attempts.forEach(attempt => console.error(` - ${attempt.candidate}: ${attempt.error}`));
        console.error(result.installHint);
      }
      if (result.status !== 'ok') process.exitCode = 1;
      return;
    }

    if (command === 'layout') {
      const url = resolveWorkflowUrl(positional[1] || options.url);
      if (!url) throw new BrowserToolError('MISSING_URL', 'URL is required.');
      if (options.preset === 'all') throw new Error('layout accepts one viewport preset; use mobile, tablet, or tablet-landscape.');
      const layoutPreset = VIEWPORT_PRESETS[options.preset] || VIEWPORT_PRESETS.mobile;
      const res = await huntLayoutBugs({
        url,
        headless: options.headless !== false,

        waitUntil: options.waitUntil || options['wait-until'] || 'domcontentloaded',
        viewport: layoutPreset.viewport,
        authStatePath: options.auth || null,
        token: options.token || null,
        cookie: options.cookie || null,
        network: options.network || null,
        geo: options.geo || null,
        timezone: options.timezone || null,
        redact: Boolean(options.redact),
        safetyMode,
        allowedHosts,
        readySelector,
        readyTimeout,
        delay: options.delay ? Number(options.delay) : 0,
        tapTargetMinimum: options['tap-target-minimum'] ?? 28
      });
      if (options.json) {
        printCliJson(res);
      } else {
        console.log(`\nMobile Layout Bug Hunt (${res.viewportTested}):`);
        console.log(`Horizontal Overflow: ${res.hasHorizontalOverflow ? 'YES (BUG DETECTED ⚠️)' : 'NONE (PASSED ✅)'} (Doc Width: ${res.documentScrollWidth})`);
        if (res.overflowingElementsCount > 0) {
          console.log(`\nOffending Overflowing Elements (${res.overflowingElementsCount}):`);
          res.overflowingElements.forEach(e => console.log(` - <${e.tag}> ${e.id || e.className || ''} (overflows by +${e.overflowPx}px)`));
        }
        if (res.smallTapTargetsCount > 0) {
          console.log(`\nSmall Tap Targets (< ${res.tapTargetMinimum}px) (${res.smallTapTargetsCount}):`);
          res.smallTapTargets.forEach(t => console.log(` - <${t.tag}> "${t.text}" (${t.size})`));
        }
      }
      if (res.hasHorizontalOverflow || res.smallTapTargetsCount > 0) process.exitCode = 1;
      return;
    }

    if (command === 'map') {
      const url = resolveWorkflowUrl(positional[1] || options.url);
      if (!url) throw new BrowserToolError('MISSING_URL', 'URL is required.');
      const res = await mapInteractiveElements({
        url,
        headless: options.headless !== false,

        authStatePath: options.auth || null,
        token: options.token || null,
        cookie: options.cookie || null,
        network: options.network || null,
        geo: options.geo || null,
        timezone: options.timezone || null,
        redact: Boolean(options.redact),
        safetyMode,
        allowedHosts,
        maxItems: options.maxItems ?? options['max-items'] ?? DEFAULT_AGENT_ITEM_LIMIT,
        maxText: options.maxText ?? options['max-text'] ?? DEFAULT_AGENT_TEXT_LIMIT,
        waitUntil: options.waitUntil || options['wait-until'] || 'domcontentloaded',
        readySelector,
        readyTimeout,
        delay: options.delay ? Number(options.delay) : 0
      });
      if (options.json) {
        printCliJson(res);
      } else {
        console.log(`\nInteractive Map for ${res.url} (${res.totalElements} elements found):`);
        res.elements.forEach(e => console.log(` [${e.tag.toUpperCase()}] ${e.label ? `"${e.label}" ` : ''}-> selector: '${e.selector}' ${e.isIframe ? '(iFrame)' : ''} ${e.isCanvas ? '(Canvas)' : ''}`));
      }
      return;
    }

    if (command === 'qa') {
      const url = resolveWorkflowUrl(positional[1] || options.url || 'http://localhost:5173');
      const maxA11yIssues = options.maxA11yIssues ?? options['max-a11y-issues'];
      const maxNetworkErrors = options.maxNetworkErrors ?? options['max-network-errors'];
      const maxConsoleErrors = options.maxConsoleErrors ?? options['max-console-errors'];
      const qaResult = await runFullQA({
        frontendUrl: url,
        testWorkflow: options.workflow || null,
        mode: options.mode || 'standard',
        presets: options.preset || options.presets || undefined,
        headless: options.headless !== false,
        authStatePath: options.auth || null,

        network: options.network || null,
        token: options.token || null,
        cookie: options.cookie || null,
        geo: options.geo || null,
        timezone: options.timezone || null,
        safetyMode,
        allowedHosts,
        ignoreUrls,
        json: Boolean(options.json),
        maxA11yIssues: maxA11yIssues === undefined ? 0 : Number(maxA11yIssues),
        maxNetworkErrors: maxNetworkErrors === undefined ? 0 : Number(maxNetworkErrors),
        maxConsoleErrors: maxConsoleErrors === undefined ? 0 : Number(maxConsoleErrors),
        maxSmallTapTargets: options['max-small-tap-targets'] === undefined ? null : Number(options['max-small-tap-targets']),
        tapTargetMinimum: options['tap-target-minimum'] === undefined ? 28 : Number(options['tap-target-minimum']),
        checkLayout: options['skip-layout'] === true ? false : undefined,
        allowHorizontalOverflow: Boolean(options['allow-overflow']),
        readySelector,
        readyTimeout,
        maxConcurrency: options['max-concurrency'] || DEFAULT_SCREENSHOT_CONCURRENCY,
        trace: options.trace || 'off',
        traceDir: options['trace-dir'] || './traces',
        allowSensitiveTrace: Boolean(options['allow-sensitive-trace']),
        freezeAnimations,
        visualStabilityTimeout: options['visual-stability-timeout'] === undefined ? undefined : Number(options['visual-stability-timeout']),
        waitUntil: options.waitUntil || options['wait-until'] || 'domcontentloaded'
      });
      if (options.json) printCliJson(qaResult);
      if (!qaResult.passed) process.exitCode = 1;
      return;
    }

    if (command === 'probe') {
      const url = resolveWorkflowUrl(positional[1] || options.url);
      if (!url) throw new BrowserToolError('MISSING_URL', 'URL is required.');

      const result = await probeUrl({
        url,
        delay: options.delay === undefined ? 0 : Number(options.delay),
        headless: options.headless !== false,

        takeScreenshot: Boolean(options.screenshot),
        recordVideo: Boolean(options.record),
        authStatePath: options.auth || null,
        network: options.network || null,
        token: options.token || null,
        cookie: options.cookie || null,
        ignoreUrls,
        geo: options.geo || null,
        timezone: options.timezone || null,
        hover: options.hover || null,
        safetyMode,
        allowedHosts,
        waitUntil: options.waitUntil || options['wait-until'] || 'domcontentloaded',
        freezeAnimations,
        readySelector,
        readyTimeout
      });

      if (options.json) {
        printCliJson(result);
      } else {
        console.log(`\nProbe: ${result.url} | Status: ${result.httpStatus} | Load: ${result.loadTimeMs}ms`);
        console.log(`Console Errors: ${result.consoleLogs.totalErrors} | Network Errors: ${result.network.errors.length} | A11y Issues: ${result.diagnostics.a11y.totalIssues} | Broken Images: ${result.diagnostics.brokenImages}`);
        if (result.screenshotPath) console.log(`Screenshot: ${result.screenshotPath}`);
      }
      if (result.httpStatus === null || result.httpStatus >= 400 || result.consoleLogs.totalErrors > 0 || result.network.errors.length > 0 || result.network.requestFailures.length > 0 || result.diagnostics.a11y.totalIssues > 0 || result.diagnostics.brokenImages > 0) process.exitCode = 1;
      return;
    }

    if (command === 'screenshot') {
      const url = resolveWorkflowUrl(positional[1] || options.url);
      if (!url) throw new BrowserToolError('MISSING_URL', 'URL is required.');

      const customViewport = parseViewportSize(options.size);
      const customSizes = customViewport ? [customViewport] : [];

      const result = await captureResponsiveScreenshots({
        url,
        outputDir: options.output || options.o || './screenshots',
        presets: customSizes.length > 0 && !options.preset ? [] : (options.preset || 'desktop'),
        customSizes,
        fullPage: Boolean(options.fullpage),
        selector: options.selector,
        clip: options.clip || null,
        hover: options.hover || null,
        delay: options.delay === undefined ? 0 : Number(options.delay),
        colorScheme: options.theme || 'no-preference',
        headless: options.headless !== false,

        recordVideo: Boolean(options.record),
        maxConcurrency: options['max-concurrency'] || DEFAULT_SCREENSHOT_CONCURRENCY,
        authStatePath: options.auth || null,
        network: options.network || null,
        token: options.token || null,
        cookie: options.cookie || null,
        geo: options.geo || null,
        timezone: options.timezone || null,
        redact: Boolean(options.redact),
        safetyMode,
        allowedHosts,
        freezeAnimations,
        visualStabilityTimeout: options['visual-stability-timeout'] || undefined,
        waitUntil: options.waitUntil || options['wait-until'] || 'domcontentloaded',
        readySelector,
        readyTimeout
      });

      if (options.json) {
        printCliJson(result);
      } else {
        console.log(`Captured ${result.totalCaptured} view(s) via ${result.channelUsed}:`);
        result.files.forEach(f => console.log(` - [${f.name}] -> ${f.path}`));
      }
      return;
    }

    if (command === 'diff') {
      const url = resolveWorkflowUrl(positional[1] || options.url);
      const baseline = options.baseline || options.b;
      if (!url || !baseline) throw new BrowserToolError('MISSING_ARGUMENT', 'URL and --baseline path are required.');
      const customViewport = parseViewportSize(options.size);

      const diffResult = await compareVisualDiff({
        url,
        baselinePath: baseline,
        threshold: options.threshold === undefined ? 0.05 : Number(options.threshold),
        outputDiffPath: options.output || './screenshots/visual-diff.png',
        headless: options.headless !== false,

        waitUntil: options.waitUntil || options['wait-until'] || 'domcontentloaded',
        authStatePath: options.auth || null,
        token: options.token || null,
        cookie: options.cookie || null,
        redact: Boolean(options.redact),
        preset: options.preset || 'desktop',
        customViewport,
        network: options.network || null,
        geo: options.geo || null,
        timezone: options.timezone || null,
        safetyMode,
        allowedHosts,
        readySelector,
        readyTimeout,
        delay: options.delay === undefined ? 0 : Number(options.delay),
        freezeAnimations,
        visualStabilityTimeout: options['visual-stability-timeout'] || undefined
      });

      if (options.json) printCliJson(diffResult);
      else {
        console.log(`\nVisual Diff: ${diffResult.match ? 'MATCH ✅' : 'MISMATCH ❌'} (${diffResult.pixelDiffPercent} pixel diff)`);
        if (diffResult.diffSavedTo) console.log(`Diff Saved: ${diffResult.diffSavedTo}`);
      }
      if (!diffResult.match) process.exitCode = 1;
      return;
    }

    if (command === 'interact') {
      const filePath = positional[1];
      if (!filePath) throw new BrowserToolError('MISSING_WORKFLOW', 'Workflow JSON path is required.');

      const workflowData = await readWorkflowFile(filePath);
      const steps = Array.isArray(workflowData) ? workflowData : workflowData.steps;

      const result = await runWorkflow({
        steps,
        preset: options.preset || workflowData.preset || 'desktop',
        headless: options.headless !== false,

        recordVideo: Boolean(options.record || workflowData.record),
        saveSnapshots: Boolean(options.snapshots || workflowData.snapshots),
        videoDir: options['video-dir'] || workflowData.videoDir || './recordings',
        videoFilename: options['video-filename'] || workflowData.videoFilename || null,
        customViewport: workflowData.customViewport || null,
        authStatePath: options.auth || workflowData.auth || null,
        saveStatePath: options.saveState || workflowData.saveState || null,
        permissions: options.permissions || workflowData.permissions || null,
        permissionOrigin: options['permission-origin'] || workflowData.permissionOrigin || null,
        network: options.network || workflowData.network || null,
        token: options.token || workflowData.token || null,
        cookie: options.cookie || workflowData.cookie || null,
        geo: options.geo || workflowData.geo || null,
        timezone: options.timezone || workflowData.timezone || null,
        readySelector,
        readyTimeout,
        delay: options.delay === undefined ? (workflowData.delay || 0) : Number(options.delay),
        redact: Boolean(options.redact || workflowData.redact),
        safetyMode: safetyModeOptionProvided
          ? safetyMode
          : (workflowData.safetyMode || (workflowData.safeMode === true ? 'safe' : workflowData.unsafe === true ? 'unsafe' : safetyMode)),
        allowedHosts: options.allowedHosts ?? options['allowed-hosts'] ?? workflowData.allowedHosts ?? allowedHosts,
        ignoreUrls: options.ignoreUrls ?? options['ignore-urls'] ?? options.ignoreUrl ?? options['ignore-url'] ?? workflowData.ignoreUrls ?? ignoreUrls,
        waitUntil: options.waitUntil || options['wait-until'] || workflowData.waitUntil || 'domcontentloaded',
        trace: options.trace || workflowData.trace || 'off',
        traceDir: options['trace-dir'] || workflowData.traceDir || './traces',
        retrySideEffects: Boolean(options['retry-side-effects'] || workflowData.retrySideEffects),
        allowSensitiveTrace: Boolean(options['allow-sensitive-trace'] || workflowData.allowSensitiveTrace),
        freezeAnimations: options['no-freeze'] === true ? false : workflowData.freezeAnimations !== false,
        visualStabilityTimeout: options['visual-stability-timeout'] || workflowData.visualStabilityTimeout || undefined
      });

      if (options.json) {
        printCliJson(result);
      } else {
        console.log(`\nWorkflow Result: ${result.status.toUpperCase()} (${result.passedSteps}/${result.totalSteps} steps passed) via ${result.channelUsed}`);
        if (result.behavioralWarnings) {
          console.log(`⚠️ Warnings (${result.behavioralWarnings.length}):`);
          result.behavioralWarnings.forEach(w => console.log(` - Step ${w.step}: ${w.description} -> ${w.error}`));
        }
        if (result.extractedData) console.log(`Extracted Data:`, result.extractedData);
      }
      if (result.status === 'failed' || (result.status === 'warning' && !options['allow-warnings'])) process.exitCode = 1;
      return;
    }

    if (command === 'clean') {
      const result = await cleanArtifacts({ force: Boolean(options.all || options.force) });
      if (options.json) printCliJson(result);
      else console.log(`Cleaned ${result.removedCount} artifact(s).${result.skippedCount ? ` Skipped ${result.skippedCount} non-tool or failed file(s); use --all to include all files.` : ''}`);
      return;
    }

    if (command === 'presets') {
      console.log('\n--- Viewport Presets ---');
      console.table(Object.entries(VIEWPORT_PRESETS).map(([k, v]) => ({
        Preset: k, Resolution: `${v.viewport.width}x${v.viewport.height}`, isMobile: Boolean(v.isMobile)
      })));
      console.log('\n--- Network Presets ---');
      console.table(Object.keys(NETWORK_PROFILES).map(k => ({ Profile: k })));
      console.log('\n--- QA Modes ---');
      console.table(Object.entries(QA_PRESET_MODES).map(([mode, modePresets]) => ({ Mode: mode, Presets: modePresets.join(', ') })));
      return;
    }

    throw new BrowserToolError('UNKNOWN_COMMAND', `Unknown command: "${command}"`);
  } catch (err) {
    const message = errorMessage(err);
    if (options.json) printJson({ status: 'error', code: errorCode(err), error: message, details: errorDetails(err) }, outputLimit);
    else console.error(`[${errorCode(err)}] ${message}`);
    process.exitCode = 1;
  }
}

const isMainEntry = (() => {
  if (!process.argv[1]) return false;
  try {
    // Compare real paths so npm link / junction / symlink installs match too.
    return path.resolve(realpathSync(process.argv[1])) === path.resolve(realpathSync(fileURLToPath(import.meta.url)));
  } catch {
    return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  }
})();

if (isMainEntry) {
  cliMain();
}
