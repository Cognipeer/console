/**
 * Structured output reaches the Agent Responses body.
 *
 * `executeAgentChatLocal` is the single execution chokepoint behind the sync
 * `/client/v1/agents/responses` path AND the background AgentRun worker. The
 * SDK reports `result.output` / `result.outputError`; this pins that they
 * are surfaced as `output_parsed` / `output_error` (the top-level `output`
 * stays the OpenAI-style item array) and that a plain-text agent's response
 * is byte-for-byte what it was before.
 *
 * SDK faked at the boundary (same pattern as agent-chat-cancellation-cell);
 * SYNC mock factories throughout, per this repo's vitest notes.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IAgent, IAgentConversation } from '@/lib/database';

const hoisted = vi.hoisted(() => ({
  runHook: vi.fn(),
  resolveGuardrail: vi.fn(),
  getModelByKey: vi.fn(),
  buildModelRuntime: vi.fn(),
  createdWithOutputSchema: [] as boolean[],
  scripted: { content: 'plain answer' } as { content: string; output?: unknown; outputError?: unknown },
}));

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));

vi.mock('@/lib/services/models/modelService', () => ({
  getModelByKey: hoisted.getModelByKey,
}));

vi.mock('@/lib/services/models/runtimeService', () => ({
  buildModelRuntime: hoisted.buildModelRuntime,
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

  const createSmartAgent = (opts: { outputSchema?: unknown }) => ({
    invoke: async (state: { messages: Array<{ role: string; content: unknown }> }) => {
      hoisted.createdWithOutputSchema.push(opts.outputSchema !== undefined);
      const answer = { role: 'assistant', content: hoisted.scripted.content };
      const messages = [...state.messages, answer];
      return {
        content: answer.content,
        ...(hoisted.scripted.output !== undefined ? { output: hoisted.scripted.output } : {}),
        ...(hoisted.scripted.outputError ? { outputError: hoisted.scripted.outputError } : {}),
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
    fromLangchainModel: (model: unknown) => model,
    createTool: (spec: unknown) => spec,
    customSink: (config: unknown) => config,
  };
});

import { getDatabase } from '@/lib/database';
import { createMockDb } from '../helpers/db.mock';
import { executeAgentChatLocal } from '@/lib/services/agents/agentService';

const TENANT_DB = 'tenant_acme';
const TENANT_ID = 'tenant-acme';
const PROJECT_ID = 'proj-1';
const AGENT_KEY = 'jira-analysis';
const CONVERSATION_ID = 'conv-1';

const STRUCTURED = {
  enabled: true,
  schema: {
    type: 'object',
    properties: { verdict: { type: 'string' }, confidence: { type: 'number' } },
    required: ['verdict', 'confidence'],
  },
};

function nativeAgent(structuredOutput?: unknown): IAgent {
  return {
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    key: AGENT_KEY,
    name: 'Jira Analysis',
    config: {
      modelKey: 'gpt-4o',
      systemPrompt: 'Analyse the issue.',
      ...(structuredOutput ? { structuredOutput } : {}),
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
  hoisted.createdWithOutputSchema.length = 0;
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
  hoisted.buildModelRuntime.mockResolvedValue({ runtime: { createChatModel: () => ({}) } });
});

function run() {
  return executeAgentChatLocal({
    tenantDbName: TENANT_DB,
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    agentKey: AGENT_KEY,
    conversationId: CONVERSATION_ID,
    userMessage: 'analyse DIAG-1',
    userId: 'user-1',
  });
}

function persistedAssistantTurn() {
  const update = db.updateAgentConversation.mock.calls[0][1] as unknown as { messages: Array<Record<string, unknown>> };
  return update.messages[update.messages.length - 1];
}

describe('structured output on the Agent Responses body', () => {
  it('success: exposes the validated object as output_parsed and keeps the text + item array', async () => {
    db.findAgentByKey.mockResolvedValue(nativeAgent(STRUCTURED));
    hoisted.scripted = { content: '{"verdict":"bug","confidence":0.9}', output: { verdict: 'bug', confidence: 0.9 } };

    const response = await run();

    expect(hoisted.createdWithOutputSchema).toEqual([true]);
    expect(response.output_parsed).toEqual({ verdict: 'bug', confidence: 0.9 });
    expect(response.output_error).toBeUndefined();
    // Backward compatible: `output` is still the OpenAI item array with the text.
    expect(Array.isArray(response.output)).toBe(true);
    expect(response.output[response.output.length - 1]).toMatchObject({
      type: 'message',
      content: [{ type: 'output_text', text: '{"verdict":"bug","confidence":0.9}' }],
    });
    expect(response.status).toBe('completed');
  });

  it('validation failure: exposes output_error (a string) and no output_parsed', async () => {
    db.findAgentByKey.mockResolvedValue(nativeAgent(STRUCTURED));
    hoisted.scripted = {
      content: 'not json at all',
      outputError: { type: 'parse_error', message: 'Response is not valid JSON', rawContent: 'not json at all' },
    };

    const response = await run();

    expect(response).not.toHaveProperty('output_parsed');
    expect(response.output_error).toBe('Response is not valid JSON');
    // The text answer is still returned so the caller can inspect it.
    expect(response.output[response.output.length - 1]).toMatchObject({
      content: [{ type: 'output_text', text: 'not json at all' }],
    });
  });

  it('plain-text agent: the response carries neither field and is otherwise unchanged', async () => {
    db.findAgentByKey.mockResolvedValue(nativeAgent());

    const response = await run();

    expect(hoisted.createdWithOutputSchema).toEqual([false]);
    expect(response).not.toHaveProperty('output_parsed');
    expect(response).not.toHaveProperty('output_error');
    expect(response.output[response.output.length - 1]).toMatchObject({
      content: [{ type: 'output_text', text: 'plain answer' }],
    });
  });

  it('persists the parsed output / error on the stored assistant turn', async () => {
    db.findAgentByKey.mockResolvedValue(nativeAgent(STRUCTURED));
    hoisted.scripted = { content: '{"verdict":"bug","confidence":1}', output: { verdict: 'bug', confidence: 1 } };
    await run();
    expect(persistedAssistantTurn()).toMatchObject({ output: { verdict: 'bug', confidence: 1 } });
    expect(persistedAssistantTurn()).not.toHaveProperty('outputError');

    vi.clearAllMocks();
    db.findAgentConversationById.mockResolvedValue(conversation());
    hoisted.scripted = { content: 'nope', outputError: { type: 'validation_error', message: 'verdict is required' } };
    await run();
    expect(persistedAssistantTurn()).toMatchObject({ outputError: 'verdict is required' });
    expect(persistedAssistantTurn()).not.toHaveProperty('output');
  });
});
