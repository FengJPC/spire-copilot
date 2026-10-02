// safety responsibilities; dependencies are injected by runtime/index.mjs.
export function createSafety({ config, session }, dependencies = {}) {
  const {
    cardRef,
    cardForAction,
    choiceCards,
    entityHasPower,
    entityMatches,
    liveMonsters,
    stateHasRelic,
  } = dependencies;

  const NORMALITY_IDS = new Set(["Normality"]);

  const NORMALITY_NAMES = new Set(["Normality", "凡庸"]);

  function collectContextAdvisories(state) {
    const advisories = [];
    const floor = Number.isFinite(state?.floor) ? state.floor : "unknown";
    const turn = Number.isFinite(state?.combat_detail?.turn) ? state.combat_detail.turn : "unknown";
    const add = (scope, id, text) => {
      // Interface semantics are once per connection, not once per floor.
      const key = scope === "interface" ? `${scope}:${id}` : `${floor}:${scope}:${id}`;
      if (session.advisoryKeys.has(key)) return;
      session.advisoryKeys.add(key);
      advisories.push({ id, text });
    };

    if (state?.screen_type === "REST" && stateHasRelic(state, ["Coffee Dripper", "咖啡滤杯"])) {
      add("rest", "coffee-dripper", "Coffee Dripper prevents healing at Rest sites; treat this campfire as an upgrade or other non-healing action.");
    }

    if (state?.room_phase !== "COMBAT" || !Number.isFinite(state?.combat_detail?.turn)) {
      return advisories;
    }

    if (Array.isArray(state.hand) && state.hand.length) {
      add("interface", "hand-playability", "In a full hand/choice snapshot, p=false means observed unplayable; omitted p is a candidate, not proof (upstream true and missing flags compress alike). In deltas, omitted p retains the old value; p=null clears the old negative marker. Other instance payloads use playable=false; inspect_pile exposes neither marker and cannot establish playability. c=-1 is X-cost (normally all current Energy); c=-2 is the unplayable marker, not negative spending. Special card/free-play effects may alter spending or permit play; check live flags/costs and runtime validation, never the sentinel alone.");
    }

    const enemies = liveMonsters(state);
    const enemyMatches = (identities) => enemies.some((enemy) => entityMatches(enemy, identities));
    const enemyHasPower = (identities) => enemies.some((enemy) => entityHasPower(enemy, identities));
    const player = state?.combat_detail?.player;
    if (enemies.some((enemy) => (enemy.powers ?? []).some((power) =>
      entityMatches(power, ["Poison", "中毒"]) && Number.isFinite(power.amount) && power.amount > 0))
        || entityHasPower(player, ["Noxious Fumes", "NoxiousFumes", "毒雾"])) {
      add("combat", "poison-timing", "For a poison lethal at end_turn, count only Poison already on the enemy: it ticks before that enemy acts. Noxious Fumes triggers at the next player-turn start, not before the intervening enemy action. Check live HP/powers and unusual Mod mechanics; do not invent extra Poison.");
    }
    const changedCost = (state.hand ?? []).some((card) => {
      const definition = session.cardCatalog.definitions.get(cardRef(card));
      return Number.isFinite(card.cost) && card.cost >= 0
        && Number.isFinite(definition?.c) && definition.c >= 0 && card.cost !== definition.c;
    });
    if (changedCost || entityHasPower(player, ["Confusion", "混乱"])) {
      add("combat", "live-card-cost", "Hand c is the live current-turn cost; card_defs c is the printed/upgraded baseline. Differences can be legitimate cost modification, not automatically bad Mod data. Budget live costs and playability, refresh after draw/cost changes, and do not infer the cause from a mismatch alone. c=-1 is X-cost (normally all current Energy); c=-2 is the unplayable marker. Special card/free-play effects may alter spending or playability; p=false forbids play. Neither sentinel is a negative energy cost.");
    }
    if (enemies.some((enemy) => Number.isFinite(enemy.move?.damage) && enemy.move.damage >= 0)) {
      add("combat", "incoming-damage", "Enemy atk is the game's current displayed intent damage per hit, already adjusted for stance including Wrath; do not double it again. AxN means A damage on each of N hits, before your Block, not guaranteed HP loss. Refresh after changing stance; unusual Mod mechanics may alter actual damage.");
    }
    const thorns = enemies.flatMap((enemy) => (enemy.powers ?? [])
      .filter((power) => entityMatches(power, ["Thorns", "Sharp Hide", "尖刺", "锋利外壳"]))
      .map((power) => Number(power.amount) || 0));

    if (thorns.length) {
      const amount = Math.max(...thorns);
      add("combat", "per-hit-retaliation", `On-hit retaliation${amount > 0 ? ` (${amount})` : ""} triggers once per damage hit, so multi-hit attacks repeat it; prefer single large hits at low HP and establish block first.`);
    }
    if (hasNormality(state)) {
      add(`turn-${turn}`, "normality", "Normality is in hand: no more than three cards may be played this turn. Remove or exhaust it, then refresh before continuing.");
    }
    if (state?.combat_detail?.player?.stance === "Wrath"
        && enemies.some((enemy) => enemy.intent === "ATTACK" || Number(enemy.move?.damage) > 0)) {
      add(`turn-${turn}`, "wrath-incoming", "Wrath is active while an enemy intends to attack; confirm lethal or exit Wrath and cover the displayed incoming damage before ending the turn.");
    }

    if (enemyMatches(["Time Eater", "TimeEater", "时间吞噬者"]) || enemyHasPower(["Time Warp", "TimeWarp"])) {
      add("combat", "time-eater", "Time Eater ends the turn after the twelfth card and gains Strength. Read Time Warp before every sequence and make the twelfth card deliberate with defense already established.");
    }
    if (enemyMatches(["Awakened One", "AwakenedOne", "觉醒者"]) || enemyHasPower(["Curiosity", "好奇"])) {
      add("combat", "awakened-one", "Awakened One gains Strength from Powers in phase one and revives into phase two. Delay nonessential Powers, clear Cultists deliberately, and plan beyond the first lethal.");
    }
    if (enemyMatches(["Corrupt Heart", "CorruptHeart", "腐化之心"])
        || enemyHasPower(["Beat of Death", "BeatOfDeath", "Invincible", "无敌"])) {
      add("combat", "corrupt-heart", "Corrupt Heart punishes each card with Beat of Death and caps turn damage with Invincible. Establish block before long chains and do not spend attacks beyond the remaining cap.");
    }
    if (enemyMatches(["Slime Boss", "SlimeBoss", "史莱姆老大"])) {
      add("combat", "slime-boss", "Slime Boss splits after being reduced to half HP or lower. Send a split-triggering attack separately because the enemy roster and target indices will change.");
    }
    if (enemyMatches(["The Guardian", "TheGuardian", "守护者"])) {
      add("combat", "the-guardian", "The Guardian changes form at its Mode Shift threshold and can gain Sharp Hide. Track the threshold and treat Sharp Hide as per-hit retaliation before multi-hit attacks.");
    }
    if (enemyMatches(["Hexaghost", "六火亡魂"])) {
      add("combat", "hexaghost", "Hexaghost's opening Divider scales with current HP; Burns accumulate toward its later Inferno. Prioritize scalable defense and a timely kill rather than healing assumptions.");
    }
    if (enemyMatches(["Bronze Automaton", "BronzeAutomaton", "青铜自动机"])) {
      add("combat", "bronze-automaton", "Bronze Automaton's Orbs can steal cards and Hyper Beam is its major burst. Plan the defensive turn and refresh targets after killing an Orb.");
    }
    if (enemyMatches(["The Champ", "Champ", "勇士"])) {
      add("combat", "the-champ", "The Champ cleanses debuffs and changes behavior below half HP before Execute. Do not cross the threshold without enough burst or defense for the transition.");
    }
    if (enemyMatches(["The Collector", "Collector", "收藏家"])) {
      add("combat", "the-collector", "The Collector can summon minions and apply Vulnerable, Weak, and Frail before a large attack. Preserve mitigation and refresh target indices after summons or deaths.");
    }
    if (enemyMatches(["Donu", "甜圈"]) || enemyMatches(["Deca", "八体"])) {
      add("combat", "donu-and-deca", "Donu adds Strength while Deca adds defense and Dazed cards. Choose a focus target instead of splitting damage, then refresh indices after the first kill.");
    }

    return advisories;
  }

  function syncCombatSafety(state) {
    const turn = state?.combat_detail?.turn;
    const floor = state?.floor;
    if (state?.in_game === false || state?.room_phase === "COMPLETE") {
      session.combatSafety = { floor: null, turn: null, trackedCardsPlayed: 0, countUncertain: false };
      return;
    }
    if (state?.room_phase !== "COMBAT" || !Number.isFinite(turn) || !Number.isFinite(floor)) return;
    if (session.combatSafety.countUncertain && floor === session.combatSafety.floor && turn <= session.combatSafety.turn) return;
    if (session.combatSafety.floor !== floor || session.combatSafety.turn !== turn) {
      session.combatSafety = { floor, turn, trackedCardsPlayed: 0, countUncertain: false };
    }
  }

  function syncEndTurnSafety(state) {
    const turn = state?.combat_detail?.turn;
    const floor = state?.floor;
    if (state?.in_game === false || state?.room_phase === "COMPLETE") {
      session.turnTransitionSafety = { floor: null, turn: null, endTurnSent: false };
      return;
    }
    if (state?.room_phase !== "COMBAT" || !Number.isFinite(turn) || !Number.isFinite(floor)) return;
    if (session.turnTransitionSafety.endTurnSent && floor === session.turnTransitionSafety.floor
        && turn <= session.turnTransitionSafety.turn) return;
    if (session.turnTransitionSafety.floor !== floor || session.turnTransitionSafety.turn !== turn) {
      session.turnTransitionSafety = { floor, turn, endTurnSent: false };
    }
  }

  function markEndTurnSent(state) {
    syncEndTurnSafety(state);
    if (session.turnTransitionSafety.endTurnSent) {
      throw new Error(
        `SAFETY duplicate end_turn: an end-turn request was already sent on floor ${state.floor}, `
        + `turn ${state.combat_detail.turn}. Poll state until the turn number changes; do not resend end_turn.`,
      );
    }
    if (state?.room_phase !== "COMBAT" || !Number.isFinite(state.floor)
        || !Number.isFinite(state.combat_detail?.turn)) {
      throw new Error("SAFETY end_turn requires an observed stable combat turn");
    }
    session.turnTransitionSafety.endTurnSent = true;
  }

  function endTurnHasSettled(start, state) {
    if (state?.in_game === false || state?.room_phase === "COMPLETE") return true;
    if (Number.isFinite(state?.floor) && state.floor !== start.floor) return true;
    const currentTurn = state?.combat_detail?.turn;
    return Number.isFinite(currentTurn) && currentTurn > start.turn;
  }

  function isNormality(card) {
    return NORMALITY_IDS.has(card?.id) || NORMALITY_NAMES.has(card?.name);
  }

  function hasNormality(state) {
    return (state?.hand ?? []).some(isNormality);
  }

  function isPlayCardAction(action) {
    return action?.action === "play_card";
  }

  function isTargetedAction(action) {
    return (action?.action === "play_card" || action?.action === "use_potion")
      && Number.isInteger(action?.target_index);
  }

  function normalitySafetyCheck(state, actions) {
    syncCombatSafety(state);
    if (!hasNormality(state)) return;
    const requested = actions.filter(isPlayCardAction).length;
    const authoritative = state.combat_detail?.cards_played_this_turn;
    const hasAuthoritative = Number.isInteger(authoritative) && authoritative >= 0;
    if (!hasAuthoritative && session.combatSafety.countUncertain) {
      throw new Error("SAFETY Normality: a sent card has an unknown outcome; tracked count is uncertain until the next turn");
    }
    const played = hasAuthoritative ? authoritative : session.combatSafety.trackedCardsPlayed;
    const remaining = Math.max(0, 3 - played);
    if (requested > remaining) {
      throw new Error(
        `SAFETY Normality: turn ${session.combatSafety.turn} already has ${played} ${hasAuthoritative ? "authoritative" : "tracked"} card(s); `
        + `batch requests ${requested}, but only ${remaining} more may be played. `
        + "Play/exhaust Normality separately, refresh state, then continue.",
      );
    }
  }

  function lethalRetargetSafetyCheck(state, actions) {
    const monsters = liveMonsters(state);
    if (monsters.length <= 1) return;
    for (let index = 0; index < actions.length; index += 1) {
      const action = actions[index];
      if (!isTargetedAction(action) || action.action !== "play_card") continue;
      const target = monsters[action.target_index - 1];
      const card = cardForAction(state, action);
      const remainingTargeted = actions.slice(index + 1).some(isTargetedAction);
      if (!target || !card || !remainingTargeted) continue;
      const effectiveHp = (target.current_hp ?? Infinity) + (target.block ?? 0);
      if (Number.isFinite(card.damage) && card.damage >= effectiveHp) {
        throw new Error(
          `SAFETY target reindex: '${card.name}' is already lethal on enemy ${action.target_index} `
          + `(${target.name}, ${effectiveHp} effective HP), and a later targeted action would reuse stale indices. `
          + "Send the lethal action alone, refresh enemies, then issue the next targeted action.",
        );
      }
    }
  }

  function preflightCombatActions(state, actions) {
    normalitySafetyCheck(state, actions);
    lethalRetargetSafetyCheck(state, actions);
  }

  function isShopScreen(state) {
    return state?.screen_type === "SHOP_SCREEN";
  }

  function normalizeShopChooseArgs(state, args) {
    if (!isShopScreen(state)) return { ...args };
    const choiceText = args?.choice_text;
    if (typeof choiceText !== "string" || !choiceText.trim()) {
      throw new Error(
        "SAFETY shop reindex: shop choices are renumbered after every purchase. "
        + "Use choice_text instead of choice_index so the relay resolves the item against the latest shop state.",
      );
    }
    const needle = choiceText.trim();
    const choices = state?.choice_list ?? [];
    const exact = choices
      .map((choice, index) => ({ choice, index }))
      .filter(({ choice }) => choice === needle);
    const matches = exact.length ? exact : choices
      .map((choice, index) => ({ choice, index }))
      .filter(({ choice }) => choice.includes(needle));
    if (matches.length !== 1) {
      throw new Error(
        `SAFETY shop choice_text '${needle}' matched ${matches.length} current item(s). `
        + `Current choices: [${choices.join(" | ")}]. Use a unique item name from the refreshed state.`,
      );
    }
    const normalized = { ...args, choice_index: matches[0].index + 1 };
    delete normalized.choice_text;
    return normalized;
  }

  function resolveChoiceText(state, choiceText) {
    const needle = choiceText.trim();
    const choices = state?.choice_list ?? [];
    const indexed = choices.map((choice, index) => ({ choice, index }));
    const exact = indexed.filter(({ choice }) => choice === needle);
    const matches = exact.length ? exact : indexed.filter(({ choice }) => choice.includes(needle));
    if (matches.length !== 1) {
      throw new Error(
        `SAFETY choice_text '${needle}' matched ${matches.length} current choice(s). `
        + `Current choices: [${choices.join(" | ")}]. Use a unique current choice_text or choice_uuid.`,
      );
    }
    return matches[0].index + 1;
  }

  function resolveChoiceUuid(state, choiceUuid) {
    const cards = choiceCards(state);
    const matches = cards
      .map((card, index) => ({ card, index }))
      .filter(({ card }) => card?.uuid === choiceUuid);
    if (matches.length !== 1) {
      throw new Error(
        `SAFETY choice_uuid '${choiceUuid}' matched ${matches.length} current card choice(s). `
        + "Refresh state and use a uuid exposed on the current choice.",
      );
    }
    return matches[0].index + 1;
  }

  function normalizeChooseArgs(state, args) {
    if (isShopScreen(state)) return normalizeShopChooseArgs(state, args);
    const normalized = { ...args };
    if (typeof normalized.choice_uuid === "string" && normalized.choice_uuid.trim()) {
      normalized.choice_index = resolveChoiceUuid(state, normalized.choice_uuid.trim());
      delete normalized.choice_uuid;
      delete normalized.choice_text;
      return normalized;
    }
    if (typeof normalized.choice_text === "string" && normalized.choice_text.trim()) {
      normalized.choice_index = resolveChoiceText(state, normalized.choice_text);
      delete normalized.choice_text;
      return normalized;
    }
    if (state?.screen_type === "HAND_SELECT") {
      throw new Error(
        "SAFETY hand-selection reindex: selectable cards are renumbered after each pick. "
        + "Use choice_text for a unique card name or choice_uuid for an exact card instance.",
      );
    }
    return normalized;
  }

  function monsterRosterKey(state) {
    return liveMonsters(state).map((monster) => `${monster.id ?? monster.name}:${monster.name}`).join("|");
  }

  return {
    collectContextAdvisories,
    syncCombatSafety,
    syncEndTurnSafety,
    markEndTurnSent,
    endTurnHasSettled,
    isNormality,
    hasNormality,
    isPlayCardAction,
    isTargetedAction,
    normalitySafetyCheck,
    lethalRetargetSafetyCheck,
    preflightCombatActions,
    isShopScreen,
    normalizeShopChooseArgs,
    resolveChoiceText,
    resolveChoiceUuid,
    normalizeChooseArgs,
    monsterRosterKey,
  };
}
