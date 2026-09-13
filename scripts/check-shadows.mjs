// Guard: with NodeNext `.js`-suffix imports, a stray compiled `.js` file next
// to a `.ts` source silently shadows it (exact-match wins over the `.ts`
// substitution). That served a stale protocol schema to every test while
// typecheck stayed green. Fail loudly instead.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const roots = ["packages/protocol/src", "packages/core/src", "tests"];
const bad = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full);
    } else if (/\.js(\.map)?$/.test(entry) || /\.d\.ts$/.test(entry)) {
      bad.push(full);
    }
  }
}

for (const root of roots) walk(root);

if (bad.length > 0) {
  console.error("Stray compiled files shadowing TypeScript sources:");
  for (const f of bad) console.error(`  ${f}`);
  console.error(
    "Delete them; build output belongs in dist/ and artifacts/ only.",
  );
  process.exit(1);
}
console.log("check-shadows: clean");
