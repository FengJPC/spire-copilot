import assert from "node:assert/strict";
import { createRuntime } from "../runtime/index.mjs";

// Public MCP regression for the observed upgrade flow: after choose, upstream
// hides the card list and exposes confirmation without reporting selected_cards.
const runtime = createRuntime({ env: {}, config: {
  pollMs: 1, settleMs: 0, visualSettleMs: 0, timeoutMs: 1000, batchTimeoutMs: 1000,
} });
const card = { id: "Zap", name: "电击", uuid: "zap-upgrade", cost: 1, type: "SKILL" };
const game = {
  in_game: true,
  ready_for_command: true,
  floor: 2,
  room_phase: "COMPLETE",
  screen_type: "GRID",
  choice_list: [card.name],
  can_proceed: false,
  screen_state: { cards: [card], num_cards: 1, any_number: false,
    confirm_up: false, for_upgrade: true, selected_cards: [] },
  run_detail: { act: 1, class: "DEFECT", deck: [card], relics: [], potions: [] },
};
let reads = 0, sends = 0;
runtime.modules.state.decisionState = async () => { reads += 1; return structuredClone(game); };
runtime.modules.transport.validateToolCall = async (name, args) => {
  assert.equal(name, "choose");
  assert.deepEqual(args, { choice_index: 1 });
};
runtime.modules.transport.rawTool = async (name, args, { execution }) => {
  assert.equal(name, "choose");
  assert.deepEqual(args, { choice_index: 1 });
  sends += 1;
  execution.certainty = "sent_unknown";
  game.choice_list = undefined;
  game.can_proceed = true;
  game.proceed_button = "confirm";
  game.screen_state = { ...game.screen_state, cards: undefined, confirm_up: true,
    selected_cards: undefined };
  execution.certainty = "accepted";
  return { message: "OK" };
};

const response = await runtime.handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call",
  params: { name: "act", arguments: { action: "choose", choice_uuid: card.uuid,
    visual_wait: false, timeout_ms: 1000 } } });
assert.equal(response.result.isError, undefined);
const receipt = JSON.parse(response.result.content[0].text);
assert.equal(sends, 1);
assert.equal(reads, 2, "one initial read plus the first confirming settlement read");
assert.equal(receipt.result.settlement, "verified");
assert.equal(receipt.result.execution_certainty, "verified");
assert.equal(receipt.result.choice_uuid, card.uuid);
assert.equal(receipt.result.failed_action_status, undefined);
assert.equal(receipt.changes.proceed, "confirm");
assert.equal(receipt.changes.details.confirm_up, true);
console.log("GRID choice settlement passed: exact single-card confirmation verifies on the first post-action read.");
