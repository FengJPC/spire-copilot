import assert from "node:assert/strict";
import { createRuntime } from "../runtime/index.mjs";
import { createState } from "../runtime/state.mjs";

const spent = () => ({ in_game: true, ready_for_command: true, floor: 12,
  room_phase: "COMBAT", screen_type: "NONE", current_energy: 0, hand: [],
  combat_detail: { turn: 1, draw_count: 12, discard_count: 5, exhaust_count: 0 },
  monsters: [{ id: "Slime", name: "Slime", current_hp: 5, intent: "ATTACK", move: { damage: 5 } }] });
const app = createRuntime({ env: {} });
const stable = app.modules.state.isStableDecisionState;
assert.equal(stable(spent()), true, "spent opening hand is a playable decision boundary");
const opening = { ...spent(), combat_detail: { turn: 1, draw_count: 12, discard_count: 0, exhaust_count: 0 } };
assert.equal(stable(opening), false, "genuinely incomplete opening draw still waits");
for (const field of ["discard_count", "exhaust_count", "cards_discarded_this_turn", "cards_played_this_turn"]) {
  assert.equal(stable({ ...opening, combat_detail: { ...opening.combat_detail, [field]: 1 } }), true);
}
for (const count of [undefined, null, -1, NaN, "1"]) {
  assert.equal(stable({ ...opening, combat_detail: { ...opening.combat_detail, discard_count: count } }), false);
}
app.session.lastStableDecisionState = { ...opening, hand: [{ uuid: "power" }] };
assert.equal(stable(opening), true, "all-power hand can leave no discard/exhaust evidence");
assert.equal(stable({ ...opening, floor: 13 }), false, "prior floor must not prove opening activity");
app.session.lastStableDecisionState.combat_detail = { turn: 2 };
assert.equal(stable(opening), false, "prior turn must not prove opening activity");
assert.equal(stable({ ...spent(), monsters: [{ intent: "DEBUG", current_hp: 5 }] }), false);
assert.equal(stable({ ...spent(), screen_type: "COMBAT_REWARD" }), false);

function fixture({ incomplete = false, overrun = false } = {}) {
  const runtime = createRuntime({ env: {}, config: { pollMs: 5, visualSettleMs: 0 } });
  let clock = 0;
  const reads = [];
  const snapshot = incomplete ? opening : spent();
  runtime.modules.state = createState(runtime, {
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    liveMonsters: runtime.modules.shared.liveMonsters,
    monsterRosterKey: runtime.modules.safety.monsterRosterKey,
    parseState: runtime.modules.shared.parseState,
    syncEndTurnSafety: () => {},
    enrichCardDefinitions: async (state) => state,
    rawTool: async (name, args, { timeout }) => {
      reads.push({ name, timeout });
      if (overrun) {
        clock += timeout;
        const error = new Error(`Timed out after ${timeout}ms waiting for the MCP response`);
        error.code = "ACTION_TRANSPORT_TIMEOUT";
        throw error;
      }
      clock += 1;
      return { message: JSON.stringify(name === "get_screen_state" ? snapshot : {
        game_state: { class: "DEFECT", act: 1, combat_state: {
          turn: 1, hand: [], draw_pile: Array(12).fill({}),
          discard_pile: Array(snapshot.combat_detail.discard_count).fill({}),
          exhaust_pile: [], monsters: snapshot.monsters, player: {},
        } },
      }) };
    },
  });
  return { runtime, reads, elapsed: () => clock };
}
const read = fixture();
const recovered = await read.runtime.modules.state.decisionState({ timeout: 20 });
assert.deepEqual(recovered.hand, []);
assert.equal(read.elapsed(), 2);
assert.equal(read.reads.length, 2, "reconnect needs only one screen/details read pair");

const pending = fixture({ incomplete: true });
await assert.rejects(pending.runtime.modules.state.decisionState({ timeout: 10 }), (error) => {
  assert.equal(error.code, "STATE_READ_TIMEOUT");
  assert.match(error.message, /after 10ms.*stage=screen readiness/);
  assert.doesNotMatch(error.message, /after 1ms/);
  return true;
});
assert.equal(pending.elapsed(), 10);
assert.deepEqual(pending.reads.map((r) => r.timeout), [10, 9, 3, 2]);
assert.ok(pending.reads.every((r) => r.timeout > 0), "nothing dispatches after the deadline");
const slow = fixture({ overrun: true });
await assert.rejects(slow.runtime.modules.state.decisionState({ timeout: 20 }), (error) => {
  assert.equal(error.code, "STATE_READ_TIMEOUT");
  assert.match(error.message, /after 20ms.*stage=screen readiness/);
  assert.equal(error.cause.code, "ACTION_TRANSPORT_TIMEOUT");
  return true;
});
assert.equal(slow.reads.length, 1);

// Public action path: the final opening Strike leaves hand and kills one of
// several enemies. Verification must finish, without waiting for end_turn.
const runtime = createRuntime({ env: {}, config: { pollMs: 1, visualSettleMs: 0, batchTimeoutMs: 100 } });
let game = { ...spent(), current_energy: 1,
  hand: [{ id: "Strike_B", name: "Strike", uuid: "last-strike", cost: 1, damage: 9, has_target: true }],
  combat_detail: { ...spent().combat_detail, discard_count: 4 },
  monsters: [{ id: "Slime", name: "Slime", current_hp: 6, intent: "ATTACK" }, ...spent().monsters] };
let dispatches = 0, stateReads = 0;
runtime.modules.transport.validateToolCall = async () => {};
runtime.modules.transport.rawTool = async (name, args, options = {}) => {
  let value;
  if (name === "get_screen_state") { stateReads++; value = game; }
  else if (name === "get_game_state") value = { game_state: { class: "DEFECT", act: 1,
    deck: [], relics: [], potions: [], combat_state: { turn: 1, hand: game.hand,
      monsters: game.monsters, player: {}, draw_pile: Array(12).fill({}),
      discard_pile: Array(game.combat_detail.discard_count).fill({}), exhaust_pile: [] } } };
  else if (name === "get_card_info") value = { cards: [] };
  else if (name === "execute_actions") {
    dispatches++;
    assert.equal(args.actions[0].card_uuid, "last-strike");
    options.execution.certainty = "accepted";
    game = spent(); value = "OK";
  } else throw new Error(`Unexpected tool ${name}`);
  return { message: typeof value === "string" ? value : JSON.stringify(value) };
};
const response = await runtime.handleMcpMessage({ id: 1, method: "tools/call",
  params: { name: "act", arguments: { action: "play_card", card_name: "Strike", target_index: 1 } } });
const receipt = JSON.parse(response.result.content[0].text);
assert.equal(receipt.result.halted, undefined, JSON.stringify(receipt));
assert.equal(receipt.result.execution_certainty, "verified");
assert.equal(dispatches, 1);
assert.equal(stateReads, 2, "preflight plus first confirming read");
assert.deepEqual(game.hand, []);
console.log("Opening-turn settlement and read deadlines passed.");
