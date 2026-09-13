import { existsSync } from "node:fs";
import { BrowserBridge } from "@browser-bridge/core";

export interface DoctorReport {
  node: string;
  platform: string;
  arch: string;
  chromium: { present: boolean; executable?: string; error?: string };
  launchSmoke: { ok: boolean; ms?: number; error?: string };
}

/** Pre-flight check for fresh machines: runtime, browser install, launch. */
export async function doctor(): Promise<DoctorReport> {
  const report: DoctorReport = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    chromium: { present: false },
    launchSmoke: { ok: false },
  };
  const probe = new BrowserBridge({ headless: true });
  try {
    const { chromium } = await import("playwright");
    let exe = "";
    try {
      exe = chromium.executablePath();
    } catch (err) {
      report.chromium = {
        present: false,
        error: `no executable: ${String(err).slice(0, 300)}`,
      };
      return report;
    }
    // executablePath() computes a path without checking it exists.
    if (!existsSync(exe)) {
      report.chromium = {
        present: false,
        error: `missing executable at ${exe}; run 'npx playwright install chromium' (or set PLAYWRIGHT_BROWSERS_PATH)`,
      };
      return report;
    }
    report.chromium = { present: true, executable: exe };
    const started = Date.now();
    try {
      await probe.launch();
      const { sessionId } = await probe.createSession();
      await probe.closeSession("r-doctor", sessionId);
      report.launchSmoke = { ok: true, ms: Date.now() - started };
    } catch (err) {
      report.launchSmoke = { ok: false, error: String(err).slice(0, 500) };
    } finally {
      await probe.shutdown().catch(() => undefined);
    }
  } catch (err) {
    report.chromium = {
      present: false,
      error: `playwright unavailable: ${String(err).slice(0, 300)}`,
    };
  }
  return report;
}
