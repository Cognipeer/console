/**
 * Agent Service
 *
 * The public surface of the agent service: every name below lives in its own module
 * (records, conversations, chat run, playground run, resume, tracing, ...) and is
 * re-exported here so callers keep one import path. No logic lives in this file.
 */

import { textStreamOptions, createTurnFlowSink, turnFlowRecord } from './agentStreamTaps';
import { guardrailDenial, guardrailBlockedError, buildAgentGuardrailPlugins, MessageRewriteLedger, persistedUserTurn } from './agentGuardrails';
import { firstTurnTitle } from './agentChatRun';
import { toToolCallEvent } from './agentChatTypes';
import { buildAgentCostEstimator, priceAgentTurn } from './agentCost';

export { knowledgeCallerOf, buildAgentKnowledgeTools } from './agentKnowledgeTools';
export { incompleteReason, agentRelayCallbacks } from './agentChatTypes';
export type { AgentRunCancellationCell, AgentChatRequest, AgentToolCallEvent, AgentPlaygroundChatRequest, AgentPlaygroundStep, AgentPlaygroundChatResult, ResponseOutputText, ResponseOutputMessage, ResponseReasoningItem, ResponseOutputItem, ResponseUsage, AgentChatResponse } from './agentChatTypes';
export { createAgentToolGuard } from './agentToolGuard';
export { AgentGuardrailBlockedError } from './agentGuardrails';
export { extractAgentReasoning, buildTracingMetadata, reconcileTraceTotals, markTraceSessionFailed, createInternalTracingSink, extractInternalTraceDiagnostics } from './agentTracing';
export { assertOwnedAgentReachable, buildAgentSubagents, buildSubagentModel } from './agentSubagents';
export type { AgentModelCaller, SubagentOutputOptions } from './agentSubagents';
export { buildBoundTools } from './agentBoundTools';
export { createAgentRecord, updateAgentRecord, deleteAgentRecord, getAgentById, getAgentByKey, listAgents, publishAgent, getAgentVersion, listAgentVersions, resolveAgentVoiceVersion, buildAgentChatModel, checkAgentModel } from './agentRecords';
export type { AgentModelCheckResult, AgentModelCall } from './agentRecords';
export { createConversation, getConversationById, listConversations, deleteConversation } from './agentConversations';
export type { AgentConversationSource } from './agentConversations';
export { createReasoningTap } from './agentStreamTaps';
export { executeAgentChat, executeAgentChatLocal, agentMayStreamAnswer, routingCallerOf } from './agentChatRun';
export { extractPlaygroundSteps } from './agentPlaygroundSteps';
export { executePlaygroundChat, executePlaygroundChatLocal } from './agentPlaygroundRun';
export { validateApprovedArgs, executeAgentContinueLocal, executeAgentResumeLocal } from './agentResume';
export type { AgentResumeRequest, AgentResumeResult } from './agentResume';

// Lives in agentConfigResolution.ts (the spend pre-flight and the sub-agent roster need it without
// importing this module); the name stays here for every caller.
export { resolveAgentConfig } from './agentConfigResolution';

/**
 * EXPORTED FOR TESTS ONLY. These are module-private helpers whose whole job is
 * to notice something the SDK does not announce, or to compose several keys'
 * plugins; they need coverage that does not require standing up a real agent
 * and a real model.
 */
export const __testables = {
    textStreamOptions,
    createTurnFlowSink,
    turnFlowRecord,
    guardrailDenial,
    guardrailBlockedError,
    buildAgentGuardrailPlugins,
    MessageRewriteLedger,
    persistedUserTurn,
    firstTurnTitle,
    toToolCallEvent,
    buildAgentCostEstimator,
    priceAgentTurn,
};
