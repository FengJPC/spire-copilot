#!/usr/bin/env node

import readline from 'node:readline';
import { createRuntime } from './runtime/index.mjs';

const runtime = createRuntime();

if (process.argv.includes('--self-test')) {
  const { runSafetySelfTests } = await import('./tests/self-test.mjs');
  await runSafetySelfTests(runtime);
  process.exit(0);
}

if (process.argv.includes('--benchmark')) {
  const { runSyntheticBenchmark } = await import('./tests/benchmark.mjs');
  runSyntheticBenchmark(runtime);
  process.exit(0);
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

const { handleMcpMessage } = runtime;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const rawLine of rl) {
  const line = rawLine.trim();
  if (!line) continue;
  try {
    const response = await handleMcpMessage(JSON.parse(line));
    if (response) emit(response);
  } catch (error) {
    emit({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: error instanceof Error ? error.message : String(error) },
    });
  }
}
