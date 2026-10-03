import assert from "node:assert/strict";
import { createRuntime } from "../runtime/index.mjs";

const relic = { reward_type: "RELIC", relic: { id: "StrikeDummy", name: "打击木偶" } };
const gold = { reward_type: "GOLD", gold: 17 };
const potion = { reward_type: "POTION", potion: { id: "Block Potion", name: "格挡药水" } };
const rewardText = "relic: [打击木偶] 名字中有打击的卡牌造成额外伤害";
function snapshot(rewards = [relic], choices = [rewardText]) {
  return { in_game: true, ready_for_command: true, floor: 9, room_phase: "COMPLETE",
    screen_type: "COMBAT_REWARD", choice_list: choices, can_proceed: true,
    proceed_button: "proceed", gold: 108,
    screen_state: { rewards: structuredClone(rewards) },
    run_detail: { act: 1, deck: [], relics: [], potions: [] } };
}
const runtime = createRuntime({ env: {}, config: { pollMs: 1, visualSettleMs: 0 } });
const { actionSettlementEvidence, waitForActionSettlement } = runtime.modules.settlement;
const action = { action: "choose", choice_index: 1 };
const start = snapshot();
const after = { ...snapshot([]), choice_list: undefined,
  run_detail: { ...start.run_detail, relics: [relic.relic] } };

assert.equal(actionSettlementEvidence(action, start, after), "chosen_reward_removed");
let elapsed = 0, reads = 0;
const settled = await waitForActionSettlement(action, start, {
  timeout: 20000, waitForVisual: false, now: () => elapsed,
  pause: async (ms) => { elapsed += ms; },
  readState: async () => { reads++; return after; },
});
assert.equal(settled.evidence, "chosen_reward_removed");
assert.equal(reads, 1);
assert.equal(elapsed, 1);

for (const reward of [gold, { ...gold, reward_type: "STOLEN_GOLD" }, potion,
  { reward_type: "SAPPHIRE_KEY", link: { id: "StrikeDummy" } }]) {
  assert.equal(actionSettlementEvidence(action, snapshot([reward], ["claim"]),
    { ...after, run_detail: start.run_detail }), "chosen_reward_removed");
}
// Counts handle duplicates; immutable identity excludes mutable relic counters.
const duplicates = snapshot([relic, relic], [rewardText, rewardText]);
assert.equal(actionSettlementEvidence({ ...action, choice_index: 2 }, duplicates,
  { ...after, screen_state: { rewards: [relic] } }), "chosen_reward_removed");
assert.equal(actionSettlementEvidence(action, start,
  { ...after, screen_state: { rewards: [{ ...relic, relic: { ...relic.relic, counter: 2 } }] } }), undefined);

const mixed = snapshot([gold, relic, potion], ["gold", rewardText, "potion"]);
assert.equal(actionSettlementEvidence({ ...action, choice_index: 2 }, mixed,
  { ...after, choice_list: ["gold", "potion"], screen_state: { rewards: [gold, potion] } }),
"chosen_reward_removed");
// Omissions, different-reward removal, transient data and malformed indexing
// cannot independently prove the selected reward was claimed.
for (const [command, before, observed] of [
  [action, start, { ...after, screen_state: undefined }],
  [action, start, { ...after, screen_state: {} }],
  [action, start, { ...after, screen_state: { rewards: null } }],
  [action, start, { ...after, screen_state: start.screen_state }],
  [{ ...action, choice_index: 2 }, mixed,
    { ...after, screen_state: { rewards: [relic, potion] } }],
  [{ ...action, choice_index: 0 }, start, after],
  [{ ...action, choice_index: 2 }, start, after],
  [action, { ...start, choice_list: undefined }, after],
  [action, { ...start, choice_list: [rewardText, "other"] }, after],
  [action, { ...start, room_phase: "COMBAT" }, { ...after, room_phase: "COMBAT" }],
  [action, snapshot([{ reward_type: "MOD_REWARD" }], ["claim"]), after],
]) assert.equal(actionSettlementEvidence(command, before, observed), undefined);

async function publicClaim(tool, { uncertain = false } = {}) {
  const app = createRuntime({ env: {}, config: { pollMs: 1, visualSettleMs: 0,
    timeoutMs: 1000, batchTimeoutMs: 1000 } });
  let game = snapshot(), reads = 0;
  const calls = [];
  app.modules.state.decisionState = async () => { reads++; return structuredClone(game); };
  app.modules.transport.validateToolCall = async (name, args) => {
    assert.equal(name, "choose");
    assert.deepEqual(args, { choice_index: 1 });
  };
  app.modules.transport.rawTool = async (name, args, { execution }) => {
    calls.push({ name, args });
    execution.certainty = "sent_unknown";
    game = structuredClone(after);
    if (uncertain) throw new Error("response lost after dispatch");
    execution.certainty = "accepted";
    return { message: "OK" };
  };
  const choice = { action: "choose", choice_text: rewardText };
  const response = await app.handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: tool, arguments: { visual_wait: false, timeout_ms: 1000,
      ...(tool === "act" ? choice : { actions: [choice, ...(uncertain ? [{ action: "proceed" }] : [])] }) } } });
  const receipt = JSON.parse(response.result.content[0].text);
  assert.equal(calls.length, 1, "never retry a claim or send suffix after an uncertain dispatch");
  assert.deepEqual(calls[0], { name: "choose", args: { choice_index: 1 } });
  if (uncertain) {
    assert.equal(receipt.result.failed_action_status, "outcome_unknown");
    assert.equal(receipt.result.completed_actions, 0);
    assert.equal(receipt.result.execution_certainty, "sent_unknown");
    assert.equal(receipt.result.remaining_actions.length, 1);
  } else {
    assert.equal(reads, 2, "initial state plus first confirming read");
    assert.equal(receipt.result.settlement, "verified");
    assert.equal(receipt.result.execution_certainty, "verified");
    assert.equal(receipt.run_context.relics[0].id, "StrikeDummy");
  }
}
await publicClaim("act");
await publicClaim("act_many");
await publicClaim("act_many", { uncertain: true });
console.log("Reward settlement passed: final reward verifies promptly, exact identity/count evidence, no uncertain replay or suffix.");
