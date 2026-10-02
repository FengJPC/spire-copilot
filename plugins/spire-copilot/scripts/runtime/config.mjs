// Preserve the public environment variables and defaults.
export function createConfig(env = process.env, overrides = {}) {
  return {
    pluginVersion: "0.2.23",
    endpoint: env.STS_MCP_URL ?? "http://127.0.0.1:8080/mcp",
    accept: "application/json, text/event-stream",
    pollMs: Number(env.STS_POLL_MS ?? 180),
    settleMs: Number(env.STS_SETTLE_MS ?? 250),
    visualSettleMs: Number(env.STS_VISUAL_SETTLE_MS ?? 600),
    timeoutMs: Number(env.STS_WAIT_TIMEOUT_MS ?? 20000),
    batchTimeoutMs: Number(env.STS_BATCH_TIMEOUT_MS ?? 20000),
    ...overrides,
  };
}
