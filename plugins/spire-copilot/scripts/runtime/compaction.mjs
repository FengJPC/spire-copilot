// compaction responsibilities; dependencies are injected by runtime/index.mjs.
export function createCompaction({ config, session }, dependencies = {}) {
  const {
    cardRef,
    cardUpgradeCount,
    choiceCards,
    collectContextAdvisories,
    compactCardInstance,
    handHandle,
    pendingCardDefinitionPayload,
  } = dependencies;

  function powerAmount(entity, ids) {
    const power = (entity?.powers ?? []).find((item) => ids.has(item?.id));
    return Number.isFinite(power?.amount) ? power.amount : power ? 1 : 0;
  }

  function hasRelic(state, ids) {
    return (state?.run_detail?.relics ?? []).some((relic) => ids.has(relic?.id));
  }

  function estimatedDamagePerHit(card, target, state) {
    if (!Number.isFinite(card?.damage) || card.damage < 0 || !card?.has_target) return undefined;
    let damage = card.damage;
    if (powerAmount(target, new Set(["Vulnerable"])) > 0) {
      damage = Math.floor(damage * (hasRelic(state, new Set(["Paper Frog", "PaperPhrog"])) ? 1.75 : 1.5));
    }
    const slow = powerAmount(target, new Set(["Slow"]));
    if (slow > 0) damage = Math.floor(damage * (1 + slow * 0.1));
    if (powerAmount(target, new Set(["Flight"])) > 0) damage = Math.floor(damage * 0.5);
    if (powerAmount(target, new Set(["Intangible"])) > 0) damage = Math.min(damage, 1);
    return Math.max(0, damage);
  }

  function targetDamageEstimate(card, state) {
    if (!Number.isFinite(card?.damage) || card.damage < 0 || !card?.has_target) return undefined;
    const targets = (state?.monsters ?? []).filter((monster) => !monster.is_gone);
    const changed = targets.map((target, index) => ({
      i: index + 1,
      d: estimatedDamagePerHit(card, target, state),
    })).filter((entry) => Number.isFinite(entry.d) && entry.d !== card.damage);
    if (!changed.length) return undefined;
    if (targets.length === 1) return changed[0].d;
    return Object.fromEntries(changed.map(({ i, d }) => [i, d]));
  }

  function compactCard(card, state = undefined) {
    const value = { n: card.name, c: card.cost, ...(cardRef(card) ? { ref: cardRef(card) } : {}) };
    const key = handHandle(card);
    if (key) value.k = key;
    if (card.is_playable === false) value.p = false;
    if (Number.isFinite(card.damage) && card.damage >= 0) value.d = card.damage;
    const effectiveDamage = targetDamageEstimate(card, state);
    if (effectiveDamage !== undefined) value.ed = effectiveDamage;
    if (Number.isFinite(card.block) && card.block >= 0) value.b = card.block;
    if (card.magic_number) value.m = card.magic_number;
    if (card.upgrades) value.u = card.upgrades;
    if (card.exhausts) value.x = true;
    if (card.has_target) value.t = true;
    return value;
  }

  function compactChoiceCard(card) {
    if (!card) return {};
    return {
      ...(cardRef(card) ? { ref: cardRef(card) } : {}),
      ...(Number.isFinite(card.cost) ? { c: card.cost } : {}),
      ...(Number.isFinite(card.damage) && card.damage >= 0 ? { d: card.damage } : {}),
      ...(Number.isFinite(card.block) && card.block >= 0 ? { b: card.block } : {}),
      ...(Number.isFinite(card.magic_number) && card.magic_number !== 0 ? { m: card.magic_number } : {}),
      ...(cardUpgradeCount(card) ? { u: cardUpgradeCount(card) } : {}),
      ...(card.is_playable === false ? { p: false } : {}),
      ...(card.exhausts ? { x: true } : {}),
      ...(card.has_target ? { t: true } : {}),
    };
  }

  function normalizeDisplayedChoiceIndices(value, key = "") {
    if (Array.isArray(value)) return value.map((item) => normalizeDisplayedChoiceIndices(item));
    if (!value || typeof value !== "object") {
      return key === "choice_index" && Number.isInteger(value) ? value + 1 : value;
    }
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        normalizeDisplayedChoiceIndices(childValue, childKey),
      ]),
    );
  }

  function compactMapNode(node) {
    const value = { x: node.x, y: node.y, s: node.symbol };
    if (node.children?.length) value.to = node.children.map((child) => [child.x, child.y]);
    return value;
  }

  function compactDeckCard(card) {
    return {
      id: card.id,
      n: card.name,
      ...(card.upgrades ? { u: card.upgrades } : {}),
    };
  }

  function compactRelic(relic) {
    return {
      id: relic.id,
      n: relic.name,
      ...(Number.isFinite(relic.counter) && relic.counter >= 0 ? { c: relic.counter } : {}),
    };
  }

  function compactPotion(potion, index, includeAvailability = false) {
    return {
      slot: index + 1,
      id: potion.id,
      n: potion.name,
      ...(potion.is_empty === true ? { empty: true } : {}),
      ...(includeAvailability ? Object.fromEntries(
        ["can_use", "can_discard", "requires_target"]
          .filter((key) => typeof potion[key] === "boolean")
          .map((key) => [key, potion[key]]),
      ) : {}),
    };
  }

  function currentStance(state) {
    const player = state?.combat_detail?.player;
    if (state?.room_phase !== "COMBAT" || !player || typeof player !== "object" || Array.isArray(player)) return null;
    const stance = player.stance;
    // MCP The Spire omits stance only for Neutral in an available player object.
    // Missing player data / non-combat states must not masquerade as Neutral.
    if (stance === undefined) return "Neutral";
    return typeof stance === "string" && stance.trim() ? stance : null;
  }

  function compactScreenCard(card) {
    return {
      id: card.id,
      n: card.name,
      ...(Number.isFinite(card.cost) ? { c: card.cost } : {}),
      ...(card.type ? { type: card.type } : {}),
      ...(Number.isFinite(card.damage) && card.damage >= 0 ? { d: card.damage } : {}),
      ...(Number.isFinite(card.block) && card.block >= 0 ? { b: card.block } : {}),
      ...(card.magic_number ? { m: card.magic_number } : {}),
      ...(card.upgrades ? { u: card.upgrades } : {}),
      ...(card.exhausts ? { x: true } : {}),
      ...(Number.isFinite(card.price) ? { price: card.price } : {}),
    };
  }

  function compactStoreItem(item) {
    return {
      id: item.id,
      n: item.name,
      ...(Number.isFinite(item.price) ? { price: item.price } : {}),
      ...(Number.isFinite(item.counter) && item.counter >= 0 ? { c: item.counter } : {}),
    };
  }

  function compactShopChoices(state) {
    const details = state.screen_state ?? {};
    const normalizedName = (name) => typeof name === "string" ? name.normalize("NFKC").trim() : undefined;
    return state.choice_list.map((text, index) => {
      const base = { i: index + 1, text };
      if (typeof text !== "string") return base;
      const priceMatch = text.match(/\((\d+)\s+gold\)\s*$/i);
      const price = priceMatch ? Number(priceMatch[1]) : undefined;
      if (/^purge\s*\(/i.test(text)) {
        return { ...base, kind: "purge", ...(Number.isFinite(price) ? { price } : {}) };
      }
      const patterns = [
        ["card", "cards", /^\[([^\]]+)\]\s+Cost:/i],
        ["relic", "relics", /^relic:\s*\[([^\]]+)\]/i],
        ["potion", "potions", /^add potion:\s*\[([^\]]+)\]/i],
      ];
      const matched = patterns.map(([kind, list, pattern]) => ({ kind, list, match: text.match(pattern) }))
        .find((entry) => entry.match);
      if (!matched) return base;
      const { kind, list, match } = matched;
      const tagged = { ...base, kind, ...(Number.isFinite(price) ? { price } : {}) };
      // A zero-price card has no suffix in the upstream formatter. Missing
      // prices on other item types cannot establish an identity safely.
      const expectedPrice = price ?? (kind === "card" ? 0 : undefined);
      const items = Array.isArray(details[list]) ? details[list] : [];
      const candidates = items.filter((item) => normalizedName(item?.name) === normalizedName(match[1])
        && Number.isFinite(expectedPrice) && item?.price === expectedPrice);
      if (candidates.length !== 1) return tagged;
      const item = candidates[0];
      if (kind === "card") return { ...tagged,
        ...(item.id ? { card_id: item.id } : {}),
        ...(item.uuid ? { choice_uuid: item.uuid } : {}), ...compactChoiceCard(item) };
      return { ...tagged, ...(item.id ? { item_id: item.id } : {}) };
    });
  }

  function compactScreenDetails(state) {
    const details = normalizeDisplayedChoiceIndices(state.screen_state);
    if (state.screen_type === "HAND_SELECT") {
      return {
        max_cards: details.max_cards,
        can_pick_zero: details.can_pick_zero,
        selected: (details.selected ?? details.selected_cards ?? []).map((card) => compactCardInstance(card)),
      };
    }
    if (state.screen_type === "GRID") {
      return {
        num_cards: details.num_cards,
        any_number: details.any_number,
        confirm_up: details.confirm_up,
        for_upgrade: details.for_upgrade,
        for_transform: details.for_transform,
        for_purge: details.for_purge,
        selected: (details.selected_cards ?? details.selected ?? []).map((card) => compactCardInstance(card)),
      };
    }
    if (state.screen_type === "CARD_REWARD") {
      const cards = details.cards ?? [];
      const choicesCoverCards = cards.length > 0 && state.choice_list?.length === cards.length;
      return {
        ...(!choicesCoverCards ? { cards: cards.map(compactScreenCard) } : {}),
        bowl_available: details.bowl_available,
        skip_available: details.skip_available,
      };
    }
    if (state.screen_type === "SHOP_SCREEN") {
      return {
        cards: (details.cards ?? []).map(compactScreenCard),
        relics: (details.relics ?? []).map(compactStoreItem),
        potions: (details.potions ?? []).map(compactStoreItem),
        purge_cost: details.purge_cost,
        purge_available: details.purge_available,
      };
    }
    if (state.screen_type === "EVENT" && Array.isArray(details.options)) {
      return {
        event_id: details.event_id,
        event_name: details.event_name,
        body_text: details.body_text,
        options: details.options.map((option) => ({
          ...(Number.isInteger(option.choice_index) ? { i: option.choice_index } : {}),
          ...(option.disabled ? { disabled: true } : {}),
          text: option.text,
        })),
      };
    }
    return details;
  }

  function compactRunContext(state) {
    const run = state.run_detail;
    if (!run) return undefined;
    return {
      act: run.act,
      class: run.class,
      boss: run.boss,
      deck: (run.deck ?? []).map(compactDeckCard),
      relics: (run.relics ?? []).map(compactRelic),
      potions: Array.isArray(run.potions) ? run.potions.map((potion, index) => compactPotion(potion, index)) : null,
    };
  }

  function compactState(state, { includeMap = true } = {}) {
    const out = {
      ready: state.ready_for_command,
      room: state.room_type,
      screen: state.screen_type,
    };
    if (Number.isFinite(state.floor)) out.floor = state.floor;
    if (Number.isFinite(state.current_hp) && Number.isFinite(state.max_hp)) {
      out.hp = `${state.current_hp}/${state.max_hp}`;
    }
    if (Number.isFinite(state.gold)) out.gold = state.gold;
    if (Number.isFinite(state.current_energy)) out.energy = `${state.current_energy}/${state.max_energy}`;
    if (state.in_game || state.run_detail) {
      out.potions = Array.isArray(state.run_detail?.potions)
        ? state.run_detail.potions.map((potion, index) => compactPotion(potion, index, true)) : null;
    }
    if (state.room_phase === "COMBAT") {
      out.stance = currentStance(state);
      const player = state.combat_detail?.player;
      const orbs = player?.orbs;
      // Preserve slot order, duplicate IDs and empty/unknown entries. Missing
      // upstream data is unknown, not an empty orb inventory or zero amounts.
      out.orbs = Array.isArray(orbs) ? orbs.map((orb, index) => ({
        slot: index + 1,
        ...(orb && Object.hasOwn(orb, "id") ? { id: orb.id } : {}),
        ...(Number.isFinite(orb?.passive) ? { passive: orb.passive } : {}),
        ...(Number.isFinite(orb?.evoke) ? { evoke: orb.evoke } : {}),
      })) : null;
      // Upstream omits powers when none exist; an absent Focus on an available
      // player is zero. Unavailable/malformed player or power data is unknown.
      const focus = Array.isArray(player?.powers)
        ? player.powers.find((power) => power?.id === "Focus") : undefined;
      out.focus = !player || typeof player !== "object" || Array.isArray(player)
        || (player.powers !== undefined && !Array.isArray(player.powers))
        ? null : focus ? (Number.isFinite(focus.amount) ? focus.amount : null) : 0;
    }
    const detail = state.combat_detail;
    if (detail) {
      out.turn = detail.turn;
      if (detail.player?.block) out.block = detail.player.block;
      if (detail.player?.powers?.length) {
        out.powers = detail.player.powers.map((power) => ({
          id: power.id,
          ...(Number.isFinite(power.amount) && power.amount !== 0 ? { n: power.amount } : {}),
          ...(Number.isFinite(power.damage) && power.damage !== 0 ? { d: power.damage } : {}),
          ...(Number.isFinite(power.misc) && power.misc !== 0 ? { misc: power.misc } : {}),
          ...(power.just_applied ? { just_applied: true } : {}),
        }));
      }
      out.piles = { draw: detail.draw_count, discard: detail.discard_count, exhaust: detail.exhaust_count };
      if (detail.limbo_count) out.piles.limbo = detail.limbo_count;
      if (detail.cards_discarded_this_turn) out.discarded = detail.cards_discarded_this_turn;
    }
    if (state.monsters?.length) {
      out.enemies = state.monsters.filter((m) => !m.is_gone).map((m, index) => ({
        i: index + 1,
        n: m.name,
        hp: `${m.current_hp}/${m.max_hp}`,
        intent: m.intent,
        ...(Number.isFinite(m.move?.damage) && m.move.damage >= 0
          ? { atk: m.move.hits > 1 ? `${m.move.damage}x${m.move.hits}` : m.move.damage } : {}),
        ...(Number.isFinite(m.block) && m.block ? { b: m.block } : {}),
        ...(m.powers?.length ? { powers: m.powers.map((power) => ({ id: power.id, ...(power.amount ? { n: power.amount } : {}) })) } : {}),
      }));
    }
    if (Array.isArray(state.hand)) out.hand = state.hand.map((card, index) => ({ ...compactCard(card, state), i: index + 1 }));
    if (state.choice_list?.length) {
      const cards = choiceCards(state);
      out.choices = state.screen_type === "SHOP_SCREEN" ? compactShopChoices(state) : state.choice_list.map((text, index) => ({
        i: index + 1,
        text,
        ...(cards[index]?.id ? { card_id: cards[index].id } : {}),
        ...(cards[index]?.uuid ? { choice_uuid: cards[index].uuid } : {}),
        ...compactChoiceCard(cards[index]),
      }));
    }
    if (state.screen_state && Object.keys(state.screen_state).length) {
      out.details = compactScreenDetails(state);
    }
    if (state.screen_type === "MAP" && state.map_version) out.map_ref = state.map_version;
    if (state.screen_type === "MAP" && state.map_status) out.map_status = state.map_status;
    if (includeMap && state.screen_type === "MAP" && state.map?.length) out.map = state.map.map(compactMapNode);
    if (state.can_proceed) out.proceed = state.proceed_button ?? true;
    if (state.can_cancel) out.cancel = state.cancel_button ?? true;
    return out;
  }

  function multisetDifference(before, after) {
    const remaining = new Map();
    for (const item of after) {
      const key = JSON.stringify(item);
      const entry = remaining.get(key) ?? { item, count: 0 };
      entry.count += 1;
      remaining.set(key, entry);
    }
    const removed = [];
    for (const item of before) {
      const key = JSON.stringify(item);
      const entry = remaining.get(key);
      if (entry?.count) entry.count -= 1;
      else removed.push(item);
    }
    const added = [];
    for (const { item, count } of remaining.values()) {
      for (let index = 0; index < count; index += 1) added.push(item);
    }
    return { removed, added };
  }

  function handCardKey(card) {
    return card?.k ?? card?.ref ?? card?.n;
  }

  function handArrayDifference(before, after) {
    if ([...before, ...after].every((card) => card.k)
        && new Set(before.map((card) => card.k)).size === before.length
        && new Set(after.map((card) => card.k)).size === after.length) {
      const beforeMap = new Map(before.map((card) => [card.k, card]));
      const afterMap = new Map(after.map((card) => [card.k, card]));
      const changed = [];
      for (const card of after) {
        const old = beforeMap.get(card.k);
        if (!old) continue;
        const delta = diffValue(old, card);
        if (delta !== undefined) changed.push({ key: card.k, ...delta });
      }
      const removed = before.filter((card) => !afterMap.has(card.k)).map((card) => ({ k: card.k }));
      const added = after.filter((card) => !beforeMap.has(card.k));
      return { count: after.length, ...(changed.length ? { changed } : {}),
        ...(removed.length ? { removed } : {}), ...(added.length ? { added } : {}) };
    }
    const beforeRemaining = before.map((item) => ({ item }));
    const afterRemaining = after.map((item) => ({ item }));
    const consumeMatch = (left, right, predicate) => {
      for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex -= 1) {
        const leftIndex = left.findIndex((entry) => predicate(entry.item, right[rightIndex].item));
        if (leftIndex < 0) continue;
        left.splice(leftIndex, 1);
        right.splice(rightIndex, 1);
      }
    };

    consumeMatch(beforeRemaining, afterRemaining, (left, right) => JSON.stringify(left) === JSON.stringify(right));
    const changed = [];
    for (let afterIndex = afterRemaining.length - 1; afterIndex >= 0; afterIndex -= 1) {
      const next = afterRemaining[afterIndex];
      const key = handCardKey(next.item);
      if (!key) continue;
      const beforeIndex = beforeRemaining.findIndex((entry) => handCardKey(entry.item) === key);
      if (beforeIndex < 0) continue;
      const previous = beforeRemaining[beforeIndex];
      const delta = diffValue(previous.item, next.item);
      if (delta !== undefined) changed.unshift({ key, ...delta });
      beforeRemaining.splice(beforeIndex, 1);
      afterRemaining.splice(afterIndex, 1);
    }

    const removed = beforeRemaining.map(({ item }) => item);
    const added = afterRemaining.map(({ item }) => item);
    return {
      count: after.length,
      ...(changed.length ? { changed } : {}),
      ...(removed.length ? { removed } : {}),
      ...(added.length ? { added } : {}),
    };
  }

  function entityArrayDifference(before, after) {
    const keyFor = (item) => item?.i ?? item?.slot ?? item?.id;
    const beforeMap = new Map(before.map((item) => [keyFor(item), item]));
    const afterMap = new Map(after.map((item) => [keyFor(item), item]));
    if ([...beforeMap.keys(), ...afterMap.keys()].some((key) => key === undefined)) return undefined;
    const changed = [];
    for (const [key, item] of afterMap) {
      if (!beforeMap.has(key)) changed.push({ key, added: item });
      else {
        const delta = diffValue(beforeMap.get(key), item);
        if (delta !== undefined) changed.push({ key, ...delta });
      }
    }
    const removed = [...beforeMap.keys()].filter((key) => !afterMap.has(key));
    return changed.length || removed.length ? { changed, ...(removed.length ? { removed } : {}) } : undefined;
  }

  function diffValue(before, after, key = "") {
    if (JSON.stringify(before) === JSON.stringify(after)) return undefined;
    if (Array.isArray(before) && Array.isArray(after)) {
      // Orbs are an ordered queue, not an ID-keyed entity set. A replacement
      // is small and clears stale values when evoking, rotating or resizing.
      if (key === "orbs") return after;
      if (key === "hand") return handArrayDifference(before, after);
      if (key === "deck") {
        const { removed, added } = multisetDifference(before, after);
        return {
          ...(removed.length ? { removed } : {}),
          ...(added.length ? { added } : {}),
        };
      }
      const entityDelta = entityArrayDifference(before, after);
      return entityDelta ?? after;
    }
    if (!before || !after || typeof before !== "object" || typeof after !== "object") {
      return after;
    }
    const result = {};
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!(key in after)) result[key] = null;
      else {
        const change = diffValue(before[key], after[key], key);
        if (change !== undefined) result[key] = change;
      }
    }
    return Object.keys(result).length ? result : undefined;
  }

  function compactRunDelta(before, after) {
    if (!before) return { run_context: after };
    const delta = diffValue(before, after);
    if (!delta) return {};
    const named = {};
    for (const [key, value] of Object.entries(delta)) {
      if (key === "relics") named.relic_changes = value;
      else if (key === "deck") named.deck_changes = value;
      else if (key === "potions") named.potion_changes = value;
      else named[key] = value;
    }
    return { run_delta: named };
  }

  function rememberAndCompact(state, deltaOnly = false, actionResult = undefined) {
    const includeMap = state.map_version && session.mapCache.emittedVersion !== state.map_version;
    const compact = compactState(state, { includeMap });
    const change = session.previousState ? diffValue(session.previousState, compact) : compact;
    const runContext = compactRunContext(state);
    const runPayload = runContext ? compactRunDelta(session.previousRunContext, runContext) : {};
    const definitionPayload = pendingCardDefinitionPayload();
    const advisories = collectContextAdvisories(state);
    const advisoryPayload = advisories.length ? { advisories } : {};
    const current = { stance: currentStance(state) };
    session.previousState = compact;
    session.observedHandState = { floor: state.floor, turn: state?.combat_detail?.turn,
      hand: (state.hand ?? []).map((card) => ({ ...card })) };
    if (runContext) session.previousRunContext = runContext;
    if (includeMap) session.mapCache.emittedVersion = state.map_version;
    if (actionResult) {
      return { result: actionResult, current, changes: change ?? {}, ...runPayload, ...definitionPayload, ...advisoryPayload };
    }
    return deltaOnly
      ? { delta: change ?? {}, current, ...runPayload, ...definitionPayload, ...advisoryPayload }
      : { ...compact, ...runPayload, ...definitionPayload, ...advisoryPayload };
  }

  return {
    powerAmount,
    hasRelic,
    estimatedDamagePerHit,
    targetDamageEstimate,
    compactCard,
    compactChoiceCard,
    normalizeDisplayedChoiceIndices,
    compactMapNode,
    compactDeckCard,
    compactRelic,
    compactPotion,
    currentStance,
    compactScreenCard,
    compactStoreItem,
    compactShopChoices,
    compactScreenDetails,
    compactRunContext,
    compactState,
    multisetDifference,
    handCardKey,
    handArrayDifference,
    entityArrayDifference,
    diffValue,
    compactRunDelta,
    rememberAndCompact,
  };
}
