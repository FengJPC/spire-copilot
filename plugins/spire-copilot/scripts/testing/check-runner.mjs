// Development checks only; never imported by the gameplay runtime.
import { spawn } from "node:child_process";

export function runNodeCheck(args, { timeoutMs = 90000,
  executable = process.execPath, stdio = "inherit" } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio, windowsHide: true });
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(deadline);
      reject(new Error(`Could not run check (${error.code ?? "spawn error"}): ${error.message}`));
    });
    // Wait for process/stdio closure before starting another independent check.
    child.once("close", (code, signal) => {
      clearTimeout(deadline);
      if (timedOut) reject(new Error(`Check timeout after ${timeoutMs}ms: ${args.join(" ")}`));
      else if (code === 0) resolve();
      else reject(new Error(`Check failed (${signal ?? code}): ${args.join(" ")}`));
    });
  });
}

export async function runChecks(checks, { run = runNodeCheck,
  write = (line) => console.log(line) } = {}) {
  const results = [];
  for (const check of checks) {
    write(`RUN ${check.name}`);
    try {
      if (check.run) await check.run();
      else await run(check.args);
      results.push({ name: check.name, status: "passed" });
    } catch (error) {
      const message = error?.message ?? String(error);
      results.push({ name: check.name, status: "failed", error: message });
      write(`FAIL ${check.name}: ${message}`);
    }
  }
  const failed = results.filter((result) => result.status === "failed").length;
  const passed = results.length - failed;
  write(`\nCheck summary: ${passed} passed, ${failed} failed, ${results.length} total.`);
  for (const result of results) {
    write(`${result.status === "passed" ? "PASS" : "FAIL"} ${result.name}`
      + (result.error ? `: ${result.error}` : ""));
  }
  return { results, passed, failed, exitCode: failed ? 1 : 0 };
}
