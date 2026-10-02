// Pure helpers: no session state, I/O on import, or runtime lifecycle.
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function parseState(message) {
  try {
    return JSON.parse(message);
  } catch {
    throw new Error(`State was not JSON: ${message}`);
  }
}

export function isConnectionError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /fetch failed|ECONNREFUSED|ECONNRESET|socket|HTTP 404|HTTP 410|HTTP 5\d\d/i.test(message);
}

export function isTimeoutError(error) {
  return error?.code === "ACTION_SETTLEMENT_TIMEOUT"
    || error?.code === "ACTION_TRANSPORT_TIMEOUT"
    || /^Timed out after \d+ms/i.test(String(error?.message ?? error));
}

export function liveMonsters(state) {
  return (state?.monsters ?? []).filter((monster) => !monster.is_gone);
}

export function identityKey(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

export function entityMatches(entity, identities) {
  const values = [entity?.id, entity?.name].map(identityKey).filter(Boolean);
  const expected = identities.map(identityKey);
  return values.some((value) => expected.includes(value));
}

export function entityHasPower(entity, identities) {
  return (entity?.powers ?? []).some((power) => entityMatches(power, identities));
}

export function stateHasRelic(state, identities) {
  return (state?.run_detail?.relics ?? []).some((relic) => entityMatches(relic, identities));
}
