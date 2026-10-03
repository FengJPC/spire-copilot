#!/usr/bin/env node
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runChecks } from "./testing/check-runner.mjs";

const scripts = new URL("./", import.meta.url);
const checks = [];
async function syntax(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), folder);
    if (entry.isDirectory()) await syntax(url);
    else if (entry.name.endsWith(".mjs")) checks.push({
      name: `syntax ${fileURLToPath(url).slice(fileURLToPath(scripts).length)}`,
      args: ["--check", fileURLToPath(url)],
    });
  }
}
const path = (name) => fileURLToPath(new URL(name, scripts));
try { await syntax(scripts); }
catch (error) {
  checks.push({ name: "syntax discovery", run: () => { throw error; } });
}
checks.push({ name: "safety self-tests", args: [path("server.mjs"), "--self-test"] });
for (const name of ["tests/check-runner.mjs", "tests/grid-choice-settlement.mjs", "tests/reward-choice-settlement.mjs", "tests/runtime-isolation.mjs",
  "tests/terminal-settlement.mjs", "tests/observability.mjs", "tests/orb-observability.mjs",
  "tests/shop-batches.mjs", "tests/interface-advisories.mjs", "tests/compaction-efficiency.mjs", "test-hand-actions.mjs",
  "test-shop-observability.mjs", "test-execution-certainty.mjs"]) {
  checks.push({ name, args: [path(name)] });
}
checks.push({ name: "synthetic benchmark", args: [path("server.mjs"), "--benchmark"] });
const report = await runChecks(checks);
process.exitCode = report.exitCode;
if (!report.failed) console.log("All syntax, safety, isolation, integration, execution-certainty and benchmark checks passed.");
