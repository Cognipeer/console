/**
 * The session event log and `steps` as `executeAgentChatLocal` produces them.
 * SDK faked at the boundary; SYNC mock factories (this repo's vitest notes).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IAgent, IAgentConversation } from '@/lib/database';

const hoisted = vi.hoisted(() => ({
  runHook: vi.fn(),
  resolveGuardrail: vi.fn(),
  getModelByKey: vi.fn(),
  buildGatewayChatModel: vi.fn(),
  scripted: { content: 'plain answer' } as { content: string; ctx?: Record<string, unknown> },
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
    invoke: async (
      state: { messages: Array<{ role: string; content: unknown }> },
      config?: { onEvent?: (event: Record<string, unknown>) => void; onStream?: (c: { text?: string }) => void; stream?: boolean },
    ) => {
      config?.onEvent?.({ type: 'tool_call', phase: 'start', name: 'lookup', id: 'tc1', args: { q: 'x' } });
      config?.onEvent?.({ type: 'tool_call', phase: 'success', name: 'lookup', id: 'tc1', durationMs: 5 });
      config?.onStream?.({ text: 'par' });
      const answer = { role: 'assistant', content: hoisted.scripted.content };
      const messages = [...state.messages, answer];
      return {
        content: answer.content,
        messages,
        state: {
          ...state,
          messages,
          toolHistory: [{ executionId: 'e1', toolName: 'lookup', args: { q: 'x' }, output: { hit: 1 }, status: 'success' }],
          ctx: hoisted.scripted.ctx ?? {},
        },
        metadata: { usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } },
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
import { executeAgentChatLocal } from '@/lib/services/agents/agentService';
import { messageIdOf } from '@/lib/services/agents/messageIds';

const TENANT_DB = 'tenant_acme';
const TENANT_ID = 'tenant-acme';
const PROJECT_ID = 'proj-1';
const AGENT_KEY = 'jira-analysis';
const CONVERSATION_ID = 'conv-1';

function nativeAgent(): IAgent {
  return {
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    key: AGENT_KEY,
    name: 'Jira Analysis',
    config: {
      modelKey: 'gpt-4o',
      systemPrompt: 'Analyse the issue.',
    },
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

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.scripted = { content: 'plain answer' };
  db = createMockDb();
  (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  db.findAgentConversationById.mockResolvedValue(conversation());
  hoisted.getModelByKey.mockResolvedValue({
    key: 'gpt-4o',
    name: 'GPT-4o',
    category: 'llm',
    providerKey: 'openai',
    providerDriver: 'openai',
    modelId: 'gpt-4o',
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    settings: {},
  });
  hoisted.buildGatewayChatModel.mockResolvedValue({});
});

function run(extra: Record<string, unknown> = {}) {
  return executeAgentChatLocal({
    tenantDbName: TENANT_DB,
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    agentKey: AGENT_KEY,
    conversationId: CONVERSATION_ID,
    userMessage: 'look it up',
    userId: 'user-1',
    ...extra,
  });
}

/** Everything the turn wrote to the event log, in order. */
function loggedEvents() {
  return db.appendAgentSessionEvents.mock.calls.flatMap((call) => call[0] as Array<{ seq: number; type: string; data: Record<string, unknown>; runId?: string }>);
}

describe('executeAgentChatLocal — session events and steps', () => {
  beforeEach(() => {
    db.findAgentByKey.mockResolvedValue(nativeAgent());
  });

  it('persists the tool calls as steps on the assistant message (steps parity with sessions)', async () => {
    await run();
    const update = db.updateAgentConversation.mock.calls[0][1] as unknown as { messages: Array<Record<string, unknown>> };
    const assistant = update.messages[update.messages.length - 1];
    expect(assistant.steps).toEqual([
      expect.objectContaining({ id: 'e1', name: 'lookup', args: { q: 'x' }, output: { hit: 1 }, status: 'success' }),
    ]);
  });

  it('names the answer in the response by the id a client rates it with (the stored message\'s own)', async () => {
    const response = await run();
    const update = db.updateAgentConversation.mock.calls[0][1] as unknown as { messages: Array<{ role: string; id?: string; timestamp: Date }> };
    const index = update.messages.map((message) => message.role).lastIndexOf('assistant');
    const item = response.output.find((entry) => entry.type === 'message');
    expect(item?.id).toBe(messageIdOf(CONVERSATION_ID, index, update.messages[index]));
    expect(item?.id).toMatch(/^msg_[0-9a-f]{20}$/);
  });

  it('logs the turn: user message, running, tool use/result, answer, idle(end_turn), work_done', async () => {
    await run({ runId: 'run-9' });
    const events = loggedEvents();
    expect(events.map((e) => e.type)).toEqual([
      'user.message', 'session.status_running', 'agent.tool_use', 'agent.tool_result',
      'agent.message', 'session.status_idle', 'session.work_done',
    ]);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(events[0].data).toEqual({ content: 'look it up' });
    expect(events[2].data).toMatchObject({ toolCallId: 'tc1', name: 'lookup', args: { q: 'x' } });
    expect(events[3].data).toMatchObject({ toolCallId: 'tc1', name: 'lookup', ok: true, durationMs: 5 });
    expect(events[4].data).toMatchObject({ content: 'plain answer', messageIndex: 1 });
    expect(events[5].data).toEqual({ stopReason: 'end_turn' });
    expect(events.every((e) => e.runId === 'run-9')).toBe(true);

    const runtime = db.updateAgentConversationRuntime.mock.calls.map((c) => c[1]);
    // The turn names itself as the owner of the runtime fields, and writes its end only while it still is.
    expect(runtime[0]).toEqual({ runtimeStatus: 'running', runtimeTurnId: expect.any(String) });
    const owner = (runtime[0] as { runtimeTurnId: string }).runtimeTurnId;
    expect(db.updateAgentConversationRuntime.mock.calls.slice(1).map((c) => c[2])).toEqual([{ onlyIfTurn: owner }, { onlyIfTurn: owner }]);
    expect(Object.assign({}, ...runtime)).toMatchObject({ runtimeStatus: 'idle', stopReason: 'end_turn', lastEventSeq: 7 });
  });

  it('a run a limit stopped reports stopReason limit (the run still returns its partial answer)', async () => {
    hoisted.scripted = { content: 'partial', ctx: { __limitBreached: 'maxWallClockMs (1000ms) exceeded' } };
    await run();
    const idle = loggedEvents().find((e) => e.type === 'session.status_idle');
    expect(idle?.data).toMatchObject({ stopReason: 'limit', detail: 'maxWallClockMs (1000ms) exceeded' });
    expect(Object.assign({}, ...db.updateAgentConversationRuntime.mock.calls.map((c) => c[1]))).toMatchObject({ runtimeStatus: 'idle', stopReason: 'limit' });
  });

  it('streams text deltas live only: published, never persisted', async () => {
    const chunks: string[] = [];
    await run({ onTextChunk: (t: string) => chunks.push(t) });
    expect(chunks).toEqual(['par']);
    expect(loggedEvents().some((e) => e.type === 'agent.message.delta')).toBe(false);
  });

  it('a thrown turn is logged as session.error + idle(error) and still throws', async () => {
    hoisted.buildGatewayChatModel.mockRejectedValue(new Error('provider exploded'));
    await expect(run()).rejects.toThrow('provider exploded');
    const types = loggedEvents().map((e) => e.type);
    expect(types).toContain('session.error');
    expect(loggedEvents().find((e) => e.type === 'session.status_idle')?.data).toMatchObject({ stopReason: 'error' });
    expect(Object.assign({}, ...db.updateAgentConversationRuntime.mock.calls.map((c) => c[1]))).toMatchObject({ runtimeStatus: 'idle', stopReason: 'error' });
  });

  it('keeps the turn working when the event log cannot be written', async () => {
    db.appendAgentSessionEvents.mockRejectedValue(new Error('events table gone'));
    db.updateAgentConversationRuntime.mockRejectedValue(new Error('nope'));
    const response = await run();
    expect(response.status).toBe('completed');
  });
});
