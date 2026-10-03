import assert from "node:assert/strict";
import { createRuntime } from "../runtime/index.mjs";

const runtime = createRuntime({ env: {} });
const { compactState, diffValue } = runtime.modules.compaction;
const event = { ready_for_command: true, screen_type: "EVENT",
  choice_list: ["Give potion for relic", "Leave"], screen_state: {
    event_id: "WeMeetAgain", event_name: "We Meet Again", body_text: "Choose a trade.",
    options: [{ choice_index: 0, text: "Give potion for relic" }, { choice_index: 1, text: "Leave" }],
  } };
const compact = compactState(event);
assert.equal(compact.details.options, undefined);
assert.equal(compact.details.body_text, event.screen_state.body_text);
assert.deepEqual(compact.choices, [
  { i: 1, text: event.choice_list[0] }, { i: 2, text: event.choice_list[1] },
]);
const disabled = structuredClone(event);
disabled.screen_state.options[0].disabled = true;
const withDisabled = compactState(disabled);
assert.equal(withDisabled.details.options[0].disabled, true);
assert.equal(withDisabled.details.options[0].i, 1);
assert.ok(diffValue(compact, withDisabled).details.options);
assert.equal(diffValue(withDisabled, compact).details.options, null);
for (const options of [
  event.screen_state.options.slice(1),
  [{ ...event.screen_state.options[0], text: "Different effect" }, event.screen_state.options[1]],
  [{ ...event.screen_state.options[0], choice_index: 3 }, event.screen_state.options[1]],
  [{ text: event.choice_list[0] }, { text: event.choice_list[1] }],
]) assert.ok(compactState({ ...event, screen_state: { ...event.screen_state, options } }).details.options);
assert.ok(compactState({ ...event, choice_list: undefined }).details.options);

const duplicatesBefore = [{ id: "Same", n: "A", amount: 1 }, { id: "Same", n: "B", amount: 2 }];
const duplicatesAfter = [{ id: "Same", n: "A", amount: 1 }, { id: "Same", n: "B", amount: 3 }];
assert.deepEqual(diffValue(duplicatesBefore, duplicatesAfter), duplicatesAfter);
assert.deepEqual(diffValue(duplicatesBefore, duplicatesAfter.slice(1)), duplicatesAfter.slice(1));
assert.deepEqual(diffValue(duplicatesBefore.slice(0, 1), duplicatesAfter), duplicatesAfter);
assert.deepEqual(diffValue([{ slot: 1, id: "Same" }, { slot: 2, id: "Same" }],
  [{ slot: 1, id: "Same" }]), { changed: [], removed: [2] });

// Repeated state enrichment reuses immutable definitions, but never masks a
// newly loaded record, upgrade variant, catalog reset, or live hand cost.
let parses = 0;
const raw = { id: "Zap", name: "Zap", type: "SKILL", cost: 1, upgraded: { cost: 0 } };
Object.defineProperty(raw, "description", { enumerable: true, get() {
  parses++; return "Channel 1 Lightning.";
} });
runtime.session.cardCatalog.rawById.set("Zap", raw);
const first = runtime.modules.cards.rememberCardDefinition({ id: "Zap" });
const initialParses = parses;
for (let index = 0; index < 50; index++) {
  assert.equal(runtime.modules.cards.rememberCardDefinition({ id: "Zap" }), first);
}
assert.ok(initialParses > 0);
assert.equal(parses, initialParses);
assert.equal(runtime.modules.cards.rememberCardDefinition({ id: "Zap", upgrades: 1 }).c, 0);
assert.ok(parses > initialParses);
runtime.session.cardCatalog.rawById.set("Zap", { id: "Zap", name: "Modified Zap", cost: 2,
  description: "Modded effect." });
assert.equal(runtime.modules.cards.rememberCardDefinition({ id: "Zap" }).c, 2);
runtime.modules.cards.resetCardCatalog();
assert.equal(runtime.modules.cards.rememberCardDefinition({ id: "Zap" }), undefined);
runtime.session.cardCatalog.rawById.set("Zap", { id: "Zap", name: "New Zap", cost: 3 });
assert.equal(runtime.modules.cards.rememberCardDefinition({ id: "Zap" }).c, 3);
const live = compactState({ screen_type: "NONE", hand: [{ id: "Zap", name: "Zap",
  uuid: "live", cost: 0, is_playable: false }] });
assert.equal(live.hand[0].c, 0);
assert.equal(live.hand[0].p, false);
console.log("Compaction efficiency passed: event information retained, duplicate arrays lossless, definition reuse and live stats independent.");
