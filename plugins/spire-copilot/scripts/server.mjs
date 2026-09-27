#!/usr/bin/env node

import readline from "node:readline";

const pluginVersion = "0.2.12";
const endpoint = process.env.STS_MCP_URL ?? "http://127.0.0.1:8080/mcp";
const accept = "application/json, text/event-stream";
const pollMs = Number(process.env.STS_POLL_MS ?? 180);
const settleMs = Number(process.env.STS_SETTLE_MS ?? 250);
const visualSettleMs = Number(process.env.STS_VISUAL_SETTLE_MS ?? 600);
const timeoutMs = Number(process.env.STS_WAIT_TIMEOUT_MS ?? 20000);

let sessionId;
let requestId = 1;
let toolCache;
let previousState;
let previousRunContext;
let gameInitialized = false;
let combatSafety = { floor: null, turn: null, cardsPlayed: 0 };
let turnTransitionSafety = { floor: null, turn: null, endTurnSent: false };
let advisoryKeys = new Set();
let mapCache = { act: null, nodes: null, version: null, emittedVersion: null };
let cardCatalog = {
  activeRun: false,
  rawById: new Map(),
  attemptedIds: new Set(),
  definitions: new Map(),
  emittedRefs: new Set(),
  catalogPayloadSent: false,
};

const NORMALITY_IDS = new Set(["Normality"]);
const NORMALITY_NAMES = new Set(["Normality", "凡庸"]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function visualDelayForAction(name) {
  if (["play_card", "use_potion", "end_turn"].includes(name)) return visualSettleMs;
  if (["choose", "confirm", "proceed", "skip", "cancel", "discard_potion"].includes(name)) {
    return Math.min(300, visualSettleMs);
  }
  return 0;
}

async function waitForVisualSettlement(
  name,
  state,
  { pause = sleep, readState = decisionState } = {},
) {
  const delay = visualDelayForAction(name);
  if (delay <= 0) return state;
  await pause(delay);
  return readState();
}

function resetMapCache() {
  mapCache = { act: null, nodes: null, version: null, emittedVersion: null };
}

function resetCardCatalog() {
  cardCatalog = {
    activeRun: false,
    rawById: new Map(),
    attemptedIds: new Set(),
    definitions: new Map(),
    emittedRefs: new Set(),
    catalogPayloadSent: false,
  };
}

function numericAct(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function isActStartMap(state) {
  return state?.screen_type === "MAP"
    && state?.screen_state?.first_node_chosen === false
    && state?.screen_state?.current_node?.y === -1;
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
  if (act !== null && mapCache.act !== null && mapCache.act !== act) resetMapCache();
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

async function post(payload) {
  const headers = { Accept: accept, "Content-Type": "application/json" };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body}`);
  sessionId ||= response.headers.get("mcp-session-id") ?? undefined;
  return parseRpcBody(body);
}

function resetGameConnection() {
  sessionId = undefined;
  toolCache = undefined;
  previousState = undefined;
  previousRunContext = undefined;
  gameInitialized = false;
  combatSafety = { floor: null, turn: null, cardsPlayed: 0 };
  turnTransitionSafety = { floor: null, turn: null, endTurnSent: false };
  advisoryKeys = new Set();
  resetMapCache();
  resetCardCatalog();
}

async function initializeGame() {
  resetGameConnection();
  await post({
    jsonrpc: "2.0",
    id: requestId++,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "spire-copilot-proxy", version: pluginVersion },
    },
  });
  await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  gameInitialized = true;
}

async function ensureGameConnection() {
  if (!gameInitialized) await initializeGame();
}

function contentText(result) {
  return (result?.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

async function rawTool(name, args = {}) {
  await ensureGameConnection();
  const response = await post({
    jsonrpc: "2.0",
    id: requestId++,
    method: "tools/call",
    params: { name, arguments: args },
  });
  if (response?.error) throw new Error(`${name}: ${JSON.stringify(response.error)}`);
  const result = response?.result ?? {};
  const message = contentText(result) || JSON.stringify(result);
  if (result.isError) throw new Error(`${name}: ${message}`);
  return { result, message };
}

function parseState(message) {
  try {
    return JSON.parse(message);
  } catch {
    throw new Error(`State was not JSON: ${message}`);
  }
}

function cardUpgradeCount(card) {
  return Number.isInteger(card?.upgrades) && card.upgrades > 0 ? card.upgrades : 0;
}

function cardRef(card) {
  return card?.id ? `${card.id}@${cardUpgradeCount(card)}` : undefined;
}

function normalizeCardText(value) {
  if (typeof value !== "string") return undefined;
  return value.replace(/\s+NL\s+/g, " ").replace(/\s+/g, " ").trim();
}

function compactCardDefinition(raw, upgrades = 0) {
  if (!raw?.id) return undefined;
  const upgraded = upgrades > 0 && raw.upgraded ? raw.upgraded : {};
  const variant = { ...raw, ...upgraded };
  const text = normalizeCardText(variant.description);
  const definition = {
    id: raw.id,
    n: variant.name ?? raw.name,
    ...(raw.type ? { type: raw.type } : {}),
    ...(raw.rarity ? { rarity: raw.rarity } : {}),
    ...(Number.isFinite(variant.cost) ? { c: variant.cost } : {}),
    ...(text ? { text } : {}),
    ...(Number.isFinite(variant.base_damage) ? { d: variant.base_damage } : {}),
    ...(Number.isFinite(variant.base_block) ? { b: variant.base_block } : {}),
    ...(Number.isFinite(variant.base_magic_number) ? { m: variant.base_magic_number } : {}),
    ...(upgrades ? { u: upgrades } : {}),
    ...(variant.exhausts ? { x: true } : {}),
    ...(variant.ethereal ? { ethereal: true } : {}),
    ...(variant.retain ? { retain: true } : {}),
    ...(variant.has_target ? { target: true } : {}),
  };
  return definition;
}

function collectCardInstances(state) {
  const collected = [];
  const add = (cards, zone) => {
    for (const card of cards ?? []) {
      if (card?.id) collected.push({ card, zone });
    }
  };
  add(state?.screen_state?.cards, "choice");
  if (state?.screen_type === "HAND_SELECT") add(state?.screen_state?.hand, "choice");
  add(state?.hand, "hand");
  add(state?.screen_state?.selected_cards, "selected");
  add(state?.screen_state?.selected, "selected");
  for (const instance of state?._card_catalog_instances ?? []) {
    if (instance?.card?.id) collected.push(instance);
  }
  add(state?.run_detail?.deck, "deck");
  const seen = new Set();
  return collected.filter(({ card, zone }) => {
    const key = card.uuid ?? `${zone}:${cardRef(card)}:${card.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function syncCardCatalogRun(state) {
  if (!state?.in_game) {
    cardCatalog.activeRun = false;
    return;
  }
  if (!cardCatalog.activeRun) {
    resetCardCatalog();
    cardCatalog.activeRun = true;
  }
}

async function requestCardInfo(cardIds) {
  if (!cardIds.length) return [];
  try {
    const payload = parseState((await rawTool("get_card_info", { card_ids: cardIds })).message);
    return Array.isArray(payload?.cards) ? payload.cards : [];
  } catch (error) {
    if (isConnectionError(error)) throw error;
    if (cardIds.length === 1) return [];
    const cards = [];
    for (const cardId of cardIds) cards.push(...await requestCardInfo([cardId]));
    return cards;
  }
}

async function loadCardInfo(cardIds, { force = false } = {}) {
  const pending = [...new Set(cardIds.filter(Boolean))]
    .filter((cardId) => force || !cardCatalog.attemptedIds.has(cardId));
  if (!pending.length) return;
  for (const cardId of pending) cardCatalog.attemptedIds.add(cardId);
  for (const card of await requestCardInfo(pending)) {
    if (card?.id) cardCatalog.rawById.set(card.id, card);
  }
}

function rememberCardDefinition(card) {
  const ref = cardRef(card);
  const raw = cardCatalog.rawById.get(card?.id);
  if (!ref || !raw) return undefined;
  const definition = compactCardDefinition(raw, cardUpgradeCount(card));
  if (definition) cardCatalog.definitions.set(ref, definition);
  return definition;
}

async function enrichCardDefinitions(state) {
  syncCardCatalogRun(state);
  if (!state?.in_game) return state;
  const instances = collectCardInstances(state);
  delete state._card_catalog_instances;
  await loadCardInfo(instances.map(({ card }) => card.id));
  for (const { card } of instances) rememberCardDefinition(card);
  return state;
}

function pendingCardDefinitionPayload() {
  const pending = [...cardCatalog.definitions.entries()]
    .filter(([ref]) => !cardCatalog.emittedRefs.has(ref));
  if (!pending.length) return {};
  const field = cardCatalog.catalogPayloadSent ? "card_defs_added" : "card_defs";
  for (const [ref] of pending) cardCatalog.emittedRefs.add(ref);
  cardCatalog.catalogPayloadSent = true;
  return { [field]: Object.fromEntries(pending) };
}

function compactCardInstance(card, zone = undefined) {
  return {
    ...(cardRef(card) ? { ref: cardRef(card) } : {}),
    ...(card?.id ? { id: card.id } : {}),
    ...(card?.name ? { n: card.name } : {}),
    ...(card?.uuid ? { uuid: card.uuid } : {}),
    ...(zone ? { zone } : {}),
    ...(Number.isFinite(card?.cost) ? { c: card.cost } : {}),
    ...(Number.isFinite(card?.damage) && card.damage >= 0 ? { d: card.damage } : {}),
    ...(Number.isFinite(card?.block) && card.block >= 0 ? { b: card.block } : {}),
    ...(Number.isFinite(card?.magic_number) && card.magic_number !== 0 ? { m: card.magic_number } : {}),
    ...(cardUpgradeCount(card) ? { u: cardUpgradeCount(card) } : {}),
    ...(card?.is_playable === false ? { playable: false } : {}),
    ...(card?.exhausts ? { x: true } : {}),
    ...(card?.has_target ? { target: true } : {}),
  };
}

async function screenState() {
  return parseState((await rawTool("get_screen_state")).message);
}

function isTransientScreenReadError(error) {
  return /^get_screen_state: Internal error: null$/i.test(String(error?.message ?? error).trim());
}

async function waitUntilReady({ timeout = timeoutMs, readScreen = screenState, pause = sleep } = {}) {
  const started = Date.now();
  let lastScreen = "unknown";
  do {
    try {
      const state = await readScreen();
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

async function enrichRunAndCombat(state) {
  if (!state.in_game) return state;
  if (state.floor === 0 && mapCache.act !== null) {
    resetMapCache();
  }
  const include = ["deck", "relics", "potions"];
  if (state.room_phase === "COMBAT") include.push("combat");
  const detailed = parseState((await rawTool("get_game_state", { include })).message);
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

async function enrichMap(state) {
  if (state.screen_type !== "MAP") return state;
  let act = state.run_detail?.act ?? resolveAct(state);
  syncMapCacheAct(act);
  if (mapCache.nodes && mapCache.act === act) {
    return { ...state, map: mapCache.nodes, map_version: mapCache.version };
  }
  const detailed = parseState((await rawTool("get_game_state", { include: ["map"] })).message);
  const game = detailed?.game_state;
  const map = game?.map;
  if (!Array.isArray(map)) return state;
  act = resolveAct(state, game) ?? act;
  syncMapCacheAct(act);
  const version = mapVersion(act, map);
  mapCache = { act, nodes: map, version, emittedVersion: null };
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

async function decisionState() {
  const started = Date.now();
  let state;
  do {
    state = await waitUntilReady({ timeout: Math.max(1, timeoutMs - (Date.now() - started)) });
    state = await enrichRunAndCombat(state);
    if (isStableDecisionState(state)) break;
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for a stable game state`);
    }
    await sleep(pollMs);
  } while (true);
  state = await enrichMap(state);
  state = await enrichCardDefinitions(state);
  syncEndTurnSafety(state);
  return state;
}

function liveMonsters(state) {
  return (state?.monsters ?? []).filter((monster) => !monster.is_gone);
}

function identityKey(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function entityMatches(entity, identities) {
  const values = [entity?.id, entity?.name].map(identityKey).filter(Boolean);
  const expected = identities.map(identityKey);
  return values.some((value) => expected.includes(value));
}

function entityHasPower(entity, identities) {
  return (entity?.powers ?? []).some((power) => entityMatches(power, identities));
}

function stateHasRelic(state, identities) {
  return (state?.run_detail?.relics ?? []).some((relic) => entityMatches(relic, identities));
}

function collectContextAdvisories(state) {
  const advisories = [];
  const floor = Number.isFinite(state?.floor) ? state.floor : "unknown";
  const turn = Number.isFinite(state?.combat_detail?.turn) ? state.combat_detail.turn : "unknown";
  const add = (scope, id, text) => {
    const key = `${floor}:${scope}:${id}`;
    if (advisoryKeys.has(key)) return;
    advisoryKeys.add(key);
    advisories.push({ id, text });
  };

  if (state?.screen_type === "REST" && stateHasRelic(state, ["Coffee Dripper", "咖啡滤杯"])) {
    add("rest", "coffee-dripper", "Coffee Dripper prevents healing at Rest sites; treat this campfire as an upgrade or other non-healing action.");
  }

  if (state?.room_phase !== "COMBAT" || !Number.isFinite(state?.combat_detail?.turn)) {
    return advisories;
  }

  const enemies = liveMonsters(state);
  const enemyMatches = (identities) => enemies.some((enemy) => entityMatches(enemy, identities));
  const enemyHasPower = (identities) => enemies.some((enemy) => entityHasPower(enemy, identities));
  const thorns = enemies.flatMap((enemy) => (enemy.powers ?? [])
    .filter((power) => entityMatches(power, ["Thorns", "Sharp Hide", "尖刺", "锋利外壳"]))
    .map((power) => Number(power.amount) || 0));

  if (thorns.length) {
    const amount = Math.max(...thorns);
    add("combat", "per-hit-retaliation", `On-hit retaliation${amount > 0 ? ` (${amount})` : ""} triggers once per damage hit, so multi-hit attacks repeat it; prefer single large hits at low HP and establish block first.`);
  }
  if (hasNormality(state)) {
    add(`turn-${turn}`, "normality", "Normality is in hand: no more than three cards may be played this turn. Remove or exhaust it, then refresh before continuing.");
  }
  if (state?.combat_detail?.player?.stance === "Wrath"
      && enemies.some((enemy) => enemy.intent === "ATTACK" || Number(enemy.move?.damage) > 0)) {
    add(`turn-${turn}`, "wrath-incoming", "Wrath is active while an enemy intends to attack; confirm lethal or exit Wrath and cover the displayed incoming damage before ending the turn.");
  }

  if (enemyMatches(["Time Eater", "TimeEater", "时间吞噬者"]) || enemyHasPower(["Time Warp", "TimeWarp"])) {
    add("combat", "time-eater", "Time Eater ends the turn after the twelfth card and gains Strength. Read Time Warp before every sequence and make the twelfth card deliberate with defense already established.");
  }
  if (enemyMatches(["Awakened One", "AwakenedOne", "觉醒者"]) || enemyHasPower(["Curiosity", "好奇"])) {
    add("combat", "awakened-one", "Awakened One gains Strength from Powers in phase one and revives into phase two. Delay nonessential Powers, clear Cultists deliberately, and plan beyond the first lethal.");
  }
  if (enemyMatches(["Corrupt Heart", "CorruptHeart", "腐化之心"])
      || enemyHasPower(["Beat of Death", "BeatOfDeath", "Invincible", "无敌"])) {
    add("combat", "corrupt-heart", "Corrupt Heart punishes each card with Beat of Death and caps turn damage with Invincible. Establish block before long chains and do not spend attacks beyond the remaining cap.");
  }
  if (enemyMatches(["Slime Boss", "SlimeBoss", "史莱姆老大"])) {
    add("combat", "slime-boss", "Slime Boss splits after being reduced to half HP or lower. Send a split-triggering attack separately because the enemy roster and target indices will change.");
  }
  if (enemyMatches(["The Guardian", "TheGuardian", "守护者"])) {
    add("combat", "the-guardian", "The Guardian changes form at its Mode Shift threshold and can gain Sharp Hide. Track the threshold and treat Sharp Hide as per-hit retaliation before multi-hit attacks.");
  }
  if (enemyMatches(["Hexaghost", "六火亡魂"])) {
    add("combat", "hexaghost", "Hexaghost's opening Divider scales with current HP; Burns accumulate toward its later Inferno. Prioritize scalable defense and a timely kill rather than healing assumptions.");
  }
  if (enemyMatches(["Bronze Automaton", "BronzeAutomaton", "青铜自动机"])) {
    add("combat", "bronze-automaton", "Bronze Automaton's Orbs can steal cards and Hyper Beam is its major burst. Plan the defensive turn and refresh targets after killing an Orb.");
  }
  if (enemyMatches(["The Champ", "Champ", "勇士"])) {
    add("combat", "the-champ", "The Champ cleanses debuffs and changes behavior below half HP before Execute. Do not cross the threshold without enough burst or defense for the transition.");
  }
  if (enemyMatches(["The Collector", "Collector", "收藏家"])) {
    add("combat", "the-collector", "The Collector can summon minions and apply Vulnerable, Weak, and Frail before a large attack. Preserve mitigation and refresh target indices after summons or deaths.");
  }
  if (enemyMatches(["Donu", "甜圈"]) || enemyMatches(["Deca", "八体"])) {
    add("combat", "donu-and-deca", "Donu adds Strength while Deca adds defense and Dazed cards. Choose a focus target instead of splitting damage, then refresh indices after the first kill.");
  }

  return advisories;
}

function syncCombatSafety(state) {
  const turn = state?.combat_detail?.turn;
  const floor = state?.floor;
  if (state?.room_phase !== "COMBAT" || !Number.isFinite(turn)) {
    combatSafety = { floor: null, turn: null, cardsPlayed: 0 };
    return;
  }
  if (combatSafety.floor !== floor || combatSafety.turn !== turn) {
    combatSafety = { floor, turn, cardsPlayed: 0 };
  }
}

function syncEndTurnSafety(state) {
  const turn = state?.combat_detail?.turn;
  const floor = state?.floor;
  if (state?.room_phase !== "COMBAT" || !Number.isFinite(turn)) {
    turnTransitionSafety = { floor: null, turn: null, endTurnSent: false };
    return;
  }
  if (turnTransitionSafety.floor !== floor || turnTransitionSafety.turn !== turn) {
    turnTransitionSafety = { floor, turn, endTurnSent: false };
  }
}

function markEndTurnSent(state) {
  syncEndTurnSafety(state);
  if (turnTransitionSafety.endTurnSent) {
    throw new Error(
      `SAFETY duplicate end_turn: an end-turn request was already sent on floor ${state.floor}, `
      + `turn ${state.combat_detail.turn}. Poll state until the turn number changes; do not resend end_turn.`,
    );
  }
  turnTransitionSafety.endTurnSent = true;
}

function endTurnHasSettled(start, state) {
  if (state?.room_phase !== "COMBAT") return true;
  if (state?.floor !== start.floor) return true;
  const currentTurn = state?.combat_detail?.turn;
  return Number.isFinite(currentTurn) && currentTurn !== start.turn;
}

async function waitForEndTurnSettlement(start, { timeout = timeoutMs } = {}) {
  const started = Date.now();
  let state;
  do {
    await sleep(pollMs);
    state = await decisionState();
    if (endTurnHasSettled(start, state)) return state;
    if (Date.now() - started >= timeout) {
      throw new Error(
        `Timed out after ${timeout}ms waiting for end_turn to settle from floor ${start.floor}, turn ${start.turn}. `
        + "The command was already sent; inspect state but do not resend end_turn.",
      );
    }
  } while (true);
}

function selectedHandCount(state) {
  return Array.isArray(state?.screen_state?.selected) ? state.screen_state.selected.length : 0;
}

function handSelectionChoiceHasSettled(start, state) {
  if (start?.screen_type !== "HAND_SELECT" || state?.screen_type !== "HAND_SELECT") return false;
  return state.can_proceed === true && selectedHandCount(state) > selectedHandCount(start);
}

async function waitForHandSelectionChoiceSettlement(
  start,
  { timeout = timeoutMs, readState = decisionState, pause = sleep } = {},
) {
  const started = Date.now();
  let state;
  do {
    await pause(pollMs);
    state = await readState();
    if (handSelectionChoiceHasSettled(start, state)) return state;
    if (Date.now() - started >= timeout) {
      throw new Error(
        `Timed out after ${timeout}ms waiting for the HAND_SELECT choice to expose confirm. `
        + "The choice was already sent; inspect state but do not resend it.",
      );
    }
  } while (true);
}

function isNormality(card) {
  return NORMALITY_IDS.has(card?.id) || NORMALITY_NAMES.has(card?.name);
}

function hasNormality(state) {
  return (state?.hand ?? []).some(isNormality);
}

function isPlayCardAction(action) {
  return action?.action === "play_card";
}

function isTargetedAction(action) {
  return (action?.action === "play_card" || action?.action === "use_potion")
    && Number.isInteger(action?.target_index);
}

function cardForAction(state, action) {
  const hand = state?.hand ?? [];
  if (Number.isInteger(action?.card_index)) return hand[action.card_index - 1];
  if (action?.card_name) return hand.find((card) => card.name === action.card_name);
  if (action?.card_id) return hand.find((card) => card.id === action.card_id);
  return undefined;
}

function normalitySafetyCheck(state, actions) {
  syncCombatSafety(state);
  if (!hasNormality(state)) return;
  const requested = actions.filter(isPlayCardAction).length;
  const remaining = Math.max(0, 3 - combatSafety.cardsPlayed);
  if (requested > remaining) {
    throw new Error(
      `SAFETY Normality: turn ${combatSafety.turn} already has ${combatSafety.cardsPlayed} tracked card(s); `
      + `batch requests ${requested}, but only ${remaining} more may be played. `
      + "Play/exhaust Normality separately, refresh state, then continue.",
    );
  }
}

function lethalRetargetSafetyCheck(state, actions) {
  const monsters = liveMonsters(state);
  if (monsters.length <= 1) return;
  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index];
    if (!isTargetedAction(action) || action.action !== "play_card") continue;
    const target = monsters[action.target_index - 1];
    const card = cardForAction(state, action);
    const remainingTargeted = actions.slice(index + 1).some(isTargetedAction);
    if (!target || !card || !remainingTargeted) continue;
    const effectiveHp = (target.current_hp ?? Infinity) + (target.block ?? 0);
    if (Number.isFinite(card.damage) && card.damage >= effectiveHp) {
      throw new Error(
        `SAFETY target reindex: '${card.name}' is already lethal on enemy ${action.target_index} `
        + `(${target.name}, ${effectiveHp} effective HP), and a later targeted action would reuse stale indices. `
        + "Send the lethal action alone, refresh enemies, then issue the next targeted action.",
      );
    }
  }
}

function preflightCombatActions(state, actions) {
  normalitySafetyCheck(state, actions);
  lethalRetargetSafetyCheck(state, actions);
}

function isShopScreen(state) {
  return state?.screen_type === "SHOP_SCREEN";
}

function normalizeShopChooseArgs(state, args) {
  if (!isShopScreen(state)) return { ...args };
  const choiceText = args?.choice_text;
  if (typeof choiceText !== "string" || !choiceText.trim()) {
    throw new Error(
      "SAFETY shop reindex: shop choices are renumbered after every purchase. "
      + "Use choice_text instead of choice_index so the relay resolves the item against the latest shop state.",
    );
  }
  const needle = choiceText.trim();
  const choices = state?.choice_list ?? [];
  const exact = choices
    .map((choice, index) => ({ choice, index }))
    .filter(({ choice }) => choice === needle);
  const matches = exact.length ? exact : choices
    .map((choice, index) => ({ choice, index }))
    .filter(({ choice }) => choice.includes(needle));
  if (matches.length !== 1) {
    throw new Error(
      `SAFETY shop choice_text '${needle}' matched ${matches.length} current item(s). `
      + `Current choices: [${choices.join(" | ")}]. Use a unique item name from the refreshed state.`,
    );
  }
  const normalized = { ...args, choice_index: matches[0].index + 1 };
  delete normalized.choice_text;
  return normalized;
}

function choiceCards(state) {
  if (state?.screen_type === "HAND_SELECT") {
    if (Array.isArray(state?.screen_state?.hand)) return state.screen_state.hand;
    if (Array.isArray(state.hand)) return state.hand;
  }
  return Array.isArray(state?.screen_state?.cards) ? state.screen_state.cards : [];
}

function resolveChoiceText(state, choiceText) {
  const needle = choiceText.trim();
  const choices = state?.choice_list ?? [];
  const indexed = choices.map((choice, index) => ({ choice, index }));
  const exact = indexed.filter(({ choice }) => choice === needle);
  const matches = exact.length ? exact : indexed.filter(({ choice }) => choice.includes(needle));
  if (matches.length !== 1) {
    throw new Error(
      `SAFETY choice_text '${needle}' matched ${matches.length} current choice(s). `
      + `Current choices: [${choices.join(" | ")}]. Use a unique current choice_text or choice_uuid.`,
    );
  }
  return matches[0].index + 1;
}

function resolveChoiceUuid(state, choiceUuid) {
  const cards = choiceCards(state);
  const matches = cards
    .map((card, index) => ({ card, index }))
    .filter(({ card }) => card?.uuid === choiceUuid);
  if (matches.length !== 1) {
    throw new Error(
      `SAFETY choice_uuid '${choiceUuid}' matched ${matches.length} current card choice(s). `
      + "Refresh state and use a uuid exposed on the current choice.",
    );
  }
  return matches[0].index + 1;
}

function normalizeChooseArgs(state, args) {
  if (isShopScreen(state)) return normalizeShopChooseArgs(state, args);
  const normalized = { ...args };
  if (typeof normalized.choice_uuid === "string" && normalized.choice_uuid.trim()) {
    normalized.choice_index = resolveChoiceUuid(state, normalized.choice_uuid.trim());
    delete normalized.choice_uuid;
    delete normalized.choice_text;
    return normalized;
  }
  if (typeof normalized.choice_text === "string" && normalized.choice_text.trim()) {
    normalized.choice_index = resolveChoiceText(state, normalized.choice_text);
    delete normalized.choice_text;
    return normalized;
  }
  if (state?.screen_type === "HAND_SELECT") {
    throw new Error(
      "SAFETY hand-selection reindex: selectable cards are renumbered after each pick. "
      + "Use choice_text for a unique card name or choice_uuid for an exact card instance.",
    );
  }
  return normalized;
}

function monsterRosterKey(state) {
  return liveMonsters(state).map((monster) => `${monster.id ?? monster.name}:${monster.name}`).join("|");
}

function normalizeStableCardReference(action, initialState) {
  if (!isPlayCardAction(action) || !Number.isInteger(action.card_index)) return { ...action };
  const card = (initialState?.hand ?? [])[action.card_index - 1];
  if (!card) throw new Error(`SAFETY card index ${action.card_index} was not present in the initial hand`);
  const normalized = { ...action };
  delete normalized.card_index;
  normalized.card_name = card.name;
  return normalized;
}

function actionToolCall(action) {
  const { action: kind, ...args } = action;
  if (["play_card", "choose", "use_potion", "discard_potion"].includes(kind)) return { name: kind, args };
  if (["end_turn", "proceed", "skip", "cancel", "confirm"].includes(kind)) return { name: kind, args: {} };
  return null;
}

function powerAmount(entity, ids) {
  const power = (entity?.powers ?? []).find((item) => ids.has(item?.id));
  return Number.isFinite(power?.amount) ? power.amount : power ? 1 : 0;
}

function hasRelic(state, ids) {
  return (state?.run_detail?.relics ?? []).some((relic) => ids.has(relic?.id));
}

function estimatedDamagePerHit(card, target, state) {
  if (!Number.isFinite(card?.damage) || card.damage < 0 || !card?.has_target) return undefined;
  let damage = card.damage;
  if (powerAmount(target, new Set(["Vulnerable"])) > 0) {
    damage = Math.floor(damage * (hasRelic(state, new Set(["Paper Frog", "PaperPhrog"])) ? 1.75 : 1.5));
  }
  const slow = powerAmount(target, new Set(["Slow"]));
  if (slow > 0) damage = Math.floor(damage * (1 + slow * 0.1));
  if (powerAmount(target, new Set(["Flight"])) > 0) damage = Math.floor(damage * 0.5);
  if (powerAmount(target, new Set(["Intangible"])) > 0) damage = Math.min(damage, 1);
  return Math.max(0, damage);
}

function targetDamageEstimate(card, state) {
  if (!Number.isFinite(card?.damage) || card.damage < 0 || !card?.has_target) return undefined;
  const targets = (state?.monsters ?? []).filter((monster) => !monster.is_gone);
  const changed = targets.map((target, index) => ({
    i: index + 1,
    d: estimatedDamagePerHit(card, target, state),
  })).filter((entry) => Number.isFinite(entry.d) && entry.d !== card.damage);
  if (!changed.length) return undefined;
  if (targets.length === 1) return changed[0].d;
  return Object.fromEntries(changed.map(({ i, d }) => [i, d]));
}

function compactCard(card, state = undefined) {
  const value = { n: card.name, c: card.cost, ...(cardRef(card) ? { ref: cardRef(card) } : {}) };
  if (card.is_playable === false) value.p = false;
  if (Number.isFinite(card.damage) && card.damage >= 0) value.d = card.damage;
  const effectiveDamage = targetDamageEstimate(card, state);
  if (effectiveDamage !== undefined) value.ed = effectiveDamage;
  if (Number.isFinite(card.block) && card.block >= 0) value.b = card.block;
  if (card.magic_number) value.m = card.magic_number;
  if (card.upgrades) value.u = card.upgrades;
  if (card.exhausts) value.x = true;
  if (card.has_target) value.t = true;
  return value;
}

function compactChoiceCard(card) {
  if (!card) return {};
  return {
    ...(cardRef(card) ? { ref: cardRef(card) } : {}),
    ...(Number.isFinite(card.cost) ? { c: card.cost } : {}),
    ...(Number.isFinite(card.damage) && card.damage >= 0 ? { d: card.damage } : {}),
    ...(Number.isFinite(card.block) && card.block >= 0 ? { b: card.block } : {}),
    ...(Number.isFinite(card.magic_number) && card.magic_number !== 0 ? { m: card.magic_number } : {}),
    ...(cardUpgradeCount(card) ? { u: cardUpgradeCount(card) } : {}),
    ...(card.is_playable === false ? { p: false } : {}),
    ...(card.exhausts ? { x: true } : {}),
    ...(card.has_target ? { t: true } : {}),
  };
}

function normalizeDisplayedChoiceIndices(value, key = "") {
  if (Array.isArray(value)) return value.map((item) => normalizeDisplayedChoiceIndices(item));
  if (!value || typeof value !== "object") {
    return key === "choice_index" && Number.isInteger(value) ? value + 1 : value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      normalizeDisplayedChoiceIndices(childValue, childKey),
    ]),
  );
}

function compactMapNode(node) {
  const value = { x: node.x, y: node.y, s: node.symbol };
  if (node.children?.length) value.to = node.children.map((child) => [child.x, child.y]);
  return value;
}

function compactDeckCard(card) {
  return {
    id: card.id,
    n: card.name,
    ...(card.upgrades ? { u: card.upgrades } : {}),
  };
}

function compactRelic(relic) {
  return {
    id: relic.id,
    n: relic.name,
    ...(Number.isFinite(relic.counter) && relic.counter >= 0 ? { c: relic.counter } : {}),
  };
}

function compactPotion(potion, index) {
  return {
    slot: index + 1,
    id: potion.id,
    n: potion.name,
  };
}

function compactScreenCard(card) {
  return {
    id: card.id,
    n: card.name,
    ...(Number.isFinite(card.cost) ? { c: card.cost } : {}),
    ...(card.type ? { type: card.type } : {}),
    ...(Number.isFinite(card.damage) && card.damage >= 0 ? { d: card.damage } : {}),
    ...(Number.isFinite(card.block) && card.block >= 0 ? { b: card.block } : {}),
    ...(card.magic_number ? { m: card.magic_number } : {}),
    ...(card.upgrades ? { u: card.upgrades } : {}),
    ...(card.exhausts ? { x: true } : {}),
    ...(Number.isFinite(card.price) ? { price: card.price } : {}),
  };
}

function compactStoreItem(item) {
  return {
    id: item.id,
    n: item.name,
    ...(Number.isFinite(item.price) ? { price: item.price } : {}),
    ...(Number.isFinite(item.counter) && item.counter >= 0 ? { c: item.counter } : {}),
  };
}

function compactScreenDetails(state) {
  const details = normalizeDisplayedChoiceIndices(state.screen_state);
  if (state.screen_type === "HAND_SELECT") {
    return {
      max_cards: details.max_cards,
      can_pick_zero: details.can_pick_zero,
      selected: (details.selected ?? details.selected_cards ?? []).map((card) => compactCardInstance(card)),
    };
  }
  if (state.screen_type === "GRID") {
    return {
      num_cards: details.num_cards,
      any_number: details.any_number,
      confirm_up: details.confirm_up,
      for_upgrade: details.for_upgrade,
      for_transform: details.for_transform,
      for_purge: details.for_purge,
      selected: (details.selected_cards ?? details.selected ?? []).map((card) => compactCardInstance(card)),
    };
  }
  if (state.screen_type === "CARD_REWARD") {
    const cards = details.cards ?? [];
    const choicesCoverCards = cards.length > 0 && state.choice_list?.length === cards.length;
    return {
      ...(!choicesCoverCards ? { cards: cards.map(compactScreenCard) } : {}),
      bowl_available: details.bowl_available,
      skip_available: details.skip_available,
    };
  }
  if (state.screen_type === "SHOP_SCREEN") {
    return {
      cards: (details.cards ?? []).map(compactScreenCard),
      relics: (details.relics ?? []).map(compactStoreItem),
      potions: (details.potions ?? []).map(compactStoreItem),
      purge_cost: details.purge_cost,
      purge_available: details.purge_available,
    };
  }
  if (state.screen_type === "EVENT" && Array.isArray(details.options)) {
    return {
      event_id: details.event_id,
      event_name: details.event_name,
      body_text: details.body_text,
      options: details.options.map((option) => ({
        ...(Number.isInteger(option.choice_index) ? { i: option.choice_index } : {}),
        ...(option.disabled ? { disabled: true } : {}),
        text: option.text,
      })),
    };
  }
  return details;
}

function compactRunContext(state) {
  const run = state.run_detail;
  if (!run) return undefined;
  return {
    act: run.act,
    class: run.class,
    boss: run.boss,
    deck: (run.deck ?? []).map(compactDeckCard),
    relics: (run.relics ?? []).map(compactRelic),
    potions: (run.potions ?? []).map(compactPotion),
  };
}

function compactState(state, { includeMap = true } = {}) {
  const out = {
    ready: state.ready_for_command,
    room: state.room_type,
    screen: state.screen_type,
  };
  if (Number.isFinite(state.floor)) out.floor = state.floor;
  if (Number.isFinite(state.current_hp) && Number.isFinite(state.max_hp)) {
    out.hp = `${state.current_hp}/${state.max_hp}`;
  }
  if (Number.isFinite(state.gold)) out.gold = state.gold;
  if (Number.isFinite(state.current_energy)) out.energy = `${state.current_energy}/${state.max_energy}`;
  const detail = state.combat_detail;
  if (detail) {
    out.turn = detail.turn;
    if (detail.player?.block) out.block = detail.player.block;
    if (detail.player?.stance) out.stance = detail.player.stance;
    if (detail.player?.powers?.length) {
      out.powers = detail.player.powers.map((power) => ({
        id: power.id,
        ...(Number.isFinite(power.amount) && power.amount !== 0 ? { n: power.amount } : {}),
        ...(Number.isFinite(power.damage) && power.damage !== 0 ? { d: power.damage } : {}),
        ...(Number.isFinite(power.misc) && power.misc !== 0 ? { misc: power.misc } : {}),
        ...(power.just_applied ? { just_applied: true } : {}),
      }));
    }
    out.piles = { draw: detail.draw_count, discard: detail.discard_count, exhaust: detail.exhaust_count };
    if (detail.limbo_count) out.piles.limbo = detail.limbo_count;
    if (detail.cards_discarded_this_turn) out.discarded = detail.cards_discarded_this_turn;
  }
  if (state.monsters?.length) {
    out.enemies = state.monsters.filter((m) => !m.is_gone).map((m, index) => ({
      i: index + 1,
      n: m.name,
      hp: `${m.current_hp}/${m.max_hp}`,
      intent: m.intent,
      ...(m.move?.damage ? { atk: m.move.hits > 1 ? `${m.move.damage}x${m.move.hits}` : m.move.damage } : {}),
      ...(Number.isFinite(m.block) && m.block ? { b: m.block } : {}),
      ...(m.powers?.length ? { powers: m.powers.map((power) => ({ id: power.id, ...(power.amount ? { n: power.amount } : {}) })) } : {}),
    }));
  }
  if (state.hand?.length) out.hand = state.hand.map((card) => compactCard(card, state));
  if (state.choice_list?.length) {
    const cards = choiceCards(state);
    out.choices = state.choice_list.map((text, index) => ({
      i: index + 1,
      text,
      ...(cards[index]?.id ? { card_id: cards[index].id } : {}),
      ...(cards[index]?.uuid ? { choice_uuid: cards[index].uuid } : {}),
      ...compactChoiceCard(cards[index]),
    }));
  }
  if (state.screen_state && Object.keys(state.screen_state).length) {
    out.details = compactScreenDetails(state);
  }
  if (state.screen_type === "MAP" && state.map_version) out.map_ref = state.map_version;
  if (includeMap && state.screen_type === "MAP" && state.map?.length) out.map = state.map.map(compactMapNode);
  if (state.can_proceed) out.proceed = state.proceed_button ?? true;
  if (state.can_cancel) out.cancel = state.cancel_button ?? true;
  return out;
}

function multisetDifference(before, after) {
  const remaining = new Map();
  for (const item of after) {
    const key = JSON.stringify(item);
    const entry = remaining.get(key) ?? { item, count: 0 };
    entry.count += 1;
    remaining.set(key, entry);
  }
  const removed = [];
  for (const item of before) {
    const key = JSON.stringify(item);
    const entry = remaining.get(key);
    if (entry?.count) entry.count -= 1;
    else removed.push(item);
  }
  const added = [];
  for (const { item, count } of remaining.values()) {
    for (let index = 0; index < count; index += 1) added.push(item);
  }
  return { removed, added };
}

function handCardKey(card) {
  return card?.ref ?? card?.n;
}

function handArrayDifference(before, after) {
  const beforeRemaining = before.map((item) => ({ item }));
  const afterRemaining = after.map((item) => ({ item }));
  const consumeMatch = (left, right, predicate) => {
    for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex -= 1) {
      const leftIndex = left.findIndex((entry) => predicate(entry.item, right[rightIndex].item));
      if (leftIndex < 0) continue;
      left.splice(leftIndex, 1);
      right.splice(rightIndex, 1);
    }
  };

  consumeMatch(beforeRemaining, afterRemaining, (left, right) => JSON.stringify(left) === JSON.stringify(right));
  const changed = [];
  for (let afterIndex = afterRemaining.length - 1; afterIndex >= 0; afterIndex -= 1) {
    const next = afterRemaining[afterIndex];
    const key = handCardKey(next.item);
    if (!key) continue;
    const beforeIndex = beforeRemaining.findIndex((entry) => handCardKey(entry.item) === key);
    if (beforeIndex < 0) continue;
    const previous = beforeRemaining[beforeIndex];
    const delta = diffValue(previous.item, next.item);
    if (delta !== undefined) changed.unshift({ key, ...delta });
    beforeRemaining.splice(beforeIndex, 1);
    afterRemaining.splice(afterIndex, 1);
  }

  const removed = beforeRemaining.map(({ item }) => item);
  const added = afterRemaining.map(({ item }) => item);
  return {
    ...(changed.length ? { changed } : {}),
    ...(removed.length ? { removed } : {}),
    ...(added.length ? { added } : {}),
  };
}

function entityArrayDifference(before, after) {
  const keyFor = (item) => item?.i ?? item?.id ?? item?.slot;
  const beforeMap = new Map(before.map((item) => [keyFor(item), item]));
  const afterMap = new Map(after.map((item) => [keyFor(item), item]));
  if ([...beforeMap.keys(), ...afterMap.keys()].some((key) => key === undefined)) return undefined;
  const changed = [];
  for (const [key, item] of afterMap) {
    if (!beforeMap.has(key)) changed.push({ key, added: item });
    else {
      const delta = diffValue(beforeMap.get(key), item);
      if (delta !== undefined) changed.push({ key, ...delta });
    }
  }
  const removed = [...beforeMap.keys()].filter((key) => !afterMap.has(key));
  return changed.length || removed.length ? { changed, ...(removed.length ? { removed } : {}) } : undefined;
}

function diffValue(before, after, key = "") {
  if (JSON.stringify(before) === JSON.stringify(after)) return undefined;
  if (Array.isArray(before) && Array.isArray(after)) {
    if (key === "hand") return handArrayDifference(before, after);
    if (key === "deck") {
      const { removed, added } = multisetDifference(before, after);
      return {
        ...(removed.length ? { removed } : {}),
        ...(added.length ? { added } : {}),
      };
    }
    const entityDelta = entityArrayDifference(before, after);
    return entityDelta ?? after;
  }
  if (!before || !after || typeof before !== "object" || typeof after !== "object") {
    return after;
  }
  const result = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!(key in after)) result[key] = null;
    else {
      const change = diffValue(before[key], after[key], key);
      if (change !== undefined) result[key] = change;
    }
  }
  return Object.keys(result).length ? result : undefined;
}

function compactRunDelta(before, after) {
  if (!before) return { run_context: after };
  const delta = diffValue(before, after);
  if (!delta) return {};
  const named = {};
  for (const [key, value] of Object.entries(delta)) {
    if (key === "relics") named.relic_changes = value;
    else if (key === "deck") named.deck_changes = value;
    else if (key === "potions") named.potion_changes = value;
    else named[key] = value;
  }
  return { run_delta: named };
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function actionSummary(action, extra = {}) {
  return {
    action: action.action,
    ...(action.card_name ? { card: action.card_name } : {}),
    ...(!action.card_name && action.card_id ? { card: action.card_id } : {}),
    ...(action.card_index ? { card_index: action.card_index } : {}),
    ...(action.target_index ? { target: action.target_index } : {}),
    ...(action.choice_text ? { choice: action.choice_text } : {}),
    ...(action.choice_uuid ? { choice_uuid: action.choice_uuid } : {}),
    ...(!action.choice_text && action.choice_index ? { choice_index: action.choice_index } : {}),
    ...(action.potion_slot ? { potion_slot: action.potion_slot } : {}),
    ...extra,
  };
}

function failedBatchReceipt(actions, index, error, downstreamAccepted, stateRefreshError = undefined) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    action: "act_many",
    halted: true,
    reason: "ACTION_FAILED",
    completed_actions: index,
    ...(index ? { completed: actions.slice(0, index).map((action) => actionSummary(action)) } : {}),
    failed_action: actionSummary(actions[index]),
    failed_action_status: downstreamAccepted ? "outcome_uncertain" : "not_executed",
    error: message,
    remaining_actions: actions.slice(index + 1),
    state_status: stateRefreshError ? "last_known" : "refreshed_after_failure",
    ...(stateRefreshError ? {
      state_refresh_error: stateRefreshError instanceof Error ? stateRefreshError.message : String(stateRefreshError),
    } : {}),
  };
}

async function settleFailedBatchAction({ state, actions, index, error, downstreamAccepted }) {
  let currentState = state;
  let stateRefreshError;
  try {
    await sleep(settleMs);
    currentState = await decisionState();
    syncCombatSafety(currentState);
  } catch (refreshError) {
    stateRefreshError = refreshError;
  }
  return rememberAndCompact(
    currentState,
    false,
    failedBatchReceipt(actions, index, error, downstreamAccepted, stateRefreshError),
  );
}

function rememberAndCompact(state, deltaOnly = false, actionResult = undefined) {
  const includeMap = state.map_version && mapCache.emittedVersion !== state.map_version;
  const compact = compactState(state, { includeMap });
  const change = previousState ? diffValue(previousState, compact) : compact;
  const runContext = compactRunContext(state);
  const runPayload = runContext ? compactRunDelta(previousRunContext, runContext) : {};
  const definitionPayload = pendingCardDefinitionPayload();
  const advisories = collectContextAdvisories(state);
  const advisoryPayload = advisories.length ? { advisories } : {};
  previousState = compact;
  if (runContext) previousRunContext = runContext;
  if (includeMap) mapCache.emittedVersion = state.map_version;
  if (actionResult) {
    return { result: actionResult, changes: change ?? {}, ...runPayload, ...definitionPayload, ...advisoryPayload };
  }
  return deltaOnly
    ? { delta: change ?? {}, ...runPayload, ...definitionPayload, ...advisoryPayload }
    : { ...compact, ...runPayload, ...definitionPayload, ...advisoryPayload };
}

async function listTools() {
  await ensureGameConnection();
  if (toolCache) return toolCache;
  const response = await post({ jsonrpc: "2.0", id: requestId++, method: "tools/list", params: {} });
  if (response?.error) throw new Error(JSON.stringify(response.error));
  toolCache = response?.result?.tools ?? [];
  return toolCache;
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

async function safeExecuteActions(actions, wait = true) {
  let state = await decisionState();
  syncCombatSafety(state);

  const isCombatBatch = state.room_phase === "COMBAT" && actions.length > 0;
  if (isCombatBatch) preflightCombatActions(state, actions);
  const initialState = state;
  const normalizedActions = actions.map((action) => normalizeStableCardReference(action, initialState));

  for (let index = 0; index < normalizedActions.length; index += 1) {
    const action = normalizedActions[index];
    const beforeRoster = monsterRosterKey(state);
    const beforeTurn = state?.combat_detail?.turn;

    let settledByDedicatedWait = false;
    let toolCall;
    let downstreamAccepted = false;
    try {
      if (action.action === "wait") {
        await sleep(Math.min(500, Math.max(0, Number(action.ms ?? 100))));
        downstreamAccepted = true;
      } else {
        if (isPlayCardAction(action)) normalitySafetyCheck(state, [action]);
        toolCall = actionToolCall(action);
        if (toolCall) {
          if (toolCall.name === "choose") {
            toolCall = { ...toolCall, args: normalizeChooseArgs(state, toolCall.args) };
          }
          if (toolCall.name === "end_turn") markEndTurnSent(state);
          await validateToolCall(toolCall.name, toolCall.args);
          await rawTool(toolCall.name, toolCall.args);
          downstreamAccepted = true;
          if (toolCall.name === "play_card") combatSafety.cardsPlayed += 1;
          if (toolCall.name === "end_turn" && wait) {
            state = await waitForEndTurnSettlement({ floor: state.floor, turn: beforeTurn });
            settledByDedicatedWait = true;
          } else if (toolCall.name === "choose" && state.screen_type === "HAND_SELECT") {
            state = await waitForHandSelectionChoiceSettlement(state);
            settledByDedicatedWait = true;
          }
        } else {
          await rawTool("execute_actions", { actions: [action] });
          downstreamAccepted = true;
        }
      }

      if (!settledByDedicatedWait) {
        await sleep(settleMs);
        state = await decisionState();
      }
      if (wait && action.action !== "wait") {
        state = await waitForVisualSettlement(toolCall?.name ?? action.action, state);
      }
      syncCombatSafety(state);
    } catch (error) {
      if (toolCall?.name === "end_turn" && !downstreamAccepted) {
        turnTransitionSafety.endTurnSent = false;
      }
      return settleFailedBatchAction({
        state,
        actions: normalizedActions,
        index,
        error,
        downstreamAccepted,
      });
    }

    const remaining = normalizedActions.slice(index + 1);
    const rosterChanged = monsterRosterKey(state) !== beforeRoster;
    const turnChanged = Number.isFinite(beforeTurn) && state?.combat_detail?.turn !== beforeTurn;
    if (remaining.length && rosterChanged && remaining.some(isTargetedAction)) {
      return {
        halted: true,
        reason: "SAFETY enemy roster changed; remaining targeted actions were not executed because target_index values may have shifted",
        completed_actions: index + 1,
        remaining_actions: remaining,
        state: rememberAndCompact(state, false, { action: "act_many", completed: index + 1 }),
      };
    }
    if (remaining.length && turnChanged) {
      return {
        halted: true,
        reason: "SAFETY turn changed before the batch ended; remaining actions were not executed",
        completed_actions: index + 1,
        remaining_actions: remaining,
        state: rememberAndCompact(state, false, { action: "act_many", completed: index + 1 }),
      };
    }
  }

  return rememberAndCompact(state, false, { action: "act_many", completed: normalizedActions.length });
}

async function callAndSettle(name, args = {}, wait = true) {
  if (name === "execute_actions") return safeExecuteActions(args.actions ?? [], wait);
  let callArgs = { ...args };
  const summaryArgs = { ...args };
  let callState;
  if (name === "choose") {
    callState = await decisionState();
    callArgs = normalizeChooseArgs(callState, callArgs);
  }
  if (name === "end_turn") {
    callState ??= await decisionState();
    markEndTurnSent(callState);
  }
  await validateToolCall(name, callArgs);
  if (name === "play_card") {
    const state = await decisionState();
    normalitySafetyCheck(state, [{ action: "play_card", ...callArgs }]);
  }
  let called;
  try {
    called = await rawTool(name, callArgs);
  } catch (error) {
    if (name === "end_turn") turnTransitionSafety.endTurnSent = false;
    throw error;
  }
  if (name === "play_card") combatSafety.cardsPlayed += 1;
  if (!wait || name === "get_screen_state" || name === "get_game_state") {
    if (name === "get_screen_state") return rememberAndCompact(parseState(called.message));
    if (name === "get_game_state") return parseState(called.message);
    return { ok: true, result: called.message };
  }
  if (name === "end_turn") {
    let state = await waitForEndTurnSettlement({
      floor: callState.floor,
      turn: callState.combat_detail.turn,
    });
    state = await waitForVisualSettlement(name, state);
    syncCombatSafety(state);
    return rememberAndCompact(state, false, actionSummary({ action: name, ...summaryArgs }));
  }
  if (name === "choose" && callState?.screen_type === "HAND_SELECT") {
    let state = await waitForHandSelectionChoiceSettlement(callState);
    state = await waitForVisualSettlement(name, state);
    syncCombatSafety(state);
    return rememberAndCompact(state, false, actionSummary({ action: name, ...summaryArgs }));
  }
  await sleep(settleMs);
  let state = await decisionState();
  state = await waitForVisualSettlement(name, state);
  syncCombatSafety(state);
  return rememberAndCompact(state, false, actionSummary({ action: name, ...summaryArgs }));
}

async function runSafetySelfTests() {
  const baseState = {
    floor: 1,
    room_phase: "COMBAT",
    combat_detail: { turn: 1 },
    hand: [
      { id: "Normality", name: "凡庸", type: "CURSE" },
      { id: "Strike_R", name: "打击", damage: 10 },
      { id: "Bash", name: "痛击", damage: 8 },
    ],
    monsters: [
      { id: "A", name: "A", current_hp: 10, block: 0, is_gone: false },
      { id: "B", name: "B", current_hp: 20, block: 0, is_gone: false },
    ],
  };
  const expectThrow = (label, fn) => {
    try {
      fn();
    } catch {
      return;
    }
    throw new Error(`Self-test failed: ${label} did not throw`);
  };

  let observedVisualDelay = -1;
  let visualRefreshes = 0;
  const visuallySettled = await waitForVisualSettlement(
    "play_card",
    { marker: "logical" },
    {
      pause: async (delay) => { observedVisualDelay = delay; },
      readState: async () => { visualRefreshes += 1; return { marker: "visual" }; },
    },
  );
  if (observedVisualDelay !== visualSettleMs
      || visualRefreshes !== 1
      || visuallySettled.marker !== "visual") {
    throw new Error("Self-test failed: play-card settlement did not wait for visual pacing and refresh state");
  }
  const nonVisualState = { marker: "unchanged" };
  if (await waitForVisualSettlement("get_state", nonVisualState) !== nonVisualState) {
    throw new Error("Self-test failed: read-only state call received an unnecessary visual delay");
  }

  combatSafety = { floor: null, turn: null, cardsPlayed: 0 };
  expectThrow("Normality rejects a fourth queued card", () => normalitySafetyCheck(baseState, [
    { action: "play_card" }, { action: "play_card" }, { action: "play_card" }, { action: "play_card" },
  ]));

  syncCombatSafety(baseState);
  combatSafety.cardsPlayed = 2;
  expectThrow("Normality accounts for cards already played", () => normalitySafetyCheck(baseState, [
    { action: "play_card" }, { action: "play_card" },
  ]));

  const noNormality = { ...baseState, hand: baseState.hand.slice(1) };
  expectThrow("Known lethal prevents stale later target", () => lethalRetargetSafetyCheck(noNormality, [
    { action: "play_card", card_name: "打击", target_index: 1 },
    { action: "play_card", card_name: "痛击", target_index: 2 },
  ]));
  lethalRetargetSafetyCheck(
    { ...noNormality, hand: [{ id: "Strike_R", name: "打击", damage: 9 }, noNormality.hand[1]] },
    [
      { action: "play_card", card_name: "打击", target_index: 1 },
      { action: "play_card", card_name: "痛击", target_index: 2 },
    ],
  );

  const shopState = {
    screen_type: "SHOP_SCREEN",
    choice_list: ["purge (125 gold)", "[黑暗之拥+] Cost: 1 POWER (67 gold)", "relic: [冰淇淋] (292 gold)"],
  };
  const resolvedShopChoice = normalizeShopChooseArgs(shopState, { choice_text: "黑暗之拥+" });
  if (resolvedShopChoice.choice_index !== 2 || "choice_text" in resolvedShopChoice) {
    throw new Error("Self-test failed: named shop choice did not resolve to the current index");
  }
  expectThrow("Shop rejects stale numeric-only choices", () => normalizeShopChooseArgs(shopState, { choice_index: 2 }));
  expectThrow("Shop rejects ambiguous named choices", () => normalizeShopChooseArgs(
    { ...shopState, choice_list: ["add potion: [能量药水]", "add potion: [能量药水+]" ] },
    { choice_text: "能量药水" },
  ));

  const handChoiceState = {
    screen_type: "HAND_SELECT",
    choice_list: ["通晓万物+", "化体为空", "灼伤", "灼伤"],
    hand: [
      { id: "Omniscience", name: "通晓万物+", uuid: "omni-1" },
      { id: "EmptyBody", name: "化体为空", uuid: "empty-1" },
      { id: "Burn", name: "灼伤", uuid: "burn-1" },
      { id: "Burn", name: "灼伤", uuid: "burn-2" },
    ],
    screen_state: {
      hand: [
        { id: "Omniscience", name: "通晓万物+", uuid: "omni-1" },
        { id: "EmptyBody", name: "化体为空", uuid: "empty-1" },
        { id: "Burn", name: "灼伤", uuid: "burn-1" },
        { id: "Burn", name: "灼伤", uuid: "burn-2" },
      ],
    },
  };
  const resolvedHandText = normalizeChooseArgs(handChoiceState, { choice_text: "化体为空" });
  if (resolvedHandText.choice_index !== 2 || "choice_text" in resolvedHandText) {
    throw new Error("Self-test failed: named hand choice did not resolve against the latest indices");
  }
  const reindexedHandChoiceState = {
    ...handChoiceState,
    choice_list: handChoiceState.choice_list.slice(1),
    hand: handChoiceState.hand.slice(1),
    screen_state: { hand: handChoiceState.screen_state.hand.slice(1) },
  };
  if (normalizeChooseArgs(reindexedHandChoiceState, { choice_text: "化体为空" }).choice_index !== 1) {
    throw new Error("Self-test failed: named hand choice reused its stale pre-selection index");
  }
  const resolvedHandUuid = normalizeChooseArgs(handChoiceState, { choice_uuid: "burn-2" });
  if (resolvedHandUuid.choice_index !== 4 || "choice_uuid" in resolvedHandUuid) {
    throw new Error("Self-test failed: UUID hand choice did not resolve an exact duplicate card");
  }
  expectThrow("Hand selection rejects stale numeric-only choices", () => normalizeChooseArgs(
    handChoiceState,
    { choice_index: 2 },
  ));
  expectThrow("Hand selection rejects ambiguous named choices", () => normalizeChooseArgs(
    handChoiceState,
    { choice_text: "灼伤" },
  ));

  const endTurnState = { floor: 9, room_phase: "COMBAT", combat_detail: { turn: 4 } };
  turnTransitionSafety = { floor: null, turn: null, endTurnSent: false };
  markEndTurnSent(endTurnState);
  expectThrow("Duplicate end_turn is rejected on the same turn", () => markEndTurnSent(endTurnState));
  syncEndTurnSafety({ ...endTurnState, combat_detail: { turn: 5 } });
  markEndTurnSent({ ...endTurnState, combat_detail: { turn: 5 } });
  const endTurnStart = { floor: endTurnState.floor, turn: endTurnState.combat_detail.turn };
  if (endTurnHasSettled(endTurnStart, endTurnState)) {
    throw new Error("Self-test failed: unchanged turn was treated as settled");
  }
  if (!endTurnHasSettled(endTurnStart, { ...endTurnState, combat_detail: { turn: 5 } })) {
    throw new Error("Self-test failed: advanced turn was not treated as settled");
  }
  if (!endTurnHasSettled(endTurnStart, { floor: 9, room_phase: "COMPLETE" })) {
    throw new Error("Self-test failed: combat completion was not treated as settled");
  }

  const liveCombatRewardFrame = {
    ready_for_command: true,
    room_phase: "COMPLETE",
    screen_type: "COMBAT_REWARD",
    screen_state: { rewards: [] },
    combat_detail: { turn: 5 },
    monsters: [{ id: "Collector", current_hp: 120, is_gone: false, intent: "ATTACK" }],
  };
  if (isStableDecisionState(liveCombatRewardFrame)) {
    throw new Error("Self-test failed: transient combat reward with live monsters was treated as stable");
  }
  if (!isStableDecisionState({
    ...liveCombatRewardFrame,
    combat_detail: undefined,
    monsters: [],
    screen_state: { rewards: [{ reward_type: "GOLD", gold: 25 }] },
  })) {
    throw new Error("Self-test failed: completed combat reward was treated as transient");
  }

  const handSelectStart = {
    ready_for_command: true,
    room_phase: "COMBAT",
    screen_type: "HAND_SELECT",
    can_proceed: false,
    screen_state: { selected: [] },
  };
  if (handSelectionChoiceHasSettled(handSelectStart, {
    ready_for_command: true,
    room_phase: "COMPLETE",
    screen_type: "COMBAT_REWARD",
    can_proceed: true,
    screen_state: { rewards: [] },
  })) {
    throw new Error("Self-test failed: transient combat reward settled a HAND_SELECT choice");
  }
  if (handSelectionChoiceHasSettled(handSelectStart, {
    ...handSelectStart,
    screen_type: "NONE",
    can_proceed: false,
  })) {
    throw new Error("Self-test failed: transient NONE screen settled a HAND_SELECT choice");
  }
  let handSelectionReads = 0;
  const settledHandSelection = await waitForHandSelectionChoiceSettlement(handSelectStart, {
    timeout: 1000,
    pause: async () => {},
    readState: async () => {
      handSelectionReads += 1;
      if (handSelectionReads === 1) {
        return { ...handSelectStart, screen_type: "COMBAT_REWARD", room_phase: "COMPLETE", can_proceed: true };
      }
      if (handSelectionReads === 2) return { ...handSelectStart, screen_type: "NONE" };
      return {
        ...handSelectStart,
        can_proceed: true,
        screen_state: { selected: [{ id: "Reflex", name: "本能反应+" }] },
      };
    },
  });
  if (handSelectionReads !== 3 || settledHandSelection.screen_type !== "HAND_SELECT"
      || selectedHandCount(settledHandSelection) !== 1) {
    throw new Error("Self-test failed: HAND_SELECT choice did not ignore transient screens");
  }

  const compactMenu = compactState({ ready_for_command: true, screen_type: "MAIN_MENU" });
  if ("hp" in compactMenu || "floor" in compactMenu || "gold" in compactMenu) {
    throw new Error("Self-test failed: unavailable main-menu values leaked into compact state");
  }

  const compactEvent = compactState({
    ready_for_command: true,
    screen_type: "EVENT",
    choice_list: ["first", "second"],
    screen_state: { options: [{ choice_index: 0 }, { choice_index: 1 }] },
  });
  if (compactEvent.choices[0].i !== 1 || compactEvent.choices[1].i !== 2
      || compactEvent.details.options[0].i !== 1
      || compactEvent.details.options[1].i !== 2) {
    throw new Error("Self-test failed: displayed choices were not normalized to 1-based indices");
  }

  const compactMap = compactState({
    ready_for_command: true,
    screen_type: "MAP",
    map_version: "act-1-1",
    map: [{ x: 1, y: 0, symbol: "M", children: [{ x: 2, y: 1 }] }],
  });
  if (compactMap.map_ref !== "act-1-1" || compactMap.map?.[0]?.s !== "M" || compactMap.map[0].to?.[0]?.join(",") !== "2,1") {
    throw new Error("Self-test failed: full map graph was not compacted correctly");
  }

  const compactHandChoices = compactState({
    ready_for_command: true,
    screen_type: "HAND_SELECT",
    choice_list: handChoiceState.choice_list,
    hand: handChoiceState.hand,
    screen_state: handChoiceState.screen_state,
  });
  if (compactHandChoices.choices[1].choice_uuid !== "empty-1"
      || compactHandChoices.choices[1].card_id !== "EmptyBody") {
    throw new Error("Self-test failed: compact hand choices omitted stable card identities");
  }

  const compactGrid = compactState({
    ready_for_command: true,
    screen_type: "GRID",
    choice_list: ["化体为空+", "时之沙"],
    screen_state: {
      cards: [
        { id: "EmptyBody", name: "化体为空+", uuid: "empty-up", upgrades: 1, cost: 1, block: 10 },
        { id: "SandsOfTime", name: "时之沙", uuid: "sands", cost: 0, damage: 20, has_target: true },
      ],
      selected_cards: [],
      num_cards: 2,
      any_number: false,
      confirm_up: false,
    },
  });
  if (compactGrid.details.cards
      || compactGrid.details.num_cards !== 2
      || compactGrid.choices[0].ref !== "EmptyBody@1"
      || compactGrid.choices[0].b !== 10
      || compactGrid.choices[1].choice_uuid !== "sands") {
    throw new Error("Self-test failed: GRID choices were not compacted without losing stable or dynamic card data");
  }

  const upgradedDefinition = compactCardDefinition({
    id: "EmptyBody",
    name: "化体为空",
    type: "SKILL",
    rarity: "COMMON",
    cost: 1,
    base_block: 7,
    description: "获得 !B! 点 格挡 。 NL 退出当前 姿态 。",
    upgraded: { name: "化体为空+", base_block: 10 },
  }, 1);
  if (upgradedDefinition.n !== "化体为空+"
      || upgradedDefinition.b !== 10
      || upgradedDefinition.u !== 1
      || upgradedDefinition.text.includes("NL")) {
    throw new Error("Self-test failed: upgraded card definition was not normalized correctly");
  }

  resetCardCatalog();
  cardCatalog.definitions.set("EmptyBody@1", upgradedDefinition);
  const initialDefinitionPayload = pendingCardDefinitionPayload();
  if (!initialDefinitionPayload.card_defs?.["EmptyBody@1"]
      || Object.keys(pendingCardDefinitionPayload()).length !== 0) {
    throw new Error("Self-test failed: initial card definitions were not emitted exactly once");
  }
  cardCatalog.definitions.set("Insight@0", { id: "Insight", n: "洞见", text: "抽2张牌。" });
  if (!pendingCardDefinitionPayload().card_defs_added?.["Insight@0"]) {
    throw new Error("Self-test failed: a newly discovered card definition was not emitted incrementally");
  }
  expectThrow("Card inspection requires one selector", () => validateCardInspectionArgs({}));
  expectThrow("Card inspection rejects ambiguous selectors", () => validateCardInspectionArgs({
    card_id: "EmptyBody",
    card_name: "化体为空",
  }));
  resetCardCatalog();

  if (resolveAct({
    floor: 17,
    screen_type: "MAP",
    screen_state: { first_node_chosen: false, current_node: { y: -1 } },
  }) !== 2 || resolveAct({ floor: 18, screen_type: "NONE" }) !== 2) {
    throw new Error("Self-test failed: act transition was not inferred from the floor and start map");
  }
  if (resolveAct({ floor: 18 }, { act: 3 }) !== 3) {
    throw new Error("Self-test failed: an explicit game act did not override floor inference");
  }
  if (resolveAct({
    floor: 34,
    screen_type: "MAP",
    screen_state: { first_node_chosen: false, current_node: { y: -1 } },
  }, { act: 2 }) !== 3) {
    throw new Error("Self-test failed: stale downstream act overrode the next act's start map");
  }
  const sameSizeMapA = [{ x: 0, y: 0, symbol: "M", children: [{ x: 1, y: 1 }] }];
  const sameSizeMapB = [{ x: 0, y: 0, symbol: "M", children: [{ x: 2, y: 1 }] }];
  if (mapVersion(2, sameSizeMapA) === mapVersion(2, sameSizeMapB)) {
    throw new Error("Self-test failed: distinct same-size map topologies shared a version");
  }

  const compactPlayerStatus = compactState({
    ready_for_command: true,
    screen_type: "NONE",
    combat_detail: {
      turn: 3,
      player: {
        stance: "Calm",
        powers: [
          { id: "Frail", amount: 2, just_applied: true },
          { id: "Strength", amount: -1 },
        ],
      },
      draw_count: 0,
      discard_count: 0,
      exhaust_count: 0,
    },
  });
  if (compactPlayerStatus.stance !== "Calm"
      || compactPlayerStatus.powers[0]?.id !== "Frail"
      || compactPlayerStatus.powers[0]?.n !== 2
      || compactPlayerStatus.powers[0]?.just_applied !== true
      || compactPlayerStatus.powers[1]?.n !== -1) {
    throw new Error("Self-test failed: compact player status dropped a stance or debuff field");
  }

  const semanticHandDelta = diffValue(
    { hand: [{ n: "打击", c: 1 }, { n: "防御", c: 1 }] },
    { hand: [{ n: "防御", c: 1 }] },
  );
  if (semanticHandDelta.hand.removed?.[0]?.n !== "打击" || semanticHandDelta.hand.added) {
    throw new Error("Self-test failed: hand delta was not semantic");
  }

  const scaledHandDelta = diffValue(
    { hand: [{ n: "打击", ref: "Strike_R@0", c: 1, d: 6, t: true }, { n: "防御", ref: "Defend_R@0", c: 1, b: 5 }] },
    { hand: [{ n: "打击", ref: "Strike_R@0", c: 1, d: 12, t: true }, { n: "防御", ref: "Defend_R@0", c: 1, b: 5 }] },
  );
  if (scaledHandDelta.hand.changed?.[0]?.key !== "Strike_R@0"
      || scaledHandDelta.hand.changed[0].d !== 12
      || scaledHandDelta.hand.removed
      || scaledHandDelta.hand.added) {
    throw new Error("Self-test failed: hand stat update was expanded into remove/add churn");
  }

  const duplicateHandDelta = diffValue(
    { hand: [{ n: "化体为空", ref: "EmptyBody@0", c: 1 }, { n: "化体为空", ref: "EmptyBody@0", c: 1 }] },
    { hand: [{ n: "化体为空", ref: "EmptyBody@0", c: 1 }, { n: "化体为空", ref: "EmptyBody@0", c: 0 }] },
  );
  if (duplicateHandDelta.hand.changed?.length !== 1
      || duplicateHandDelta.hand.changed[0].c !== 0
      || duplicateHandDelta.hand.removed
      || duplicateHandDelta.hand.added) {
    throw new Error("Self-test failed: duplicate hand refs did not preserve an in-place stat update");
  }

  const targetAdjustedDamage = compactState({
    ready_for_command: true,
    screen_type: "NONE",
    hand: [{ id: "Strike_R", name: "打击", cost: 1, damage: 8, has_target: true }],
    monsters: [{ name: "易伤目标", current_hp: 20, max_hp: 20, is_gone: false, powers: [{ id: "Vulnerable", amount: 1 }] }],
  });
  if (targetAdjustedDamage.hand[0]?.d !== 8 || targetAdjustedDamage.hand[0]?.ed !== 12) {
    throw new Error("Self-test failed: target-adjusted damage estimate omitted vulnerability");
  }
  const multiTargetDamage = compactState({
    ready_for_command: true,
    screen_type: "NONE",
    hand: [{ id: "Strike_R", name: "打击", cost: 1, damage: 8, has_target: true }],
    monsters: [
      { name: "易伤目标", current_hp: 20, max_hp: 20, is_gone: false, powers: [{ id: "Vulnerable", amount: 1 }] },
      { name: "普通目标", current_hp: 20, max_hp: 20, is_gone: false, powers: [] },
    ],
  });
  if (multiTargetDamage.hand[0]?.ed?.[1] !== 12 || multiTargetDamage.hand[0]?.ed?.[2] !== undefined) {
    throw new Error("Self-test failed: multi-target damage estimate did not isolate modified enemies");
  }

  const semanticEnemyDelta = diffValue(
    { enemies: [{ i: 1, n: "大颚虫", hp: "44/44" }] },
    { enemies: [{ i: 1, n: "大颚虫", hp: "36/44" }] },
  );
  if (semanticEnemyDelta.enemies.changed?.[0]?.hp !== "36/44") {
    throw new Error("Self-test failed: enemy delta did not isolate the changed entity");
  }

  const partialBatchFailure = failedBatchReceipt(
    [
      { action: "play_card", card_name: "旋身+" },
      { action: "play_card", card_name: "化体为空+" },
      { action: "end_turn" },
    ],
    1,
    new Error("play_card: Card not found in hand: 化体为空+"),
    false,
  );
  if (partialBatchFailure.completed_actions !== 1
      || partialBatchFailure.completed?.[0]?.card !== "旋身+"
      || partialBatchFailure.failed_action?.card !== "化体为空+"
      || partialBatchFailure.failed_action_status !== "not_executed"
      || partialBatchFailure.remaining_actions?.[0]?.action !== "end_turn"
      || partialBatchFailure.state_status !== "refreshed_after_failure") {
    throw new Error("Self-test failed: partial batch failure lost its completed, failed, or remaining action receipt");
  }
  if (failedBatchReceipt(
    [{ action: "end_turn" }],
    0,
    new Error("settlement timed out"),
    true,
  ).failed_action_status !== "outcome_uncertain") {
    throw new Error("Self-test failed: an accepted action with failed settlement was reported as not executed");
  }

  const runDelta = compactRunDelta(
    { deck: [], relics: [{ id: "Ring", n: "蛇之戒指" }], potions: [] },
    { deck: [], relics: [{ id: "Ring", n: "蛇之戒指" }, { id: "Letter Opener", n: "开信刀" }], potions: [] },
  );
  if (runDelta.run_delta?.relic_changes?.changed?.[0]?.added?.n !== "开信刀") {
    throw new Error("Self-test failed: newly acquired relic was not reported");
  }

  if (isStableDecisionState({
    room_phase: "COMBAT",
    current_energy: 0,
    combat_detail: { turn: 1, draw_count: 12 },
    monsters: [{ name: "敌人", intent: "DEBUG", is_gone: false }],
  })) {
    throw new Error("Self-test failed: transient DEBUG combat state was treated as stable");
  }

  let screenReads = 0;
  const settledEvent = await waitUntilReady({
    timeout: 1000,
    pause: async () => {},
    readScreen: async () => {
      screenReads += 1;
      if (screenReads === 1) throw new Error("get_screen_state: Internal error: null");
      return { ready_for_command: true, screen_type: "EVENT" };
    },
  });
  if (screenReads !== 2 || settledEvent.screen_type !== "EVENT") {
    throw new Error("Self-test failed: transient event screen read was not retried");
  }

  let unrelatedErrorWasRetried = false;
  try {
    await waitUntilReady({
      timeout: 1000,
      pause: async () => {},
      readScreen: async () => {
        if (unrelatedErrorWasRetried) return { ready_for_command: true, screen_type: "EVENT" };
        unrelatedErrorWasRetried = true;
        throw new Error("get_screen_state: permission denied");
      },
    });
    throw new Error("Self-test failed: unrelated screen read error was suppressed");
  } catch (error) {
    if (error.message !== "get_screen_state: permission denied") throw error;
  }

  advisoryKeys = new Set();
  const advisoryCombat = {
    floor: 42,
    room_phase: "COMBAT",
    screen_type: "NONE",
    combat_detail: { turn: 1, player: { stance: "Neutral" } },
    hand: [{ id: "Normality", name: "凡庸" }],
    monsters: [{
      id: "Spiker",
      name: "钉刺机",
      current_hp: 40,
      max_hp: 40,
      is_gone: false,
      intent: "ATTACK",
      move: { damage: 7, hits: 1 },
      powers: [{ id: "Thorns", amount: 5 }],
    }],
  };
  const firstAdvisories = collectContextAdvisories(advisoryCombat);
  if (!firstAdvisories.some(({ id }) => id === "per-hit-retaliation")
      || !firstAdvisories.some(({ id }) => id === "normality")
      || collectContextAdvisories(advisoryCombat).length !== 0) {
    throw new Error("Self-test failed: contextual advisories were missing or repeated in one combat turn");
  }
  const nextTurnAdvisories = collectContextAdvisories({
    ...advisoryCombat,
    combat_detail: { turn: 2, player: { stance: "Neutral" } },
  });
  if (nextTurnAdvisories.length !== 1 || nextTurnAdvisories[0].id !== "normality") {
    throw new Error("Self-test failed: turn-scoped Normality advisory did not refresh exactly once");
  }
  const timeEaterAdvisories = collectContextAdvisories({
    ...advisoryCombat,
    hand: [],
    monsters: [{
      id: "TimeEater",
      name: "时间吞噬者",
      current_hp: 456,
      max_hp: 456,
      is_gone: false,
      intent: "ATTACK",
      move: { damage: 8, hits: 3 },
      powers: [{ id: "Time Warp", amount: 0 }],
    }],
  });
  if (!timeEaterAdvisories.some(({ id }) => id === "time-eater")) {
    throw new Error("Self-test failed: boss identity did not produce a contextual advisory");
  }
  const restAdvisories = collectContextAdvisories({
    floor: 43,
    room_phase: "COMPLETE",
    screen_type: "REST",
    run_detail: { relics: [{ id: "Coffee Dripper", name: "咖啡滤杯" }] },
  });
  if (restAdvisories.length !== 1 || restAdvisories[0].id !== "coffee-dripper") {
    throw new Error("Self-test failed: Coffee Dripper Rest advisory was not emitted");
  }

  combatSafety = { floor: null, turn: null, cardsPlayed: 0 };
  turnTransitionSafety = { floor: null, turn: null, endTurnSent: false };
  advisoryKeys = new Set();
  process.stdout.write("Self-tests passed: safety guards, contextual advisories, stable combat state, transient reward, event and hand-selection reads, 1-based choices, act-aware map graph, semantic delta, and run changes\n");
}

function runSyntheticBenchmark() {
  const before = {
    ready: true,
    room: "MonsterRoom",
    screen: "NONE",
    floor: 5,
    hp: "77/77",
    gold: 40,
    energy: "3/3",
    turn: 2,
    enemies: [{ i: 1, n: "大颚虫", hp: "35/44", intent: "ATTACK_DEFEND", atk: 7 }],
    hand: [
      { n: "防御", c: 1, b: 5 }, { n: "中和", c: 0, d: 3, m: 1, t: true },
      { n: "防御", c: 1, b: 5 }, { n: "飞膝", c: 1, d: 8, t: true }, { n: "防御", c: 1, b: 5 },
    ],
  };
  const after = {
    ...before,
    energy: "1/3",
    block: 5,
    enemies: [{ i: 1, n: "大颚虫", hp: "24/44", intent: "ATTACK_DEFEND", atk: 5, powers: [{ id: "Weakened", n: 1 }] }],
    hand: [{ n: "防御", c: 1, b: 5 }, { n: "防御", c: 1, b: 5 }],
  };
  const bytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");
  const repeatedCompact = bytes(before) + bytes(after);
  const deltaBytes = bytes({ delta: diffValue(before, after) });
  const initialPlusDelta = bytes(before) + deltaBytes;
  const gridCards = Array.from({ length: 20 }, (_, index) => ({
    id: `Card${index}`,
    name: `选择牌${index}`,
    uuid: `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`,
    type: index % 2 ? "SKILL" : "ATTACK",
    cost: index % 3,
    damage: index % 2 ? undefined : 8 + index,
    block: index % 2 ? 6 + index : undefined,
    magic_number: 2,
    upgrades: index % 4 === 0 ? 1 : 0,
    is_playable: true,
    has_target: index % 2 === 0,
  }));
  const legacyGridPayload = {
    choices: gridCards.map((card, index) => ({
      i: index + 1,
      text: card.name,
      card_id: card.id,
      choice_uuid: card.uuid,
    })),
    details: {
      cards: gridCards,
      selected_cards: [],
      num_cards: 2,
      any_number: false,
      confirm_up: false,
      for_upgrade: false,
      for_transform: false,
      for_purge: false,
    },
  };
  const compactGridState = compactState({
    ready_for_command: true,
    screen_type: "GRID",
    choice_list: gridCards.map((card) => card.name),
    screen_state: legacyGridPayload.details,
  });
  const compactGridPayload = { choices: compactGridState.choices, details: compactGridState.details };
  const stanceBefore = [
    { n: "打击", ref: "Strike_P@1", c: 1, d: 9, u: 1, t: true },
    { n: "不惧妖邪", ref: "FearNoEvil@0", c: 1, d: 8, t: true },
    { n: "斩破命运", ref: "CutThroughFate@0", c: 1, d: 7, m: 2, t: true },
    { n: "防御", ref: "Defend_P@1", c: 1, b: 8, u: 1 },
  ];
  const stanceAfter = stanceBefore.map((card) => card.d ? { ...card, d: card.d * 2 } : card);
  const legacyStanceDelta = { hand: multisetDifference(stanceBefore, stanceAfter) };
  const compactStanceDelta = { hand: handArrayDifference(stanceBefore, stanceAfter) };
  process.stdout.write(`${JSON.stringify({
    fixture: "single-combat-decision",
    repeated_state_bytes_per_followup: bytes(after),
    semantic_delta_bytes_per_followup: deltaBytes,
    followup_reduction_percent: Number(((1 - deltaBytes / bytes(after)) * 100).toFixed(1)),
    repeated_compact_bytes: repeatedCompact,
    initial_plus_semantic_delta_bytes: initialPlusDelta,
    reduction_percent: Number(((1 - initialPlusDelta / repeatedCompact) * 100).toFixed(1)),
    grid_20_card_legacy_bytes: bytes(legacyGridPayload),
    grid_20_card_compact_bytes: bytes(compactGridPayload),
    grid_20_card_reduction_percent: Number(((1 - bytes(compactGridPayload) / bytes(legacyGridPayload)) * 100).toFixed(1)),
    stance_hand_legacy_delta_bytes: bytes(legacyStanceDelta),
    stance_hand_compact_delta_bytes: bytes(compactStanceDelta),
    stance_hand_reduction_percent: Number(((1 - bytes(compactStanceDelta) / bytes(legacyStanceDelta)) * 100).toFixed(1)),
    note: "Synthetic regression fixture; not a published real-run token claim",
  }, null, 2)}\n`);
}

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

if (process.argv.includes("--self-test")) {
  await runSafetySelfTests();
  process.exit(0);
}

if (process.argv.includes("--benchmark")) {
  runSyntheticBenchmark();
  process.exit(0);
}

const ACTION_PROPERTIES = {
  action: {
    type: "string",
    enum: ["play_card", "end_turn", "choose", "proceed", "skip", "cancel", "confirm", "use_potion", "discard_potion"],
  },
  card_name: { type: "string" },
  card_id: { type: "string" },
  card_index: { type: "integer", minimum: 1 },
  target_index: { type: "integer", minimum: 1 },
  choice_index: { type: "integer", minimum: 1 },
  choice_text: { type: "string" },
  choice_uuid: { type: "string" },
  potion_slot: { type: "integer", minimum: 1 },
};

const PLUGIN_TOOLS = [
  {
    name: "get_state",
    description: "Read settled game state. compact sends run context and the full map once per run/act; delta returns semantic changes; full is diagnostic and verbose. Contextual advisories are emitted once when relevant mechanics first appear.",
    inputSchema: {
      type: "object",
      properties: { mode: { type: "string", enum: ["compact", "delta", "full"], default: "compact" } },
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
    description: "Perform one safe action and return an action receipt plus settled semantic changes. Reindexing choice screens accept choice_text or choice_uuid; shops require choice_text. end_turn waits for the next turn and rejects duplicates.",
    inputSchema: {
      type: "object",
      properties: { ...ACTION_PROPERTIES, wait: { type: "boolean", default: true } },
      required: ["action"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "act_many",
    description: "Execute a short safe sequence serially and return settled semantic changes. Each choice_text or choice_uuid is re-resolved against fresh state; stops if the turn or enemy roster changes. A later failure returns a halted receipt with completed, failed, and remaining actions plus refreshed state. Send lethal targeted attacks separately.",
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
        wait: { type: "boolean", default: true },
      },
      required: ["actions"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
];

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

function isConnectionError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /fetch failed|ECONNREFUSED|ECONNRESET|socket|HTTP 404|HTTP 410|HTTP 5\d\d/i.test(message);
}

function validateCardInspectionArgs(args) {
  const selectors = ["choice_uuid", "card_id", "card_name"]
    .filter((key) => typeof args?.[key] === "string" && args[key].trim());
  if (selectors.length !== 1) {
    throw new Error("inspect_card requires exactly one of choice_uuid, card_id, or card_name");
  }
  if (args.upgrades !== undefined && (!Number.isInteger(args.upgrades) || args.upgrades < 0)) {
    throw new Error("inspect_card.upgrades must be a non-negative integer");
  }
  if (args.choice_uuid && args.upgrades !== undefined) {
    throw new Error("inspect_card.upgrades cannot be combined with choice_uuid");
  }
  return selectors[0];
}

function uniqueCardRefs(instances) {
  return [...new Set(instances.map(({ card }) => cardRef(card)).filter(Boolean))];
}

function preferredCardInstance(instances) {
  const priority = new Map([["choice", 0], ["hand", 1], ["selected", 2], ["deck", 3]]);
  return [...instances].sort((a, b) => (priority.get(a.zone) ?? 9) - (priority.get(b.zone) ?? 9))[0];
}

async function inspectCard(args = {}) {
  const selector = validateCardInspectionArgs(args);
  const state = await decisionState();
  let instances = collectCardInstances(state);
  let ref;

  if (selector === "choice_uuid") {
    instances = instances.filter(({ card }) => card.uuid === args.choice_uuid.trim());
    if (instances.length !== 1) {
      throw new Error(
        `inspect_card choice_uuid '${args.choice_uuid}' matched ${instances.length} live card instance(s); refresh state`,
      );
    }
    ref = cardRef(instances[0].card);
  } else if (selector === "card_id") {
    const cardId = args.card_id.trim();
    instances = instances.filter(({ card }) => card.id === cardId
      && (args.upgrades === undefined || cardUpgradeCount(card) === args.upgrades));
    const refs = uniqueCardRefs(instances);
    if (refs.length > 1) {
      throw new Error(`inspect_card card_id '${cardId}' matched multiple upgrade levels; specify upgrades`);
    }
    ref = refs[0] ?? `${cardId}@${args.upgrades ?? 0}`;
    await loadCardInfo([cardId], { force: !cardCatalog.rawById.has(cardId) });
    if (!cardCatalog.definitions.has(ref)) {
      rememberCardDefinition({ id: cardId, upgrades: args.upgrades ?? 0 });
    }
  } else {
    const name = args.card_name.trim();
    instances = instances.filter(({ card }) => card.name === name
      && (args.upgrades === undefined || cardUpgradeCount(card) === args.upgrades));
    const cachedRefs = [...cardCatalog.definitions.entries()]
      .filter(([, definition]) => definition.n === name
        && (args.upgrades === undefined || (definition.u ?? 0) === args.upgrades))
      .map(([cachedRef]) => cachedRef);
    const refs = [...new Set([...uniqueCardRefs(instances), ...cachedRefs])];
    if (refs.length !== 1) {
      throw new Error(
        `inspect_card card_name '${name}' matched ${refs.length} definition(s); use card_id or choice_uuid`,
      );
    }
    [ref] = refs;
  }

  const definition = cardCatalog.definitions.get(ref);
  if (!definition) {
    return {
      status: "DEFINITION_UNAVAILABLE",
      ref,
      source: instances.length ? "live_instance" : "not_found",
      ...(instances.length ? {
        instances: instances.map(({ card, zone }) => compactCardInstance(card, zone)),
      } : {}),
    };
  }

  cardCatalog.emittedRefs.add(ref);
  const matchingInstances = instances.filter(({ card }) => cardRef(card) === ref);
  const preferred = preferredCardInstance(matchingInstances);
  return {
    status: "ok",
    ref,
    source: matchingInstances.length ? "live_instance" : "downstream_definition",
    definition,
    ...(selector === "choice_uuid" && preferred
      ? { instance: compactCardInstance(preferred.card, preferred.zone) }
      : matchingInstances.length
        ? { instances: matchingInstances.map(({ card, zone }) => compactCardInstance(card, zone)) }
        : {}),
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
  if (name === "inspect_card") return inspectCard(args);
  if (name === "act") {
    const { action, wait = true, ...actionArgs } = args;
    const call = actionToolCall({ action, ...actionArgs });
    if (!call) throw new Error(`Unsupported action '${action}'`);
    return callAndSettle(call.name, call.args, wait);
  }
  if (name === "act_many") {
    return callAndSettle("execute_actions", { actions: args.actions ?? [] }, args.wait !== false);
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
        instructions: "Read get_state before acting and apply any contextual advisories before choosing actions. Card definitions are sent once and later states use refs; use inspect_card to verify one effect without requesting full state. Use act for normal play and act_many only for short safe sequences. Resolve changing card choices with choice_text or choice_uuid; shops require choice_text. Never resend end_turn after timeout; read state instead.",
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
