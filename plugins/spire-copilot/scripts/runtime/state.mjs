// state responsibilities; dependencies are injected by runtime/index.mjs.
export function createState({ config, session }, dependencies = {}) {
  const { pollMs, timeoutMs } = config;
  const {
    enrichCardDefinitions,
    liveMonsters,
    monsterRosterKey,
    parseState,
    rawTool,
    sleep,
    syncEndTurnSafety,
  } = dependencies;

  function resetMapCache() {
    session.mapCache = { act: null, nodes: null, version: null, emittedVersion: null };
  }

  function numericAct(value) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }

  function isActStartMap(state) {
    return state?.screen_type === "MAP"
      && state?.screen_state?.first_node_chosen === false
      && (state?.screen_state?.current_node?.x === -1
        || state?.screen_state?.current_node?.y === -1);
  }

  function inferActFromFloor(state) {
    if (!Number.isFinite(state?.floor) || state.floor < 0) return null;
    if (isActStartMap(state)) return Math.floor(state.floor / 17) + 1;
    return Math.floor(Math.max(0, state.floor - 1) / 17) + 1;
  }

  function resolveAct(state, game = {}) {
    // MCP The Spire can keep reporting the previous act while the next act's
    // start map is already visible.  The start-map floor/node combination is
    // authoritative during that narrow transition window.
    const inferred = inferActFromFloor(state);
    if (isActStartMap(state) && inferred !== null) return inferred;
    return numericAct(game.act)
      ?? numericAct(game.act_num)
      ?? numericAct(game.act_number)
      ?? numericAct(state?.act)
      ?? inferred;
  }

  function syncMapCacheAct(act) {
    if (act !== null && session.mapCache.act !== null && session.mapCache.act !== act) resetMapCache();
  }

  function mapTopologyHash(map) {
    const topology = map.map((node) => [
      node.x,
      node.y,
      node.symbol,
      (node.children ?? []).map((child) => [child.x, child.y]),
    ]);
    const text = JSON.stringify(topology);
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function mapVersion(act, map) {
    return `act-${act ?? "unknown"}-${map.length}-${mapTopologyHash(map)}`;
  }

  function mapMatchesVisibleNodes(state, map) {
    const visible = state?.screen_state?.next_nodes ?? [];
    if (!visible.length) return true;
    return visible.every((visibleNode) => map.some((node) => (
      node.x === visibleNode.x && node.y === visibleNode.y
    )));
  }

  async function screenState({ timeout = timeoutMs } = {}) {
    return parseState((await rawTool("get_screen_state", {}, { timeout })).message);
  }

  function isTransientScreenReadError(error) {
    return /^get_screen_state: Internal error: null$/i.test(String(error?.message ?? error).trim());
  }

  async function waitUntilReady({ timeout = timeoutMs, readScreen = screenState, pause = sleep } = {}) {
    const started = Date.now();
    let lastScreen = "unknown";
    do {
      try {
        const state = await readScreen({ timeout: Math.max(1, timeout - (Date.now() - started)) });
        if (state?.ready_for_command) return state;
        lastScreen = state?.screen_type ?? "unknown";
      } catch (error) {
        // MCP The Spire briefly returns this while an event room is opening.
        // The action has already been sent, so retry only this state read.
        if (!isTransientScreenReadError(error)) throw error;
        lastScreen = `unavailable (${error.message})`;
      }
      if (Date.now() - started >= timeout) {
        throw new Error(`Timed out after ${timeout}ms; last screen=${lastScreen}`);
      }
      await pause(pollMs);
    } while (true);
  }

  async function enrichRunAndCombat(state, { includePiles = false, timeout = timeoutMs } = {}) {
    if (!state.in_game) return state;
    if (state.floor === 0 && session.mapCache.act !== null) {
      resetMapCache();
    }
    const include = ["deck", "relics", "potions"];
    if (state.room_phase === "COMBAT") include.push("combat");
    const detailed = parseState((await rawTool("get_game_state", { include }, { timeout })).message);
    const game = detailed?.game_state;
    if (!game) return state;
    const act = resolveAct(state, game);
    syncMapCacheAct(act);
    const next = {
      ...state,
      run_detail: {
        act,
        class: game.class,
        boss: game.act_boss,
        deck: game.deck ?? [],
        relics: game.relics ?? [],
        potions: game.potions ?? [],
      },
    };
    const combat = game.combat_state;
    if (!combat) return next;
    const enriched = {
      ...next,
      ...(includePiles ? { _combat_piles: {
        draw: combat.draw_pile,
        discard: combat.discard_pile,
        exhaust: combat.exhaust_pile,
      } } : {}),
      hand: combat.hand ?? state.hand,
      monsters: combat.monsters ?? state.monsters,
      combat_detail: {
        turn: combat.turn,
        player: combat.player,
        draw_count: combat.draw_pile?.length ?? 0,
        discard_count: combat.discard_pile?.length ?? 0,
        exhaust_count: combat.exhaust_pile?.length ?? 0,
        limbo_count: combat.limbo?.length ?? 0,
        cards_discarded_this_turn: combat.cards_discarded_this_turn ?? 0,
        ...(Number.isInteger(combat.cards_played_this_turn) && combat.cards_played_this_turn >= 0
          ? { cards_played_this_turn: combat.cards_played_this_turn } : {}),
      },
    };
    enriched._card_catalog_instances = [
      ...(combat.draw_pile ?? []).map((card) => ({ card, zone: "draw" })),
      ...(combat.discard_pile ?? []).map((card) => ({ card, zone: "discard" })),
      ...(combat.exhaust_pile ?? []).map((card) => ({ card, zone: "exhaust" })),
      ...(combat.limbo ?? []).map((card) => ({ card, zone: "limbo" })),
    ];
    return enriched;
  }

  async function enrichMap(state, { timeout = timeoutMs } = {}) {
    if (state.screen_type !== "MAP") return state;
    let act = state.run_detail?.act ?? resolveAct(state);
    syncMapCacheAct(act);
    if (session.mapCache.nodes && session.mapCache.act === act) {
      return { ...state, map: session.mapCache.nodes, map_version: session.mapCache.version };
    }
    const detailed = parseState((await rawTool("get_game_state", { include: ["map"] }, { timeout })).message);
    const game = detailed?.game_state;
    const map = game?.map;
    if (!Array.isArray(map)) return state;
    act = resolveAct(state, game) ?? act;
    syncMapCacheAct(act);
    if (!mapMatchesVisibleNodes(state, map)) {
      return { ...state, map_status: "pending_current_act" };
    }
    const version = mapVersion(act, map);
    session.mapCache = { act, nodes: map, version, emittedVersion: null };
    return { ...state, map, map_version: version };
  }

  function isStableDecisionState(state) {
    // MCP The Spire can briefly expose an empty combat reward frame while a
    // combat card-selection grid is opening or updating.  The enriched combat
    // state is authoritative here: a reward screen cannot be real while live
    // monsters from the current turn still exist.
    if (state?.screen_type === "COMBAT_REWARD"
        && Number.isFinite(state?.combat_detail?.turn)
        && liveMonsters(state).length > 0) return false;
    if (state.room_phase !== "COMBAT") return true;
    if (!Number.isFinite(state.combat_detail?.turn)) return false;
    if (liveMonsters(state).some((monster) => !monster.intent || monster.intent === "DEBUG")) return false;
    const openingFrameLooksIncomplete = state.combat_detail.turn === 1
      && state.current_energy === 0
      && !state.hand?.length
      && state.combat_detail.draw_count > 0;
    return !openingFrameLooksIncomplete;
  }

  function carryForwardSameTurnIntents(state, previous = session.lastStableDecisionState) {
    if (state?.room_phase !== "COMBAT" || previous?.room_phase !== "COMBAT") return state;
    if (state.floor !== previous.floor
        || state?.combat_detail?.turn !== previous?.combat_detail?.turn
        || monsterRosterKey(state) !== monsterRosterKey(previous)) return state;
    const previousMonsters = new Map(liveMonsters(previous).map((monster) => [
      `${monster.id ?? monster.name}:${monster.name}`,
      monster,
    ]));
    let changed = false;
    const monsters = (state.monsters ?? []).map((monster) => {
      if (monster.is_gone || (monster.intent && monster.intent !== "DEBUG")) return monster;
      const key = `${monster.id ?? monster.name}:${monster.name}`;
      const prior = previousMonsters.get(key);
      if (!prior?.intent || prior.intent === "DEBUG") return monster;
      changed = true;
      return { ...monster, intent: prior.intent, move: monster.move ?? prior.move };
    });
    return changed ? { ...state, monsters } : state;
  }

  async function decisionState({ timeout = timeoutMs, includePiles = false } = {}) {
    const started = Date.now();
    const remaining = () => Math.max(1, timeout - (Date.now() - started));
    let state;
    do {
      state = await waitUntilReady({ timeout: remaining() });
      state = await enrichRunAndCombat(state, { includePiles, timeout: remaining() });
      state = carryForwardSameTurnIntents(state);
      if (isStableDecisionState(state)) break;
      if (Date.now() - started >= timeout) {
        throw new Error(`Timed out after ${timeout}ms waiting for a stable game state`);
      }
      await sleep(pollMs);
    } while (true);
    state = await enrichMap(state, { timeout: remaining() });
    state = await enrichCardDefinitions(state, { timeout: remaining() });
    syncEndTurnSafety(state);
    session.lastStableDecisionState = state;
    return state;
  }

  return {
    resetMapCache,
    numericAct,
    isActStartMap,
    inferActFromFloor,
    resolveAct,
    syncMapCacheAct,
    mapTopologyHash,
    mapVersion,
    mapMatchesVisibleNodes,
    screenState,
    isTransientScreenReadError,
    waitUntilReady,
    enrichRunAndCombat,
    enrichMap,
    isStableDecisionState,
    carryForwardSameTurnIntents,
    decisionState,
  };
}
