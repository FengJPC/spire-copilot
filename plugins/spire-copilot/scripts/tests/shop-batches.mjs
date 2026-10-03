import assert from "node:assert/strict";
import { createRuntime } from "../runtime/index.mjs";

const card = (id, price, name = id) => ({ id, name, price, uuid: `uuid-${id}`, cost: 1, type: "ATTACK" });
function harness({ gold = 100, cards = [card("Expensive", 150), card("SteamBarrier", 30), card("Barrage", 60)],
  afterBuy, loseReplyAt, noEffect = false, unfiltered = false } = {}) {
  const runtime = createRuntime({ env: {}, config: { pollMs: 1, settleMs: 0, visualSettleMs: 0 } });
  const game = { in_game: true, ready_for_command: true, floor: 3, room_phase: "COMPLETE",
    screen_type: "SHOP_SCREEN", room_type: "ShopRoom", gold,
    screen_state: { cards: structuredClone(cards), relics: [{ id: "R", name: "Relic", price: 20 }],
      potions: [{ id: "P", name: "Potion", price: 10 }], purge_available: true, purge_cost: 75 },
    run_detail: { deck: [], relics: [], potions: [{ id: "Potion Slot", is_empty: true }] } };
  let reads = 0;
  const sent = [];
  function options() {
    if (game.screen_type !== "SHOP_SCREEN") return [];
    return [
      ...(game.screen_state.purge_available && game.gold >= game.screen_state.purge_cost
        ? [{ kind: "purge", text: `purge (${game.screen_state.purge_cost} gold)` }] : []),
      ...game.screen_state.cards.filter((item) => unfiltered || item.price <= game.gold).map((item) => ({ kind: "card", item,
        text: `[${item.name}] Cost: ${item.cost} ${item.type}${item.price ? ` (${item.price} gold)` : ""}` })),
      ...game.screen_state.relics.filter((item) => item.price <= game.gold).map((item) => ({ kind: "relic", item,
        text: `relic: [${item.name}] description(${item.price} gold)` })),
      ...game.screen_state.potions.filter((item) => item.price <= game.gold).map((item) => ({ kind: "potion", item,
        text: `add potion: [${item.name}] description(${item.price} gold)` })),
    ];
  }
  const snapshot = () => structuredClone({ ...game, choice_list: options().map((entry) => entry.text) });
  runtime.modules.state.decisionState = async () => { reads++; return snapshot(); };
  runtime.modules.transport.validateToolCall = async (name, args) => {
    assert.equal(name, "choose");
    assert.deepEqual(Object.keys(args), ["choice_index"], "private bindings and stale UUIDs never reach the game");
  };
  runtime.modules.transport.rawTool = async (name, args, { execution }) => {
    assert.equal(name, "choose");
    execution.certainty = "sent_unknown";
    const entry = options()[args.choice_index - 1];
    assert.ok(entry);
    if (sent.length) assert.ok(reads > sent.at(-1).reads, "settled read between purchase dispatches");
    sent.push({ id: entry.item?.id, kind: entry.kind, index: args.choice_index, reads });
    if (!noEffect) {
      if (entry.kind === "purge") {
        game.screen_type = "GRID";
        game.screen_state = { cards: [card("Strike", 0)] };
      } else {
        game.gold -= entry.item.price;
        const list = { card: "cards", relic: "relics", potion: "potions" }[entry.kind];
        game.screen_state[list] = game.screen_state[list].filter((item) => item !== entry.item);
        const runList = { card: "deck", relic: "relics", potion: "potions" }[entry.kind];
        if (entry.kind === "potion") game.run_detail.potions[0] = { id: entry.item.id, name: entry.item.name };
        else game.run_detail[runList].push({ ...entry.item });
      }
      afterBuy?.(game, sent.length);
    }
    if (sent.length === loseReplyAt) throw new Error("Connection reset after game execution");
    execution.certainty = "accepted";
    return { message: "OK" };
  };
  const call = async (name, args) => {
    const response = await runtime.handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name, arguments: args } });
    assert.equal(response.result.isError, undefined);
    return JSON.parse(response.result.content[0].text);
  };
  const buy = (text) => ({ action: "choose", choice_text: text });
  const batch = (texts, extra = {}) => call("act_many", { actions: texts.map(buy), visual_wait: false, ...extra });
  return { runtime, game, sent, snapshot, call, batch, buy };
}

// Public MCP batch: buying one item removes purge/other unaffordable choices,
// so the second item's numeric index changes. Its identity must not change.
const success = harness();
const bought = await success.batch(["Barrage", "SteamBarrier"]);
assert.equal(bought.result.completed, 2);
assert.equal(bought.result.execution_certainty, "verified");
assert.deepEqual(success.sent.map((entry) => [entry.id, entry.index]), [["Barrage", 3], ["SteamBarrier", 1]]);
assert.deepEqual(bought.result.purchases.map((item) => item.choice_uuid), ["uuid-Barrage", "uuid-SteamBarrier"]);
assert.deepEqual(bought.result.purchases.map((item) => item.price), [60, 30]);
assert.equal(success.game.gold, 10);
assert.deepEqual(bought.run_context.deck.map((item) => item.id), ["Barrage", "SteamBarrier"]);

// Mixed non-card items do not borrow the card UUID at the same position.
const mixed = harness();
const items = await mixed.batch(["relic: [Relic]", "add potion: [Potion]"]);
assert.deepEqual(items.result.purchases.map((item) => item.kind), ["relic", "potion"]);
assert.deepEqual(items.result.purchases.map((item) => item.item_id), ["R", "P"]);
assert.ok(items.result.purchases.every((item) => !Object.hasOwn(item, "choice_uuid")));
assert.equal(items.result.completed, 2);
const free = harness({ cards: [card("Expensive", 150), card("Free", 0)] });
const zero = await free.call("act", { ...free.buy("Free"), choice_uuid: "wrong-client-uuid", visual_wait: false });
assert.equal(zero.result.choice_uuid, "uuid-Free");
assert.equal(zero.result.price, 0);

const scenarios = [
  { name: "price change", afterBuy: (game) => { game.screen_state.cards.find((item) => item.id === "SteamBarrier").price++; } },
  { name: "identity change", afterBuy: (game) => { game.screen_state.cards.find((item) => item.id === "SteamBarrier").uuid = "replacement"; } },
  { name: "missing item", afterBuy: (game) => { game.screen_state.cards = game.screen_state.cards.filter((item) => item.id !== "SteamBarrier"); } },
  { name: "insufficient funds", cards: [card("Expensive", 150), card("SteamBarrier", 40), card("Barrage", 80)] },
];
for (const scenario of scenarios) {
  const test = harness(scenario);
  const result = await test.batch(["Barrage", "SteamBarrier"]);
  assert.equal(result.result.halted, true, scenario.name);
  assert.equal(result.result.completed_actions, 1, scenario.name);
  assert.equal(result.result.failed_action_status, "not_executed", scenario.name);
  assert.equal(test.sent.length, 1, scenario.name);
  assert.deepEqual(result.result.purchases.map((item) => item.card_id), ["Barrage"]);
}
const ambiguous = harness({ cards: [card("A", 10, "Twin"), card("B", 10, "Twin")] });
const rejected = await ambiguous.batch(["Twin"]);
assert.equal(rejected.result.completed_actions, 0);
assert.equal(rejected.result.failed_action_status, "not_executed");
assert.equal(ambiguous.sent.length, 0);
const tooExpensive = harness({ gold: 20, cards: [card("Barrage", 60)], unfiltered: true });
const blockedSpend = await tooExpensive.batch(["Barrage"]);
assert.equal(blockedSpend.result.failed_action_status, "not_executed");
assert.equal(tooExpensive.sent.length, 0, "unfiltered Mod choices do not bypass the live gold check");
const indexed = harness();
const stale = await indexed.call("act_many", { actions: [{ action: "choose", choice_index: 3 }] });
assert.equal(stale.result.failed_action_status, "not_executed");
assert.equal(indexed.sent.length, 0);

// A purchase can open a new decision screen, e.g. a reward from a relic.
const screen = harness({ afterBuy: (game) => {
  game.screen_type = "GRID"; game.screen_state = { cards: [card("NewDecision", 0)] };
} });
const boundary = await screen.batch(["Barrage", "SteamBarrier"]);
assert.equal(boundary.halted, true);
assert.equal(boundary.completed_actions, 1);
assert.equal(screen.sent.length, 1);
assert.deepEqual(boundary.state.result.purchases.map((item) => item.card_id), ["Barrage"]);
const purge = harness();
const remove = await purge.batch(["purge", "Barrage"]);
assert.equal(remove.halted, true);
assert.equal(remove.completed_actions, 1);
assert.equal(purge.sent.length, 1);
assert.equal(remove.state.result.purchases, undefined, "opening removal is not a completed purchase/removal");

// Response loss after the second purchase leaves only one verified purchase.
// Both effects may be visible in run state; neither action is blindly replayed.
const lost = harness({ loseReplyAt: 2 });
const unknown = await lost.batch(["Barrage", "SteamBarrier", "add potion: [Potion]"]);
assert.equal(unknown.result.failed_action_status, "outcome_unknown");
assert.equal(unknown.result.completed_actions, 1);
assert.deepEqual(unknown.result.purchases.map((item) => item.card_id), ["Barrage"]);
assert.equal(lost.sent.length, 2);
assert.deepEqual(lost.game.run_detail.deck.map((item) => item.id), ["Barrage", "SteamBarrier"]);
assert.equal(unknown.result.remaining_actions.length, 1);
assert.equal(Object.hasOwn(unknown.result.remaining_actions[0], "_shop_choice"), false);
const stalled = harness({ noEffect: true });
const timeout = await stalled.batch(["Barrage", "SteamBarrier"], { timeout_ms: 1000 });
assert.equal(timeout.result.failed_action_status, "timeout_unknown");
assert.equal(timeout.result.completed_actions, 0);
assert.equal(timeout.result.purchases, undefined);
assert.equal(stalled.sent.length, 1, "accepted without effect cannot continue or retry");

// A known item's disappearance from affordable choices is not purchase proof,
// and removing a different stock card cannot prove the selected purchase.
const proof = harness();
const before = proof.snapshot();
const choose = { action: "choose", choice_index: 3 };
const evidence = proof.runtime.modules.settlement.actionSettlementEvidence;
const unaffordable = structuredClone(before);
unaffordable.gold = 0; unaffordable.choice_list = [];
assert.equal(evidence(choose, before, unaffordable), undefined);
const wrong = structuredClone(unaffordable);
wrong.screen_state.cards = wrong.screen_state.cards.filter((item) => item.id !== "Barrage");
assert.equal(evidence({ action: "choose", choice_index: 2 }, before, wrong), undefined,
  "removed Barrage must not verify choosing SteamBarrier");
const unmatched = structuredClone(before);
unmatched.choice_list = ["[Mystery] Cost: 1 ATTACK (10 gold)"];
assert.equal(proof.runtime.modules.compaction.choiceCardForAction(unmatched, { choice_index: 1 }), undefined);
assert.equal(proof.runtime.modules.compaction.shopChoiceForAction(unmatched, { choice_index: 1 }).choice_uuid, undefined);
console.log("Shop batch tests passed: bound identities/prices, fresh indices, per-item verification, partial receipts and no uncertain replay.");
