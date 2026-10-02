// Extracted unchanged regression fixtures; test state is instance-local.
export function runSyntheticBenchmark(runtime) {
  const { session } = runtime;
  const { compactState, diffValue, handArrayDifference, multisetDifference } = runtime.modules.compaction;

  const before = {
    ready: true,
    room: "MonsterRoom",
    screen: "NONE",
    floor: 5,
    hp: "77/77",
    gold: 40,
    energy: "3/3",
    turn: 2,
    enemies: [{ i: 1, n: "大颚虫", hp: "35/44", intent: "ATTACK_DEFEND", atk: 7 }],
    hand: [
      { n: "防御", c: 1, b: 5 }, { n: "中和", c: 0, d: 3, m: 1, t: true },
      { n: "防御", c: 1, b: 5 }, { n: "飞膝", c: 1, d: 8, t: true }, { n: "防御", c: 1, b: 5 },
    ],
  };
  const after = {
    ...before,
    energy: "1/3",
    block: 5,
    enemies: [{ i: 1, n: "大颚虫", hp: "24/44", intent: "ATTACK_DEFEND", atk: 5, powers: [{ id: "Weakened", n: 1 }] }],
    hand: [{ n: "防御", c: 1, b: 5 }, { n: "防御", c: 1, b: 5 }],
  };
  const bytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");
  const repeatedCompact = bytes(before) + bytes(after);
  const deltaBytes = bytes({ delta: diffValue(before, after) });
  const initialPlusDelta = bytes(before) + deltaBytes;
  const gridCards = Array.from({ length: 20 }, (_, index) => ({
    id: `Card${index}`,
    name: `选择牌${index}`,
    uuid: `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`,
    type: index % 2 ? "SKILL" : "ATTACK",
    cost: index % 3,
    damage: index % 2 ? undefined : 8 + index,
    block: index % 2 ? 6 + index : undefined,
    magic_number: 2,
    upgrades: index % 4 === 0 ? 1 : 0,
    is_playable: true,
    has_target: index % 2 === 0,
  }));
  const legacyGridPayload = {
    choices: gridCards.map((card, index) => ({
      i: index + 1,
      text: card.name,
      card_id: card.id,
      choice_uuid: card.uuid,
    })),
    details: {
      cards: gridCards,
      selected_cards: [],
      num_cards: 2,
      any_number: false,
      confirm_up: false,
      for_upgrade: false,
      for_transform: false,
      for_purge: false,
    },
  };
  const compactGridState = compactState({
    ready_for_command: true,
    screen_type: "GRID",
    choice_list: gridCards.map((card) => card.name),
    screen_state: legacyGridPayload.details,
  });
  const compactGridPayload = { choices: compactGridState.choices, details: compactGridState.details };
  const stanceBefore = [
    { n: "打击", ref: "Strike_P@1", c: 1, d: 9, u: 1, t: true },
    { n: "不惧妖邪", ref: "FearNoEvil@0", c: 1, d: 8, t: true },
    { n: "斩破命运", ref: "CutThroughFate@0", c: 1, d: 7, m: 2, t: true },
    { n: "防御", ref: "Defend_P@1", c: 1, b: 8, u: 1 },
  ];
  const stanceAfter = stanceBefore.map((card) => card.d ? { ...card, d: card.d * 2 } : card);
  const legacyStanceDelta = { hand: multisetDifference(stanceBefore, stanceAfter) };
  const compactStanceDelta = { hand: handArrayDifference(stanceBefore, stanceAfter) };
  process.stdout.write(`${JSON.stringify({
    fixture: "single-combat-decision",
    repeated_state_bytes_per_followup: bytes(after),
    semantic_delta_bytes_per_followup: deltaBytes,
    followup_reduction_percent: Number(((1 - deltaBytes / bytes(after)) * 100).toFixed(1)),
    repeated_compact_bytes: repeatedCompact,
    initial_plus_semantic_delta_bytes: initialPlusDelta,
    reduction_percent: Number(((1 - initialPlusDelta / repeatedCompact) * 100).toFixed(1)),
    grid_20_card_legacy_bytes: bytes(legacyGridPayload),
    grid_20_card_compact_bytes: bytes(compactGridPayload),
    grid_20_card_reduction_percent: Number(((1 - bytes(compactGridPayload) / bytes(legacyGridPayload)) * 100).toFixed(1)),
    stance_hand_legacy_delta_bytes: bytes(legacyStanceDelta),
    stance_hand_compact_delta_bytes: bytes(compactStanceDelta),
    stance_hand_reduction_percent: Number(((1 - bytes(compactStanceDelta) / bytes(legacyStanceDelta)) * 100).toFixed(1)),
    note: "Synthetic regression fixture; not a published real-run token claim",
  }, null, 2)}\n`);
}
