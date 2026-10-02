#!/usr/bin/env node
// Exercise the real stdio -> HTTP -> settlement path without a running game.
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const uuid = (i) => `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`;
const body = (i, cost = 0) => ({ id: "EmptyBody", name: "化体为空", uuid: uuid(i),
  type: "SKILL", cost, block: 7, is_playable: true });
const strike = (i) => ({ id: "Strike_P", name: "打击", uuid: uuid(i),
  type: "ATTACK", cost: 0, damage: 6, has_target: true });
let state, sent, failAction, noEffect, changeTurn;
function reset(hand) {
  sent = []; failAction = false; noEffect = false; changeTurn = false;
  state = { in_game: true, ready_for_command: true, floor: 50,
    room_type: "MonsterRoomBoss", room_phase: "COMBAT", screen_type: "NONE",
    current_energy: 3, max_energy: 3, current_hp: 74, max_hp: 74, hand,
    combat_detail: { turn: 1, draw_count: 0, discard_count: 0, exhaust_count: 0, player: { block: 0 } },
    monsters: [{ id: "Boss", name: "Boss", current_hp: 320, max_hp: 320,
      is_gone: false, intent: "ATTACK", move: { damage: 22, hits: 1 }, powers: [] }] };
}
reset([]);
const result = (value, isError = false) => ({ content: [{ type: "text",
  text: typeof value === "string" ? value : JSON.stringify(value) }], ...(isError ? { isError: true } : {}) });
const server = http.createServer(async (req, res) => {
  try {
    let bytes = "";
    for await (const chunk of req) bytes += chunk;
    const message = JSON.parse(bytes);
    let value = {};
    if (message.method === "tools/list") value = { tools: [
      { name: "execute_actions", inputSchema: { properties: { actions: { type: "array" } }, required: ["actions"] } },
      { name: "end_turn", inputSchema: { properties: {} } },
    ] };
    if (message.method === "tools/call") {
      const { name, arguments: args = {} } = message.params;
      if (name === "get_screen_state") value = result(state);
      else if (name === "get_game_state") value = result({ game_state: null });
      else if (name === "get_card_info") value = result({ cards: [] });
      else if (name === "execute_actions") {
        assert.equal(args.actions.length, 1, "Copilot must settle one backend action at a time");
        const action = args.actions[0];
        assert.equal(action.action, "play_card");
        assert.ok(action.card_uuid, "game-thread selection must use UUID");
        assert.equal(action.card_index, undefined, "do not leak a shifting position to the game thread");
        sent.push(action);
        if (failAction) value = result("Error at action 1: cannot play", true);
        else {
          const index = state.hand.findIndex((card) => card.uuid === action.card_uuid);
          assert.ok(index >= 0);
          const card = state.hand[index];
          assert.ok(card.cost <= state.current_energy);
          if (!noEffect) {
            state.hand.splice(index, 1);
            state.current_energy -= card.cost;
            state.combat_detail.discard_count++;
            if (card.block) state.combat_detail.player.block += card.block;
            if (changeTurn) state.combat_detail.turn++;
          }
          value = result("OK");
        }
      } else if (name === "end_turn") {
        sent.push({ action: "end_turn" }); state.combat_detail.turn++; value = result("OK");
      } else throw new Error(`Unexpected tool ${name}`);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: value }));
  } catch (error) {
    res.writeHead(500); res.end(String(error.stack));
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const child = spawn(process.execPath, [fileURLToPath(new URL("./server.mjs", import.meta.url))], {
  env: { ...process.env, STS_MCP_URL: `http://127.0.0.1:${server.address().port}/mcp`,
    STS_POLL_MS: "5", STS_SETTLE_MS: "0", STS_VISUAL_SETTLE_MS: "0" },
  stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
});
let nextId = 1, errors = "";
const pending = new Map();
child.stderr.on("data", (chunk) => { errors += chunk; });
const lines = readline.createInterface({ input: child.stdout });
lines.on("line", (line) => {
  const response = JSON.parse(line), entry = pending.get(response.id);
  if (!entry) return;
  clearTimeout(entry.timer); pending.delete(response.id); entry.resolve(response);
});
async function call(name, args = {}) {
  const id = nextId++;
  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`RPC timeout: ${name}; ${errors}`)), 5000);
    pending.set(id, { resolve, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call",
      params: { name, arguments: args } })}\n`);
  });
  assert.equal(response.error, undefined);
  assert.equal(response.result.isError, undefined, JSON.stringify(response));
  return JSON.parse(response.result.content[0].text);
}
try {
  reset([body(1, 3), body(2, 0)]); state.current_energy = 1;
  const initial = await call("get_state");
  assert.notEqual(initial.hand[0].k, initial.hand[1].k);
  const cheap = await call("act", { action: "play_card", card_name: "化体为空" });
  assert.equal(sent[0].card_uuid, uuid(2)); assert.equal(cheap.result.cost, 0);
  assert.equal(cheap.changes.hand.removed[0].k, initial.hand[1].k);

  reset([body(1), strike(3), body(2)]);
  await call("get_state");
  const batch = await call("act_many", { actions: [
    { action: "play_card", card_index: 1 }, { action: "play_card", card_index: 3 },
  ] });
  assert.equal(batch.result.completed, 2);
  assert.deepEqual(sent.map((action) => action.card_uuid), [uuid(1), uuid(2)]);
  assert.deepEqual(state.hand.map((card) => card.uuid), [uuid(3)]);

  reset([body(1), strike(3), body(2)]);
  const beforeReorder = await call("get_state");
  state.hand.reverse();
  await call("act", { action: "play_card", card_index: 3 });
  assert.equal(sent[0].card_uuid, uuid(2));
  const reordered = await call("act", { action: "play_card", card: beforeReorder.hand[0].k });
  assert.equal(sent[1].card_uuid, uuid(1)); assert.equal(reordered.result.k, beforeReorder.hand[0].k);

  reset([body(1), body(2)]);
  const costView = await call("get_state"); state.hand[1].cost = 2;
  const increased = await call("act", { action: "play_card", card: costView.hand[1].k });
  assert.equal(increased.result.failed_action_status, "not_executed"); assert.equal(sent.length, 0);
  assert.match(increased.result.error, /cost increased/);

  reset([body(1), body(2)]);
  const goneView = await call("get_state"); state.hand.pop();
  const gone = await call("act", { action: "play_card", card: goneView.hand[1].k });
  assert.equal(gone.result.failed_action_status, "not_executed"); assert.equal(sent.length, 0);

  reset([body(1), body(2)]); await call("get_state");
  const repeated = await call("act_many", { actions: [
    { action: "play_card", card_index: 1 }, { action: "play_card", card_index: 1 }, { action: "end_turn" },
  ] });
  assert.equal(repeated.result.completed_actions, 1);
  assert.equal(repeated.result.failed_action_status, "not_executed"); assert.equal(sent.length, 1);

  reset([body(1)]); const failedView = await call("get_state"); failAction = true;
  const failed = await call("act_many", { actions: [
    { action: "play_card", card: failedView.hand[0].k }, { action: "end_turn" },
  ] });
  assert.equal(failed.result.failed_action_status, "not_executed"); assert.equal(sent.length, 1);
  assert.equal(state.combat_detail.turn, 1);

  reset([body(1)]); await call("get_state"); noEffect = true;
  const uncertain = await call("act", { action: "play_card", card_name: "化体为空", timeout_ms: 1000 });
  assert.equal(uncertain.result.failed_action_status, "timeout_unknown"); assert.equal(sent.length, 1);

  reset([body(1), body(2)]); await call("get_state"); changeTurn = true;
  const newTurn = await call("act_many", { actions: [
    { action: "play_card", card_index: 1 }, { action: "play_card", card_index: 2 },
  ] });
  assert.equal(newTurn.halted, true); assert.equal(sent.length, 1);
  console.log("Integration tests passed: cheapest copy, exact handles, observed indices, reorders, cost/gone guards, partial failure, no auto-end/retry, timeout and turn change.");
} finally {
  for (const entry of pending.values()) clearTimeout(entry.timer);
  child.stdin.end(); child.kill(); lines.close();
  await new Promise((resolve) => server.close(resolve));
}
