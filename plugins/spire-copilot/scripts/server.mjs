#!/usr/bin/env node

import readline from "node:readline";

const endpoint = process.env.STS_MCP_URL ?? "http://127.0.0.1:8080/mcp";
const accept = "application/json, text/event-stream";
const pollMs = Number(process.env.STS_POLL_MS ?? 180);
const settleMs = Number(process.env.STS_SETTLE_MS ?? 250);
const timeoutMs = Number(process.env.STS_WAIT_TIMEOUT_MS ?? 20000);

let sessionId;
let requestId = 1;
let toolCache;
let previousState;
let gameInitialized = false;
let combatSafety = { floor: null, turn: null, cardsPlayed: 0 };
let turnTransitionSafety = { floor: null, turn: null, endTurnSent: false };

const NORMALITY_IDS = new Set(["Normality"]);
const NORMALITY_NAMES = new Set(["Normality", "凡庸"]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  gameInitialized = false;
  combatSafety = { floor: null, turn: null, cardsPlayed: 0 };
  turnTransitionSafety = { floor: null, turn: null, endTurnSent: false };
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
      clientInfo: { name: "spire-copilot-proxy", version: "0.1.0" },
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

async function screenState() {
  return parseState((await rawTool("get_screen_state")).message);
}

async function waitUntilReady({ timeout = timeoutMs } = {}) {
  const started = Date.now();
  let state;
  do {
    state = await screenState();
    if (state.ready_for_command) return state;
    if (Date.now() - started >= timeout) {
      throw new Error(`Timed out after ${timeout}ms; last screen=${state.screen_type ?? "unknown"}`);
    }
    await sleep(pollMs);
  } while (true);
}

async function enrichCombat(state) {
  if (state.room_phase !== "COMBAT") return state;
  const detailed = parseState((await rawTool("get_game_state", { include: ["combat"] })).message);
  const combat = detailed?.game_state?.combat_state;
  if (!combat) return state;
  return {
    ...state,
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
}

async function decisionState() {
  const state = await enrichCombat(await waitUntilReady());
  syncEndTurnSafety(state);
  return state;
}

function liveMonsters(state) {
  return (state?.monsters ?? []).filter((monster) => !monster.is_gone);
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

function compactCard(card) {
  const value = { n: card.name, c: card.cost };
  if (card.is_playable === false) value.p = false;
  if (Number.isFinite(card.damage) && card.damage >= 0) value.d = card.damage;
  if (Number.isFinite(card.block) && card.block >= 0) value.b = card.block;
  if (card.magic_number) value.m = card.magic_number;
  if (card.upgrades) value.u = card.upgrades;
  if (card.exhausts) value.x = true;
  if (card.has_target) value.t = true;
  return value;
}

function compactState(state) {
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
    if (detail.player?.powers?.length) {
      out.powers = detail.player.powers.map((power) => ({
        id: power.id,
        ...(power.amount ? { n: power.amount } : {}),
        ...(power.damage ? { d: power.damage } : {}),
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
  if (state.hand?.length) out.hand = state.hand.map(compactCard);
  if (state.choice_list?.length) out.choices = state.choice_list;
  if (state.screen_state && Object.keys(state.screen_state).length) out.details = state.screen_state;
  if (state.can_proceed) out.proceed = state.proceed_button ?? true;
  if (state.can_cancel) out.cancel = state.cancel_button ?? true;
  return out;
}

function diffValue(before, after) {
  if (JSON.stringify(before) === JSON.stringify(after)) return undefined;
  if (!before || !after || typeof before !== "object" || typeof after !== "object" || Array.isArray(before) || Array.isArray(after)) {
    return after;
  }
  const result = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!(key in after)) result[key] = null;
    else {
      const change = diffValue(before[key], after[key]);
      if (change !== undefined) result[key] = change;
    }
  }
  return Object.keys(result).length ? result : undefined;
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function rememberAndCompact(state, deltaOnly = false) {
  const compact = compactState(state);
  const change = previousState ? diffValue(previousState, compact) : compact;
  previousState = compact;
  return deltaOnly ? { delta: change ?? {} } : compact;
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
  await validateToolCall("execute_actions", { actions });
  let state = await decisionState();
  syncCombatSafety(state);

  if (isShopScreen(state) && actions.some((action) => action?.action === "choose")) {
    throw new Error(
      "SAFETY shop reindex: batched shop choices are disabled because every purchase renumbers the remaining items. "
      + "Send one choose call with choice_text, wait for refreshed state, then choose the next item by text.",
    );
  }

  const isCombatBatch = state.room_phase === "COMBAT" && actions.length > 0;
  if (!isCombatBatch) {
    const called = await rawTool("execute_actions", { actions });
    if (!wait) return { ok: true, result: called.message };
    await sleep(settleMs);
    state = await decisionState();
    syncCombatSafety(state);
    return rememberAndCompact(state);
  }

  preflightCombatActions(state, actions);
  const initialState = state;
  const normalizedActions = actions.map((action) => normalizeStableCardReference(action, initialState));

  for (let index = 0; index < normalizedActions.length; index += 1) {
    const action = normalizedActions[index];
    const beforeRoster = monsterRosterKey(state);
    const beforeTurn = state?.combat_detail?.turn;

    let settledByTurnAdvance = false;
    if (action.action === "wait") {
      await sleep(Math.min(500, Math.max(0, Number(action.ms ?? 100))));
    } else {
      if (isPlayCardAction(action)) normalitySafetyCheck(state, [action]);
      const toolCall = actionToolCall(action);
      if (toolCall) {
        if (toolCall.name === "end_turn") markEndTurnSent(state);
        await validateToolCall(toolCall.name, toolCall.args);
        try {
          await rawTool(toolCall.name, toolCall.args);
        } catch (error) {
          if (toolCall.name === "end_turn") turnTransitionSafety.endTurnSent = false;
          throw error;
        }
        if (toolCall.name === "play_card") combatSafety.cardsPlayed += 1;
        if (toolCall.name === "end_turn" && wait) {
          state = await waitForEndTurnSettlement({ floor: state.floor, turn: beforeTurn });
          settledByTurnAdvance = true;
        }
      } else {
        await rawTool("execute_actions", { actions: [action] });
      }
    }

    if (!settledByTurnAdvance) {
      await sleep(settleMs);
      state = await decisionState();
    }
    syncCombatSafety(state);

    const remaining = normalizedActions.slice(index + 1);
    const rosterChanged = monsterRosterKey(state) !== beforeRoster;
    const turnChanged = Number.isFinite(beforeTurn) && state?.combat_detail?.turn !== beforeTurn;
    if (remaining.length && rosterChanged && remaining.some(isTargetedAction)) {
      return {
        halted: true,
        reason: "SAFETY enemy roster changed; remaining targeted actions were not executed because target_index values may have shifted",
        completed_actions: index + 1,
        remaining_actions: remaining,
        state: rememberAndCompact(state),
      };
    }
    if (remaining.length && turnChanged) {
      return {
        halted: true,
        reason: "SAFETY turn changed before the batch ended; remaining actions were not executed",
        completed_actions: index + 1,
        remaining_actions: remaining,
        state: rememberAndCompact(state),
      };
    }
  }

  return rememberAndCompact(state);
}

async function callAndSettle(name, args = {}, wait = true) {
  if (name === "execute_actions") return safeExecuteActions(args.actions ?? [], wait);
  let callArgs = { ...args };
  let callState;
  if (name === "choose") {
    callState = await decisionState();
    callArgs = normalizeShopChooseArgs(callState, callArgs);
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
    const state = await waitForEndTurnSettlement({
      floor: callState.floor,
      turn: callState.combat_detail.turn,
    });
    syncCombatSafety(state);
    return rememberAndCompact(state);
  }
  await sleep(settleMs);
  const state = await decisionState();
  syncCombatSafety(state);
  return rememberAndCompact(state);
}

function runSafetySelfTests() {
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

  const compactMenu = compactState({ ready_for_command: true, screen_type: "MAIN_MENU" });
  if ("hp" in compactMenu || "floor" in compactMenu || "gold" in compactMenu) {
    throw new Error("Self-test failed: unavailable main-menu values leaked into compact state");
  }

  combatSafety = { floor: null, turn: null, cardsPlayed: 0 };
  turnTransitionSafety = { floor: null, turn: null, endTurnSent: false };
  process.stdout.write("Safety self-tests passed: Normality, target reindex, named shop choice, and settled end-turn guards\n");
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
  runSafetySelfTests();
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
  potion_slot: { type: "integer", minimum: 1 },
};

const PLUGIN_TOOLS = [
  {
    name: "get_state",
    description: "Read the settled Slay the Spire state. compact is the normal low-token view; delta returns changes since the previous read; full is diagnostic and verbose.",
    inputSchema: {
      type: "object",
      properties: { mode: { type: "string", enum: ["compact", "delta", "full"], default: "compact" } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "act",
    description: "Perform one safe game action and return settled compact state. Shop choices must use choice_text. end_turn waits for the next turn and rejects duplicates.",
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
    description: "Execute a short safe action sequence serially. Stops if the turn or enemy roster changes. Never batch multiple shop purchases; send lethal targeted attacks separately.",
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

async function readPluginState(mode) {
  const read = async () => {
    const state = await decisionState();
    if (mode === "full") return state;
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
        serverInfo: { name: "spire-copilot", version: "0.1.0" },
        instructions: "Read get_state before acting. Use act for normal play and act_many only for short safe sequences. Shop purchases require choice_text. Never resend end_turn after timeout; read state instead.",
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

