import { spawn } from "node:child_process";
import { readDaemonInfo } from "./files.js";

/**
 * `bridge viewer`: print the local viewer URL (token in the fragment, so it
 * never travels to the server or lands in logs) and best-effort open it.
 */
export async function openViewer(
  dir: string | undefined,
  opts: { open: boolean },
): Promise<{ text: string; exitCode: number }> {
  const info = await readDaemonInfo(dir).catch(() => undefined);
  if (!info) {
    return {
      text: "No daemon running. Start one first: bridge daemon start\n",
      exitCode: 2,
    };
  }
  const url = `http://127.0.0.1:${info.port}/#token=${info.token}`;
  if (opts.open) {
    const opener =
      process.platform === "win32"
        ? { cmd: "cmd", args: ["/c", "start", "", url] }
        : process.platform === "darwin"
          ? { cmd: "open", args: [url] }
          : { cmd: "xdg-open", args: [url] };
    spawn(opener.cmd, opener.args, { stdio: "ignore", detached: true }).unref();
  }
  return { text: `${url}\n`, exitCode: 0 };
}
