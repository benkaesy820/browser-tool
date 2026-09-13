import { getCapabilities } from "@browser-bridge/protocol";
import { doctor } from "./doctor.js";
import type { Logger } from "pino";

export async function printCapabilities(): Promise<{
  text: string;
  exitCode: number;
}> {
  return {
    text: `${JSON.stringify(getCapabilities(), null, 2)}\n`,
    exitCode: 0,
  };
}

export async function runDoctor(
  log: Logger,
): Promise<{ text: string; exitCode: number }> {
  const report = await doctor();
  log.info({ ok: report.launchSmoke.ok }, "doctor");
  const healthy = report.chromium.present && report.launchSmoke.ok;
  return {
    text: `${JSON.stringify(report, null, 2)}\n`,
    exitCode: healthy ? 0 : 1,
  };
}
