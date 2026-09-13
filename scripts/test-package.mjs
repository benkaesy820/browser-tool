// Clean-install package test: pack tarballs, install into a virgin
// directory, and exercise the CLI + MCP entrypoints there.
// Usage: node scripts/test-package.mjs (run AFTER pnpm build).
// Requires network access for transitive dependencies.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const isWindows = process.platform === "win32";
const expectedCliVersion = JSON.parse(
  readFileSync(join(root, "packages", "cli", "package.json"), "utf8"),
).version;
let failures = 0;

function check(name, cond, detail = "") {
  console.log(
    `${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`,
  );
  if (!cond) failures += 1;
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", timeout: 120_000, ...opts });
}

function pnpm(args, opts = {}) {
  if (isWindows)
    return run("cmd.exe", ["/d", "/s", "/c", `pnpm ${args.join(" ")}`], opts);
  return run("pnpm", args, opts);
}

function tarList(tarball) {
  const out = run("tar", ["-tf", tarball], {});
  if (out.status !== 0)
    throw new Error(`tar -tf failed for ${tarball}: ${out.stderr}`);
  return out.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

// 1. Pack (runs each package's prepack: LICENSE copy, viewer bundle).
const packDir = mkdtempSync(join(tmpdir(), "bb-pack-"));
console.log(`packing to ${packDir}`);
const packs = {};
const { readdirSync } = await import("node:fs");
for (const pkg of ["protocol", "core", "mcp", "cli"]) {
  const r = pnpm(
    [
      "--filter",
      `@browser-bridge/${pkg}`,
      "pack",
      "--pack-destination",
      packDir,
    ],
    { cwd: root },
  );
  if (r.status !== 0) {
    console.log(r.stdout, r.stderr);
    throw new Error(`pack failed for ${pkg}`);
  }
  // pnpm names tarballs like browser-bridge-cli-0.4.0.tgz.
  const found = readdirSync(packDir).find(
    (f) => f.includes(`bridge-${pkg}-`) && f.endsWith(".tgz"),
  );
  if (!found) throw new Error(`no tarball for ${pkg} in ${packDir}`);
  packs[pkg] = join(packDir, found);
  console.log(`packed ${pkg}: ${found}`);
}

// 2. Content assertions.
const FORBIDDEN = [
  /\.env$/i,
  /\.pem$/i,
  /token/i,
  /secret/i,
  /password/i,
  /cookie/i,
  /artifacts\//i,
  /journal/i,
  /profiles\//i,
  /\.git\//i,
  /(^|\/)tests?\//i,
  /(^|\/)fixtures?\//i,
  /(?<!\.d)\.ts$/,
];
for (const [pkg, tgz] of Object.entries(packs)) {
  const files = tarList(tgz);
  check(
    `${pkg} has dist output`,
    files.some((f) => f.includes("package/dist/")),
    `${files.length} files`,
  );
  check(
    `${pkg} has package.json`,
    files.some((f) => f.endsWith("package/package.json")),
  );
  check(
    `${pkg} ships LICENSE`,
    files.some((f) => f.endsWith("package/LICENSE")),
  );
  const bad = files.filter((f) => FORBIDDEN.some((re) => re.test(f)));
  check(
    `${pkg} excludes secrets/tests/sources`,
    bad.length === 0,
    bad.slice(0, 3).join(", "),
  );
}
{
  const files = tarList(packs["cli"]);
  check(
    "cli bundles the viewer",
    files.some((f) => f.includes("package/viewer-dist/index.html")),
  );
}

// 3. Install into a virgin directory (transitive deps come from the registry).
// pnpm.overrides pin every workspace sibling to its tarball, so the
// unpublished registry is never consulted for our own packages.
const appDir = mkdtempSync(join(tmpdir(), "bb-install-"));
console.log(`installing to ${appDir}`);
import { writeFileSync } from "node:fs";
const names = {
  protocol: "@browser-bridge/protocol",
  core: "@browser-bridge/core",
  mcp: "@browser-bridge/mcp",
  cli: "@browser-bridge/cli",
};
const overrides = Object.fromEntries(
  Object.entries(names).map(([pkg, name]) => [name, `file:${packs[pkg]}`]),
);
writeFileSync(
  join(appDir, "package.json"),
  JSON.stringify({
    name: "bb-clean-test",
    private: true,
    type: "module",
    pnpm: { overrides },
  }),
);
const add = pnpm(["add", `${names["cli"]}@file:${packs["cli"]}`], {
  cwd: appDir,
});
check(
  "clean install succeeds",
  add.status === 0,
  add.status === 0 ? "" : `${add.stderr ?? ""}`.slice(0, 500),
);

const bridgeBin = join(
  appDir,
  "node_modules",
  ".bin",
  isWindows ? "bridge.cmd" : "bridge",
);
const bridge = (args, input) =>
  run(bridgeBin, args, {
    cwd: appDir,
    input,
    shell: isWindows,
    timeout: 60_000,
  });

// 4. Entrypoints.
{
  const v = bridge(["--version"]);
  check(
    "bridge --version",
    v.status === 0 && v.stdout.trim() === expectedCliVersion,
    v.stdout.trim(),
  );
}
{
  const caps = bridge(["capabilities"]);
  let ok = false;
  try {
    const doc = JSON.parse(caps.stdout);
    ok =
      caps.status === 0 &&
      doc.protocolVersion === "1.0" &&
      doc.ops.includes("batch") &&
      doc.ops.includes("viewport");
  } catch {
    ok = false;
  }
  check("bridge capabilities", ok);
}
{
  // No browsers in a clean env: doctor must degrade gracefully, not crash.
  const env = {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: join(appDir, "no-browsers-here"),
  };
  const doc = run(bridgeBin, ["doctor"], {
    cwd: appDir,
    env,
    shell: isWindows,
    encoding: "utf8",
    timeout: 120_000,
  });
  let graceful = false;
  try {
    const report = JSON.parse(doc.stdout);
    graceful = report.chromium.present === false && doc.status === 1;
  } catch {
    graceful = false;
  }
  check("bridge doctor degrades gracefully", graceful);
}
{
  // serve --stdio smoke over the installed binary.
  const proc = bridge(
    ["serve", "--stdio"],
    '{"protocolVersion":"1.0","requestId":"pkg-1","op":"capabilities"}\n',
  );
  const lines = proc.stdout.split("\n").filter((l) => l.trim());
  let pure = lines.length > 0;
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.protocolVersion !== "1.0") pure = false;
    } catch {
      pure = false;
    }
  }
  check("installed serve answers pure JSONL", pure && proc.status === 0);
}
{
  // mcp --stdio smoke: raw initialize handshake.
  const init = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pkg-probe", version: "0.0.0" } } })}\n`;
  const proc = bridge(["mcp", "--stdio"], init);
  const first = proc.stdout.split("\n").find((l) => l.trim());
  let ok = false;
  try {
    const msg = JSON.parse(first ?? "");
    ok = msg.result?.serverInfo?.name === "browser-bridge";
  } catch {
    ok = false;
  }
  check("installed mcp handshakes", ok);
}

console.log(
  failures === 0
    ? "test:package ALL GREEN"
    : `test:package ${failures} FAILURES`,
);
rmSync(packDir, { recursive: true, force: true });
rmSync(appDir, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
