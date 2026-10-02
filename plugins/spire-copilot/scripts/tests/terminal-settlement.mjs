import assert from "node:assert/strict";
import { createRuntime } from "../runtime/index.mjs";

const runtime = createRuntime({ env: {}, config: { pollMs: 1, visualSettleMs: 0 } });
const { actionSettlementEvidence, combatCompletionEvidence, waitForActionSettlement } = runtime.modules.settlement;
const selected = { id: "Strike", name: "Strike", uuid: "exact", cost: 1 };
const action = { action: "play_card", card_uuid: selected.uuid };
const start = { in_game: true, floor: 51, room_phase: "COMBAT", screen_type: "NONE",
  current_hp: 29, hand: [selected], combat_detail: { turn: 7 },
  monsters: [{ id: "TimeEater", current_hp: 3, is_gone: false }] };
const terminal = { in_game: true, floor: 51, room_phase: "COMPLETE", screen_type: "COMPLETE",
  current_hp: 29, can_proceed: true };

// A missing terminal hand must never become an invented empty hand / UUID proof.
for (const state of [terminal, { ...terminal, hand: null }, { ...terminal, hand: [selected] },
  { ...terminal, screen_type: "COMBAT_REWARD" }, { ...terminal, screen_type: "GAME_OVER", current_hp: 0 }]) {
  assert.equal(actionSettlementEvidence(action, start, state), undefined);
  assert.equal(combatCompletionEvidence(start, state), "combat_completed");
  let elapsed = 0, reads = 0;
  const settled = await waitForActionSettlement(action, start, {
    timeout: 100, waitForVisual: false,
    pause: async (ms) => { elapsed += ms; }, now: () => elapsed,
    readState: async () => { reads++; return state; },
  });
  assert.equal(settled.terminal, "combat_completed");
  assert.equal(settled.evidence, undefined);
  assert.equal(reads, 1, "terminal observations stop on the first poll, not the deadline");
  assert.equal(settled.elapsedMs, 1);
}

// Completion and action verification are independent: retain exact proof when
// the game actually supplies the hand, rather than treating every lethal as unknown.
const proved = { ...terminal, hand: [] };
assert.equal(actionSettlementEvidence(action, start, proved), "card_left_hand");
assert.equal(combatCompletionEvidence(start, proved), "combat_completed");
assert.equal(actionSettlementEvidence({ action: "end_turn" }, start, terminal), "turn_or_combat_completed");

// Neither omissions, a screen flash, zero-HP foes awaiting rebirth, menu exit,
// nor a terminal state on a different floor proves this combat completed.
const falseCues = [
  {},
  { ...terminal, room_phase: undefined },
  { ...terminal, room_phase: "COMBAT" },
  { ...terminal, screen_type: "COMBAT_REWARD", room_phase: "COMBAT" },
  { ...terminal, monsters: start.monsters },
  { ...terminal, monsters: [{ id: "Enemy", is_gone: false }] },
  { ...start, hand: undefined, monsters: [{ id: "AwakenedOne", current_hp: 0 }] },
  { ...terminal, floor: 52 },
  { ...terminal, floor: undefined },
  { ...terminal, in_game: false },
];
for (const state of falseCues) assert.equal(combatCompletionEvidence(start, state), undefined);
assert.equal(combatCompletionEvidence({ ...start, room_phase: "COMPLETE" }, terminal), undefined);
assert.equal(combatCompletionEvidence({ ...start, floor: undefined }, terminal), undefined);

// False cues still use the existing action-specific verifier and bounded timeout.
let elapsed = 0, reads = 0;
await assert.rejects(waitForActionSettlement(action, start, {
  timeout: 4, waitForVisual: false,
  pause: async (ms) => { elapsed += ms; }, now: () => elapsed,
  readState: async () => { reads++; return { ...start, hand: undefined, screen_type: "COMBAT_REWARD" }; },
}), (error) => error.code === "ACTION_SETTLEMENT_TIMEOUT");
assert.ok(reads > 1);
console.log("Terminal-settlement tests passed: prompt completion, exact proof vs terminal outcome, and false-positive rejection.");
