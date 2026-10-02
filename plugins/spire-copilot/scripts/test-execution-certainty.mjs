#!/usr/bin/env node
// Protocol invariants through the real stdio runtime and an isolated HTTP game.
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const card = (uuid) => ({ id: "Guard", name: "Guard", uuid, cost: 0, block: 5, is_playable: true });
let floor = 60, state, sent, faultAt, fault, mutate, holdTurn, noise, readFailures, initFailure, hangReads;
let completeAt, completionScreen, completionHand, screenReads;
function reset() {
  faultAt = 0; fault = "drop"; mutate = true; holdTurn = false; noise = false; readFailures = 0; hangReads = false;
  completeAt = 0; completionScreen = "COMPLETE"; completionHand = "omit"; screenReads = 0;
  state = { in_game: true, ready_for_command: true, floor: floor++, room_phase: "COMBAT",
    room_type: "MonsterRoom", screen_type: "NONE", current_energy: 3, max_energy: 3,
    current_hp: 50, max_hp: 50, hand: [card("a"), card("b"), card("c")],
    combat_detail: { turn: 1, player: { block: 0 } },
    monsters: [{ id: "Enemy", name: "Enemy", current_hp: 40, intent: "ATTACK", move: { damage: 8 } }],
    potions: [{ id: "EnergyPotion", name: "Energy", can_use: true }, { id: "BlockPotion", name: "Block", can_use: true }] };
  sent = [];
}
reset(); initFailure = true;
const result = (value, isError = false) => ({ content: [{ type: "text", text: JSON.stringify(value) }],
  ...(isError ? { isError: true } : {}) });
const properties = {
  execute_actions: { actions: { type: "array" } }, end_turn: {},
  use_potion: { potion_slot: { type: "integer" } }, discard_potion: { potion_slot: { type: "integer" } },
  choose: { choice_index: { type: "integer" } }, proceed: {}, confirm: {}, cancel: {}, skip: {},
};
const sockets = new Set();
const server = http.createServer(async (req, res) => {
  try {
    let bytes = "";
    for await (const chunk of req) bytes += chunk;
    const message = JSON.parse(bytes);
    if (message.method === "initialize" && initFailure) {
      initFailure = false; res.writeHead(503); res.end("Unavailable before action dispatch"); return;
    }
    let value = {};
    if (message.method === "tools/list") value = { tools: Object.entries(properties).map(([name, props]) => ({
      name, inputSchema: { properties: props, required: Object.keys(props) },
    })) };
    if (message.method === "tools/call") {
      const { name, arguments: args = {} } = message.params;
      if (name === "get_screen_state") {
        screenReads++;
        if (hangReads && sent.length) return;
        if (readFailures > 0) { readFailures--; res.destroy(); return; }
        value = result(state);
      } else if (name === "get_game_state") value = result({ game_state: {
        class: "WATCHER", act: 3, deck: [], relics: [], potions: state.potions,
        combat_state: state.room_phase === "COMBAT" ? { ...state.combat_detail,
          hand: state.hand, monsters: state.monsters, draw_pile: [], discard_pile: [], exhaust_pile: [] } : undefined,
      } });
      else if (name === "get_card_info") value = result({ cards: [] });
      else {
        assert.ok(name in properties, `unexpected mutation ${name}`);
        const action = name === "execute_actions" ? args.actions[0] : { action: name, ...args };
        if (name === "execute_actions") assert.equal(args.actions.length, 1);
        sent.push(action);
        const failing = sent.length === faultAt;
        if (failing && fault === "reject") value = result("Could not execute action", true);
        else {
          const beforeHand = state.hand?.slice();
          if (mutate) {
            if (action.action === "play_card") {
              const index = state.hand.findIndex((c) => c.uuid === action.card_uuid);
              assert.ok(index >= 0, "exact UUID must be present");
              state.hand.splice(index, 1); state.combat_detail.player.block += 5;
              if (Number.isInteger(state.combat_detail.cards_played_this_turn)) state.combat_detail.cards_played_this_turn++;
            } else if (action.action === "end_turn") {
              if (!holdTurn) state.combat_detail.turn++;
            } else if (["use_potion", "discard_potion"].includes(action.action)) {
              state.potions[action.potion_slot - 1] = { id: "Potion Slot" };
            } else if (action.action === "choose") {
              const selected = state.screen_state.cards?.[action.choice_index - 1]
                ?? state.screen_state.hand?.[action.choice_index - 1];
              assert.ok(selected);
              if (state.screen_type === "HAND_SELECT") state.screen_state.selected.push(selected);
              else state.screen_state.selected_cards.push(selected);
              state.can_proceed = true;
            } else { state.screen_type = "MAP"; state.room_phase = "COMPLETE"; }
          }
          if (sent.length === completeAt) {
            state.room_phase = "COMPLETE"; state.screen_type = completionScreen; state.can_proceed = true;
            if (completionScreen === "GAME_OVER") state.current_hp = 0;
            delete state.combat_detail; delete state.monsters;
            if (completionHand === "omit") delete state.hand;
            else if (completionHand === "null") state.hand = null;
            else if (completionHand === "retained") state.hand = beforeHand;
          }
          if (noise) { state.combat_detail.player.block++; state.can_proceed = true; }
          if (failing) {
            if (fault === "drop") { res.destroy(); return; }
            if (fault === "hang") return;
            if (fault === "malformed") { res.writeHead(200); res.end("broken JSON"); return; }
            if (fault === "missing") { res.writeHead(200); res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id })); return; }
            if (fault === "empty") { value = {}; }
            else if (fault === "http500") { res.writeHead(500); res.end("Action may already have executed"); return; }
            else if (fault === "rpcerror") {
              res.writeHead(200); res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id,
                error: { code: -32603, message: "Failure after side effects" } })); return;
            } else value = result("OK");
          } else value = result("OK");
        }
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: value }));
  } catch (error) { res.writeHead(500); res.end(String(error.stack)); }
});
server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const child = spawn(process.execPath, [fileURLToPath(new URL("./server.mjs", import.meta.url))], {
  env: { ...process.env, STS_MCP_URL: `http://127.0.0.1:${server.address().port}/mcp`,
    STS_POLL_MS: "5", STS_SETTLE_MS: "0", STS_VISUAL_SETTLE_MS: "0" },
  stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
});
const pending = new Map(); let nextId = 1, stderr = "";
child.stderr.on("data", (chunk) => { stderr += chunk; });
const lines = readline.createInterface({ input: child.stdout });
lines.on("line", (line) => {
  const response = JSON.parse(line), entry = pending.get(response.id);
  if (!entry) return;
  clearTimeout(entry.timer); pending.delete(response.id); entry.resolve(response);
});
async function call(name, args = {}) {
  const id = nextId++;
  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`RPC timeout ${name}: ${stderr}`)), 6000);
    pending.set(id, { timer, resolve });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call",
      params: { name, arguments: args } })}\n`);
  });
  assert.equal(response.error, undefined); assert.equal(response.result.isError, undefined, JSON.stringify(response));
  return JSON.parse(response.result.content[0].text);
}
const play = { action: "play_card", card_name: "Guard" };
const end = { action: "end_turn" };
const act = (action, extra = {}) => call("act", { ...action, timeout_ms: 1000, ...extra });
const batch = (actions, extra = {}) => call("act_many", { actions, timeout_ms: 1000, ...extra });
async function fresh() { reset(); await call("get_state"); }
function unknown(receipt, count, status = "outcome_unknown") {
  assert.equal(receipt.result.failed_action_status, status);
  assert.notEqual(receipt.result.execution_certainty, "not_sent");
  assert.equal(sent.length, count, "uncertain actions must not retry or execute later batch steps");
}
try {
  // Initialization failure and local validation happen before mutation dispatch.
  const notInitialized = await act(play);
  assert.equal(notInitialized.result.failed_action_status, "not_executed"); assert.equal(sent.length, 0);
  await fresh();
  const invalid = await act({ action: "use_potion" });
  assert.equal(invalid.result.execution_certainty, "not_sent"); assert.equal(sent.length, 0);

  for (const kind of ["drop", "malformed", "missing", "empty", "http500", "rpcerror", "reject"]) {
    await fresh(); faultAt = 1; fault = kind;
    const failed = await batch([play, end]); unknown(failed, 1);
    assert.equal(failed.result.execution_certainty, "sent_unknown");
    assert.equal(state.hand.length, kind === "reject" ? 3 : 2);
    await call("get_state"); assert.equal(sent.length, 1);
  }
  await fresh(); faultAt = 2;
  const partial = await batch([play, play, end]); unknown(partial, 2);
  assert.equal(partial.result.completed_actions, 1); assert.equal(state.hand.length, 1);

  await fresh(); faultAt = 1; fault = "hang";
  const started = Date.now(); unknown(await batch([play, end]), 1, "timeout_unknown");
  assert.ok(Date.now() - started < 2500, "HTTP timeout must be bounded, not just settlement polling");
  await fresh(); hangReads = true;
  const verificationStarted = Date.now();
  const stalledRead = await batch([play, end]); unknown(stalledRead, 1, "timeout_unknown");
  assert.equal(stalledRead.result.execution_certainty, "accepted");
  assert.ok(Date.now() - verificationStarted < 2500, "verification reads must share the per-action deadline");

  // Unrelated mutations and legacy wait=false cannot bypass postconditions.
  await fresh(); mutate = false; noise = true;
  unknown(await batch([play, end], { wait: false }), 1, "timeout_unknown");
  assert.equal(state.hand.length, 3);
  await fresh(); mutate = false; noise = true;
  unknown(await act({ action: "use_potion", potion_slot: 1 }, { visual_wait: false }), 1, "timeout_unknown");

  // Terminal combat frames omit the hand after a lethal. Completion stops the
  // verifier promptly without claiming that the exact UUID play was verified.
  for (const screen of ["COMPLETE", "COMBAT_REWARD", "GAME_OVER"]) {
    for (const hand of ["omit", "null", "retained"]) {
      await fresh(); completeAt = 1; completionScreen = screen; completionHand = hand;
      const beforeReads = screenReads;
      const receipt = await act(play);
      assert.equal(receipt.result.reason, "COMBAT_COMPLETED");
      assert.equal(receipt.result.combat_completed, true);
      assert.equal(receipt.result.settlement, "combat_completed");
      assert.equal(receipt.result.execution_certainty, "accepted");
      assert.equal(receipt.result.action_status, "outcome_unknown");
      assert.equal(receipt.result.completed_actions, 0);
      assert.equal(receipt.result.unverified_action.card, "Guard");
      assert.equal(receipt.result.error_kind, undefined);
      assert.equal(receipt.changes.screen, screen);
      assert.equal(sent.length, 1);
      assert.equal(screenReads - beforeReads, 2, "only preflight and one terminal poll, not a timeout loop");
    }
  }
  await fresh(); completeAt = 2;
  const endedBatch = await batch([play, play, { action: "proceed" }, end]);
  assert.equal(endedBatch.result.action_status, "outcome_unknown");
  assert.equal(endedBatch.result.completed_actions, 1, "unverified terminal action is not counted as completed");
  assert.equal(endedBatch.result.completed.length, 1);
  assert.deepEqual(endedBatch.result.remaining_actions.map((item) => item.action), ["proceed", "end_turn"]);
  assert.equal(sent.length, 2, "terminal batch never continues or retries");
  await call("get_state"); assert.equal(sent.length, 2);

  // When exact-card evidence survives, keep verification but halt even
  // untargeted cards / navigation / end-turn steps at the combat boundary.
  await fresh(); completeAt = 1; completionHand = "remaining";
  const provedEnd = await batch([play, play, { action: "proceed" }, end]);
  assert.equal(provedEnd.result.settlement, "verified");
  assert.equal(provedEnd.result.execution_certainty, "verified");
  assert.equal(provedEnd.result.reason, "COMBAT_COMPLETED");
  assert.equal(provedEnd.result.completed_actions, 1);
  assert.equal(provedEnd.result.remaining_actions.length, 3); assert.equal(sent.length, 1);
  await fresh(); completeAt = 1;
  const endedTurn = await batch([end, { action: "proceed" }]);
  assert.equal(endedTurn.result.execution_certainty, "verified");
  assert.equal(endedTurn.result.reason, "COMBAT_COMPLETED"); assert.equal(sent.length, 1);

  // A lost mutation response remains transport-unknown even if combat ended;
  // observing terminal state is never an excuse to replay or claim verification.
  await fresh(); completeAt = 1; faultAt = 1;
  const lostLethal = await batch([play, { action: "proceed" }]); unknown(lostLethal, 1);
  assert.equal(lostLethal.result.execution_certainty, "sent_unknown");
  assert.equal(lostLethal.changes.screen, "COMPLETE");
  await call("get_state"); assert.equal(sent.length, 1);

  // Pending end-turn fences survive duplicate attempts, read errors/reconnects,
  // missing/backward turn metadata, and both public action paths.
  await fresh(); holdTurn = true; faultAt = 1;
  unknown(await act(end), 1);
  for (const invoke of [() => batch([end]), () => act(end), () => batch([end])]) {
    const blocked = await invoke(); assert.equal(blocked.result.failed_action_status, "not_executed");
    assert.match(blocked.result.error, /duplicate end_turn/); assert.equal(sent.length, 1);
  }
  readFailures = 1; await call("get_state");
  assert.match((await act(end)).result.error, /duplicate end_turn/); assert.equal(sent.length, 1);
  state.combat_detail.turn = 0; await call("get_state");
  assert.match((await act(end)).result.error, /duplicate end_turn/); assert.equal(sent.length, 1);
  state.combat_detail.turn = 2; holdTurn = false; faultAt = 0;
  const advanced = await act(end); assert.equal(advanced.result.execution_certainty, "verified");
  assert.equal(sent.length, 2); assert.equal(state.combat_detail.turn, 3);

  await fresh(); holdTurn = true;
  unknown(await act(end, { wait: false }), 1, "timeout_unknown");
  assert.match((await batch([end])).result.error, /duplicate end_turn/); assert.equal(sent.length, 1);
  state.room_phase = "COMPLETE"; state.screen_type = "MAP";
  await call("get_state"); state.room_phase = "COMBAT"; state.screen_type = "NONE"; holdTurn = false;
  assert.equal((await act(end)).result.execution_certainty, "verified");

  // Successful loss of an end-turn response requires observation, not replay.
  await fresh(); faultAt = 1;
  unknown(await batch([end, play]), 1);
  assert.equal(state.combat_detail.turn, 2);
  faultAt = 0; assert.equal((await act(end)).result.execution_certainty, "verified");
  assert.equal(state.combat_detail.turn, 3); assert.equal(sent.length, 2);

  // Specific success evidence for both potion actions and both choice screens.
  for (const action of ["use_potion", "discard_potion"]) {
    await fresh(); const success = await act({ action, potion_slot: 1 }, { wait: false });
    assert.equal(success.result.execution_certainty, "verified"); assert.equal(state.potions[0].id, "Potion Slot");
  }
  for (const screen of ["GRID", "HAND_SELECT"]) {
    await fresh(); state.screen_type = screen; state.choice_list = ["Guard", "Guard"];
    state.screen_state = { cards: state.hand.slice(0, 2), hand: state.hand.slice(0, 2), selected: [], selected_cards: [] };
    assert.equal((await act({ action: "choose", choice_uuid: "a" })).result.execution_certainty, "verified");
    await fresh(); state.screen_type = screen; state.choice_list = ["Guard", "Guard"];
    state.screen_state = { cards: state.hand.slice(0, 2), hand: state.hand.slice(0, 2), selected: [], selected_cards: [] };
    mutate = false; noise = true;
    unknown(await batch([{ action: "choose", choice_uuid: "a" }, end]), 1, "timeout_unknown");
  }
  await fresh(); assert.equal((await act({ action: "proceed" }, { visual_wait: false })).result.execution_certainty, "verified");
  await fresh(); mutate = false; noise = true;
  // Neither a block mutation nor an enemy intent change proves a potion use.
  state.monsters[0].intent = "BUFF";
  unknown(await batch([{ action: "discard_potion", potion_slot: 1 }, end]), 1, "timeout_unknown");

  // Local tracked counts are uncertain after a sent unknown card. A supplied
  // authoritative count takes precedence; current upstream does not supply it.
  await fresh(); faultAt = 1; await act(play);
  state.hand.push({ id: "Normality", name: "Normality", uuid: "normality", cost: -2 });
  const unsafeCount = await act(play);
  assert.equal(unsafeCount.result.failed_action_status, "not_executed");
  assert.match(unsafeCount.result.error, /tracked count is uncertain/); assert.equal(sent.length, 1);
  readFailures = 1; await call("get_state");
  assert.match((await act(play)).result.error, /tracked count is uncertain/); assert.equal(sent.length, 1);
  state.combat_detail.cards_played_this_turn = 3;
  assert.match((await act(play)).result.error, /authoritative/); assert.equal(sent.length, 1);
  state.combat_detail.cards_played_this_turn = 1; faultAt = 0;
  assert.equal((await act(play)).result.execution_certainty, "verified"); assert.equal(sent.length, 2);
  console.log("Execution-certainty tests passed: not-sent vs lost/malformed/error responses, transport deadline, no retry/continuation, terminal combat accounting, persistent end-turn fences, action-specific evidence, wait=false verification and uncertain/authoritative card counts.");
} finally {
  for (const entry of pending.values()) clearTimeout(entry.timer);
  child.stdin.end(); child.kill(); lines.close();
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
}
