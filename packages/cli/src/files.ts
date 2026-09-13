import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface DaemonInfo {
  port: number;
  token: string;
  pid: number;
  startedAt: string;
}

/** Well-known daemon rendezvous. Same OS user only (0700/0600 best effort). */
export function daemonDir(custom?: string): string {
  return custom ?? join(tmpdir(), "browser-bridge");
}

export function daemonFile(custom?: string): string {
  return join(daemonDir(custom), "daemon.json");
}

export async function writeDaemonInfo(
  info: DaemonInfo,
  custom?: string,
): Promise<void> {
  const dir = daemonDir(custom);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(daemonFile(custom), JSON.stringify(info, null, 2), {
    mode: 0o600,
  });
}

export async function readDaemonInfo(custom?: string): Promise<DaemonInfo> {
  const raw = await readFile(daemonFile(custom), "utf8").catch(() => {
    throw Object.assign(
      new Error(
        "Daemon not running (no daemon.json). Start it with: bridge daemon start",
      ),
      {
        code: "DAEMON_NOT_RUNNING",
      },
    );
  });
  const info = JSON.parse(raw) as Partial<DaemonInfo>;
  if (typeof info["port"] !== "number" || typeof info["token"] !== "string") {
    throw Object.assign(
      new Error("Daemon file is corrupt. Start it with: bridge daemon start"),
      {
        code: "DAEMON_NOT_RUNNING",
      },
    );
  }
  return info as DaemonInfo;
}

export async function removeDaemonInfo(custom?: string): Promise<void> {
  await rm(daemonFile(custom), { force: true });
}
