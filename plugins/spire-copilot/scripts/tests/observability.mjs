import assert from "node:assert/strict";
import { createRuntime } from "../runtime/index.mjs";

const runtime = createRuntime({ env: {} });
const metadata = await runtime.handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "initialize" });
assert.ok(metadata.result.instructions.includes("one by one"));
assert.ok(metadata.result.instructions.includes("current.stance"));
const catalog = await runtime.handleMcpMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" });
assert.ok(catalog.result.tools.find((tool) => tool.name === "act_many").description.includes("before sending"));
const { compactState, compactShopChoices, rememberAndCompact, currentStance } = runtime.modules.compaction;
// Wire shapes are part of the first-action contract. ed is intentionally
// sparse, zero is meaningful, and missing damage must not become numeric zero.
const hit = { id: "Strike", name: "打击", cost: 1, damage: 6, has_target: true };
const plain = { id: "A", current_hp: 20, powers: [] };
const vulnerable = { id: "B", current_hp: 20, powers: [{ id: "Vulnerable", amount: 1 }] };
const asHand = (monsters, overrides = {}) => compactState({ hand: [{ ...hit, ...overrides }], monsters }).hand[0];
const sparse = JSON.parse(JSON.stringify(asHand([plain, vulnerable])));
assert.equal(sparse.d, 6);
assert.deepEqual(sparse.ed, { "2": 9 });
assert.equal(Object.hasOwn(sparse.ed, "1"), false, "unmodified target uses d, not an invented zero");
assert.equal(typeof sparse.ed, "object");
assert.equal(asHand([vulnerable]).ed, 9, "sole enemy uses scalar ed");
assert.equal(asHand([plain, { ...vulnerable, is_gone: true }]).ed, undefined);
const reindexed = asHand([{ ...plain, is_gone: true }, vulnerable]);
assert.equal(reindexed.ed, 9, "remaining sole target no longer uses the old index map");
assert.deepEqual(asHand([{ ...plain, is_gone: true }, plain, vulnerable]).ed, { "2": 9 });
const flying = { ...vulnerable, powers: [{ id: "Flight", amount: 1 }] };
assert.equal(asHand([flying], { damage: 1 }).ed, 0);
assert.deepEqual(asHand([plain, flying], { damage: 1 }).ed, { "2": 0 });
const keyedHand = (monsters) => compactState({ hand: [{ ...hit, uuid: "ed-copy" }], monsters }).hand;
const previousHand = keyedHand([plain, vulnerable]);
const changedTargets = runtime.modules.compaction.handArrayDifference(previousHand, keyedHand([vulnerable, plain]));
assert.deepEqual(changedTargets.changed[0].ed, { "1": 9, "2": null }, "map removal must explicitly clear the old target override");
const cleared = runtime.modules.compaction.handArrayDifference(previousHand, keyedHand([plain, plain]));
assert.equal(cleared.changed[0].ed, null, "clear absent estimate rather than silently keeping stale damage");
const costOnly = runtime.modules.compaction.handArrayDifference(previousHand, [{ ...previousHand[0], c: 0 }]);
assert.equal(Object.hasOwn(costOnly.changed[0], "ed"), false, "patch omission retains the previous estimate");
assert.equal(asHand([plain], { damage: 0 }).d, 0);
assert.equal(asHand([plain], { damage: 0 }).ed, undefined);
for (const damage of [undefined, -1]) {
  const unknown = asHand([plain, vulnerable], { damage });
  assert.equal(Object.hasOwn(unknown, "d"), false);
  assert.equal(Object.hasOwn(unknown, "ed"), false);
}
for (const cost of [-1, -2]) {
  const blocked = asHand([plain], { cost, is_playable: false });
  assert.equal(blocked.c, cost);
  assert.equal(blocked.p, false);
  assert.equal(runtime.modules.cards.playableHandCard({ ...hit, cost, is_playable: false }, { current_energy: 3 }), false);
  // A special effect may permit the negative-cost instance. Preserve the live
  // flag; do not add a blanket cost=-2 rejection or promise that X always plays.
  const allowed = asHand([plain], { cost, is_playable: true });
  assert.equal(allowed.c, cost);
  assert.equal(allowed.p, undefined);
  assert.equal(runtime.modules.cards.playableHandCard({ ...hit, cost, is_playable: true }, { current_energy: 0 }), true);
}
const card = (id, name, price, extra = {}) => ({ id, name, price, uuid: `uuid-${id}`, cost: 0, type: "ATTACK", ...extra });
const shop = { in_game: true, floor: 4, screen_type: "SHOP_SCREEN", room_phase: "COMPLETE", gold: 100,
  choice_list: ["purge (75 gold)", "[迂回] Cost: 0 ATTACK (87 gold)",
    "relic: [迂回] description(50 gold)", "add potion: [迂回] description(40 gold)"],
  screen_state: {
    cards: [card("ReachHeaven", "通天", 150), card("Affordable", "迂回", 87)],
    relics: [{ id: "Relic", name: "迂回", price: 50 }],
    potions: [{ id: "Potion", name: "迂回", price: 40 }], purge_cost: 75, purge_available: true,
  } };
const choices = compactShopChoices(shop);
assert.equal(choices[0].kind, "purge");
assert.equal(choices[1].card_id, "Affordable");
assert.equal(choices[1].ref, "Affordable@0");
assert.equal(choices[1].choice_uuid, "uuid-Affordable");
assert.equal(choices[2].item_id, "Relic");
assert.equal(choices[3].item_id, "Potion");
for (const index of [0, 2, 3]) {
  for (const key of ["card_id", "ref", "choice_uuid", "d", "c"]) assert.equal(choices[index][key], undefined);
}

// Permutations, purchase-driven filtering and removal of purge change indices,
// never the association. Details keep all items, including unaffordable cards.
for (const texts of [shop.choice_list.slice().reverse(), shop.choice_list.slice(1),
  [shop.choice_list[3], shop.choice_list[1]], [shop.choice_list[1]]]) {
  const result = compactShopChoices({ ...shop, choice_list: texts,
    screen_state: { ...shop.screen_state, cards: shop.screen_state.cards.slice().reverse() } });
  result.forEach((entry, index) => {
    assert.equal(entry.i, index + 1);
    const expected = choices.find((choice) => choice.text === entry.text);
    assert.deepEqual({ ...entry, i: expected.i }, expected);
  });
}
assert.equal(compactState(shop).details.cards.length, 2, "preserve the canonical complete shop details");

// Mismatches, collisions, missing details and unrecognized Mod formatting fail
// closed rather than falling back to another array's positional card.
const badShops = [
  { ...shop, screen_state: {} },
  { ...shop, screen_state: { cards: [card("A", "迂回", 88)] } },
  { ...shop, screen_state: { cards: [card("A", "迂回", 87), card("B", "迂回", 87)] } },
  { ...shop, screen_state: { cards: [card("A", "迂回+", 87)] } },
];
for (const snapshot of badShops) {
  const item = compactShopChoices(snapshot)[1];
  for (const key of ["card_id", "ref", "choice_uuid"]) assert.equal(item[key], undefined);
}
const otherText = { ...shop, choice_list: ["Unknown Mod option", "[通天] Cost: 0 ATTACK (87 gold)"] };
assert.ok(compactShopChoices(otherText).every((item) => item.card_id === undefined));
assert.equal(compactShopChoices({ ...shop, choice_list: ["[免费牌] Cost: 0 ATTACK"],
  screen_state: { cards: [card("Free", "免费牌", 0)] } })[0].card_id, "Free");
assert.equal(compactShopChoices({ ...shop, choice_list: ["[迂回] Cost: 0 ATTACK (90 gold)"],
  screen_state: { cards: [card("A", "迂回", 87), card("B", "迂回", 90)] } })[0].card_id, "B");

// Non-shop UUID choices retain the established shape and meaning.
const grid = compactState({ screen_type: "GRID", choice_list: ["迂回"],
  screen_state: { cards: [shop.screen_state.cards[1]] } });
assert.equal(grid.choices[0].card_id, "Affordable");
assert.equal(grid.choices[0].kind, undefined);

const potions = [{ id: "P", name: "同名药水", can_use: true, requires_target: true },
  { id: "P", name: "同名药水", can_discard: true }, { id: "Potion Slot", name: "空槽", is_empty: true }];
const combat = { in_game: true, floor: 5, room_phase: "COMBAT", screen_type: "NONE", hand: [],
  combat_detail: { turn: 1, player: { stance: "Wrath" } }, run_detail: { potions },
  monsters: [{ id: "Enemy", current_hp: 40, move: { damage: 76, hits: 2 } }] };
rememberAndCompact(combat);
const compact = rememberAndCompact(combat);
assert.equal(compact.run_context, undefined);
assert.equal(compact.potions.length, 3, "repeated compact still has all current potion slots");
assert.equal(compact.potions[2].empty, true);
assert.equal(compact.potions[0].can_use, true);
assert.equal(compact.potions[0].requires_target, true);
assert.equal(compact.potions[1].slot, 2);
assert.equal(compact.stance, "Wrath");
assert.equal(compact.enemies[0].atk, "76x2", "never multiply the upstream stance-adjusted intent again");
const unchanged = rememberAndCompact(combat, false, { action: "example" });
assert.deepEqual(unchanged.changes, {});
assert.deepEqual(unchanged.current, { stance: "Wrath" });
assert.deepEqual(rememberAndCompact(combat, true).current, { stance: "Wrath" });

const changed = rememberAndCompact({ ...combat, combat_detail: { turn: 1, player: {} },
  run_detail: { potions: [potions[0], potions[2], potions[2]] } }, false, { action: "example" });
assert.equal(changed.current.stance, "Neutral");
assert.equal(changed.changes.stance, "Neutral");
assert.deepEqual(changed.changes.potions.changed.map((item) => item.key), [2]);
assert.deepEqual(changed.run_delta.potion_changes.changed.map((item) => item.key), [2]);
assert.equal(compactState({ ...combat, run_detail: {} }).potions, null);
assert.deepEqual(compactState({ ...combat, run_detail: { potions: [] } }).potions, []);
assert.equal(currentStance({ ...combat, combat_detail: {} }), null);
assert.equal(currentStance({ ...combat, combat_detail: { player: "malformed" } }), null);
assert.equal(currentStance({ ...combat, combat_detail: { player: { stance: null } } }), null);
assert.equal(currentStance({ ...combat, combat_detail: { player: { stance: "ModStance" } } }), "ModStance");
assert.equal(rememberAndCompact({ ...combat, room_phase: "COMPLETE", combat_detail: undefined },
  false, { action: "example" }).current.stance, null);
assert.equal(compactState({ ...combat, monsters: [{ move: { damage: 0, hits: 3 } }] }).enemies[0].atk, "0x3");

// The damage advisory appears once per combat, including zero-damage intent,
// without changing the existing stance warning or execution guards.
const fresh = createRuntime({ env: {} });
const advisories = fresh.modules.safety.collectContextAdvisories({ ...combat,
  monsters: [{ id: "Enemy", intent: "ATTACK", move: { damage: 0 } }] });
assert.ok(advisories.some((item) => item.id === "incoming-damage"));
assert.ok(advisories.some((item) => item.id === "wrath-incoming"));
assert.equal(fresh.modules.safety.collectContextAdvisories({ ...combat,
  combat_detail: { turn: 2, player: { stance: "Wrath" } } }).filter((item) => item.id === "incoming-damage").length, 0);
assert.equal(fresh.modules.safety.collectContextAdvisories({ ...combat, floor: 6 })
  .filter((item) => item.id === "incoming-damage").length, 1);
// Context pushes must appear when the mechanism first becomes observable,
// even mid-combat; unknown bases and sentinel values must not invent a cause.
const relevant = (items) => items.filter((item) => ["poison-timing", "live-card-cost"].includes(item.id));
const contextual = createRuntime({ env: {} });
const baseState = { ...combat, hand: [], monsters: [{ id: "Enemy", current_hp: 40, powers: [] }],
  combat_detail: { turn: 1, player: {} } };
assert.deepEqual(relevant(contextual.modules.safety.collectContextAdvisories(baseState)), []);
const poisoned = { ...baseState, monsters: [{ id: "Enemy", current_hp: 40,
  powers: [{ id: "Poison", amount: 3 }] }] };
assert.deepEqual(relevant(contextual.modules.safety.collectContextAdvisories(poisoned)).map((item) => item.id), ["poison-timing"]);
assert.deepEqual(relevant(contextual.modules.safety.collectContextAdvisories(poisoned)), []);
assert.deepEqual(relevant(contextual.modules.safety.collectContextAdvisories({ ...poisoned,
  combat_detail: { turn: 2, player: {} } })), [], "timing explanation is not repeated every turn");
assert.equal(relevant(contextual.modules.safety.collectContextAdvisories({ ...poisoned, floor: 6 })).length, 1);
for (const powers of [[{ id: "Poison", amount: 0 }], [{ id: "Poison" }], [{ id: "ModPoison", amount: 5 }]]) {
  assert.deepEqual(relevant(createRuntime({ env: {} }).modules.safety.collectContextAdvisories({ ...baseState,
    monsters: [{ powers }] })), []);
}
assert.deepEqual(relevant(createRuntime({ env: {} }).modules.safety.collectContextAdvisories({ ...poisoned,
  monsters: [{ ...poisoned.monsters[0], is_gone: true }] })), []);
for (const id of ["Noxious Fumes", "毒雾"]) {
  assert.equal(relevant(createRuntime({ env: {} }).modules.safety.collectContextAdvisories({ ...baseState,
    combat_detail: { turn: 1, player: { powers: [{ id, amount: 2 }] } } }))[0].id, "poison-timing");
}
const priced = createRuntime({ env: {} });
const pricedCard = { id: "EmptyMind", name: "清心", cost: 3, uuid: "priced", upgrades: 0 };
const pricedState = { ...baseState, hand: [pricedCard] };
assert.deepEqual(relevant(priced.modules.safety.collectContextAdvisories(pricedState)), [], "missing definition is not a cost mismatch");
priced.session.cardCatalog.rawById.set("EmptyMind", { id: "EmptyMind", cost: 1, upgraded: { cost: 0 } });
priced.modules.cards.rememberCardDefinition(pricedCard);
const pricedReceipt = priced.modules.compaction.rememberAndCompact(pricedState);
assert.equal(pricedReceipt.hand[0].c, 3, "keep live cost rather than substituting definition cost");
assert.equal(pricedReceipt.card_defs["EmptyMind@0"].c, 1);
assert.equal(relevant(pricedReceipt.advisories)[0].id, "live-card-cost");
assert.deepEqual(relevant(priced.modules.safety.collectContextAdvisories(pricedState)), []);
for (const cost of [1, -1, -2, undefined]) {
  assert.deepEqual(relevant(priced.modules.safety.collectContextAdvisories({ ...pricedState,
    floor: 8, hand: [{ ...pricedCard, cost }] })), [], "equal, unknown and special costs do not trigger numeric mismatch");
}
const upgradedCard = { ...pricedCard, upgrades: 1, cost: 0 };
priced.modules.cards.rememberCardDefinition(upgradedCard);
assert.deepEqual(relevant(priced.modules.safety.collectContextAdvisories({ ...pricedState,
  floor: 8, hand: [upgradedCard] })), [], "compare the matching upgraded definition");
assert.equal(relevant(priced.modules.safety.collectContextAdvisories({ ...pricedState,
  floor: 8, hand: [{ ...upgradedCard, cost: 2 }] }))[0].id, "live-card-cost");
assert.equal(relevant(createRuntime({ env: {} }).modules.safety.collectContextAdvisories({ ...baseState,
  combat_detail: { turn: 1, player: { powers: [{ id: "Confusion" }] } } }))[0].id, "live-card-cost");
assert.deepEqual(relevant(createRuntime({ env: {} }).modules.safety.collectContextAdvisories({ ...poisoned,
  room_phase: "COMPLETE" })), [], "no combat explanation outside combat");
console.log("Observability tests passed: sparse/scalar/zero/unknown ed, negative costs/playability, shop identity, potion slots, stance/intent semantics, and context-triggered advisories.");
