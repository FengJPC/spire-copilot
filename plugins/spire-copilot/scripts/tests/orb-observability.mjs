import assert from "node:assert/strict";
import { createRuntime } from "../runtime/index.mjs";

const runtime = createRuntime({ env: {} });
const { compaction, safety, transport } = runtime.modules;
const base = { in_game: true, floor: 4, room_phase: "COMBAT", screen_type: "NONE",
  combat_detail: { turn: 1, player: {} } };
const state = (orbs, player = {}) => ({ ...base, combat_detail: {
  turn: 1, player: { ...player, orbs },
} });
const initial = [{ id: "Lightning", passive: 5, evoke: 10 },
  { id: "Lightning", passive: 5, evoke: 10 },
  { id: "Dark", passive: 8, evoke: 24 }, {}];
const expected = initial.map((orb, index) => ({ slot: index + 1, ...orb }));
const focus = [{ id: "Focus", amount: 2 }];
const first = compaction.rememberAndCompact(state(initial, { powers: focus }));
assert.deepEqual(first.orbs, expected);
assert.equal(first.powers[0].n, 2);
assert.equal(first.focus, 2);
assert.equal(compaction.compactState(state(initial)).focus, 0);
assert.equal(compaction.compactState(state(initial, { powers: [{ id: "Focus", amount: -3 }] })).focus, -3);
assert.equal(compaction.compactState(state(initial, { powers: [{ id: "Focus" }] })).focus, null);
assert.equal(compaction.compactState(state(initial, { powers: null })).focus, null);
assert.equal(compaction.compactState({ ...base, combat_detail: { turn: 1 } }).focus, null);
assert.equal(compaction.compactState({ ...base, combat_detail: { player: [] } }).focus, null);
assert.equal(first.orbs[0].passive, 5, "do not apply Focus a second time");
assert.equal(first.orbs.length, 4, "duplicate types and empty slot are not merged");
assert.ok(first.advisories.some((hint) => hint.id === "orb-slots"));
const same = compaction.rememberAndCompact(state(initial, { powers: focus }), true);
assert.equal(Object.hasOwn(same.delta, "orbs"), false, "unchanged list costs no repeated payload");
assert.equal((same.advisories ?? []).some((hint) => hint.id === "orb-slots"), false);

// All orb changes are snapshots, never ID-keyed semantic patches. A rotated
// queue may have unchanged counts but a different next-to-evoke orb.
const sequences = [
  [initial[2], initial[0], initial[1], initial[3]],
  [initial[0], initial[1], { ...initial[2], evoke: 32 }, initial[3]],
  [initial[0], { id: "Frost", passive: 0, evoke: 0 }, { id: "ModOrb", passive: -2 }],
  [{ id: "Plasma", passive: 1, evoke: 2 }],
  [...initial, {}],
  [],
];
for (const orbs of sequences) {
  const receipt = compaction.rememberAndCompact(state(orbs), true);
  assert.deepEqual(receipt.delta.orbs, orbs.map((orb, index) => ({ slot: index + 1, ...orb })));
  assert.ok(Array.isArray(receipt.delta.orbs));
  assert.equal((receipt.advisories ?? []).some((hint) => hint.id === "orb-slots"), false);
}
const unavailable = compaction.rememberAndCompact(base, true);
assert.equal(unavailable.delta.orbs, null, "missing upstream list clears stale knowledge");
assert.equal(compaction.compactState(base).orbs, null);
assert.equal(compaction.compactState({ ...base, combat_detail: undefined }).orbs, null);
assert.equal(compaction.compactState(state(null)).orbs, null);
assert.equal(compaction.compactState(state({})).orbs, null);
assert.deepEqual(compaction.compactState(state([])).orbs, []);
assert.deepEqual(compaction.compactState(state([null, {}])).orbs,
  [{ slot: 1 }, { slot: 2 }]);
const action = compaction.rememberAndCompact(state(initial), false,
  { action: "play_card", settlement: "verified" });
assert.deepEqual(action.changes.orbs, expected, "action receipts carry the same orb snapshot");
assert.equal(Object.hasOwn(action.changes, "focus"), false, "unchanged zero Focus is retained, not resent");
const debuffed = compaction.rememberAndCompact(state(initial, { powers: [{ id: "Focus", amount: -2 }] }), true);
assert.equal(debuffed.delta.focus, -2);
const resetFocus = compaction.rememberAndCompact(state(initial), true);
assert.equal(resetFocus.delta.focus, 0, "removing Focus clears the old bonus explicitly");
assert.equal(Object.hasOwn(resetFocus.delta, "orbs"), false);
const terminal = compaction.rememberAndCompact({ ...base, room_phase: "COMPLETE",
  combat_detail: undefined }, true);
assert.equal(terminal.delta.orbs, null, "combat exit clears the list");
assert.equal(terminal.delta.focus, null);
assert.equal(Object.hasOwn(compaction.compactState({ ...base, room_phase: "COMPLETE" }), "orbs"), false);

// Hint delivery waits for an actual list, not a class label or transition.
const hints = createRuntime({ env: {} });
for (const snapshot of [base, { ...state(initial), in_game: false },
  { ...state(initial), room_phase: "COMPLETE" },
  { ...state(initial), combat_detail: { turn: undefined, player: { orbs: initial } } }]) {
  assert.equal(hints.modules.safety.collectContextAdvisories(snapshot)
    .some((hint) => hint.id === "orb-slots"), false);
}
assert.ok(hints.modules.safety.collectContextAdvisories(state([])).some((hint) => hint.id === "orb-slots"));
assert.equal(safety.collectContextAdvisories(state(initial)).some((hint) => hint.id === "orb-slots"), false);
transport.resetGameConnection();
assert.ok(safety.collectContextAdvisories(state(initial)).some((hint) => hint.id === "orb-slots"));

// Exercise the upstream-enrichment -> public MCP compact/delta path without
// a live game or any mutations. Retain the upstream slot array, not its type set.
runtime.modules.transport.rawTool = async (name) => {
  assert.equal(name, "get_game_state");
  return { message: JSON.stringify({ game_state: {
    class: "DEFECT", act: 1, combat_state: {
      turn: 1, player: { orbs: initial, powers: focus }, hand: [], monsters: [],
    },
  } }) };
};
let live = await runtime.modules.state.enrichRunAndCombat(base);
assert.deepEqual(live.combat_detail.player.orbs, initial);
runtime.modules.state.decisionState = async () => live;
const read = async (mode) => {
  const response = await runtime.handleMcpMessage({ jsonrpc: "2.0", id: 7, method: "tools/call",
    params: { name: "get_state", arguments: { mode } } });
  assert.equal(response.result.isError, undefined);
  return JSON.parse(response.result.content[0].text);
};
assert.deepEqual((await read("compact")).orbs, expected);
assert.equal((await read("compact")).focus, 2);
live = state([initial[2], initial[0]]);
assert.deepEqual((await read("delta")).delta.orbs,
  [{ slot: 1, ...initial[2] }, { slot: 2, ...initial[0] }]);
assert.deepEqual((await read("full")).combat_detail.player.orbs, live.combat_detail.player.orbs);
console.log("Orb observability, ordered replacement, enrichment and hint checks passed.");
