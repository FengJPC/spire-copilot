// Extracted unchanged regression fixtures; test state is instance-local.
export async function runSafetySelfTests(runtime) {
  const { session } = runtime;
  const { visualSettleMs } = runtime.config;
  const { resetGameConnection } = runtime.modules.transport;
  const { carryForwardSameTurnIntents, isStableDecisionState, mapMatchesVisibleNodes, mapVersion, resolveAct, waitUntilReady } = runtime.modules.state;
  const { compactCardDefinition, normalizeStableCardReference, pendingCardDefinitionPayload, resetCardCatalog, resolvePlayCardAction } = runtime.modules.cards;
  const { collectContextAdvisories, endTurnHasSettled, lethalRetargetSafetyCheck, markEndTurnSent, normalitySafetyCheck, normalizeChooseArgs, normalizeShopChooseArgs, syncCombatSafety, syncEndTurnSafety } = runtime.modules.safety;
  const { actionSettlementEvidence, handSelectionChoiceHasSettled, makeSettlementTimeout, selectedHandCount, waitForActionSettlement, waitForHandSelectionChoiceSettlement, waitForVisualSettlement } = runtime.modules.settlement;
  const { compactRunDelta, compactState, diffValue, handArrayDifference } = runtime.modules.compaction;
  const { failedBatchReceipt, publicAction } = runtime.modules.execution;
  const { compactPileCards, validateCardInspectionArgs, validatePileInspectionArgs } = runtime.modules.inspection;

  const baseState = {
    floor: 1,
    room_phase: "COMBAT",
    combat_detail: { turn: 1 },
    hand: [
      { id: "Normality", name: "凡庸", type: "CURSE" },
      { id: "Strike_R", name: "打击", damage: 10 },
      { id: "Bash", name: "痛击", damage: 8 },
    ],
    monsters: [
      { id: "A", name: "A", current_hp: 10, block: 0, is_gone: false },
      { id: "B", name: "B", current_hp: 20, block: 0, is_gone: false },
    ],
  };
  const expectThrow = (label, fn) => {
    try {
      fn();
    } catch {
      return;
    }
    throw new Error(`Self-test failed: ${label} did not throw`);
  };

  const expectReject = async (label, fn) => {
    try {
      await fn();
    } catch (error) {
      return error;
    }
    throw new Error(`Self-test failed: ${label} did not reject`);
  };

  for (const pile of ["draw", "discard", "exhaust"]) validatePileInspectionArgs({ pile });
  expectThrow("pile inspection requires a pile", () => validatePileInspectionArgs({}));
  expectThrow("pile inspection rejects unknown piles", () => validatePileInspectionArgs({ pile: "hand" }));
  expectThrow("pile inspection cannot request hidden order", () => validatePileInspectionArgs({ pile: "draw", order: true }));
  const pileCopies = [
    { id: "Strike_P", name: "打击", uuid: "secret-1", cost: 1, damage: 6, is_playable: false },
    { id: "Strike_P", name: "打击", uuid: "secret-2", cost: 1, damage: 6 },
    { id: "Strike_P", name: "打击", uuid: "secret-3", cost: 0, damage: 6 },
    { id: "Strike_P", name: "打击+", uuid: "secret-4", cost: 1, damage: 9, upgrades: 1 },
    { id: "ModCard", name: "Mod", uuid: "secret-5", cost: 1, type: "SKILL", description: "Unknown effect" },
  ];
  const handleCount = session.handHandles.next;
  const pileGroups = compactPileCards(pileCopies);
  if (pileGroups.length !== 4 || pileGroups.reduce((n, card) => n + card.qty, 0) !== 5
      || pileGroups.find((card) => card.n === "打击" && card.c === 1)?.qty !== 2
      || !pileGroups.some((card) => card.ref === "Strike_P@1" && card.d === 9)
      || !pileGroups.some((card) => card.ref === "ModCard@0" && card.text === "Unknown effect")
      || JSON.stringify(pileGroups) !== JSON.stringify(compactPileCards([...pileCopies].reverse()))
      || pileGroups.some((card) => ["uuid", "k", "i", "p"].some((field) => field in card))
      || session.handHandles.next !== handleCount || compactPileCards([]).length !== 0) {
    throw new Error("Self-test failed: pile composition lost multiplicity/variants or exposed order/hand slots");
  }
  session.cardCatalog.definitions.set("Z@0", { id: "Z", n: "Z" });
  session.cardCatalog.definitions.set("A@0", { id: "A", n: "A" });
  session.cardCatalog.definitions.set("Other@0", { id: "Other", n: "Other" });
  const queriedDefinitions = pendingCardDefinitionPayload(new Set(["Z@0", "A@0"]));
  if (JSON.stringify(Object.keys(queriedDefinitions.card_defs)) !== '["A@0","Z@0"]'
      || session.cardCatalog.emittedRefs.has("Other@0")
      || !pendingCardDefinitionPayload().card_defs_added?.["Other@0"]) {
    throw new Error("Self-test failed: pile definitions exposed traversal order or consumed unqueried refs");
  }
  resetCardCatalog();

  const copyState = {
    floor: 50, room_phase: "COMBAT", current_energy: 1,
    combat_detail: { turn: 3 },
    hand: [
      { id: "EmptyBody", name: "化体为空", uuid: "body-expensive", cost: 3, block: 7, is_playable: false },
      { id: "Strike_P", name: "打击", uuid: "strike", cost: 0, damage: 6 },
      { id: "EmptyBody", name: "化体为空", uuid: "body-cheap", cost: 0, block: 7, is_playable: true },
    ],
  };
  const initialCopies = compactState(copyState).hand;
  const cheapKey = initialCopies[2].k;
  if (!cheapKey || initialCopies[0].k === cheapKey || initialCopies[2].i !== 3) {
    throw new Error("Self-test failed: compact hand omitted distinct copy handles and actual positions");
  }
  const cheapest = resolvePlayCardAction(copyState, { action: "play_card", card_name: "化体为空" });
  if (cheapest.action.card_uuid !== "body-cheap" || cheapest.toolCall.name !== "execute_actions"
      || cheapest.toolCall.args.actions[0].card_uuid !== "body-cheap"
      || "card_index" in cheapest.toolCall.args.actions[0]) {
    throw new Error("Self-test failed: same-name play did not select the cheapest playable copy by UUID");
  }
  const bound = normalizeStableCardReference({ action: "play_card", card_index: 3 }, copyState);
  const reorderedCopies = { ...copyState, hand: [copyState.hand[2], copyState.hand[0]] };
  if (bound.card_uuid !== "body-cheap" || bound.card_name
      || resolvePlayCardAction(reorderedCopies, bound).action.card_index !== 1
      || resolvePlayCardAction(reorderedCopies, { action: "play_card", card: cheapKey }).action.card_uuid !== "body-cheap") {
    throw new Error("Self-test failed: indexed/handle actions did not preserve the instance through reindexing");
  }
  expectThrow("missing exact instance must not fall back to its name", () => resolvePlayCardAction(
    { ...copyState, hand: [copyState.hand[0]] }, bound,
  ));
  expectThrow("a spent batch card must not switch to a second copy", () => resolvePlayCardAction(
    { ...copyState, hand: [{ ...copyState.hand[0], cost: 0, is_playable: true }] }, bound,
  ));
  expectThrow("bound cost increase", () => resolvePlayCardAction(
    { ...copyState, hand: [{ ...copyState.hand[2], cost: 1 }] }, bound,
  ));
  expectThrow("unknown short handle", () => resolvePlayCardAction(copyState, { action: "play_card", card: "h99999" }));
  expectThrow("same name with different effects", () => resolvePlayCardAction(
    { ...copyState, hand: [copyState.hand[2], { ...copyState.hand[2], uuid: "modified", block: 20 }] },
    { action: "play_card", card_name: "化体为空" },
  ));
  expectThrow("multiple selectors", () => normalizeStableCardReference(
    { action: "play_card", card: cheapKey, card_name: "化体为空" }, copyState,
  ));
  const costChangedCopies = { ...copyState, hand: [
    { ...copyState.hand[2], cost: 1 }, { ...copyState.hand[0], cost: 0, is_playable: true }, copyState.hand[1],
  ] };
  const preciseDelta = handArrayDifference(initialCopies, compactState(costChangedCopies).hand);
  if (preciseDelta.changed.find((item) => item.key === cheapKey)?.c !== 1
      || preciseDelta.changed.find((item) => item.key === cheapKey)?.i !== 1
      || preciseDelta.added || preciseDelta.removed) {
    throw new Error("Self-test failed: duplicate cost/position changes were assigned to the wrong copy");
  }
  const reconstructed = new Map(initialCopies.map((card) => [card.k, { ...card }]));
  for (const { key, ...patch } of preciseDelta.changed ?? []) {
    const card = reconstructed.get(key);
    for (const [field, value] of Object.entries(patch)) {
      if (value === null) delete card[field];
      else card[field] = value;
    }
  }
  if (JSON.stringify([...reconstructed.values()].sort((a, b) => a.i - b.i))
      !== JSON.stringify(compactState(costChangedCopies).hand)) {
    throw new Error("Self-test failed: instance-keyed delta did not reconstruct the complete ordered hand");
  }
  if (publicAction(bound).card !== cheapKey || "card_uuid" in publicAction(bound)) {
    throw new Error("Self-test failed: recovery actions leaked internal UUID bookkeeping");
  }
  const removedCopies = handArrayDifference(initialCopies, compactState(reorderedCopies).hand);
  if (removedCopies.count !== 2 || removedCopies.removed[0].k !== initialCopies[1].k
      || removedCopies.changed.find((item) => item.key === cheapKey)?.i !== 1) {
    throw new Error("Self-test failed: exact removal and actual hand reindex were not recoverable");
  }
  resetCardCatalog();

  let observedVisualDelay = -1;
  let visualRefreshes = 0;
  const visuallySettled = await waitForVisualSettlement(
    "play_card",
    { marker: "logical" },
    {
      pause: async (delay) => { observedVisualDelay = delay; },
      readState: async () => { visualRefreshes += 1; return { marker: "visual" }; },
    },
  );
  if (observedVisualDelay !== visualSettleMs
      || visualRefreshes !== 1
      || visuallySettled.marker !== "visual") {
    throw new Error("Self-test failed: play-card settlement did not wait for visual pacing and refresh state");
  }
  const nonVisualState = { marker: "unchanged" };
  if (await waitForVisualSettlement("get_state", nonVisualState) !== nonVisualState) {
    throw new Error("Self-test failed: read-only state call received an unnecessary visual delay");
  }

  const actionStart = {
    floor: 8,
    room_phase: "COMBAT",
    screen_type: "NONE",
    current_energy: 3,
    combat_detail: { turn: 2, draw_count: 5, discard_count: 0, exhaust_count: 0, limbo_count: 0 },
    hand: [
      { id: "Shiv", name: "小刀", uuid: "shiv-1", cost: 0 },
      { id: "Shiv", name: "小刀", uuid: "shiv-2", cost: 0 },
    ],
    monsters: [{ id: "A", name: "A", current_hp: 20, block: 0, is_gone: false, intent: "ATTACK" }],
  };
  const actionAfter = {
    ...actionStart,
    hand: actionStart.hand.slice(1),
    combat_detail: { ...actionStart.combat_detail, discard_count: 1 },
    monsters: [{ ...actionStart.monsters[0], current_hp: 16 }],
  };
  if (actionSettlementEvidence(
    { action: "play_card", card_name: "小刀", target_index: 1 },
    actionStart,
    actionStart,
  )) {
    throw new Error("Self-test failed: an unchanged action state was treated as settled");
  }
  if (actionSettlementEvidence(
    { action: "play_card", card_name: "小刀", target_index: 1 },
    actionStart,
    actionAfter,
  ) !== "card_left_hand") {
    throw new Error("Self-test failed: an exact duplicate card instance leaving hand was not detected");
  }
  const unrelated = { ...actionStart, current_energy: 2,
    combat_detail: { ...actionStart.combat_detail, player: { block: 99 } } };
  if (actionSettlementEvidence({ action: "play_card", card_name: "小刀" }, actionStart, unrelated)
      || actionSettlementEvidence({ action: "end_turn" }, actionStart, unrelated)
      || actionSettlementEvidence({ action: "play_card", card_name: "小刀" }, actionStart,
        { ...unrelated, screen_type: "GRID", hand: undefined })) {
    throw new Error("Self-test failed: unrelated state or missing hand verified a strong-postcondition action");
  }
  const potionStart = { ...actionStart, run_detail: { potions: [{ id: "P", can_use: true }, { id: "Q" }] } };
  if (actionSettlementEvidence({ action: "use_potion", potion_slot: 1 }, potionStart,
      { ...potionStart, run_detail: { potions: [{ id: "P", can_use: false }, { id: "Other" }] } })
      || actionSettlementEvidence({ action: "discard_potion", potion_slot: 1 }, potionStart,
        { ...potionStart, run_detail: { potions: undefined } })) {
    throw new Error("Self-test failed: unrelated slot/playability change verified a potion action");
  }

  let virtualNow = 0;
  let actionReads = 0;
  const verifiedAction = await waitForActionSettlement(
    { action: "play_card", card_name: "小刀", target_index: 1 },
    actionStart,
    {
      timeout: 2000,
      now: () => virtualNow,
      pause: async (delay) => { virtualNow += delay; },
      readState: async () => {
        actionReads += 1;
        return actionReads < 2 ? actionStart : actionAfter;
      },
    },
  );
  if (actionReads !== 2 || verifiedAction.evidence !== "card_left_hand" || virtualNow !== visualSettleMs) {
    throw new Error("Self-test failed: action verification did not poll until evidence and honor visual pacing");
  }

  virtualNow = 0;
  const settlementTimeout = await expectReject(
    "action verification has one fixed deadline",
    () => waitForActionSettlement(
      { action: "play_card", card_name: "小刀", target_index: 1 },
      actionStart,
      {
        timeout: 400,
        now: () => virtualNow,
        pause: async (delay) => { virtualNow += delay; },
        readState: async () => actionStart,
      },
    ),
  );
  if (settlementTimeout.code !== "ACTION_SETTLEMENT_TIMEOUT" || virtualNow !== 400) {
    throw new Error("Self-test failed: action verification timeout was not classified at its shared deadline");
  }

  session.combatSafety = { floor: null, turn: null, trackedCardsPlayed: 0, countUncertain: false };
  expectThrow("Normality rejects a fourth queued card", () => normalitySafetyCheck(baseState, [
    { action: "play_card" }, { action: "play_card" }, { action: "play_card" }, { action: "play_card" },
  ]));

  syncCombatSafety(baseState);
  session.combatSafety.trackedCardsPlayed = 2;
  expectThrow("Normality accounts for cards already played", () => normalitySafetyCheck(baseState, [
    { action: "play_card" }, { action: "play_card" },
  ]));

  const noNormality = { ...baseState, hand: baseState.hand.slice(1) };
  expectThrow("Known lethal prevents stale later target", () => lethalRetargetSafetyCheck(noNormality, [
    { action: "play_card", card_name: "打击", target_index: 1 },
    { action: "play_card", card_name: "痛击", target_index: 2 },
  ]));
  lethalRetargetSafetyCheck(
    { ...noNormality, hand: [{ id: "Strike_R", name: "打击", damage: 9 }, noNormality.hand[1]] },
    [
      { action: "play_card", card_name: "打击", target_index: 1 },
      { action: "play_card", card_name: "痛击", target_index: 2 },
    ],
  );

  const shopState = {
    screen_type: "SHOP_SCREEN",
    choice_list: ["purge (125 gold)", "[黑暗之拥+] Cost: 1 POWER (67 gold)", "relic: [冰淇淋] (292 gold)"],
  };
  const resolvedShopChoice = normalizeShopChooseArgs(shopState, { choice_text: "黑暗之拥+" });
  if (resolvedShopChoice.choice_index !== 2 || "choice_text" in resolvedShopChoice) {
    throw new Error("Self-test failed: named shop choice did not resolve to the current index");
  }
  expectThrow("Shop rejects stale numeric-only choices", () => normalizeShopChooseArgs(shopState, { choice_index: 2 }));
  expectThrow("Shop rejects ambiguous named choices", () => normalizeShopChooseArgs(
    { ...shopState, choice_list: ["add potion: [能量药水]", "add potion: [能量药水+]" ] },
    { choice_text: "能量药水" },
  ));

  const handChoiceState = {
    screen_type: "HAND_SELECT",
    choice_list: ["通晓万物+", "化体为空", "灼伤", "灼伤"],
    hand: [
      { id: "Omniscience", name: "通晓万物+", uuid: "omni-1" },
      { id: "EmptyBody", name: "化体为空", uuid: "empty-1" },
      { id: "Burn", name: "灼伤", uuid: "burn-1" },
      { id: "Burn", name: "灼伤", uuid: "burn-2" },
    ],
    screen_state: {
      hand: [
        { id: "Omniscience", name: "通晓万物+", uuid: "omni-1" },
        { id: "EmptyBody", name: "化体为空", uuid: "empty-1" },
        { id: "Burn", name: "灼伤", uuid: "burn-1" },
        { id: "Burn", name: "灼伤", uuid: "burn-2" },
      ],
    },
  };
  const resolvedHandText = normalizeChooseArgs(handChoiceState, { choice_text: "化体为空" });
  if (resolvedHandText.choice_index !== 2 || "choice_text" in resolvedHandText) {
    throw new Error("Self-test failed: named hand choice did not resolve against the latest indices");
  }
  const reindexedHandChoiceState = {
    ...handChoiceState,
    choice_list: handChoiceState.choice_list.slice(1),
    hand: handChoiceState.hand.slice(1),
    screen_state: { hand: handChoiceState.screen_state.hand.slice(1) },
  };
  if (normalizeChooseArgs(reindexedHandChoiceState, { choice_text: "化体为空" }).choice_index !== 1) {
    throw new Error("Self-test failed: named hand choice reused its stale pre-selection index");
  }
  const resolvedHandUuid = normalizeChooseArgs(handChoiceState, { choice_uuid: "burn-2" });
  if (resolvedHandUuid.choice_index !== 4 || "choice_uuid" in resolvedHandUuid) {
    throw new Error("Self-test failed: UUID hand choice did not resolve an exact duplicate card");
  }
  expectThrow("Hand selection rejects stale numeric-only choices", () => normalizeChooseArgs(
    handChoiceState,
    { choice_index: 2 },
  ));
  expectThrow("Hand selection rejects ambiguous named choices", () => normalizeChooseArgs(
    handChoiceState,
    { choice_text: "灼伤" },
  ));

  const endTurnState = { floor: 9, room_phase: "COMBAT", combat_detail: { turn: 4 } };
  session.turnTransitionSafety = { floor: null, turn: null, endTurnSent: false };
  markEndTurnSent(endTurnState);
  expectThrow("Duplicate end_turn is rejected on the same turn", () => markEndTurnSent(endTurnState));
  session.combatSafety = { floor: 9, turn: 4, trackedCardsPlayed: 2, countUncertain: true };
  resetGameConnection();
  if (!session.turnTransitionSafety.endTurnSent || !session.combatSafety.countUncertain
      || session.combatSafety.trackedCardsPlayed !== 2) throw new Error("Self-test failed: reconnect erased pending safety state");
  syncEndTurnSafety({ floor: 9, room_phase: "COMBAT" });
  syncEndTurnSafety({ ...endTurnState, combat_detail: { turn: 3 } });
  syncCombatSafety({ floor: 9, room_phase: "COMBAT" });
  syncCombatSafety({ ...endTurnState, combat_detail: { turn: 3 } });
  expectThrow("Incomplete or backward metadata cannot release an end-turn fence", () => markEndTurnSent(endTurnState));
  if (!session.combatSafety.countUncertain) throw new Error("Self-test failed: incomplete metadata cleared uncertain counts");
  syncEndTurnSafety({ ...endTurnState, combat_detail: { turn: 5 } });
  markEndTurnSent({ ...endTurnState, combat_detail: { turn: 5 } });
  const endTurnStart = { floor: endTurnState.floor, turn: endTurnState.combat_detail.turn };
  if (endTurnHasSettled(endTurnStart, endTurnState)) {
    throw new Error("Self-test failed: unchanged turn was treated as settled");
  }
  if (!endTurnHasSettled(endTurnStart, { ...endTurnState, combat_detail: { turn: 5 } })) {
    throw new Error("Self-test failed: advanced turn was not treated as settled");
  }
  if (!endTurnHasSettled(endTurnStart, { floor: 9, room_phase: "COMPLETE" })) {
    throw new Error("Self-test failed: combat completion was not treated as settled");
  }
  if (endTurnHasSettled(endTurnStart, {}) || endTurnHasSettled(endTurnStart,
    { ...endTurnState, combat_detail: { turn: 3 } })) throw new Error("Self-test failed: missing/backward metadata settled end_turn");

  const liveCombatRewardFrame = {
    ready_for_command: true,
    room_phase: "COMPLETE",
    screen_type: "COMBAT_REWARD",
    screen_state: { rewards: [] },
    combat_detail: { turn: 5 },
    monsters: [{ id: "Collector", current_hp: 120, is_gone: false, intent: "ATTACK" }],
  };
  if (isStableDecisionState(liveCombatRewardFrame)) {
    throw new Error("Self-test failed: transient combat reward with live monsters was treated as stable");
  }
  if (!isStableDecisionState({
    ...liveCombatRewardFrame,
    combat_detail: undefined,
    monsters: [],
    screen_state: { rewards: [{ reward_type: "GOLD", gold: 25 }] },
  })) {
    throw new Error("Self-test failed: completed combat reward was treated as transient");
  }

  const handSelectStart = {
    ready_for_command: true,
    room_phase: "COMBAT",
    screen_type: "HAND_SELECT",
    can_proceed: false,
    screen_state: { selected: [] },
  };
  if (handSelectionChoiceHasSettled(handSelectStart, {
    ready_for_command: true,
    room_phase: "COMPLETE",
    screen_type: "COMBAT_REWARD",
    can_proceed: true,
    screen_state: { rewards: [] },
  })) {
    throw new Error("Self-test failed: transient combat reward settled a HAND_SELECT choice");
  }
  if (handSelectionChoiceHasSettled(handSelectStart, {
    ...handSelectStart,
    screen_type: "NONE",
    can_proceed: false,
  })) {
    throw new Error("Self-test failed: transient NONE screen settled a HAND_SELECT choice");
  }
  let handSelectionReads = 0;
  const settledHandSelection = await waitForHandSelectionChoiceSettlement(handSelectStart, {
    timeout: 1000,
    pause: async () => {},
    readState: async () => {
      handSelectionReads += 1;
      if (handSelectionReads === 1) {
        return { ...handSelectStart, screen_type: "COMBAT_REWARD", room_phase: "COMPLETE", can_proceed: true };
      }
      if (handSelectionReads === 2) return { ...handSelectStart, screen_type: "NONE" };
      return {
        ...handSelectStart,
        can_proceed: true,
        screen_state: { selected: [{ id: "Reflex", name: "本能反应+" }] },
      };
    },
  });
  if (handSelectionReads !== 3 || settledHandSelection.screen_type !== "HAND_SELECT"
      || selectedHandCount(settledHandSelection) !== 1) {
    throw new Error("Self-test failed: HAND_SELECT choice did not ignore transient screens");
  }

  const compactMenu = compactState({ ready_for_command: true, screen_type: "MAIN_MENU" });
  if ("hp" in compactMenu || "floor" in compactMenu || "gold" in compactMenu) {
    throw new Error("Self-test failed: unavailable main-menu values leaked into compact state");
  }

  const compactEvent = compactState({
    ready_for_command: true,
    screen_type: "EVENT",
    choice_list: ["first", "second"],
    screen_state: { options: [{ choice_index: 0 }, { choice_index: 1 }] },
  });
  if (compactEvent.choices[0].i !== 1 || compactEvent.choices[1].i !== 2
      || compactEvent.details.options[0].i !== 1
      || compactEvent.details.options[1].i !== 2) {
    throw new Error("Self-test failed: displayed choices were not normalized to 1-based indices");
  }

  const compactMap = compactState({
    ready_for_command: true,
    screen_type: "MAP",
    map_version: "act-1-1",
    map: [{ x: 1, y: 0, symbol: "M", children: [{ x: 2, y: 1 }] }],
  });
  if (compactMap.map_ref !== "act-1-1" || compactMap.map?.[0]?.s !== "M" || compactMap.map[0].to?.[0]?.join(",") !== "2,1") {
    throw new Error("Self-test failed: full map graph was not compacted correctly");
  }

  const compactHandChoices = compactState({
    ready_for_command: true,
    screen_type: "HAND_SELECT",
    choice_list: handChoiceState.choice_list,
    hand: handChoiceState.hand,
    screen_state: handChoiceState.screen_state,
  });
  if (compactHandChoices.choices[1].choice_uuid !== "empty-1"
      || compactHandChoices.choices[1].card_id !== "EmptyBody") {
    throw new Error("Self-test failed: compact hand choices omitted stable card identities");
  }

  const compactGrid = compactState({
    ready_for_command: true,
    screen_type: "GRID",
    choice_list: ["化体为空+", "时之沙"],
    screen_state: {
      cards: [
        { id: "EmptyBody", name: "化体为空+", uuid: "empty-up", upgrades: 1, cost: 1, block: 10 },
        { id: "SandsOfTime", name: "时之沙", uuid: "sands", cost: 0, damage: 20, has_target: true },
      ],
      selected_cards: [],
      num_cards: 2,
      any_number: false,
      confirm_up: false,
    },
  });
  if (compactGrid.details.cards
      || compactGrid.details.num_cards !== 2
      || compactGrid.choices[0].ref !== "EmptyBody@1"
      || compactGrid.choices[0].b !== 10
      || compactGrid.choices[1].choice_uuid !== "sands") {
    throw new Error("Self-test failed: GRID choices were not compacted without losing stable or dynamic card data");
  }

  const upgradedDefinition = compactCardDefinition({
    id: "EmptyBody",
    name: "化体为空",
    type: "SKILL",
    rarity: "COMMON",
    cost: 1,
    base_block: 7,
    description: "获得 !B! 点 格挡 。 NL 退出当前 姿态 。",
    upgraded: { name: "化体为空+", base_block: 10 },
  }, 1);
  if (upgradedDefinition.n !== "化体为空+"
      || upgradedDefinition.b !== 10
      || upgradedDefinition.u !== 1
      || upgradedDefinition.text.includes("NL")) {
    throw new Error("Self-test failed: upgraded card definition was not normalized correctly");
  }

  resetCardCatalog();
  session.cardCatalog.definitions.set("EmptyBody@1", upgradedDefinition);
  const initialDefinitionPayload = pendingCardDefinitionPayload();
  if (!initialDefinitionPayload.card_defs?.["EmptyBody@1"]
      || Object.keys(pendingCardDefinitionPayload()).length !== 0) {
    throw new Error("Self-test failed: initial card definitions were not emitted exactly once");
  }
  session.cardCatalog.definitions.set("Insight@0", { id: "Insight", n: "洞见", text: "抽2张牌。" });
  if (!pendingCardDefinitionPayload().card_defs_added?.["Insight@0"]) {
    throw new Error("Self-test failed: a newly discovered card definition was not emitted incrementally");
  }
  expectThrow("Card inspection requires one selector", () => validateCardInspectionArgs({}));
  expectThrow("Card inspection rejects ambiguous selectors", () => validateCardInspectionArgs({
    card_id: "EmptyBody",
    card_name: "化体为空",
  }));
  resetCardCatalog();

  if (resolveAct({
    floor: 17,
    screen_type: "MAP",
    screen_state: { first_node_chosen: false, current_node: { y: -1 } },
  }) !== 2 || resolveAct({ floor: 18, screen_type: "NONE" }) !== 2) {
    throw new Error("Self-test failed: act transition was not inferred from the floor and start map");
  }
  if (resolveAct({ floor: 18 }, { act: 3 }) !== 3) {
    throw new Error("Self-test failed: an explicit game act did not override floor inference");
  }
  if (resolveAct({
    floor: 34,
    screen_type: "MAP",
    screen_state: { first_node_chosen: false, current_node: { y: -1 } },
  }, { act: 2 }) !== 3) {
    throw new Error("Self-test failed: stale downstream act overrode the next act's start map");
  }
  if (resolveAct({
    floor: 34,
    screen_type: "MAP",
    screen_state: { first_node_chosen: false, current_node: { x: -1, y: 15 } },
  }, { act: 2 }) !== 3) {
    throw new Error("Self-test failed: stale boss-row start-map coordinates hid the next act");
  }
  if (mapMatchesVisibleNodes({
    screen_state: { next_nodes: [{ x: 0, y: 0 }, { x: 4, y: 0 }] },
  }, [{ x: 0, y: 0 }, { x: 1, y: 0 }])) {
    throw new Error("Self-test failed: a stale previous-act map matched incompatible visible entrances");
  }
  const sameSizeMapA = [{ x: 0, y: 0, symbol: "M", children: [{ x: 1, y: 1 }] }];
  const sameSizeMapB = [{ x: 0, y: 0, symbol: "M", children: [{ x: 2, y: 1 }] }];
  if (mapVersion(2, sameSizeMapA) === mapVersion(2, sameSizeMapB)) {
    throw new Error("Self-test failed: distinct same-size map topologies shared a version");
  }

  const compactPlayerStatus = compactState({
    ready_for_command: true,
    screen_type: "NONE",
    combat_detail: {
      turn: 3,
      player: {
        stance: "Calm",
        powers: [
          { id: "Frail", amount: 2, just_applied: true },
          { id: "Strength", amount: -1 },
        ],
      },
      draw_count: 0,
      discard_count: 0,
      exhaust_count: 0,
    },
  });
  if (compactPlayerStatus.stance !== "Calm"
      || compactPlayerStatus.powers[0]?.id !== "Frail"
      || compactPlayerStatus.powers[0]?.n !== 2
      || compactPlayerStatus.powers[0]?.just_applied !== true
      || compactPlayerStatus.powers[1]?.n !== -1) {
    throw new Error("Self-test failed: compact player status dropped a stance or debuff field");
  }

  const semanticHandDelta = diffValue(
    { hand: [{ n: "打击", c: 1 }, { n: "防御", c: 1 }] },
    { hand: [{ n: "防御", c: 1 }] },
  );
  if (semanticHandDelta.hand.count !== 1
      || semanticHandDelta.hand.removed?.[0]?.n !== "打击"
      || semanticHandDelta.hand.added) {
    throw new Error("Self-test failed: hand delta was not semantic");
  }

  const scaledHandDelta = diffValue(
    { hand: [{ n: "打击", ref: "Strike_R@0", c: 1, d: 6, t: true }, { n: "防御", ref: "Defend_R@0", c: 1, b: 5 }] },
    { hand: [{ n: "打击", ref: "Strike_R@0", c: 1, d: 12, t: true }, { n: "防御", ref: "Defend_R@0", c: 1, b: 5 }] },
  );
  if (scaledHandDelta.hand.changed?.[0]?.key !== "Strike_R@0"
      || scaledHandDelta.hand.changed[0].d !== 12
      || scaledHandDelta.hand.count !== 2
      || scaledHandDelta.hand.removed
      || scaledHandDelta.hand.added) {
    throw new Error("Self-test failed: hand stat update was expanded into remove/add churn");
  }

  const duplicateHandDelta = diffValue(
    { hand: [{ n: "化体为空", ref: "EmptyBody@0", c: 1 }, { n: "化体为空", ref: "EmptyBody@0", c: 1 }] },
    { hand: [{ n: "化体为空", ref: "EmptyBody@0", c: 1 }, { n: "化体为空", ref: "EmptyBody@0", c: 0 }] },
  );
  if (duplicateHandDelta.hand.changed?.length !== 1
      || duplicateHandDelta.hand.changed[0].c !== 0
      || duplicateHandDelta.hand.count !== 2
      || duplicateHandDelta.hand.removed
      || duplicateHandDelta.hand.added) {
    throw new Error("Self-test failed: duplicate hand refs did not preserve an in-place stat update");
  }

  const shiv = { n: "小刀", ref: "Shiv@0", c: 0, d: 4, t: true, x: true };
  const threeShivsAdded = diffValue(
    { hand: [] },
    { hand: [shiv, shiv, shiv] },
  );
  if (threeShivsAdded.hand.count !== 3 || threeShivsAdded.hand.added?.length !== 3) {
    throw new Error("Self-test failed: three identical added cards lost their multiplicity");
  }
  const threeShivsRemoved = diffValue(
    { hand: [shiv, shiv, shiv] },
    { hand: [] },
  );
  if (threeShivsRemoved.hand.count !== 0 || threeShivsRemoved.hand.removed?.length !== 3) {
    throw new Error("Self-test failed: three identical removed cards lost their multiplicity");
  }
  const twoMoreShivsAdded = diffValue(
    { hand: [shiv] },
    { hand: [shiv, shiv, shiv] },
  );
  if (twoMoreShivsAdded.hand.count !== 3 || twoMoreShivsAdded.hand.added?.length !== 2) {
    throw new Error("Self-test failed: identical hand additions did not preserve the existing copy");
  }
  const emptyCompactHand = compactState({
    ready_for_command: true,
    room_phase: "COMBAT",
    screen_type: "NONE",
    hand: [],
    combat_detail: { turn: 2, draw_count: 0, discard_count: 5, exhaust_count: 3 },
  });
  if (!Array.isArray(emptyCompactHand.hand) || emptyCompactHand.hand.length !== 0) {
    throw new Error("Self-test failed: an empty live hand was omitted from compact state");
  }

  const targetAdjustedDamage = compactState({
    ready_for_command: true,
    screen_type: "NONE",
    hand: [{ id: "Strike_R", name: "打击", cost: 1, damage: 8, has_target: true }],
    monsters: [{ name: "易伤目标", current_hp: 20, max_hp: 20, is_gone: false, powers: [{ id: "Vulnerable", amount: 1 }] }],
  });
  if (targetAdjustedDamage.hand[0]?.d !== 8 || targetAdjustedDamage.hand[0]?.ed !== 12) {
    throw new Error("Self-test failed: target-adjusted damage estimate omitted vulnerability");
  }
  const multiTargetDamage = compactState({
    ready_for_command: true,
    screen_type: "NONE",
    hand: [{ id: "Strike_R", name: "打击", cost: 1, damage: 8, has_target: true }],
    monsters: [
      { name: "易伤目标", current_hp: 20, max_hp: 20, is_gone: false, powers: [{ id: "Vulnerable", amount: 1 }] },
      { name: "普通目标", current_hp: 20, max_hp: 20, is_gone: false, powers: [] },
    ],
  });
  if (multiTargetDamage.hand[0]?.ed?.[1] !== 12 || multiTargetDamage.hand[0]?.ed?.[2] !== undefined) {
    throw new Error("Self-test failed: multi-target damage estimate did not isolate modified enemies");
  }

  const semanticEnemyDelta = diffValue(
    { enemies: [{ i: 1, n: "大颚虫", hp: "44/44" }] },
    { enemies: [{ i: 1, n: "大颚虫", hp: "36/44" }] },
  );
  if (semanticEnemyDelta.enemies.changed?.[0]?.hp !== "36/44") {
    throw new Error("Self-test failed: enemy delta did not isolate the changed entity");
  }

  const partialBatchFailure = failedBatchReceipt(
    [
      { action: "play_card", card_name: "旋身+" },
      { action: "play_card", card_name: "化体为空+" },
      { action: "end_turn" },
    ],
    1,
    new Error("play_card: Card not found in hand: 化体为空+"),
    "not_sent",
  );
  if (partialBatchFailure.completed_actions !== 1
      || partialBatchFailure.completed?.[0]?.card !== "旋身+"
      || partialBatchFailure.failed_action?.card !== "化体为空+"
      || partialBatchFailure.failed_action_status !== "not_executed"
      || partialBatchFailure.remaining_actions?.[0]?.action !== "end_turn"
      || partialBatchFailure.state_status !== "refreshed_after_failure") {
    throw new Error("Self-test failed: partial batch failure lost its completed, failed, or remaining action receipt");
  }
  if (failedBatchReceipt(
    [{ action: "end_turn" }],
    0,
    makeSettlementTimeout({ action: "end_turn" }, 20000, endTurnState),
    "accepted",
  ).failed_action_status !== "timeout_unknown") {
    throw new Error("Self-test failed: an accepted action with expired verification was not reported as timeout_unknown");
  }

  const runDelta = compactRunDelta(
    { deck: [], relics: [{ id: "Ring", n: "蛇之戒指" }], potions: [] },
    { deck: [], relics: [{ id: "Ring", n: "蛇之戒指" }, { id: "Letter Opener", n: "开信刀" }], potions: [] },
  );
  if (runDelta.run_delta?.relic_changes?.changed?.[0]?.added?.n !== "开信刀") {
    throw new Error("Self-test failed: newly acquired relic was not reported");
  }

  if (isStableDecisionState({
    room_phase: "COMBAT",
    current_energy: 0,
    combat_detail: { turn: 1, draw_count: 12 },
    monsters: [{ name: "敌人", intent: "DEBUG", is_gone: false }],
  })) {
    throw new Error("Self-test failed: transient DEBUG combat state was treated as stable");
  }
  const knownIntentState = {
    floor: 31,
    room_phase: "COMBAT",
    combat_detail: { turn: 2 },
    monsters: [{ id: "Spiker", name: "钉刺机", current_hp: 40, intent: "ATTACK", move: { damage: 7 } }],
  };
  const repairedIntentState = carryForwardSameTurnIntents({
    ...knownIntentState,
    monsters: [{ id: "Spiker", name: "钉刺机", current_hp: 22, intent: "DEBUG" }],
  }, knownIntentState);
  if (repairedIntentState.monsters[0].intent !== "ATTACK"
      || repairedIntentState.monsters[0].current_hp !== 22
      || repairedIntentState.monsters[0].move?.damage !== 7) {
    throw new Error("Self-test failed: same-turn DEBUG intent did not preserve fresh combat values");
  }
  const nextTurnIntentState = carryForwardSameTurnIntents({
    ...knownIntentState,
    combat_detail: { turn: 3 },
    monsters: [{ id: "Spiker", name: "钉刺机", current_hp: 22, intent: "DEBUG" }],
  }, knownIntentState);
  if (nextTurnIntentState.monsters[0].intent !== "DEBUG") {
    throw new Error("Self-test failed: an intent was carried across a turn boundary");
  }

  let screenReads = 0;
  const settledEvent = await waitUntilReady({
    timeout: 1000,
    pause: async () => {},
    readScreen: async () => {
      screenReads += 1;
      if (screenReads === 1) throw new Error("get_screen_state: Internal error: null");
      return { ready_for_command: true, screen_type: "EVENT" };
    },
  });
  if (screenReads !== 2 || settledEvent.screen_type !== "EVENT") {
    throw new Error("Self-test failed: transient event screen read was not retried");
  }

  let unrelatedErrorWasRetried = false;
  try {
    await waitUntilReady({
      timeout: 1000,
      pause: async () => {},
      readScreen: async () => {
        if (unrelatedErrorWasRetried) return { ready_for_command: true, screen_type: "EVENT" };
        unrelatedErrorWasRetried = true;
        throw new Error("get_screen_state: permission denied");
      },
    });
    throw new Error("Self-test failed: unrelated screen read error was suppressed");
  } catch (error) {
    if (error.message !== "get_screen_state: permission denied") throw error;
  }

  session.advisoryKeys = new Set();
  const advisoryCombat = {
    floor: 42,
    room_phase: "COMBAT",
    screen_type: "NONE",
    combat_detail: { turn: 1, player: { stance: "Neutral" } },
    hand: [{ id: "Normality", name: "凡庸" }],
    monsters: [{
      id: "Spiker",
      name: "钉刺机",
      current_hp: 40,
      max_hp: 40,
      is_gone: false,
      intent: "ATTACK",
      move: { damage: 7, hits: 1 },
      powers: [{ id: "Thorns", amount: 5 }],
    }],
  };
  const firstAdvisories = collectContextAdvisories(advisoryCombat);
  if (!firstAdvisories.some(({ id }) => id === "per-hit-retaliation")
      || !firstAdvisories.some(({ id }) => id === "normality")
      || collectContextAdvisories(advisoryCombat).length !== 0) {
    throw new Error("Self-test failed: contextual advisories were missing or repeated in one combat turn");
  }
  const nextTurnAdvisories = collectContextAdvisories({
    ...advisoryCombat,
    combat_detail: { turn: 2, player: { stance: "Neutral" } },
  });
  if (nextTurnAdvisories.length !== 1 || nextTurnAdvisories[0].id !== "normality") {
    throw new Error("Self-test failed: turn-scoped Normality advisory did not refresh exactly once");
  }
  const timeEaterAdvisories = collectContextAdvisories({
    ...advisoryCombat,
    hand: [],
    monsters: [{
      id: "TimeEater",
      name: "时间吞噬者",
      current_hp: 456,
      max_hp: 456,
      is_gone: false,
      intent: "ATTACK",
      move: { damage: 8, hits: 3 },
      powers: [{ id: "Time Warp", amount: 0 }],
    }],
  });
  if (!timeEaterAdvisories.some(({ id }) => id === "time-eater")) {
    throw new Error("Self-test failed: boss identity did not produce a contextual advisory");
  }
  const restAdvisories = collectContextAdvisories({
    floor: 43,
    room_phase: "COMPLETE",
    screen_type: "REST",
    run_detail: { relics: [{ id: "Coffee Dripper", name: "咖啡滤杯" }] },
  });
  if (restAdvisories.length !== 1 || restAdvisories[0].id !== "coffee-dripper") {
    throw new Error("Self-test failed: Coffee Dripper Rest advisory was not emitted");
  }

  session.combatSafety = { floor: null, turn: null, trackedCardsPlayed: 0, countUncertain: false };
  session.turnTransitionSafety = { floor: null, turn: null, endTurnSent: false };
  session.advisoryKeys = new Set();
  process.stdout.write("Self-tests passed: safety guards, per-action deadlines, contextual advisories, stable combat state, transient reward, event and hand-selection reads, 1-based choices, act-aware map graph, semantic delta, on-demand unordered piles, and run changes\n");
}
