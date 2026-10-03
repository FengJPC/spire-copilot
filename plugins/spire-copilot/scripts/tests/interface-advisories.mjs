import assert from "node:assert/strict";
import { createRuntime } from "../runtime/index.mjs";
import { createInspection } from "../runtime/inspection.mjs";

const targeted = { id: "TargetedSkill", name: "Targeted Skill", uuid: "targeted",
  type: "SKILL", cost: 1, has_target: true, is_playable: true };
const untargeted = { id: "AllAttack", name: "All Attack", uuid: "all",
  type: "ATTACK", cost: 1, damage: 6 };
const combat = { in_game: true, floor: 1, room_phase: "COMBAT", screen_type: "NONE",
  current_energy: 3, hand: [], monsters: [], combat_detail: { turn: 1, player: {} } };
const ids = (receipt) => (receipt.advisories ?? []).map((item) => item.id);
const runtime = createRuntime({ env: {} });
const { compaction, cards, safety, transport } = runtime.modules;

// Positive-only targeting is distinct from playability. True needs a single
// enemy, while false/unavailable data compress alike; card type is irrelevant.
const hand = (flag) => compaction.compactState({ ...combat,
  hand: [{ ...targeted, has_target: flag }] }).hand;
assert.equal(hand(true)[0].t, true);
assert.equal(Object.hasOwn(hand(false)[0], "t"), false);
assert.deepEqual(hand(false), hand(undefined));
assert.equal(compaction.compactState({ ...combat, hand: [untargeted] }).hand[0].t, undefined);
for (const flag of [true, false, undefined]) {
  const card = { ...targeted, has_target: flag };
  assert.equal(compaction.compactChoiceCard(card).t, flag === true ? true : undefined);
  assert.equal(cards.compactCardInstance(card).target, flag === true ? true : undefined);
  assert.equal(cards.compactCardDefinition(card).target, flag === true ? true : undefined);
  assert.equal(Object.hasOwn(cards.compactCardInstance(card), "t"), false);
  assert.equal(runtime.modules.inspection.compactPileCards([card])[0].t, flag === true ? true : undefined);
}
const diff = compaction.handArrayDifference;
assert.equal(diff(hand(true), hand(false)).changed[0].t, null);
assert.equal(diff(hand(false), hand(true)).changed[0].t, true);
const costPatch = diff(hand(true), [{ ...hand(true)[0], c: 0 }]).changed[0];
assert.equal(Object.hasOwn(costPatch, "t"), false);
assert.equal({ ...hand(true)[0], ...costPatch }.t, true, "cost-only patch retains targeting");

// Incomplete/non-game states do not consume context hints. [] is a known zero
// potion-slot inventory, whereas null/missing inventories are not known.
const contextRuntime = createRuntime({ env: {} });
const read = (state) => contextRuntime.modules.compaction.rememberAndCompact(state);
const shop = { in_game: true, floor: 2, room_phase: "COMPLETE", screen_type: "SHOP_SCREEN",
  choice_list: ["purge (75 gold)"], screen_state: { cards: [] } };
for (const state of [{ ...shop, in_game: false }, { ...shop, choice_list: [] },
  { ...combat, in_game: false, hand: [targeted], run_detail: { potions: [] } },
  { ...shop, choice_list: undefined }, { ...combat, run_detail: { potions: null } }, combat]) {
  assert.deepEqual(ids(read(state)), []);
}
const firstShop = read(shop);
assert.deepEqual(ids(firstShop), ["shop-choice"]);
assert.deepEqual(ids(read({ ...shop, floor: 5, choice_list: ["purge (100 gold)"] })), []);
assert.deepEqual(ids(read({ ...combat, run_detail: { potions: [] } })), ["potion-slots"]);
assert.deepEqual(ids(read({ ...combat, floor: 6, run_detail: {
  potions: [{ id: "P", requires_target: true }] } })), []);
// Selecting a card outside combat also reveals targeting semantics; a later
// combat does not re-emit this explanation, but still sends the hand hint.
const choices = { in_game: true, floor: 3, room_phase: "COMPLETE", screen_type: "GRID",
  choice_list: [targeted.name], screen_state: { cards: [targeted] } };
assert.deepEqual(ids(read(choices)), ["card-targeting"]);
assert.deepEqual(ids(read({ ...combat, hand: [untargeted] })), ["hand-playability"]);
assert.deepEqual(ids(read({ ...combat, floor: 7, hand: [targeted], combat_detail: { turn: 3, player: {} } })), []);
contextRuntime.modules.transport.resetGameConnection();
assert.deepEqual(ids(read({ ...shop, screen_state: { cards: [targeted] },
  run_detail: { potions: [] } })).sort(), ["card-targeting", "potion-slots", "shop-choice"]);
assert.equal(ids(createRuntime({ env: {} }).modules.compaction.rememberAndCompact(choices))[0], "card-targeting");

// Intent damage is already adjusted upstream; preserve 9x2 instead of applying
// Weak/Vulnerable/Wrath again. The explanation is encounter-scoped, not per read.
const incomingRuntime = createRuntime({ env: {} });
const incomingState = { ...combat, combat_detail: { turn: 1,
  player: { stance: "Wrath", powers: [{ id: "Vulnerable", amount: 2 }] } },
  monsters: [{ id: "Enemy", current_hp: 20, intent: "ATTACK",
    powers: [{ id: "Weak", amount: 2 }], move: { damage: 9, hits: 2 } }] };
const incomingRead = (state) => incomingRuntime.modules.compaction.rememberAndCompact(state);
const firstIncoming = incomingRead(incomingState);
assert.equal(firstIncoming.enemies[0].atk, "9x2");
const incomingHint = firstIncoming.advisories.find((hint) => hint.id === "incoming-damage");
assert.ok(incomingHint.text.includes("enemy Weak") && incomingHint.text.includes("player Vulnerable"));
assert.ok(incomingHint.text.includes("not guaranteed HP loss"));
assert.equal(ids(incomingRead(incomingState)).includes("incoming-damage"), false);
assert.equal(ids(incomingRead({ ...incomingState, combat_detail: {
  ...incomingState.combat_detail, turn: 2 } })).includes("incoming-damage"), false);
assert.equal(ids(incomingRead({ ...incomingState, floor: 2 })).includes("incoming-damage"), true);
incomingRuntime.modules.transport.resetGameConnection();
assert.equal(ids(incomingRead(incomingState)).includes("incoming-damage"), true);
const absentRuntime = createRuntime({ env: {} });
assert.equal(ids(absentRuntime.modules.compaction.rememberAndCompact(combat))
  .includes("incoming-damage"), false);
assert.equal(ids(absentRuntime.modules.compaction.rememberAndCompact(incomingState))
  .includes("incoming-damage"), true, "incomplete intent must not consume the hint");

// Interface deduplication must not quiet the existing per-turn danger warnings.
const dangerous = { ...combat, hand: [{ id: "Normality", name: "凡庸" }, targeted],
  combat_detail: { turn: 1, player: { stance: "Wrath" } },
  monsters: [{ id: "Enemy", current_hp: 20, intent: "ATTACK", move: { damage: 6 } }] };
assert.ok(ids(compaction.rememberAndCompact(dangerous)).includes("card-targeting"));
const nextTurn = compaction.rememberAndCompact({ ...dangerous,
  combat_detail: { turn: 2, player: { stance: "Wrath" } } });
assert.deepEqual(ids(nextTurn).sort(), ["normality", "wrath-incoming"]);

// Isolated inspection dependencies avoid game I/O and verify delivery through
// query returns without advancing any baseline or consuming combat advisories.
const queryRuntime = createRuntime({ env: {} });
const queryCards = queryRuntime.modules.cards;
let queryState = { ...combat, hand: [targeted],
  _combat_piles: { draw: [targeted, untargeted], discard: [], exhaust: [] },
  monsters: [{ id: "Enemy", current_hp: 20, powers: [{ id: "Thorns", amount: 3 }] }] };
for (const card of [targeted, untargeted]) {
  queryRuntime.session.cardCatalog.rawById.set(card.id, card);
  queryCards.rememberCardDefinition(card);
}
const inspector = createInspection(queryRuntime, {
  cardRef: queryCards.cardRef,
  cardUpgradeCount: queryCards.cardUpgradeCount,
  collectCardInstances: queryCards.collectCardInstances,
  compactCardInstance: queryCards.compactCardInstance,
  normalizeCardText: queryCards.normalizeCardText,
  pendingCardDefinitionPayload: queryCards.pendingCardDefinitionPayload,
  rememberCardDefinition: queryCards.rememberCardDefinition,
  loadCardInfo: async () => {},
  decisionState: async () => queryState,
  collectInterfaceAdvisories: queryRuntime.modules.safety.collectInterfaceAdvisories,
});
queryRuntime.modules.compaction.rememberAndCompact(combat);
const previous = queryRuntime.session.previousState;
const observed = queryRuntime.session.observedHandState;
await assert.rejects(inspector.inspectPile({ pile: "hand" }), /inspect_pile requires/);
await assert.rejects(inspector.inspectCard({}), /exactly one/);
assert.equal(queryRuntime.session.advisoryKeys.size, 0);
const pile = await inspector.inspectPile({ pile: "draw" });
assert.deepEqual(ids(pile), ["pile-inspection", "card-targeting"]);
assert.equal(pile.cards.find((card) => card.ref === "TargetedSkill@0").t, true);
assert.equal(queryRuntime.session.previousState, previous);
assert.equal(queryRuntime.session.observedHandState, observed);
assert.deepEqual(ids(await inspector.inspectPile({ pile: "discard" })), []);
const instance = await inspector.inspectCard({ card_id: targeted.id });
assert.equal(instance.instances[0].target, true);
assert.deepEqual(ids(instance), [], "targeting hint is shared across query/state paths");
const afterQuery = queryRuntime.modules.compaction.rememberAndCompact(queryState, true);
assert.ok(afterQuery.delta.hand.added.length > 0, "query does not swallow hand changes");
assert.deepEqual(ids(afterQuery).sort(), ["hand-playability", "per-hit-retaliation"]);

// Queries also explain unavailable/empty results. Invalid selectors never
// consume a hint; reconnection repeats only what the new response contains.
queryRuntime.modules.transport.resetGameConnection();
queryState = { ...combat, room_phase: "COMPLETE" };
assert.deepEqual(ids(await inspector.inspectPile({ pile: "draw" })), ["pile-inspection"]);
queryRuntime.modules.transport.resetGameConnection();
queryState = combat;
assert.equal((await inspector.inspectPile({ pile: "draw" })).status, "UNAVAILABLE");
queryRuntime.modules.transport.resetGameConnection();
queryState = { ...combat, _combat_piles: { exhaust: [] } };
assert.deepEqual(ids(await inspector.inspectPile({ pile: "exhaust" })), ["pile-inspection"],
  "empty pile does not consume a card-targeting hint before any card is observed");
queryState = { ...combat, hand: [targeted] };
assert.deepEqual(ids(await inspector.inspectCard({ card_id: targeted.id })), ["card-targeting"]);
assert.deepEqual(ids(await inspector.inspectCard({ card_id: targeted.id })), []);
transport.resetGameConnection();
assert.equal(safety.collectInterfaceAdvisories(["shop-choice", "shop-choice"]).length, 1);
console.log("Interface advisory tests passed: targeting aliases/patches, first-context routing, reconnect/dedup, isolated query delivery and untouched state/turn safeguards.");
