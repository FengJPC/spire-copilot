// protocol responsibilities; dependencies are injected by runtime/index.mjs.
export function createProtocol({ config, session }, dependencies = {}) {
  const { pluginVersion, timeoutMs, batchTimeoutMs } = config;
  const {
    actionToolCall,
    callAndSettle,
    decisionState,
    inspectCard,
    inspectPile,
    isConnectionError,
    listTools,
    normalizeDisplayedChoiceIndices,
    rememberAndCompact,
    resetGameConnection,
  } = dependencies;

  const ACTION_PROPERTIES = {
    action: {
      type: "string",
      enum: ["play_card", "end_turn", "choose", "proceed", "skip", "cancel", "confirm", "use_potion", "discard_potion"],
    },
    card: { type: "string", description: "Hand handle k for an exact copy, or card name to select the cheapest playable equivalent copy." },
    card_name: { type: "string", description: "Selects the cheapest playable same-effect copy; use card with hand k for an exact copy." },
    card_id: { type: "string" },
    card_index: { type: "integer", minimum: 1 },
    target_index: { type: "integer", minimum: 1 },
    choice_index: { type: "integer", minimum: 1 },
    choice_text: { type: "string" },
    choice_uuid: { type: "string" },
    potion_slot: { type: "integer", minimum: 1 },
  };

  const TIMEOUT_PROPERTY = {
    type: "integer",
    minimum: 1000,
    maximum: 120000,
  };

  const PLUGIN_TOOLS = [
    {
      name: "get_state",
      description: "Read settled game state. compact includes current potion slots and combat stance; run context and the full map are sent once per run/act. delta returns semantic changes plus current.stance; full is diagnostic and verbose. Contextual advisories are emitted once when relevant mechanics first appear.",
      inputSchema: {
        type: "object",
        properties: { mode: { type: "string", enum: ["compact", "delta", "full"], default: "compact" } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: "inspect_pile",
      description: "Read current draw, discard, or exhaust pile on demand. Returns unordered compact card groups with qty, upgrades and current instance stats, reusing cached definitions. No draw order, UUIDs or hand indices. Pile stats do not promise values after drawing. Does not advance the hand/delta baseline.",
      inputSchema: {
        type: "object",
        properties: { pile: { type: "string", enum: ["draw", "discard", "exhaust"] } },
        required: ["pile"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: "inspect_card",
      description: "Query one card definition without expanding the whole game state. Prefer choice_uuid for an exact live card; use card_id plus optional upgrades for arbitrary known cards; card_name only when unique. Successful queries join the per-run card-definition cache.",
      inputSchema: {
        type: "object",
        properties: {
          choice_uuid: { type: "string" },
          card_id: { type: "string" },
          card_name: { type: "string" },
          upgrades: { type: "integer", minimum: 0 },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: "act",
      description: "Perform one settled action. Use card with a hand handle k for an exact copy, or card_name to choose the cheapest playable equivalent. Copilot resolves UUIDs and checks cost internally. Choices use choice_text or choice_uuid; shops require choice_text. Never resend uncertain end_turn.",
      inputSchema: {
        type: "object",
        properties: {
          ...ACTION_PROPERTIES,
          visual_wait: { type: "boolean", description: "Minimum visual pacing (default true); settlement is always verified." },
          wait: { type: "boolean", description: "Deprecated alias of visual_wait; false never disables verification." },
          timeout_ms: TIMEOUT_PROPERTY,
        },
        required: ["action"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "act_many",
      description: "Execute already-decided actions serially; use act when the next decision needs fresh observation. Use card with hand k for exact copies or names for cheapest playable equivalents; card_index refers to the last observed hand, never shifting intermediate positions. Safety preflight may reject the whole batch before sending. Otherwise each action is rechecked by UUID and verified before continuing; unsafe boundaries or errors stop the suffix. Never plan through unknown draws/new choices or resend uncertain actions.",
      inputSchema: {
        type: "object",
        properties: {
          actions: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: ACTION_PROPERTIES,
              required: ["action"],
              additionalProperties: false,
            },
          },
          visual_wait: { type: "boolean", description: "Minimum visual pacing (default true); settlement is always verified." },
          wait: { type: "boolean", description: "Deprecated alias of visual_wait; false never disables verification." },
          timeout_ms: TIMEOUT_PROPERTY,
        },
        required: ["actions"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
  ];

  async function handle(line) {
    if (line === "state") return rememberAndCompact(await decisionState());
    if (line === "delta") return rememberAndCompact(await decisionState(), true);
    if (line === "full") return await decisionState();

    const request = JSON.parse(line);
    if (request.cmd === "tools") {
      return (await listTools()).map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
    }
    if (request.cmd === "schema") {
      const tool = (await listTools()).find((item) => item.name === request.tool);
      if (!tool) throw new Error(`Unknown tool '${request.tool}'`);
      return tool;
    }
    if (request.cmd === "state") return rememberAndCompact(await decisionState(), Boolean(request.delta));
    if (request.cmd === "actions") {
      return callAndSettle("execute_actions", { actions: request.actions ?? [] }, request.wait !== false);
    }
    if (request.cmd === "call") {
      return callAndSettle(request.tool, request.args ?? {}, request.wait !== false);
    }
    if (request.tool) {
      return callAndSettle(request.tool, request.args ?? {}, request.wait !== false);
    }
    throw new Error("Expected state/delta/full or a JSON request with cmd/tool");
  }

  function pluginToolResult(value) {
    return { content: [{ type: "text", text: JSON.stringify(value) }] };
  }

  function pluginToolError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: JSON.stringify({ error: message }) }],
      isError: true,
    };
  }

  async function readPluginState(mode) {
    const read = async () => {
      const state = await decisionState();
      if (mode === "full") return normalizeDisplayedChoiceIndices(state);
      return rememberAndCompact(state, mode === "delta");
    };
    try {
      return await read();
    } catch (error) {
      if (!isConnectionError(error)) throw error;
      resetGameConnection();
      return read();
    }
  }

  async function dispatchPluginTool(name, args = {}) {
    if (name === "get_state") return readPluginState(args.mode ?? "compact");
    if (name === "inspect_pile") return inspectPile(args);
    if (name === "inspect_card") return inspectCard(args);
    if (name === "act") {
      const { action, wait, visual_wait = wait ?? true, timeout_ms = timeoutMs, ...actionArgs } = args;
      const call = actionToolCall({ action, ...actionArgs });
      if (!call) throw new Error(`Unsupported action '${action}'`);
      return callAndSettle(call.name, call.args, visual_wait, timeout_ms);
    }
    if (name === "act_many") {
      return callAndSettle(
        "execute_actions",
        { actions: args.actions ?? [] },
        args.visual_wait ?? args.wait ?? true,
        args.timeout_ms ?? batchTimeoutMs,
      );
    }
    throw new Error(`Unknown Spire Copilot tool '${name}'`);
  }

  async function handleMcpMessage(message) {
    const { id, method, params = {} } = message;
    if (method === "initialize") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params.protocolVersion ?? "2024-11-05",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "spire-copilot", version: pluginVersion },
          instructions: "Read get_state and apply advisories. Read current.stance in action/delta receipts; hand c is live current-turn cost, not cached definition cost. Use card with hand k for exact copies or card_name for cheapest playable equivalents; Copilot handles UUID matching and reindexing. Hand changes update key=k, not effect ref. act_many verifies already-decided actions one by one; use act across observation boundaries. Choices use choice_text or choice_uuid; shops require choice_text. Never resend uncertain end_turn; inspect state instead.",
        },
      };
    }
    if (method === "notifications/initialized" || method === "notifications/cancelled") return null;
    if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
    if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: PLUGIN_TOOLS } };
    if (method === "tools/call") {
      try {
        const value = await dispatchPluginTool(params.name, params.arguments ?? {});
        return { jsonrpc: "2.0", id, result: pluginToolResult(value) };
      } catch (error) {
        if (isConnectionError(error)) resetGameConnection();
        return { jsonrpc: "2.0", id, result: pluginToolError(error) };
      }
    }
    if (id === undefined) return null;
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    };
  }

  return {
    handle,
    pluginToolResult,
    pluginToolError,
    readPluginState,
    dispatchPluginTool,
    handleMcpMessage,
  };
}
