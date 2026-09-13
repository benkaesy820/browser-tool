// prepack helper for publishable workspace packages. Runs with
// cwd = the package directory (pnpm convention).
// - Copies the repo LICENSE next to package.json (npm ships it).
// - With --bundle-viewer (cli only): builds apps/viewer and copies its
//   dist so installed CLIs serve the viewer without a source checkout.
import { copyFileSync, cpSync, existsSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const pkgDir = process.cwd();
const rootDir = join(pkgDir, "..", "..");

copyFileSync(join(rootDir, "LICENSE"), join(pkgDir, "LICENSE"));

if (process.argv.includes("--bundle-viewer")) {
  const viewerDist = join(rootDir, "apps", "viewer", "dist");
  if (!existsSync(join(viewerDist, "index.html"))) {
    if (process.platform === "win32") {
      execFileSync(
        "cmd.exe",
        ["/d", "/s", "/c", "pnpm --filter @browser-bridge/viewer build"],
        {
          cwd: rootDir,
          stdio: "inherit",
        },
      );
    } else {
      execFileSync("pnpm", ["--filter", "@browser-bridge/viewer", "build"], {
        cwd: rootDir,
        stdio: "inherit",
      });
    }
  }
  const target = join(pkgDir, "viewer-dist");
  rmSync(target, { recursive: true, force: true });
  cpSync(viewerDist, target, { recursive: true });
}
