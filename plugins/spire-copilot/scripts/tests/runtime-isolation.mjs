import assert from "node:assert/strict";

// Imports, construction, and protocol metadata must not contact the game.
const originalFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = () => { networkCalls++; throw new Error("Unexpected game I/O"); };
try {
  const { createRuntime } = await import("../runtime/index.mjs");
  const first = createRuntime({ env: { STS_MCP_URL: "http://127.0.0.1:1/mcp", STS_VISUAL_SETTLE_MS: "0" } });
  const second = createRuntime({ env: { STS_MCP_URL: "http://127.0.0.1:2/mcp" } });
  assert.notEqual(first.config.endpoint, second.config.endpoint);
  assert.equal(first.config.visualSettleMs, 0);
  assert.equal(second.config.visualSettleMs, 600);
  for (const key of ["handHandles", "cardCatalog", "mapCache", "combatSafety", "turnTransitionSafety", "advisoryKeys"]) {
    assert.notEqual(first.session[key], second.session[key], `independent ${key}`);
  }

  const turn = { in_game: true, floor: 8, room_phase: "COMBAT", screen_type: "NONE",
    combat_detail: { turn: 2 }, current_energy: 3, current_hp: 40, max_hp: 50,
    hand: [{ id: "Guard", name: "Guard", uuid: "a", cost: 0, block: 5, description: "Gain 5 Block." }],
    run_detail: { class: "WATCHER", act: 1, deck: [], relics: [], potions: [] }, monsters: [] };
  const { safety, cards, compaction, transport } = first.modules;
  safety.syncCombatSafety(turn);
  safety.markEndTurnSent(turn);
  first.session.combatSafety.trackedCardsPlayed = 2;
  first.session.combatSafety.countUncertain = true;
  first.session.cardCatalog.rawById.set("Guard", turn.hand[0]);
  cards.rememberCardDefinition(turn.hand[0]);
  const payload = compaction.rememberAndCompact(turn);
  assert.ok(payload.card_defs?.["Guard@0"]);
  assert.equal(payload.hand[0].k, "h1");
  assert.equal(second.session.turnTransitionSafety.endTurnSent, false);
  assert.equal(second.session.combatSafety.trackedCardsPlayed, 0);
  assert.equal(second.session.cardCatalog.definitions.size, 0);
  assert.equal(second.session.handHandles.next, 1);
  assert.equal(second.session.previousState, undefined);

  // Reset the transport only: it must retain the same pending game safeguards
  // and live-instance identities while invalidating transport-dependent caches.
  first.session.toolCache = [{ name: "dummy" }];
  first.session.gameInitialized = true;
  transport.resetGameConnection();
  assert.equal(first.session.gameInitialized, false);
  assert.equal(first.session.toolCache, undefined);
  assert.equal(first.session.previousState, undefined);
  assert.equal(first.session.cardCatalog.definitions.size, 0);
  assert.equal(first.session.turnTransitionSafety.endTurnSent, true);
  assert.equal(first.session.combatSafety.trackedCardsPlayed, 2);
  assert.equal(first.session.combatSafety.countUncertain, true);
  assert.equal(cards.handHandle(turn.hand[0]), "h1");
  assert.throws(() => safety.markEndTurnSent(turn), /duplicate end_turn/);
  second.modules.safety.markEndTurnSent(turn);
  second.modules.safety.syncEndTurnSafety({ ...turn, combat_detail: { turn: 3 } });
  assert.equal(second.session.turnTransitionSafety.endTurnSent, false);
  assert.equal(first.session.turnTransitionSafety.endTurnSent, true);

  // Metadata is the same for independently constructed runtimes and normal
  // tool operations still use exactly the established five-tool interface.
  const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };
  const firstList = await first.handleMcpMessage(list);
  assert.deepEqual(firstList, await second.handleMcpMessage(list));
  assert.deepEqual(firstList.result.tools.map(tool => tool.name),
    ["get_state", "inspect_pile", "inspect_card", "act", "act_many"]);
  const initialized = await first.handleMcpMessage({ id: 2, method: "initialize" });
  assert.equal(initialized.result.serverInfo.version, first.config.pluginVersion);
  assert.equal(await first.handleMcpMessage({ method: "notifications/initialized" }), null);
  assert.equal((await first.handleMcpMessage({ id: 3, method: "unsupported" })).error.code, -32601);
  assert.equal(networkCalls, 0);
  console.log("Runtime isolation tests passed: side-effect-free construction/metadata, independent config/caches/guards, and reconnect fence/identity preservation.");
} finally {
  globalThis.fetch = originalFetch;
}
