// Cross-platform test runner: discovers *.test.ts under src/ and runs them
// with tsx's node:test integration. Works on Windows (no shell glob expansion)
// and on Node 20 (no built-in glob/.ts auto-discovery).
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function findTests(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) findTests(full, acc);
    else if (/\.test\.ts$/.test(entry)) acc.push(full);
  }
  return acc;
}

const files = findTests("src");
if (files.length === 0) {
  console.log("No test files found under src/.");
  process.exit(0);
}

const res = spawnSync("tsx", ["--test", ...files], {
  stdio: "inherit",
  shell: process.platform === "win32",
});
process.exit(res.status ?? 1);
