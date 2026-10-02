// execution responsibilities; dependencies are injected by runtime/index.mjs.
export function createExecution({ config, session }, dependencies = {}) {
  const { settleMs, timeoutMs, batchTimeoutMs } = config;
  const {
    choiceCards,
    decisionState,
    isConnectionError,
    isPlayCardAction,
    isTargetedAction,
    isTimeoutError,
    makeSettlementTimeout,
    markEndTurnSent,
    monsterRosterKey,
    normalitySafetyCheck,
    normalizeChooseArgs,
    normalizeStableCardReference,
    parseState,
    preflightCombatActions,
    rawTool,
    rememberAndCompact,
    resetGameConnection,
    resolvePlayCardAction,
    sleep,
    syncCombatSafety,
    validateToolCall,
    waitForActionSettlement,
  } = dependencies;

  function actionToolCall(action) {
    const { action: kind, ...args } = action;
    if (["play_card", "choose", "use_potion", "discard_potion"].includes(kind)) return { name: kind, args };
    if (["end_turn", "proceed", "skip", "cancel", "confirm"].includes(kind)) return { name: kind, args: {} };
    return null;
  }

  function actionSummary(action, extra = {}) {
    return {
      action: action.action,
      ...(action.card ? { card: action.card } : {}),
      ...(action.card_key ? { k: action.card_key } : {}),
      ...(Number.isFinite(action.cost) ? { cost: action.cost } : {}),
      ...(action.card_name ? { card: action.card_name } : {}),
      ...(!action.card_name && action.card_id ? { card: action.card_id } : {}),
      ...(action.card_index ? { card_index: action.card_index } : {}),
      ...(action.target_index ? { target: action.target_index } : {}),
      ...(action.choice_text ? { choice: action.choice_text } : {}),
      ...(action.choice_uuid ? { choice_uuid: action.choice_uuid } : {}),
      ...(!action.choice_text && action.choice_index ? { choice_index: action.choice_index } : {}),
      ...(action.potion_slot ? { potion_slot: action.potion_slot } : {}),
      ...extra,
    };
  }

  function publicAction(action) {
    const { card_uuid, card_key, expected_cost, cost, ...value } = action;
    if (card_uuid) {
      delete value.card_index;
      delete value.card_name;
      delete value.card_id;
      value.card = card_key ?? session.handHandles.byUuid.get(card_uuid);
    }
    return value;
  }

  function failedBatchReceipt(actions, index, error, certainty, stateRefreshError = undefined) {
    const message = error instanceof Error ? error.message : String(error);
    const errorKind = certainty === "not_sent"
      ? "action_error"
      : isTimeoutError(error)
        ? (certainty === "sent_unknown" ? "transport_timeout" : "verification_timeout")
        : certainty === "sent_unknown"
          ? (error?.code === "DOWNSTREAM_ACTION_ERROR" ? "downstream_error" : "transport_error")
          : "verification_error";
    const failedStatus = certainty === "not_sent"
      ? "not_executed"
      : isTimeoutError(error)
        ? "timeout_unknown"
        : "outcome_unknown";
    return {
      action: "act_many",
      halted: true,
      reason: errorKind.toUpperCase(),
      completed_actions: index,
      ...(index ? { completed: actions.slice(0, index).map((action) => actionSummary(action)) } : {}),
      failed_action: actionSummary(actions[index]),
      failed_action_status: failedStatus,
      execution_certainty: certainty,
      error_kind: errorKind,
      error: message,
      remaining_actions: actions.slice(index + 1).map(publicAction),
      state_status: stateRefreshError ? "last_known" : "refreshed_after_failure",
      ...(stateRefreshError ? {
        state_refresh_error: stateRefreshError instanceof Error ? stateRefreshError.message : String(stateRefreshError),
      } : {}),
    };
  }

  async function settleFailedBatchAction({
    state,
    actions,
    index,
    error,
    certainty,
    timeout = batchTimeoutMs,
  }) {
    let currentState = error?.lastState ?? state;
    let stateRefreshError;
    if (isConnectionError(error)) resetGameConnection();
    if (!isTimeoutError(error)) {
      try {
        await sleep(settleMs);
        currentState = await decisionState({ timeout: Math.min(timeout, 5000) });
        syncCombatSafety(currentState);
      } catch (refreshError) {
        stateRefreshError = refreshError;
      }
    } else {
      stateRefreshError = new Error("Verification deadline expired; no second long refresh was attempted");
    }
    return rememberAndCompact(
      currentState,
      false,
      failedBatchReceipt(actions, index, error, certainty, stateRefreshError),
    );
  }

  async function safeExecuteActions(actions, visualWait = true, timeout = batchTimeoutMs, single = false) {
    let state;
    try {
      state = await decisionState({ timeout });
    } catch (error) {
      if (isConnectionError(error)) resetGameConnection();
      return { result: failedBatchReceipt(actions, 0, error, "not_sent", error) };
    }
    syncCombatSafety(state);

    const isCombatBatch = state.room_phase === "COMBAT" && actions.length > 0;
    let normalizedActions;
    try {
      if (actions.some((action) => Number.isInteger(action.card_index))
          && (!session.observedHandState || session.observedHandState.floor !== state.floor
            || session.observedHandState.turn !== state?.combat_detail?.turn)) {
        throw new Error("SAFETY indexed cards require a current-turn observed hand; refresh state");
      }
      normalizedActions = actions.map((action) => normalizeStableCardReference(action, session.observedHandState ?? state));
      if (isCombatBatch) preflightCombatActions(state, normalizedActions);
    } catch (error) {
      return settleFailedBatchAction({ state, actions, index: 0, error, certainty: "not_sent", timeout });
    }

    for (let index = 0; index < normalizedActions.length; index += 1) {
      let action = normalizedActions[index];
      const beforeRoster = monsterRosterKey(state);
      const beforeTurn = state?.combat_detail?.turn;

      let toolCall;
      const execution = { certainty: "not_sent" };
      const actionStart = state;
      try {
        if (action.action === "wait") {
          await sleep(Math.min(500, Math.max(0, Number(action.ms ?? 100))));
          execution.certainty = "verified";
          state = await decisionState({ timeout });
        } else {
          if (isPlayCardAction(action)) {
            const resolved = resolvePlayCardAction(state, action);
            action = resolved.action;
            normalizedActions[index] = action;
            normalitySafetyCheck(state, [action]);
            toolCall = resolved.toolCall;
          } else toolCall = actionToolCall(action);
          if (toolCall) {
            if (toolCall.name === "choose") {
              toolCall = { ...toolCall, args: normalizeChooseArgs(state, toolCall.args) };
              const selected = choiceCards(state)[toolCall.args.choice_index - 1];
              action = { ...action, choice_index: toolCall.args.choice_index,
                ...(selected?.uuid ? { choice_uuid: selected.uuid } : {}) };
              normalizedActions[index] = action;
            }
            await validateToolCall(toolCall.name, toolCall.args);
          } else {
            throw new Error(`Unsupported action '${action.action}'`);
          }
          const started = Date.now();
          await rawTool(toolCall.name, toolCall.args, { execution, timeout,
            ...(action.action === "end_turn" ? { onDispatch: () => markEndTurnSent(actionStart) } : {}) });
          const remainingTimeout = timeout - (Date.now() - started);
          if (remainingTimeout <= 0) throw makeSettlementTimeout(action, timeout, state);
          const settled = await waitForActionSettlement(action, actionStart, {
            timeout: remainingTimeout, waitForVisual: visualWait,
          });
          state = settled.state;
          execution.certainty = "verified";
          if (isPlayCardAction(action) && state.floor === actionStart.floor
              && state.combat_detail?.turn === beforeTurn) {
            session.combatSafety.trackedCardsPlayed += 1;
          }
        }
        syncCombatSafety(state);
      } catch (error) {
        if (isPlayCardAction(action) && execution.certainty !== "not_sent") session.combatSafety.countUncertain = true;
        return settleFailedBatchAction({
          state,
          actions: normalizedActions,
          index,
          error,
          certainty: execution.certainty,
          timeout,
        });
      }

      const remaining = normalizedActions.slice(index + 1);
      const rosterChanged = monsterRosterKey(state) !== beforeRoster;
      const turnChanged = Number.isFinite(beforeTurn) && state?.combat_detail?.turn !== beforeTurn;
      if (remaining.length && rosterChanged && remaining.some(isTargetedAction)) {
        return {
          halted: true,
          reason: "SAFETY enemy roster changed; remaining targeted actions were not executed because target_index values may have shifted",
          completed_actions: index + 1,
          remaining_actions: remaining.map(publicAction),
          state: rememberAndCompact(state, false, { action: "act_many", completed: index + 1 }),
        };
      }
      if (remaining.length && turnChanged) {
        return {
          halted: true,
          reason: "SAFETY turn changed before the batch ended; remaining actions were not executed",
          completed_actions: index + 1,
          remaining_actions: remaining.map(publicAction),
          state: rememberAndCompact(state, false, { action: "act_many", completed: index + 1 }),
        };
      }
      if (remaining.length && (state.floor !== actionStart.floor
          || state.room_phase !== actionStart.room_phase || state.screen_type !== actionStart.screen_type)) {
        return { halted: true, reason: "SAFETY room or screen changed; inspect the new decision before continuing",
          completed_actions: index + 1, remaining_actions: remaining.map(publicAction),
          state: rememberAndCompact(state, false, { action: "act_many", completed: index + 1 }) };
      }
    }

    return rememberAndCompact(state, false, {
      ...(single ? actionSummary(normalizedActions[0])
        : { action: "act_many", completed: normalizedActions.length }),
      settlement: "verified",
      execution_certainty: "verified",
      timeout_ms: timeout,
    });
  }

  async function callAndSettle(name, args = {}, visualWait = true, timeout = timeoutMs) {
    if (name === "execute_actions") return safeExecuteActions(args.actions ?? [], visualWait, timeout);
    if (actionToolCall({ action: name })) {
      return safeExecuteActions([{ action: name, ...args }], visualWait, timeout, true);
    }
    // Retain legacy diagnostic reads; all public mutations use the same verifier.
    await validateToolCall(name, args);
    const called = await rawTool(name, args);
    if (name === "get_screen_state") return rememberAndCompact(parseState(called.message));
    if (name === "get_game_state") return parseState(called.message);
    return { ok: true, result: called.message };
  }

  return {
    actionToolCall,
    actionSummary,
    publicAction,
    failedBatchReceipt,
    settleFailedBatchAction,
    safeExecuteActions,
    callAndSettle,
  };
}
