import { createConfig } from './config.mjs';
import { createSession } from './session.mjs';
import * as shared from './shared.mjs';
import { createTransport } from './transport.mjs';
import { createState } from './state.mjs';
import { createCards } from './cards.mjs';
import { createSafety } from './safety.mjs';
import { createSettlement } from './settlement.mjs';
import { createCompaction } from './compaction.mjs';
import { createExecution } from './execution.mjs';
import { createInspection } from './inspection.mjs';
import { createProtocol } from './protocol.mjs';

// Only this composition root connects domains. Forward callbacks break lifecycle
// cycles without ESM cycles, global singletons, or dependencies on the stdio entry.
export function createRuntime({ env = process.env, config: overrides = {} } = {}) {
  const config = createConfig(env, overrides);
  const session = createSession();
  const context = { config, session };
  const modules = {};
  modules.shared = shared;
  modules.transport = createTransport(context, {
    resetCardCatalog: (...args) => modules.cards.resetCardCatalog(...args),
    resetMapCache: (...args) => modules.state.resetMapCache(...args),
  });
  modules.state = createState(context, {
    enrichCardDefinitions: (...args) => modules.cards.enrichCardDefinitions(...args),
    liveMonsters: (...args) => modules.shared.liveMonsters(...args),
    monsterRosterKey: (...args) => modules.safety.monsterRosterKey(...args),
    parseState: (...args) => modules.shared.parseState(...args),
    rawTool: (...args) => modules.transport.rawTool(...args),
    sleep: (...args) => modules.shared.sleep(...args),
    syncEndTurnSafety: (...args) => modules.safety.syncEndTurnSafety(...args),
  });
  modules.cards = createCards(context, {
    isConnectionError: (...args) => modules.shared.isConnectionError(...args),
    isPlayCardAction: (...args) => modules.safety.isPlayCardAction(...args),
    isTimeoutError: (...args) => modules.shared.isTimeoutError(...args),
    parseState: (...args) => modules.shared.parseState(...args),
    rawTool: (...args) => modules.transport.rawTool(...args),
  });
  modules.safety = createSafety(context, {
    cardForAction: (...args) => modules.cards.cardForAction(...args),
    choiceCards: (...args) => modules.cards.choiceCards(...args),
    entityHasPower: (...args) => modules.shared.entityHasPower(...args),
    entityMatches: (...args) => modules.shared.entityMatches(...args),
    liveMonsters: (...args) => modules.shared.liveMonsters(...args),
    stateHasRelic: (...args) => modules.shared.stateHasRelic(...args),
  });
  modules.settlement = createSettlement(context, {
    cardForAction: (...args) => modules.cards.cardForAction(...args),
    cardIdentityMatches: (...args) => modules.cards.cardIdentityMatches(...args),
    choiceCards: (...args) => modules.cards.choiceCards(...args),
    decisionState: (...args) => modules.state.decisionState(...args),
    endTurnHasSettled: (...args) => modules.safety.endTurnHasSettled(...args),
    isPlayCardAction: (...args) => modules.safety.isPlayCardAction(...args),
    isTimeoutError: (...args) => modules.shared.isTimeoutError(...args),
    monsterRosterKey: (...args) => modules.safety.monsterRosterKey(...args),
    sleep: (...args) => modules.shared.sleep(...args),
  });
  modules.compaction = createCompaction(context, {
    cardRef: (...args) => modules.cards.cardRef(...args),
    cardUpgradeCount: (...args) => modules.cards.cardUpgradeCount(...args),
    choiceCards: (...args) => modules.cards.choiceCards(...args),
    collectContextAdvisories: (...args) => modules.safety.collectContextAdvisories(...args),
    compactCardInstance: (...args) => modules.cards.compactCardInstance(...args),
    handHandle: (...args) => modules.cards.handHandle(...args),
    pendingCardDefinitionPayload: (...args) => modules.cards.pendingCardDefinitionPayload(...args),
  });
  modules.execution = createExecution(context, {
    choiceCards: (...args) => modules.cards.choiceCards(...args),
    decisionState: (...args) => modules.state.decisionState(...args),
    isConnectionError: (...args) => modules.shared.isConnectionError(...args),
    isPlayCardAction: (...args) => modules.safety.isPlayCardAction(...args),
    isTargetedAction: (...args) => modules.safety.isTargetedAction(...args),
    isTimeoutError: (...args) => modules.shared.isTimeoutError(...args),
    makeSettlementTimeout: (...args) => modules.settlement.makeSettlementTimeout(...args),
    markEndTurnSent: (...args) => modules.safety.markEndTurnSent(...args),
    monsterRosterKey: (...args) => modules.safety.monsterRosterKey(...args),
    normalitySafetyCheck: (...args) => modules.safety.normalitySafetyCheck(...args),
    normalizeChooseArgs: (...args) => modules.safety.normalizeChooseArgs(...args),
    normalizeStableCardReference: (...args) => modules.cards.normalizeStableCardReference(...args),
    parseState: (...args) => modules.shared.parseState(...args),
    preflightCombatActions: (...args) => modules.safety.preflightCombatActions(...args),
    rawTool: (...args) => modules.transport.rawTool(...args),
    rememberAndCompact: (...args) => modules.compaction.rememberAndCompact(...args),
    resetGameConnection: (...args) => modules.transport.resetGameConnection(...args),
    resolvePlayCardAction: (...args) => modules.cards.resolvePlayCardAction(...args),
    sleep: (...args) => modules.shared.sleep(...args),
    syncCombatSafety: (...args) => modules.safety.syncCombatSafety(...args),
    validateToolCall: (...args) => modules.transport.validateToolCall(...args),
    waitForActionSettlement: (...args) => modules.settlement.waitForActionSettlement(...args),
  });
  modules.inspection = createInspection(context, {
    cardRef: (...args) => modules.cards.cardRef(...args),
    cardUpgradeCount: (...args) => modules.cards.cardUpgradeCount(...args),
    collectCardInstances: (...args) => modules.cards.collectCardInstances(...args),
    compactCardInstance: (...args) => modules.cards.compactCardInstance(...args),
    decisionState: (...args) => modules.state.decisionState(...args),
    loadCardInfo: (...args) => modules.cards.loadCardInfo(...args),
    normalizeCardText: (...args) => modules.cards.normalizeCardText(...args),
    pendingCardDefinitionPayload: (...args) => modules.cards.pendingCardDefinitionPayload(...args),
    rememberCardDefinition: (...args) => modules.cards.rememberCardDefinition(...args),
  });
  modules.protocol = createProtocol(context, {
    actionToolCall: (...args) => modules.execution.actionToolCall(...args),
    callAndSettle: (...args) => modules.execution.callAndSettle(...args),
    decisionState: (...args) => modules.state.decisionState(...args),
    inspectCard: (...args) => modules.inspection.inspectCard(...args),
    inspectPile: (...args) => modules.inspection.inspectPile(...args),
    isConnectionError: (...args) => modules.shared.isConnectionError(...args),
    listTools: (...args) => modules.transport.listTools(...args),
    normalizeDisplayedChoiceIndices: (...args) => modules.compaction.normalizeDisplayedChoiceIndices(...args),
    rememberAndCompact: (...args) => modules.compaction.rememberAndCompact(...args),
    resetGameConnection: (...args) => modules.transport.resetGameConnection(...args),
  });
  return { config, session, modules, handleMcpMessage: modules.protocol.handleMcpMessage };
}
