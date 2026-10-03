import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { runChecks, runNodeCheck } from "../testing/check-runner.mjs";

// Real process failures, missing executable and timeout all retain their failure
// status without skipping a later independent check. No gameplay endpoint used.
const logs = [], order = [];
const quiet = (args, options = {}) => runNodeCheck(args, { stdio: "ignore", ...options });
const report = await runChecks([
  { name: "pass before", run: async () => { order.push(1); await quiet(["-e", "process.exit(0)"]); } },
  { name: "exit failure", run: async () => { order.push(2); await quiet(["-e", "process.exit(7)"]); } },
  { name: "spawn failure", run: async () => { order.push(3);
    await quiet([], { executable: process.execPath + ".nonexistent" }); } },
  { name: "timeout", run: async () => { order.push(4);
    await quiet(["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 150 }); } },
  { name: "pass after", run: async () => { order.push(5); await quiet(["-e", "process.exit(0)"]); } },
], { write: (line) => logs.push(line) });
assert.deepEqual(order, [1, 2, 3, 4, 5]);
assert.equal(report.passed, 2);
assert.equal(report.failed, 3);
assert.equal(report.exitCode, 1);
assert.match(report.results[1].error, /failed \(7\)/);
assert.match(report.results[2].error, /Could not run check.*ENOENT/);
assert.match(report.results[3].error, /timeout after 150ms/);
assert.ok(logs.some((line) => line.includes("2 passed, 3 failed, 5 total")));
const clean = await runChecks([{ name: "clean", args: ["-e", "process.exit(0)"] }],
  { run: quiet, write: () => {} });
assert.equal(clean.exitCode, 0);
const syntax = await runChecks([{ name: "bad syntax", args: ["--check", "-e", "const ="] },
  { name: "after syntax", args: ["-e", "process.exit(0)"] }], { run: quiet, write: () => {} });
assert.equal(syntax.failed, 1);
assert.equal(syntax.results[1].status, "passed");

// Confirm the consumer's exit code is observable by a parent process, not just
// present in the returned object or hidden behind a final green message.
const runner = new URL("../testing/check-runner.mjs", import.meta.url).href;
for (const fail of [false, true]) {
  const source = `import { runChecks } from ${JSON.stringify(runner)};
    const report = await runChecks([
      {name:'first',args:['-e','process.exit(${fail ? 8 : 0})']},
      {name:'later',args:['-e','process.exit(0)']}
    ]); process.exitCode = report.exitCode;`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", source],
    { encoding: "utf8", timeout: 5000, windowsHide: true });
  assert.equal(child.error, undefined);
  assert.equal(child.status, fail ? 1 : 0);
  assert.ok(child.stdout.includes("PASS later"));
  assert.ok(child.stdout.includes(fail ? "1 passed, 1 failed" : "2 passed, 0 failed"));
}
console.log("Check runner tests passed: aggregate failures, later checks, exit codes, spawn errors, syntax errors and timeout closure.");
