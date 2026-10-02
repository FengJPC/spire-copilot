#!/usr/bin/env node
import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const scripts = new URL("./", import.meta.url);
async function node(args) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: "inherit", windowsHide: true });
    const deadline = setTimeout(() => { child.kill(); reject(new Error(`Test timeout: ${args.join(" ")}`)); }, 90000);
    child.on("error", (error) => { clearTimeout(deadline); reject(error); });
    child.on("exit", (code, signal) => {
      clearTimeout(deadline);
      if (code === 0) resolve();
      else reject(new Error(`Test failed (${code ?? signal}): ${args.join(" ")}`));
    });
  });
}
async function syntax(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), folder);
    if (entry.isDirectory()) await syntax(url);
    else if (entry.name.endsWith(".mjs")) await node(["--check", fileURLToPath(url)]);
  }
}
const path = (name) => fileURLToPath(new URL(name, scripts));
await syntax(scripts);
await node([path("server.mjs"), "--self-test"]);
await node([path("tests/runtime-isolation.mjs")]);
await node([path("test-hand-actions.mjs")]);
await node([path("test-execution-certainty.mjs")]);
await node([path("server.mjs"), "--benchmark"]);
console.log("All syntax, safety, isolation, integration, execution-certainty and benchmark checks passed.");
