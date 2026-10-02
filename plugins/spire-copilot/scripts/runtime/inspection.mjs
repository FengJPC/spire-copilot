// inspection responsibilities; dependencies are injected by runtime/index.mjs.
export function createInspection({ config, session }, dependencies = {}) {
  const {
    cardRef,
    cardUpgradeCount,
    collectCardInstances,
    compactCardInstance,
    decisionState,
    loadCardInfo,
    normalizeCardText,
    pendingCardDefinitionPayload,
    rememberCardDefinition,
  } = dependencies;

  function validateCardInspectionArgs(args) {
    const selectors = ["choice_uuid", "card_id", "card_name"]
      .filter((key) => typeof args?.[key] === "string" && args[key].trim());
    if (selectors.length !== 1) {
      throw new Error("inspect_card requires exactly one of choice_uuid, card_id, or card_name");
    }
    if (args.upgrades !== undefined && (!Number.isInteger(args.upgrades) || args.upgrades < 0)) {
      throw new Error("inspect_card.upgrades must be a non-negative integer");
    }
    if (args.choice_uuid && args.upgrades !== undefined) {
      throw new Error("inspect_card.upgrades cannot be combined with choice_uuid");
    }
    return selectors[0];
  }

  function uniqueCardRefs(instances) {
    return [...new Set(instances.map(({ card }) => cardRef(card)).filter(Boolean))];
  }

  function preferredCardInstance(instances) {
    const priority = new Map([["choice", 0], ["hand", 1], ["selected", 2], ["deck", 3]]);
    return [...instances].sort((a, b) => (priority.get(a.zone) ?? 9) - (priority.get(b.zone) ?? 9))[0];
  }

  async function inspectCard(args = {}) {
    const selector = validateCardInspectionArgs(args);
    const state = await decisionState();
    let instances = collectCardInstances(state);
    let ref;

    if (selector === "choice_uuid") {
      instances = instances.filter(({ card }) => card.uuid === args.choice_uuid.trim());
      if (instances.length !== 1) {
        throw new Error(
          `inspect_card choice_uuid '${args.choice_uuid}' matched ${instances.length} live card instance(s); refresh state`,
        );
      }
      ref = cardRef(instances[0].card);
    } else if (selector === "card_id") {
      const cardId = args.card_id.trim();
      instances = instances.filter(({ card }) => card.id === cardId
        && (args.upgrades === undefined || cardUpgradeCount(card) === args.upgrades));
      const refs = uniqueCardRefs(instances);
      if (refs.length > 1) {
        throw new Error(`inspect_card card_id '${cardId}' matched multiple upgrade levels; specify upgrades`);
      }
      ref = refs[0] ?? `${cardId}@${args.upgrades ?? 0}`;
      await loadCardInfo([cardId], { force: !session.cardCatalog.rawById.has(cardId) });
      if (!session.cardCatalog.definitions.has(ref)) {
        rememberCardDefinition({ id: cardId, upgrades: args.upgrades ?? 0 });
      }
    } else {
      const name = args.card_name.trim();
      instances = instances.filter(({ card }) => card.name === name
        && (args.upgrades === undefined || cardUpgradeCount(card) === args.upgrades));
      const cachedRefs = [...session.cardCatalog.definitions.entries()]
        .filter(([, definition]) => definition.n === name
          && (args.upgrades === undefined || (definition.u ?? 0) === args.upgrades))
        .map(([cachedRef]) => cachedRef);
      const refs = [...new Set([...uniqueCardRefs(instances), ...cachedRefs])];
      if (refs.length !== 1) {
        throw new Error(
          `inspect_card card_name '${name}' matched ${refs.length} definition(s); use card_id or choice_uuid`,
        );
      }
      [ref] = refs;
    }

    const definition = session.cardCatalog.definitions.get(ref);
    if (!definition) {
      return {
        status: "DEFINITION_UNAVAILABLE",
        ref,
        source: instances.length ? "live_instance" : "not_found",
        ...(instances.length ? {
          instances: instances.map(({ card, zone }) => compactCardInstance(card, zone)),
        } : {}),
      };
    }

    session.cardCatalog.emittedRefs.add(ref);
    const matchingInstances = instances.filter(({ card }) => cardRef(card) === ref);
    const preferred = preferredCardInstance(matchingInstances);
    return {
      status: "ok",
      ref,
      source: matchingInstances.length ? "live_instance" : "downstream_definition",
      definition,
      ...(selector === "choice_uuid" && preferred
        ? { instance: compactCardInstance(preferred.card, preferred.zone) }
        : matchingInstances.length
          ? { instances: matchingInstances.map(({ card, zone }) => compactCardInstance(card, zone)) }
          : {}),
    };
  }

  function validatePileInspectionArgs(args) {
    if (!args || Object.keys(args).some((key) => key !== "pile")
        || !["draw", "discard", "exhaust"].includes(args.pile)) {
      throw new Error("inspect_pile requires pile: draw, discard, or exhaust; no other arguments");
    }
  }

  function compactPileCards(cards) {
    const groups = new Map();
    for (const card of cards) {
      const ref = cardRef(card);
      const definition = session.cardCatalog.definitions.get(ref);
      const text = normalizeCardText(card.description);
      // Do not use compactCard: its UUID-derived handle allocation would reveal
      // internal pile order. Pile cards are composition, not playable hand slots.
      const value = {
        ...(ref ? { ref } : {}),
        n: card.name ?? card.id,
        ...(Number.isFinite(card.cost) ? { c: card.cost } : {}),
        ...(Number.isFinite(card.damage) && card.damage >= 0 ? { d: card.damage } : {}),
        ...(Number.isFinite(card.block) && card.block >= 0 ? { b: card.block } : {}),
        ...(Number.isFinite(card.magic_number) ? { m: card.magic_number } : {}),
        ...(cardUpgradeCount(card) ? { u: cardUpgradeCount(card) } : {}),
        ...(card.exhausts ? { x: true } : {}),
        ...(card.has_target ? { t: true } : {}),
        ...(card.ethereal ? { ethereal: true } : {}),
        ...(card.self_retain ? { retain: true } : {}),
        ...(!definition && card.type ? { type: card.type } : {}),
        ...(text && text !== definition?.text ? { text } : {}),
      };
      for (const field of ["base_damage", "base_block", "base_magic_number", "heal", "draw", "discard", "misc"]) {
        if (Number.isFinite(card[field])) value[field] = card[field];
      }
      const signature = JSON.stringify(value);
      const group = groups.get(signature);
      if (group) group.qty++;
      else groups.set(signature, { ...value, qty: 1 });
    }
    // Canonical presentation is invariant under every internal pile permutation.
    return [...groups.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([, group]) => group);
  }

  async function inspectPile(args = {}) {
    validatePileInspectionArgs(args);
    const state = await decisionState({ includePiles: true });
    const context = { pile: args.pile, floor: state.floor, turn: state.combat_detail?.turn };
    if (!state.in_game || state.room_phase !== "COMBAT") {
      return { status: "NOT_IN_COMBAT", ...context };
    }
    const cards = state._combat_piles?.[args.pile];
    if (!Array.isArray(cards) || cards.some((card) => !card || typeof card !== "object")) {
      return { status: "UNAVAILABLE", ...context,
        reason: "Downstream did not provide a complete pile; do not treat this as empty" };
    }
    const refs = new Set(cards.map(cardRef).filter(Boolean));
    const missing = [...refs].filter((ref) => !session.cardCatalog.definitions.has(ref)).sort();
    // Read-only inspection must not replace previousState/observedHandState or
    // consume run/map/advisory deltas which have not yet been sent to the caller.
    return { status: "ok", ...context, order: "unordered", count: cards.length,
      cards: compactPileCards(cards), ...pendingCardDefinitionPayload(refs),
      ...(missing.length ? { definitions_unavailable: missing } : {}) };
  }

  return {
    validateCardInspectionArgs,
    uniqueCardRefs,
    preferredCardInstance,
    inspectCard,
    validatePileInspectionArgs,
    compactPileCards,
    inspectPile,
  };
}
