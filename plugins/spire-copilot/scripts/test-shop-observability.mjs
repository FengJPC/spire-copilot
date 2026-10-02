#!/usr/bin/env node
// Real stdio/HTTP integration against an isolated shop and Watcher combat.
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const card = (id, name, price) => ({ id, name, price, uuid: `uuid-${id}`,
  cost: 0, type: "ATTACK", is_playable: true });
let state = { in_game: true, ready_for_command: true, floor: 4, room_phase: "COMPLETE",
  screen_type: "SHOP_SCREEN", room_type: "ShopRoom", gold: 100, current_hp: 50, max_hp: 50,
  screen_state: { cards: [card("ReachHeaven", "通天", 150), card("Affordable", "迂回", 87), card("Free", "免费", 0)],
    relics: [{ id: "Relic", name: "遗物", price: 50 }],
    potions: [{ id: "StorePotion", name: "商店药水", price: 40 }], purge_available: true, purge_cost: 75 } };
let inventory = [{ id: "P", name: "同名药水", can_discard: true },
  { id: "P", name: "同名药水", can_discard: true }, { id: "Potion Slot", name: "空槽", is_empty: true }];
const sent = [];
function availableShopItems() {
  const details = state.screen_state;
  return [
    ...(details.purge_available && state.gold >= details.purge_cost
      ? [{ kind: "purge", text: `purge (${details.purge_cost} gold)` }] : []),
    ...details.cards.filter((item) => item.price <= state.gold).map((item) => ({ kind: "card", item,
      text: `[${item.name}] Cost: ${item.cost} ${item.type}${item.price ? ` (${item.price} gold)` : ""}` })),
    ...details.relics.filter((item) => item.price <= state.gold).map((item) => ({ kind: "relic", item,
      text: `relic: [${item.name}] description(${item.price} gold)` })),
    ...details.potions.filter((item) => item.price <= state.gold).map((item) => ({ kind: "potion", item,
      text: `add potion: [${item.name}] description(${item.price} gold)` })),
  ];
}
function snapshot() {
  return { ...state, ...(state.screen_type === "SHOP_SCREEN"
    ? { choice_list: availableShopItems().map((entry) => entry.text) } : {}) };
}
const result = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const properties = { choose: { choice_index: { type: "integer" } },
  discard_potion: { potion_slot: { type: "integer" } }, execute_actions: { actions: { type: "array" } } };
const sockets = new Set();
const server = http.createServer(async (req, res) => {
  try {
    let bytes = "";
    for await (const chunk of req) bytes += chunk;
    const message = JSON.parse(bytes);
    let value = {};
    if (message.method === "tools/list") value = { tools: Object.entries(properties).map(([name, props]) => ({
      name, inputSchema: { properties: props, required: Object.keys(props) },
    })) };
    if (message.method === "tools/call") {
      const { name, arguments: args = {} } = message.params;
      if (name === "get_screen_state") value = result(snapshot());
      else if (name === "get_game_state") value = result({ game_state: {
        class: "WATCHER", act: 1, deck: [], relics: [], potions: inventory,
        ...(state.room_phase === "COMBAT" ? { combat_state: { ...state.combat_detail,
          hand: state.hand, monsters: state.monsters, draw_pile: [], discard_pile: [], exhaust_pile: [] } } : {}),
      } });
      else if (name === "get_card_info") value = result({ cards: [
        { id: "Eruption", name: "暴怒", cost: 0, type: "ATTACK", has_target: true },
        { id: "EmptyBody", name: "化体为空", cost: 1, type: "SKILL" },
      ].filter((item) => args.card_ids.includes(item.id)) });
      else if (name === "discard_potion") {
        sent.push({ action: name, slot: args.potion_slot });
        inventory[args.potion_slot - 1] = { id: "Potion Slot", name: "空槽", is_empty: true };
        value = result("OK");
      } else if (name === "choose") {
        const entry = availableShopItems()[args.choice_index - 1];
        assert.ok(entry?.item, "test purchase must select a current shop item");
        sent.push({ action: name, kind: entry.kind, id: entry.item.id, index: args.choice_index });
        state.gold -= entry.item.price;
        const list = { card: "cards", relic: "relics", potion: "potions" }[entry.kind];
        state.screen_state[list] = state.screen_state[list].filter((item) => item !== entry.item);
        value = result("OK");
      } else if (name === "execute_actions") {
        assert.equal(args.actions.length, 1);
        const action = args.actions[0];
        const selected = state.hand.find((item) => item.uuid === action.card_uuid);
        assert.ok(selected, "must use exact game-thread UUID");
        assert.equal(action.target_index, selected.has_target ? 1 : undefined, "target selection follows the live flag, not type");
        sent.push({ action: "play_card", id: selected.id });
        state.hand = state.hand.filter((item) => item !== selected);
        if (selected.id === "Eruption") { state.combat_detail.player.stance = "Wrath"; state.monsters[0].move.damage = 76; }
        if (selected.id === "EmptyBody") { delete state.combat_detail.player.stance; state.monsters[0].move.damage = 38; }
        value = result("OK");
      } else throw new Error(`Unexpected call ${name}`);
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
let nextId = 1, stderr = "";
const pending = new Map();
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
    const timer = setTimeout(() => reject(new Error(`RPC timeout ${name}: ${stderr}`)), 5000);
    pending.set(id, { timer, resolve });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call",
      params: { name, arguments: args } })}\n`);
  });
  assert.equal(response.error, undefined);
  assert.equal(response.result.isError, undefined, JSON.stringify(response));
  return JSON.parse(response.result.content[0].text);
}
try {
  const first = await call("get_state");
  assert.ok(first.advisories.some((item) => item.id === "shop-choice"));
  assert.ok(first.advisories.some((item) => item.id === "potion-slots"));
  assert.ok(first.advisories.some((item) => item.id === "card-targeting"));
  assert.equal(first.choices[0].kind, "purge");
  assert.equal(first.choices[0].card_id, undefined);
  assert.equal(first.choices[1].card_id, "Affordable");
  assert.equal(first.choices[1].text.includes("迂回"), true);
  assert.equal(first.details.cards[0].id, "ReachHeaven");
  const reread = await call("get_state");
  assert.equal(reread.advisories, undefined);
  assert.equal(reread.run_context, undefined);
  assert.equal(reread.potions.length, 3);
  assert.equal(reread.potions[2].empty, true);
  const discarded = await call("act", { action: "discard_potion", potion_slot: 2 });
  assert.equal(discarded.result.execution_certainty, "verified");
  assert.deepEqual(discarded.changes.potions.changed.map((entry) => entry.key), [2]);
  assert.equal((await call("get_state")).potions[1].empty, true);
  const numeric = await call("act", { action: "choose", choice_index: 2 });
  assert.equal(numeric.result.failed_action_status, "not_executed", "retain shop reindex guard");
  assert.equal(sent.length, 1);
  const bought = await call("act", { action: "choose", choice_text: first.choices[1].text });
  assert.equal(bought.result.execution_certainty, "verified");
  assert.equal(sent[1].id, "Affordable");
  const afterPurchase = await call("get_state");
  assert.equal(afterPurchase.advisories, undefined);
  assert.equal(afterPurchase.gold, 13);
  assert.equal(afterPurchase.choices.length, 1);
  assert.equal(afterPurchase.choices[0].card_id, "Free");
  assert.equal(afterPurchase.choices[0].i, 1);
  assert.equal(afterPurchase.details.cards[0].id, "ReachHeaven");

  state = { in_game: true, ready_for_command: true, floor: 5, room_phase: "COMBAT",
    screen_type: "NONE", room_type: "MonsterRoom", current_hp: 50, max_hp: 50, current_energy: 3, max_energy: 3,
    hand: [{ ...card("Eruption", "暴怒", 0), has_target: true },
      { ...card("EmptyBody", "化体为空", 0), cost: 3, type: "SKILL", is_playable: false }],
    combat_detail: { turn: 1, player: { block: 0 } },
    monsters: [{ id: "Enemy", name: "Enemy", current_hp: 100, max_hp: 100, intent: "ATTACK", move: { damage: 38 },
      powers: [{ id: "Poison", amount: 2 }] }] };
  const combat = await call("get_state");
  assert.equal(combat.stance, "Neutral");
  assert.equal(combat.enemies[0].atk, 38);
  assert.ok(combat.advisories.some((item) => item.id === "incoming-damage"));
  assert.ok(combat.advisories.some((item) => item.id === "poison-timing"));
  assert.ok(combat.advisories.some((item) => item.id === "live-card-cost"));
  assert.ok(combat.advisories.some((item) => item.id === "hand-playability"));
  assert.equal(combat.hand[1].c, 3);
  assert.equal(combat.hand[0].t, true);
  assert.equal(combat.card_defs["Eruption@0"].target, true);
  assert.equal(combat.hand[1].p, false);
  assert.equal(combat.card_defs["EmptyBody@0"].c, 1);
  const inspected = await call("inspect_card", { card_id: "EmptyBody" });
  assert.equal(inspected.instances.find((item) => item.zone === "hand").playable, false);
  assert.equal(Object.hasOwn(inspected.definition, "playable"), false);
  state.hand[1].cost = 2;
  const costPatch = await call("get_state", { mode: "delta" });
  assert.equal(costPatch.delta.hand.changed[0].c, 2);
  assert.equal(Object.hasOwn(costPatch.delta.hand.changed[0], "p"), false, "wire omission retains blocked marker");
  assert.equal(costPatch.advisories, undefined);
  state.hand[1].is_playable = true;
  const recovered = await call("get_state", { mode: "delta" });
  assert.equal(recovered.delta.hand.changed[0].p, null);
  assert.equal(recovered.advisories, undefined);
  state.hand[1].is_playable = false;
  const blocked = await call("get_state", { mode: "delta" });
  assert.equal(blocked.delta.hand.changed[0].p, false);
  delete state.hand[1].is_playable;
  const unknownFlag = await call("get_state", { mode: "delta" });
  assert.equal(unknownFlag.delta.hand.changed[0].p, null, "missing raw flag clears negative-only marker, not positive proof");
  state.hand[1].is_playable = true;
  state.hand[1].cost = 3;
  const candidate = await call("get_state");
  assert.equal(Object.hasOwn(candidate.hand[1], "p"), false);
  assert.equal(candidate.advisories, undefined);
  assert.equal(sent.length, 2, "inspection and state checks never mutate the isolated game");
  const wrath = await call("act", { action: "play_card", card_name: "暴怒", target_index: 1 });
  assert.equal(wrath.current.stance, "Wrath");
  assert.equal(wrath.changes.stance, "Wrath");
  assert.equal(wrath.changes.enemies.changed[0].atk, 76, "upstream already doubled intent; Copilot must not double twice");
  assert.ok(wrath.advisories.some((item) => item.id === "wrath-incoming"));
  const same = await call("get_state", { mode: "delta" });
  assert.deepEqual(same.delta, {});
  assert.equal(same.current.stance, "Wrath");
  assert.equal(same.advisories, undefined);
  const neutral = await call("act", { action: "play_card", card_name: "化体为空" });
  assert.equal(neutral.current.stance, "Neutral");
  assert.equal(neutral.changes.stance, "Neutral");
  assert.equal(neutral.changes.enemies.changed[0].atk, 38);
  assert.equal(neutral.result.execution_certainty, "verified");
  assert.equal(sent.length, 4);
  console.log("Shop/observability integration passed: affordable-item identity, reindex guards, duplicate potion slots, negative-only playability wire transitions, first-hand hint, and Neutral/Wrath action/delta snapshots.");
} finally {
  for (const entry of pending.values()) clearTimeout(entry.timer);
  child.stdin.end(); child.kill(); lines.close();
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
}
