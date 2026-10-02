// transport responsibilities; dependencies are injected by runtime/index.mjs.
export function createTransport({ config, session }, dependencies = {}) {
  const { pluginVersion, endpoint, accept, timeoutMs } = config;
  const {
    resetCardCatalog,
    resetMapCache,
  } = dependencies;

  function parseRpcBody(body) {
    if (!body) return null;
    const trimmed = body.trim();
    if (!trimmed.startsWith("data:")) return JSON.parse(trimmed);
    const events = trimmed
      .split(/\r?\n\r?\n/)
      .map((event) => event.split(/\r?\n/).find((line) => line.startsWith("data:")))
      .filter(Boolean)
      .map((line) => JSON.parse(line.slice(5).trim()));
    return events.at(-1) ?? null;
  }

  async function post(payload, { execution, timeout = timeoutMs, onDispatch } = {}) {
    const headers = { Accept: accept, "Content-Type": "application/json" };
    if (session.sessionId) headers["Mcp-Session-Id"] = session.sessionId;
    const body = JSON.stringify(payload);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeout));
    try {
      onDispatch?.();
      // Once fetch is invoked, a failure cannot prove that the game did not act.
      if (execution) execution.certainty = "sent_unknown";
      const response = await fetch(endpoint, { method: "POST", headers, body, signal: controller.signal });
      const responseBody = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${responseBody}`);
      session.sessionId ||= response.headers.get("mcp-session-id") ?? undefined;
      const parsed = parseRpcBody(responseBody);
      if (payload.id !== undefined && (!parsed || parsed.id !== payload.id
          || (!Object.hasOwn(parsed, "result") && !Object.hasOwn(parsed, "error")))) {
        throw new Error("MCP response missing or mismatched; delivery outcome is unknown");
      }
      return parsed;
    } catch (error) {
      if (controller.signal.aborted) {
        const timedOut = new Error(`Timed out after ${timeout}ms waiting for the MCP response; no action was resent`);
        timedOut.code = "ACTION_TRANSPORT_TIMEOUT";
        throw timedOut;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  function resetGameConnection() {
    session.sessionId = undefined;
    session.toolCache = undefined;
    session.previousState = undefined;
    session.previousRunContext = undefined;
    session.gameInitialized = false;
    // Transport resets do not resolve pending game actions or local counts.
    session.advisoryKeys = new Set();
    session.lastStableDecisionState = undefined;
    resetMapCache();
    resetCardCatalog({ preserveInstances: true, preserveRun: true });
  }

  async function initializeGame({ timeout = timeoutMs } = {}) {
    resetGameConnection();
    const started = Date.now();
    const initialized = await post({
      jsonrpc: "2.0",
      id: session.requestId++,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "spire-copilot-proxy", version: pluginVersion },
      },
    }, { timeout });
    if (initialized?.error) throw new Error(`initialize: ${JSON.stringify(initialized.error)}`);
    await post({ jsonrpc: "2.0", method: "notifications/initialized" },
      { timeout: Math.max(1, timeout - (Date.now() - started)) });
    session.gameInitialized = true;
  }

  async function ensureGameConnection(options = {}) {
    if (!session.gameInitialized) await initializeGame(options);
  }

  function contentText(result) {
    return (result?.content ?? [])
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
  }

  async function rawTool(name, args = {}, options = {}) {
    const started = Date.now(), budget = options.timeout ?? timeoutMs;
    await ensureGameConnection({ timeout: budget });
    const remaining = budget - (Date.now() - started);
    if (remaining <= 0) {
      const error = new Error(`Timed out after ${budget}ms before ${name} dispatch`);
      error.code = "ACTION_TRANSPORT_TIMEOUT";
      throw error;
    }
    const response = await post({
      jsonrpc: "2.0",
      id: session.requestId++,
      method: "tools/call",
      params: { name, arguments: args },
    }, { ...options, timeout: remaining });
    if (response?.error) {
      const error = new Error(`${name}: ${JSON.stringify(response.error)}`);
      error.code = "DOWNSTREAM_ACTION_ERROR";
      throw error;
    }
    const result = response?.result ?? {};
    if (options.execution && !Array.isArray(result.content)) {
      throw new Error("Malformed MCP action result; delivery outcome is unknown");
    }
    const message = contentText(result) || JSON.stringify(result);
    if (result.isError) {
      const error = new Error(`${name}: ${message}`);
      error.code = "DOWNSTREAM_ACTION_ERROR";
      throw error;
    }
    if (options.execution) options.execution.certainty = "accepted";
    return { result, message };
  }

  async function listTools() {
    await ensureGameConnection();
    if (session.toolCache) return session.toolCache;
    const response = await post({ jsonrpc: "2.0", id: session.requestId++, method: "tools/list", params: {} });
    if (response?.error) throw new Error(JSON.stringify(response.error));
    session.toolCache = response?.result?.tools ?? [];
    return session.toolCache;
  }

  async function validateToolCall(name, args) {
    const tools = await listTools();
    const tool = tools.find((item) => item.name === name);
    if (!tool) throw new Error(`Unknown tool '${name}'. Use {"cmd":"tools"} to list tools.`);
    const required = tool.inputSchema?.required ?? [];
    const missing = required.filter((key) => !(key in args));
    if (missing.length) throw new Error(`${name} missing required argument(s): ${missing.join(", ")}`);
    const properties = tool.inputSchema?.properties ?? {};
    const unexpected = Object.keys(args).filter((key) => !(key in properties));
    if (unexpected.length) {
      throw new Error(`${name} unexpected argument(s): ${unexpected.join(", ")}; allowed: ${Object.keys(properties).join(", ") || "none"}`);
    }
    for (const [key, value] of Object.entries(args)) {
      const schema = properties[key];
      if (!schema?.type) continue;
      const actual = Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value;
      if (schema.type !== actual && !(schema.type === "number" && actual === "integer")) {
        throw new Error(`${name}.${key} must be ${schema.type}, got ${actual}`);
      }
      if (schema.enum && !schema.enum.includes(value)) {
        throw new Error(`${name}.${key} must be one of: ${schema.enum.join(", ")}`);
      }
    }
  }

  return {
    parseRpcBody,
    post,
    resetGameConnection,
    initializeGame,
    ensureGameConnection,
    contentText,
    rawTool,
    listTools,
    validateToolCall,
  };
}
