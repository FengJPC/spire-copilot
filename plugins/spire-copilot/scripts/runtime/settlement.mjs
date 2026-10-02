// settlement responsibilities; dependencies are injected by runtime/index.mjs.
export function createSettlement({ config, session }, dependencies = {}) {
  const { pollMs, visualSettleMs, timeoutMs, batchTimeoutMs } = config;
  const {
    cardForAction,
    cardIdentityMatches,
    choiceCards,
    decisionState,
    endTurnHasSettled,
    isPlayCardAction,
    isTimeoutError,
    monsterRosterKey,
    sleep,
  } = dependencies;

  function visualDelayForAction(name) {
    if (["play_card", "use_potion", "end_turn"].includes(name)) return visualSettleMs;
    if (["choose", "confirm", "proceed", "skip", "cancel", "discard_potion"].includes(name)) {
      return Math.min(300, visualSettleMs);
    }
    return 0;
  }

  async function waitForVisualSettlement(
    name,
    state,
    { pause = sleep, readState = decisionState } = {},
  ) {
    const delay = visualDelayForAction(name);
    if (delay <= 0) return state;
    await pause(delay);
    return readState();
  }

  async function waitForEndTurnSettlement(start, { timeout = timeoutMs } = {}) {
    const started = Date.now();
    let state;
    do {
      await sleep(pollMs);
      state = await decisionState({ timeout: Math.max(1, timeout - (Date.now() - started)) });
      if (endTurnHasSettled(start, state)) return state;
      if (Date.now() - started >= timeout) {
        throw new Error(
          `Timed out after ${timeout}ms waiting for end_turn to settle from floor ${start.floor}, turn ${start.turn}. `
          + "The command was already sent; inspect state but do not resend end_turn.",
        );
      }
    } while (true);
  }

  function selectedHandCount(state) {
    return Array.isArray(state?.screen_state?.selected) ? state.screen_state.selected.length : 0;
  }

  function handSelectionChoiceHasSettled(start, state) {
    if (start?.screen_type !== "HAND_SELECT" || state?.screen_type !== "HAND_SELECT") return false;
    return state.can_proceed === true && selectedHandCount(state) > selectedHandCount(start);
  }

  async function waitForHandSelectionChoiceSettlement(
    start,
    { timeout = timeoutMs, readState, pause = sleep } = {},
  ) {
    const started = Date.now();
    let state;
    do {
      await pause(pollMs);
      const read = readState ?? (() => decisionState({
        timeout: Math.max(1, timeout - (Date.now() - started)),
      }));
      state = await read();
      if (handSelectionChoiceHasSettled(start, state)) return state;
      if (Date.now() - started >= timeout) {
        throw new Error(
          `Timed out after ${timeout}ms waiting for the HAND_SELECT choice to expose confirm. `
          + "The choice was already sent; inspect state but do not resend it.",
        );
      }
    } while (true);
  }

  function actionTransitionEvidence(start, state) {
    if (state?.floor !== start?.floor) return "floor_changed";
    if (state?.room_phase !== start?.room_phase) return "room_phase_changed";
    if (state?.screen_type !== start?.screen_type) return "screen_changed";
    const beforeTurn = start?.combat_detail?.turn;
    const afterTurn = state?.combat_detail?.turn;
    if (Number.isFinite(beforeTurn) && Number.isFinite(afterTurn) && afterTurn !== beforeTurn) {
      return "turn_changed";
    }
    if (monsterRosterKey(state) !== monsterRosterKey(start)) return "enemy_roster_changed";
    return undefined;
  }

  function actionObservableState(state) {
    return {
      energy: state?.current_energy,
      hand: (state?.hand ?? []).map((card) => ({
        uuid: card.uuid,
        id: card.id,
        name: card.name,
        cost: card.cost,
        playable: card.is_playable,
      })),
      combat: state?.combat_detail ? {
        player: state.combat_detail.player,
        draw: state.combat_detail.draw_count,
        discard: state.combat_detail.discard_count,
        exhaust: state.combat_detail.exhaust_count,
        limbo: state.combat_detail.limbo_count,
        discarded: state.combat_detail.cards_discarded_this_turn,
      } : undefined,
      monsters: (state?.monsters ?? []).map((monster) => ({
        id: monster.id,
        name: monster.name,
        hp: monster.current_hp,
        block: monster.block,
        gone: monster.is_gone,
        intent: monster.intent,
        powers: monster.powers,
      })),
      potions: state?.run_detail?.potions,
      relics: (state?.run_detail?.relics ?? []).map((relic) => ({ id: relic.id, counter: relic.counter })),
      choices: state?.choice_list,
      canProceed: state?.can_proceed,
      screen: state?.screen_state,
    };
  }

  function actionSettlementEvidence(action, start, state) {
    if (action.action === "end_turn") {
      return endTurnHasSettled({ floor: start.floor, turn: start.combat_detail?.turn }, state)
        ? "turn_or_combat_completed" : undefined;
    }
    if (isPlayCardAction(action)) {
      const selected = cardForAction(start, action);
      if (selected && Array.isArray(state?.hand)
          && !state.hand.some((card) => cardIdentityMatches(card, selected))) {
        return "card_left_hand";
      }
      // A screen/HP/block change cannot prove that this exact card was played.
      // Immediate-return Mod cards may conservatively time out without a richer
      // upstream execution receipt; never substitute unrelated state changes.
      return undefined;
    }
    if (["use_potion", "discard_potion"].includes(action.action)) {
      const before = start.run_detail?.potions;
      const after = state.run_detail?.potions;
      const index = action.potion_slot - 1;
      return Array.isArray(before) && Array.isArray(after) && before[index] && !before[index].is_empty
        && (before[index].id !== after[index]?.id || after[index]?.is_empty === true)
          ? "potion_slot_changed" : undefined;
    }
    const transition = actionTransitionEvidence(start, state);
    const navigated = ["floor_changed", "room_phase_changed", "screen_changed"].includes(transition);
    if (action.action === "choose") {
      if (navigated) return transition;
      const selected = choiceCards(start).find((card) => action.choice_uuid && card.uuid === action.choice_uuid)
        ?? choiceCards(start)[action.choice_index - 1];
      if (selected?.uuid) {
        const selectedIn = (snapshot) => [
          ...(snapshot.screen_state?.selected ?? []), ...(snapshot.screen_state?.selected_cards ?? []),
        ].filter((card) => card.uuid === selected.uuid).length;
        if (selectedIn(start) !== selectedIn(state)) return "selected_card_changed";
        const hasChoices = state.screen_type === "HAND_SELECT"
          ? Array.isArray(state.screen_state?.hand) || Array.isArray(state.hand)
          : Array.isArray(state.screen_state?.cards);
        if (hasChoices && !choiceCards(state).some((card) => card.uuid === selected.uuid)) return "choice_card_removed";
      }
      const text = start.choice_list?.[action.choice_index - 1];
      if (text !== undefined && Array.isArray(state.choice_list)
          && state.choice_list.filter((item) => item === text).length
            < start.choice_list.filter((item) => item === text).length) return "chosen_option_removed";
      if (start.screen_type === "EVENT"
          && start.screen_state?.body_text !== state.screen_state?.body_text) return "event_advanced";
      return undefined;
    }
    if (["confirm", "proceed", "skip", "cancel"].includes(action.action)) {
      if (navigated) return transition;
      const screen = (snapshot) => ({ choices: snapshot.choice_list,
        canProceed: snapshot.can_proceed, detail: snapshot.screen_state });
      if (JSON.stringify(screen(start)) !== JSON.stringify(screen(state))) return "control_screen_changed";
    }
    return undefined;
  }

  function makeSettlementTimeout(action, timeout, lastState) {
    const error = new Error(
      `Timed out after ${timeout}ms waiting for ${action.action} result verification. `
      + "The command was already accepted; inspect state but do not resend it.",
    );
    error.code = "ACTION_SETTLEMENT_TIMEOUT";
    error.lastState = lastState;
    return error;
  }

  async function waitForActionSettlement(
    action,
    start,
    {
      timeout = batchTimeoutMs,
      waitForVisual = true,
      readState = (remaining) => decisionState({ timeout: remaining }),
      pause = sleep,
      now = Date.now,
    } = {},
  ) {
    const started = now();
    let lastState = start;
    do {
      const elapsed = now() - started;
      const remainingBeforePause = timeout - elapsed;
      if (remainingBeforePause <= 0) throw makeSettlementTimeout(action, timeout, lastState);
      await pause(Math.min(pollMs, remainingBeforePause));

      const remaining = timeout - (now() - started);
      if (remaining <= 0) throw makeSettlementTimeout(action, timeout, lastState);
      try {
        lastState = await readState(Math.max(1, remaining));
      } catch (error) {
        if (isTimeoutError(error)) throw makeSettlementTimeout(action, timeout, lastState);
        error.code ??= "ACTION_VERIFICATION_ERROR";
        error.lastState ??= lastState;
        throw error;
      }

      const evidence = actionSettlementEvidence(action, start, lastState);
      if (!evidence) continue;

      const minimumPacing = waitForVisual ? visualDelayForAction(action.action) : 0;
      const pacingRemaining = minimumPacing - (now() - started);
      if (pacingRemaining > 0) {
        if (pacingRemaining > timeout - (now() - started)) {
          throw makeSettlementTimeout(action, timeout, lastState);
        }
        await pause(pacingRemaining);
      }
      return { state: lastState, evidence, elapsedMs: now() - started };
    } while (true);
  }

  return {
    visualDelayForAction,
    waitForVisualSettlement,
    waitForEndTurnSettlement,
    selectedHandCount,
    handSelectionChoiceHasSettled,
    waitForHandSelectionChoiceSettlement,
    actionTransitionEvidence,
    actionObservableState,
    actionSettlementEvidence,
    makeSettlementTimeout,
    waitForActionSettlement,
  };
}
