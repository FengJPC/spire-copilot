// One instance owns all mutable runtime state. A transport reset is not a game reset.
export function createSession() {
  return {
    sessionId: undefined,
    requestId: 1,
    toolCache: undefined,
    previousState: undefined,
    observedHandState: undefined,
    handHandles: { next: 1, byUuid: new Map(), byKey: new Map() },
    previousRunContext: undefined,
    gameInitialized: false,
    combatSafety: { floor: null, turn: null, trackedCardsPlayed: 0, countUncertain: false },
    turnTransitionSafety: { floor: null, turn: null, endTurnSent: false },
    advisoryKeys: new Set(),
    mapCache: { act: null, nodes: null, version: null, emittedVersion: null },
    lastStableDecisionState: undefined,
    cardCatalog: {
      activeRun: false,
      rawById: new Map(),
      attemptedIds: new Set(),
      definitions: new Map(),
      emittedRefs: new Set(),
      catalogPayloadSent: false,
    },
  };
}
