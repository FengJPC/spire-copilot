// cards responsibilities; dependencies are injected by runtime/index.mjs.
export function createCards({ config, session }, dependencies = {}) {
  const { timeoutMs } = config;
  // Card-info replies are immutable catalog records, distinct from live hand
  // stats. Weak keys expire with replaced/reset replies; new source objects
  // and upgrade variants are compiled independently.
  const definitionCache = new WeakMap();
  const {
    isConnectionError,
    isPlayCardAction,
    isTimeoutError,
    parseState,
    rawTool,
  } = dependencies;

  function resetCardCatalog({ preserveInstances = false, preserveRun = false } = {}) {
    const activeRun = preserveRun && session.cardCatalog.activeRun;
    session.observedHandState = undefined;
    if (!preserveInstances) session.handHandles = { next: 1, byUuid: new Map(), byKey: new Map() };
    session.cardCatalog = {
      activeRun,
      rawById: new Map(),
      attemptedIds: new Set(),
      definitions: new Map(),
      emittedRefs: new Set(),
      catalogPayloadSent: false,
    };
  }

  function cardUpgradeCount(card) {
    return Number.isInteger(card?.upgrades) && card.upgrades > 0 ? card.upgrades : 0;
  }

  function cardRef(card) {
    return card?.id ? `${card.id}@${cardUpgradeCount(card)}` : undefined;
  }

  function normalizeCardText(value) {
    if (typeof value !== "string") return undefined;
    return value.replace(/\s+NL\s+/g, " ").replace(/\s+/g, " ").trim();
  }

  function compactCardDefinition(raw, upgrades = 0) {
    if (!raw?.id) return undefined;
    const upgraded = upgrades > 0 && raw.upgraded ? raw.upgraded : {};
    const variant = { ...raw, ...upgraded };
    const text = normalizeCardText(variant.description);
    const definition = {
      id: raw.id,
      n: variant.name ?? raw.name,
      ...(raw.type ? { type: raw.type } : {}),
      ...(raw.rarity ? { rarity: raw.rarity } : {}),
      ...(Number.isFinite(variant.cost) ? { c: variant.cost } : {}),
      ...(text ? { text } : {}),
      ...(Number.isFinite(variant.base_damage) ? { d: variant.base_damage } : {}),
      ...(Number.isFinite(variant.base_block) ? { b: variant.base_block } : {}),
      ...(Number.isFinite(variant.base_magic_number) ? { m: variant.base_magic_number } : {}),
      ...(upgrades ? { u: upgrades } : {}),
      ...(variant.exhausts ? { x: true } : {}),
      ...(variant.ethereal ? { ethereal: true } : {}),
      ...(variant.retain ? { retain: true } : {}),
      ...(variant.has_target ? { target: true } : {}),
    };
    return definition;
  }

  function collectCardInstances(state) {
    const collected = [];
    const add = (cards, zone) => {
      for (const card of cards ?? []) {
        if (card?.id) collected.push({ card, zone });
      }
    };
    add(state?.screen_state?.cards, "choice");
    if (state?.screen_type === "HAND_SELECT") add(state?.screen_state?.hand, "choice");
    add(state?.hand, "hand");
    add(state?.screen_state?.selected_cards, "selected");
    add(state?.screen_state?.selected, "selected");
    for (const instance of state?._card_catalog_instances ?? []) {
      if (instance?.card?.id) collected.push(instance);
    }
    add(state?.run_detail?.deck, "deck");
    const seen = new Set();
    return collected.filter(({ card, zone }) => {
      const key = card.uuid ?? `${zone}:${cardRef(card)}:${card.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function syncCardCatalogRun(state) {
    if (!state?.in_game) {
      session.cardCatalog.activeRun = false;
      return;
    }
    if (!session.cardCatalog.activeRun) {
      resetCardCatalog();
      session.cardCatalog.activeRun = true;
    }
  }

  async function requestCardInfo(cardIds, { timeout = timeoutMs } = {}) {
    if (!cardIds.length) return [];
    const started = Date.now();
    try {
      const payload = parseState((await rawTool("get_card_info", { card_ids: cardIds }, { timeout })).message);
      return Array.isArray(payload?.cards) ? payload.cards : [];
    } catch (error) {
      if (isConnectionError(error) || isTimeoutError(error)) throw error;
      if (cardIds.length === 1) return [];
      const cards = [];
      for (const cardId of cardIds) cards.push(...await requestCardInfo([cardId],
        { timeout: Math.max(1, timeout - (Date.now() - started)) }));
      return cards;
    }
  }

  async function loadCardInfo(cardIds, { force = false, timeout = timeoutMs } = {}) {
    const pending = [...new Set(cardIds.filter(Boolean))]
      .filter((cardId) => force || !session.cardCatalog.attemptedIds.has(cardId));
    if (!pending.length) return;
    for (const cardId of pending) session.cardCatalog.attemptedIds.add(cardId);
    for (const card of await requestCardInfo(pending, { timeout })) {
      if (card?.id) session.cardCatalog.rawById.set(card.id, card);
    }
  }

  function rememberCardDefinition(card) {
    const ref = cardRef(card);
    const raw = session.cardCatalog.rawById.get(card?.id);
    if (!ref || !raw) return undefined;
    const upgrades = cardUpgradeCount(card);
    let variants = definitionCache.get(raw);
    if (!variants) {
      variants = new Map();
      definitionCache.set(raw, variants);
    }
    if (!variants.has(upgrades)) variants.set(upgrades, compactCardDefinition(raw, upgrades));
    const definition = variants.get(upgrades);
    if (definition) session.cardCatalog.definitions.set(ref, definition);
    return definition;
  }

  async function enrichCardDefinitions(state, { timeout = timeoutMs } = {}) {
    syncCardCatalogRun(state);
    if (!state?.in_game) return state;
    const instances = collectCardInstances(state);
    delete state._card_catalog_instances;
    await loadCardInfo(instances.map(({ card }) => card.id), { timeout });
    for (const { card } of instances) rememberCardDefinition(card);
    return state;
  }

  function pendingCardDefinitionPayload(refs = undefined) {
    const pending = [...session.cardCatalog.definitions.entries()]
      .filter(([ref]) => !session.cardCatalog.emittedRefs.has(ref) && (!refs || refs.has(ref)));
    if (!pending.length) return {};
    if (refs) pending.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const field = session.cardCatalog.catalogPayloadSent ? "card_defs_added" : "card_defs";
    for (const [ref] of pending) session.cardCatalog.emittedRefs.add(ref);
    session.cardCatalog.catalogPayloadSent = true;
    return { [field]: Object.fromEntries(pending) };
  }

  function compactCardInstance(card, zone = undefined) {
    return {
      ...(cardRef(card) ? { ref: cardRef(card) } : {}),
      ...(card?.id ? { id: card.id } : {}),
      ...(card?.name ? { n: card.name } : {}),
      ...(card?.uuid ? { uuid: card.uuid } : {}),
      ...(zone ? { zone } : {}),
      ...(Number.isFinite(card?.cost) ? { c: card.cost } : {}),
      ...(Number.isFinite(card?.damage) && card.damage >= 0 ? { d: card.damage } : {}),
      ...(Number.isFinite(card?.block) && card.block >= 0 ? { b: card.block } : {}),
      ...(Number.isFinite(card?.magic_number) && card.magic_number !== 0 ? { m: card.magic_number } : {}),
      ...(cardUpgradeCount(card) ? { u: cardUpgradeCount(card) } : {}),
      ...(card?.is_playable === false ? { playable: false } : {}),
      ...(card?.exhausts ? { x: true } : {}),
      ...(card?.has_target ? { target: true } : {}),
    };
  }

  function cardIdentityMatches(card, selected) {
    if (!card || !selected) return false;
    if (selected.uuid) return card.uuid === selected.uuid;
    if (selected.id) return card.id === selected.id;
    return card.name === selected.name;
  }

  function cardForAction(state, action) {
    const hand = state?.hand ?? [];
    if (action?.card_uuid) return hand.find((card) => card.uuid === action.card_uuid);
    if (action?.card) {
      const uuid = session.handHandles.byKey.get(action.card);
      return uuid ? hand.find((card) => card.uuid === uuid)
        : hand.find((card) => card.name === action.card);
    }
    if (Number.isInteger(action?.card_index)) return hand[action.card_index - 1];
    if (action?.card_name) return hand.find((card) => card.name === action.card_name);
    if (action?.card_id) return hand.find((card) => card.id === action.card_id);
    return undefined;
  }

  function choiceCards(state) {
    if (state?.screen_type === "HAND_SELECT") {
      if (Array.isArray(state?.screen_state?.hand)) return state.screen_state.hand;
      if (Array.isArray(state.hand)) return state.hand;
    }
    return Array.isArray(state?.screen_state?.cards) ? state.screen_state.cards : [];
  }

  function normalizeStableCardReference(action, initialState) {
    if (!isPlayCardAction(action)) return { ...action };
    const selectors = ["card", "card_index", "card_name", "card_id"].filter((key) => action[key] !== undefined);
    if (selectors.length !== 1) throw new Error("SAFETY play_card requires exactly one card selector");
    if (!Number.isInteger(action.card_index)) return { ...action };
    const card = (initialState?.hand ?? [])[action.card_index - 1];
    if (!card) throw new Error(`SAFETY card index ${action.card_index} was not present in the initial hand`);
    if (!card.uuid) throw new Error("SAFETY indexed card has no instance UUID; use a unique card name");
    const normalized = { ...action };
    delete normalized.card_index;
    normalized.card_uuid = card.uuid;
    normalized.card_key = handHandle(card);
    normalized.expected_cost = card.cost;
    return normalized;
  }

  function handHandle(card) {
    if (!card?.uuid) return undefined;
    if (!session.handHandles.byUuid.has(card.uuid)) {
      const key = `h${session.handHandles.next++}`;
      session.handHandles.byUuid.set(card.uuid, key);
      session.handHandles.byKey.set(key, card.uuid);
    }
    return session.handHandles.byUuid.get(card.uuid);
  }

  function playableHandCard(card, state) {
    return card.is_playable !== false
      && !(Number.isFinite(card.cost) && card.cost >= 0
        && Number.isFinite(state.current_energy) && card.cost > state.current_energy);
  }

  function interchangeableCardSignature(card) {
    // Same name alone is not enough for upgraded or Mod-modified copies.
    return JSON.stringify([card.id, cardUpgradeCount(card), card.type, card.damage,
      card.block, card.magic_number, card.exhausts, card.self_retain, card.ethereal,
      card.description]);
  }

  function resolvePlayCardAction(state, action) {
    const hand = state?.hand ?? [];
    const selector = action.card;
    const explicitUuid = action.card_uuid ?? session.handHandles.byKey.get(selector);
    let matches;
    if (explicitUuid) matches = hand.filter((card) => card.uuid === explicitUuid);
    else if (selector && /^h\d+$/.test(selector)) {
      throw new Error(`SAFETY unknown hand handle '${selector}'; refresh state`);
    } else if (selector || action.card_name) {
      matches = hand.filter((card) => card.name === (selector ?? action.card_name));
    } else matches = hand.filter((card) => card.id === action.card_id);
    if (!matches.length) throw new Error("SAFETY selected card is no longer in hand; refresh state");
    if (explicitUuid && matches.length !== 1) throw new Error("SAFETY duplicate instance UUID in hand");
    if (!explicitUuid && new Set(matches.map(interchangeableCardSignature)).size > 1) {
      throw new Error("SAFETY same-name cards have different effects; use the exact hand handle k");
    }
    const candidates = matches.filter((card) => playableHandCard(card, state));
    if (!candidates.length) throw new Error("SAFETY selected card is not currently playable or affordable");
    const card = candidates.reduce((best, next) => next.cost < best.cost ? next : best);
    const observed = session.observedHandState?.hand?.find((item) => item.uuid === card.uuid);
    const expectedCost = action.expected_cost ?? (explicitUuid ? observed?.cost : undefined);
    if (Number.isFinite(expectedCost) && card.cost > expectedCost) {
      throw new Error("SAFETY selected card cost increased since the observed hand; refresh state");
    }
    const index = hand.indexOf(card) + 1;
    return {
      action: { action: "play_card", card_uuid: card.uuid, card_index: index,
        card_key: handHandle(card), card_name: card.name, cost: card.cost,
        ...(action.target_index ? { target_index: action.target_index } : {}) },
      // The game's execute_actions resolves UUID on its game thread, closing the
      // read-to-send reorder window without exposing UUIDs to the model.
      toolCall: card.uuid
        ? { name: "execute_actions", args: { actions: [{ action: "play_card", card_uuid: card.uuid,
          ...(action.target_index ? { target_index: action.target_index } : {}) }] } }
        : { name: "play_card", args: { card_index: index,
          ...(action.target_index ? { target_index: action.target_index } : {}) } },
    };
  }

  return {
    resetCardCatalog,
    cardUpgradeCount,
    cardRef,
    normalizeCardText,
    compactCardDefinition,
    collectCardInstances,
    syncCardCatalogRun,
    requestCardInfo,
    loadCardInfo,
    rememberCardDefinition,
    enrichCardDefinitions,
    pendingCardDefinitionPayload,
    compactCardInstance,
    cardIdentityMatches,
    cardForAction,
    choiceCards,
    normalizeStableCardReference,
    handHandle,
    playableHandCard,
    interchangeableCardSignature,
    resolvePlayCardAction,
  };
}
