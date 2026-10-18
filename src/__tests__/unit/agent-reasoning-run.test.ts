/**
 * Agent reasoning on a real run: what reaches the native model (the
 * agent > Model Hub > request precedence inputs), which model's pick applies
 * when the caller chose an additional model, and where the thinking text is
 * hidden when the agent says `showReasoning: false` (API response, stored
 * session message) while the operator's playground result keeps it.
 *
 * SDK faked at the boundary (same pattern as agent-structured-output-response).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IAgent, IAgentConversation } from '@/lib/database';

const hoisted = vi.hoisted(() => ({
  runHook: vi.fn(),
  resolveGuardrail: vi.fn(),
  getModelByKey: vi.fn(),
  buildGatewayChatModel: vi.fn(),
  scripted: { content: 'plain answer', reasoning: 'secret thoughts' } as { content: string; reasoning?: string; events?: Array<Record<string, unknown>>; chunks?: Array<Record<string, unknown>> },
  invokeConfigs: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));

vi.mock('@/lib/services/models/modelService', () => ({
  getModelByKey: hoisted.getModelByKey,
}));

vi.mock('@/lib/services/agents/gatewayChatModel', () => ({
  buildGatewayChatModel: hoisted.buildGatewayChatModel,
  isDynamicModel: () => false,
}));

vi.mock('@/lib/services/guardrail/hooks/engine', () => ({
  runHook: hoisted.runHook,
  resolveGuardrail: hoisted.resolveGuardrail,
  ensureDefaultToolGuardrail: vi.fn(async () => ({ key: 'tool-safety-default' })),
  DEFAULT_TOOL_GUARDRAIL_KEY: 'tool-safety-default',
  mergeVerdicts: vi.fn(),
  assertContractVersion: vi.fn(),
}));

vi.mock('@/lib/services/guardrail/hooks/legacy', () => ({
  ensureHooks: () => ({
    hooksVersion: 1,
    hooks: {
      contractVersion: 2,
      policies: [],
      bindings: {},
    },
  }),
}));

/** The SDK at the boundary; each test scripts what `invoke()` reports. */
vi.mock('@cognipeer/agent-sdk', () => {
  const hookNames = [
    'userPromptSubmit', 'preModelCall', 'postModelCall', 'preToolUse', 'postToolUse',
    'preFinalAnswer', 'postFinalAnswer', 'onRunStart', 'onRunEnd', 'onError', 'onStateChange',
    'preCompact', 'postCompact',
  ];
  const hooks: Record<string, unknown> = {};
  for (const name of hookNames) hooks[name] = { implemented: true };
  const CONSOLE_HOOK_MAP = {
    'prompt.pre': 'userPromptSubmit',
    'input.pre': 'preModelCall',
    'output.pre': 'postModelCall',
    'output.stream.delta': null,
    'tool.pre': 'preToolUse',
    'tool.post': 'postToolUse',
  };

  const createSmartAgent = () => ({
    invoke: async (state: { messages: Array<{ role: string; content: unknown }> }, config?: { onEvent?: (event: Record<string, unknown>) => void; onStream?: (chunk: Record<string, unknown>) => void }) => {
      hoisted.invokeConfigs.push((config ?? {}) as Record<string, unknown>);
      // What a streaming model call reports while it runs (the SDK's `reasoning` events).
      for (const event of hoisted.scripted.events ?? []) config?.onEvent?.(event);
      for (const chunk of hoisted.scripted.chunks ?? []) config?.onStream?.(chunk);
      const answer = {
        role: 'assistant',
        content: hoisted.scripted.content,
        ...(hoisted.scripted.reasoning ? { reasoning: { summary: hoisted.scripted.reasoning, blocks: [] } } : {}),
      };
      const messages = [...state.messages, answer];
      return {
        content: answer.content,
        messages,
        state: { ...state, messages },
        metadata: {},
      };
    },
  });

  return {
    version: '0.10.1',
    pluginCapabilities: () => ({
      hookContractVersion: 1,
      hooks,
      slots: {},
      features: { streamGate: { implemented: false }, traceSinkContribution: { implemented: false } },
    }),
    CONSOLE_HOOK_MAP,
    GuardrailPhase: { Request: 'request', Response: 'response' },
    createSmartAgent,
    createTool: (spec: unknown) => spec,
    customSink: (config: unknown) => config,
  };
});

import { getDatabase } from '@/lib/database';
import { createMockDb } from '../helpers/db.mock';
import { executeAgentChatLocal, executePlaygroundChatLocal } from '@/lib/services/agents/agentService';

const TENANT_DB = 'tenant_acme';
const TENANT_ID = 'tenant-acme';
const PROJECT_ID = 'proj-1';
const AGENT_KEY = 'thinker';
const CONVERSATION_ID = 'conv-1';

function agentWith(config: Record<string, unknown>): IAgent {
  return {
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    key: AGENT_KEY,
    name: 'Thinker',
    config: { modelKey: 'main', systemPrompt: 'Think.', ...config },
    createdBy: 'user-1',
  } as IAgent;
}

function conversation(): IAgentConversation {
  return {
    _id: CONVERSATION_ID,
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    agentKey: AGENT_KEY,
    title: 'New conversation',
    messages: [],
    createdBy: 'user-1',
  };
}

let db: ReturnType<typeof createMockDb>;

const modelRecord = (key: string) => ({
  key, name: key, category: 'llm', providerKey: 'openai', providerDriver: 'openai', modelId: key,
  tenantId: TENANT_ID, projectId: PROJECT_ID, settings: {},
});

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.scripted = { content: 'plain answer', reasoning: 'secret thoughts' };
  db = createMockDb();
  (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  db.findAgentConversationById.mockResolvedValue(conversation());
  hoisted.getModelByKey.mockImplementation(async (_db: string, key: string) => modelRecord(key));
  hoisted.buildGatewayChatModel.mockResolvedValue({});
});

const base = {
  tenantDbName: TENANT_DB,
  tenantId: TENANT_ID,
  projectId: PROJECT_ID,
  agentKey: AGENT_KEY,
  conversationId: CONVERSATION_ID,
  userMessage: 'think about it',
  userId: 'user-1',
};

/** The reasoning inputs the run handed the native model of the MAIN call. */
function mainModelCall() {
  return hoisted.buildGatewayChatModel.mock.calls[0][0] as { model: { key: string }; reasoning?: unknown; requestReasoning?: unknown };
}

function persistedAssistantTurn() {
  const update = db.updateAgentConversation.mock.calls[0][1] as unknown as { messages: Array<Record<string, unknown>> };
  return update.messages[update.messages.length - 1];
}

const reasoningItem = (response: { output: Array<{ type: string }> }) => response.output.find((item) => item.type === 'reasoning');

describe('what a run hands the native model', () => {
  it('the agent pick goes as the top rung, the request value as the bottom one', async () => {
    db.findAgentByKey.mockResolvedValue(agentWith({ reasoningEffort: 'high', reasoningBudgetTokens: 8000 }));
    await executeAgentChatLocal({ ...base, requestReasoning: { effort: 'minimal' } });
    expect(mainModelCall().model.key).toBe('main');
    expect(mainModelCall().reasoning).toEqual({ effort: 'high', budgetTokens: 8000 });
    expect(mainModelCall().requestReasoning).toEqual({ effort: 'minimal' });
  });

  it('no pick on the agent: nothing at the top rung, Model Hub and request decide', async () => {
    db.findAgentByKey.mockResolvedValue(agentWith({}));
    await executeAgentChatLocal({ ...base, requestReasoning: { effort: 'low' } });
    expect(mainModelCall().reasoning).toBeUndefined();
    expect(mainModelCall().requestReasoning).toEqual({ effort: 'low' });
  });

  it('a caller who picks an additional model gets THAT model\'s pick, not the main model\'s', async () => {
    db.findAgentByKey.mockResolvedValue(agentWith({
      reasoningEffort: 'high',
      additionalModels: [{ modelKey: 'cheap', reasoningEffort: 'none' }, { modelKey: 'other' }],
    }));
    await executeAgentChatLocal({ ...base, modelKey: 'cheap' });
    expect(mainModelCall().model.key).toBe('cheap');
    expect(mainModelCall().reasoning).toEqual({ effort: 'none' });
  });

  it('an additional model with no pick falls back to Model Hub / request, never to the main pick', async () => {
    db.findAgentByKey.mockResolvedValue(agentWith({
      reasoningEffort: 'high',
      additionalModels: [{ modelKey: 'other' }],
    }));
    await executeAgentChatLocal({ ...base, modelKey: 'other', requestReasoning: { effort: 'low' } });
    expect(mainModelCall().model.key).toBe('other');
    expect(mainModelCall().reasoning).toBeUndefined();
    expect(mainModelCall().requestReasoning).toEqual({ effort: 'low' });
  });

  it('an old config (runtime.reasoning) runs with its migrated pick', async () => {
    db.findAgentByKey.mockResolvedValue(agentWith({
      runtime: { reasoning: { enabled: true, effort: 'medium', budgetTokens: 4096 } },
    }));
    await executeAgentChatLocal({ ...base });
    expect(mainModelCall().reasoning).toEqual({ effort: 'medium', budgetTokens: 4096 });
  });
});

describe('sub-agents', () => {
  const sub = (modelKey: string) => ({ kind: 'inline', name: 'helper', modelKey, systemPrompt: 'help', enabled: true });
  const callFor = (key: string) => (hoisted.buildGatewayChatModel.mock.calls
    .map((call) => call[0] as { model: { key: string }; reasoning?: unknown; requestReasoning?: unknown })
    .find((input) => input.model.key === key))!;

  it('a sub-agent on a model the agent picked for gets that pick, plus the request value as the fallback', async () => {
    db.findAgentByKey.mockResolvedValue(agentWith({ reasoningEffort: 'high', subagents: [sub('main')] }));
    await executeAgentChatLocal({ ...base, requestReasoning: { effort: 'low' } });
    const calls = hoisted.buildGatewayChatModel.mock.calls.map((call) => call[0] as { reasoning?: unknown });
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call.reasoning).toEqual({ effort: 'high' });
  });

  it('a sub-agent on another model has no agent pick: Model Hub, then the request', async () => {
    db.findAgentByKey.mockResolvedValue(agentWith({ reasoningEffort: 'high', subagents: [sub('worker')] }));
    await executeAgentChatLocal({ ...base, requestReasoning: { effort: 'low' } });
    expect(callFor('main').reasoning).toEqual({ effort: 'high' });
    expect(callFor('worker').reasoning).toBeUndefined();
    expect(callFor('worker').requestReasoning).toEqual({ effort: 'low' });
  });

  it('a sub-agent on an additional model of the agent uses that entry\'s pick', async () => {
    db.findAgentByKey.mockResolvedValue(agentWith({
      additionalModels: [{ modelKey: 'worker', reasoningEffort: 'minimal' }],
      subagents: [sub('worker')],
    }));
    await executeAgentChatLocal({ ...base });
    expect(callFor('worker').reasoning).toEqual({ effort: 'minimal' });
  });
});

describe('showReasoning', () => {
  it('default (true): the response carries the reasoning item and the stored message the text', async () => {
    db.findAgentByKey.mockResolvedValue(agentWith({}));
    const response = await executeAgentChatLocal({ ...base });
    expect(reasoningItem(response)).toBeTruthy();
    expect(persistedAssistantTurn()).toMatchObject({ reasoning: 'secret thoughts' });
  });

  it('false: API response and stored session message both leave it out', async () => {
    db.findAgentByKey.mockResolvedValue(agentWith({ showReasoning: false }));
    const response = await executeAgentChatLocal({ ...base });
    expect(reasoningItem(response)).toBeUndefined();
    expect(JSON.stringify(response)).not.toContain('secret thoughts');
    expect(persistedAssistantTurn()).not.toHaveProperty('reasoning');
    expect(response.output[response.output.length - 1]).toMatchObject({ type: 'message' });
  });

  it('false: the operator playground result keeps it, the session it stores does not', async () => {
    db.findAgentByKey.mockResolvedValue(agentWith({ showReasoning: false }));
    const result = await executePlaygroundChatLocal({ ...base });
    expect(result.reasoning).toBe('secret thoughts');
    expect(persistedAssistantTurn()).not.toHaveProperty('reasoning');
  });

  it('false + operator view (Compare versions): the model is asked for the thinking text, and its stream is forwarded', async () => {
    db.findAgentByKey.mockResolvedValue(agentWith({ showReasoning: false }));
    const onReasoningChunk = vi.fn();
    const modelInputs = () => hoisted.buildGatewayChatModel.mock.calls.map((call) => call[0] as { showReasoning?: boolean; onReasoning?: unknown });

    // The playground path is the operator's view: the thinking text is requested even though the agent hides
    // it (API callers of such an agent are covered by the agent API tests); live deltas come from the SDK's
    // reasoning events, not a gateway hook.
    const result = await executePlaygroundChatLocal({ ...base, revealReasoning: true, onReasoningChunk });
    expect(modelInputs()[0].showReasoning).toBeUndefined();
    expect(modelInputs()[0].onReasoning).toBeUndefined();
    expect(result.reasoning).toBe('secret thoughts');
  });

  it('true: the playground stores it on the session like before', async () => {
    db.findAgentByKey.mockResolvedValue(agentWith({}));
    await executePlaygroundChatLocal({ ...base });
    expect(persistedAssistantTurn()).toMatchObject({ reasoning: 'secret thoughts' });
  });
});

describe('live reasoning', () => {
  const stepsOfThinking = [
    { type: 'reasoning', text: 'Need the ' },
    { type: 'reasoning', text: 'weather.' },
    { type: 'tool_call', phase: 'start', name: 'weather', id: 't1' },
    { type: 'reasoning', text: 'Got it.' },
  ];

  beforeEach(() => {
    hoisted.invokeConfigs.length = 0;
    hoisted.scripted = { content: 'plain answer', reasoning: 'the last message only', events: stepsOfThinking };
  });

  it('turns the model call into a stream and forwards the thinking, paragraph per model step', async () => {
    db.findAgentByKey.mockResolvedValue(agentWith({}));
    const chunks: string[] = [];
    const response = await executeAgentChatLocal({ ...base, onReasoningChunk: (text: string) => chunks.push(text) });
    expect(hoisted.invokeConfigs.at(-1)).toMatchObject({ stream: true });
    expect(chunks.join('')).toBe('Need the weather.\n\nGot it.');
    // The whole turn's thinking, not just what the last message kept.
    expect(reasoningItem(response)).toMatchObject({ summary: [{ text: 'Need the weather.\n\nGot it.' }] });
  });

  it('a caller that did not ask does not switch the model call into streaming', async () => {
    db.findAgentByKey.mockResolvedValue(agentWith({}));
    await executeAgentChatLocal({ ...base });
    expect(hoisted.invokeConfigs.at(-1)).not.toHaveProperty('stream');
  });

  it('showReasoning false: an API caller gets no live thinking and no stream for it', async () => {
    db.findAgentByKey.mockResolvedValue(agentWith({ showReasoning: false }));
    const chunks: string[] = [];
    await executeAgentChatLocal({ ...base, onReasoningChunk: (text: string) => chunks.push(text) });
    expect(chunks).toEqual([]);
    expect(hoisted.invokeConfigs.at(-1)).not.toHaveProperty('stream');
  });

  it('showReasoning false: the operator playground still gets it live and in the result, but does not store it', async () => {
    db.findAgentByKey.mockResolvedValue(agentWith({ showReasoning: false }));
    const chunks: string[] = [];
    const result = await executePlaygroundChatLocal({ ...base, onReasoningChunk: (text: string) => chunks.push(text) });
    expect(chunks.join('')).toBe('Need the weather.\n\nGot it.');
    expect(result.reasoning).toBe('Need the weather.\n\nGot it.');
    expect(persistedAssistantTurn()).not.toHaveProperty('reasoning');
  });

  it('the playground model call is told to keep the thinking text even when the agent hides it', async () => {
    db.findAgentByKey.mockResolvedValue(agentWith({ showReasoning: false }));
    hoisted.buildGatewayChatModel.mockClear();
    await executePlaygroundChatLocal({ ...base });
    expect(hoisted.buildGatewayChatModel.mock.calls.at(-1)![0]).not.toHaveProperty('showReasoning');
    hoisted.buildGatewayChatModel.mockClear();
    await executeAgentChatLocal({ ...base });
    expect(hoisted.buildGatewayChatModel.mock.calls.at(-1)![0]).toMatchObject({ showReasoning: false });
  });
});

describe('what a sub-agent forwards is not the turn\'s own', () => {
  // The SDK passes a delegated child's events up stamped with the child (`subagentName` / `subagentId`).
  const child = { subagentName: 'helper', subagentId: 'sa_1' };
  const compaction = (extra: Record<string, unknown> = {}) => ({
    type: 'summarization', messagesCompressed: 12, tokenCountBefore: 9000, tokenCountAfter: 2000, ...extra,
  });

  beforeEach(() => {
    hoisted.invokeConfigs.length = 0;
  });

  it('keeps the child\'s thinking out of the live reasoning and the turn\'s reasoning', async () => {
    hoisted.scripted = {
      content: 'plain answer',
      events: [
        { type: 'reasoning', text: 'Parent plans.' },
        { type: 'tool_call', phase: 'start', name: 'delegate_to', id: 'd1' },
        { type: 'reasoning', text: 'Child thinks.', ...child },
        { type: 'tool_call', phase: 'start', name: 'lookup', id: 'c1', ...child },
        { type: 'reasoning', text: 'Child again.', ...child },
        { type: 'tool_call', phase: 'success', name: 'delegate_to', id: 'd1' },
        { type: 'reasoning', text: 'Parent concludes.' },
      ],
    };
    db.findAgentByKey.mockResolvedValue(agentWith({}));
    const chunks: string[] = [];
    const response = await executeAgentChatLocal({ ...base, onReasoningChunk: (text: string) => chunks.push(text) });
    expect(chunks.join('')).toBe('Parent plans.\n\nParent concludes.');
    expect(reasoningItem(response)).toMatchObject({ summary: [{ text: 'Parent plans.\n\nParent concludes.' }] });
    expect(persistedAssistantTurn()).toMatchObject({ reasoning: 'Parent plans.\n\nParent concludes.' });

    chunks.length = 0;
    db.updateAgentConversation.mockClear();
    const result = await executePlaygroundChatLocal({ ...base, onReasoningChunk: (text: string) => chunks.push(text) });
    expect(chunks.join('')).toBe('Parent plans.\n\nParent concludes.');
    expect(result.reasoning).toBe('Parent plans.\n\nParent concludes.');
  });

  it('keeps the child\'s text out of the answer stream', async () => {
    hoisted.scripted = {
      content: 'plain answer',
      chunks: [
        { text: 'Parent ' },
        { text: 'CHILD LEAK', ...child },
        { text: 'answer' },
        { text: 'plain answer', isFinal: true },
      ],
    };
    db.findAgentByKey.mockResolvedValue(agentWith({}));
    const seen: string[] = [];
    await executeAgentChatLocal({ ...base, onTextChunk: (text: string) => seen.push(text) });
    expect(seen).toEqual(['Parent ', 'answer']);

    seen.length = 0;
    await executePlaygroundChatLocal({ ...base, onTextChunk: (text: string) => seen.push(text) });
    expect(seen).toEqual(['Parent ', 'answer']);
  });

  it('does not record the child\'s compaction as a compaction of the turn', async () => {
    hoisted.scripted = {
      content: 'plain answer',
      events: [compaction(child), compaction({ messagesCompressed: 4 })],
    };
    db.findAgentByKey.mockResolvedValue(agentWith({}));
    const live: unknown[] = [];
    await executeAgentChatLocal({ ...base });
    // Only the turn's own compaction is on the stored message.
    expect((persistedAssistantTurn().compactions as Array<{ messagesCompressed: number }>).map((c) => c.messagesCompressed)).toEqual([4]);

    db.updateAgentConversation.mockClear();
    await executePlaygroundChatLocal({ ...base, onCompaction: (c: unknown) => live.push(c) });
    expect((persistedAssistantTurn().compactions as Array<{ messagesCompressed: number }>).map((c) => c.messagesCompressed)).toEqual([4]);
    expect(live).toHaveLength(1);
  });
});
