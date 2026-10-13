/**
 * The reasoning precedence on the wire. A native agent model is built exactly
 * as a run builds it and the request body it sends is read back:
 *   agent pick > Model Hub default > API request > nothing sent.
 * Also: the title is forced to "none" above every rung, and a Dynamic LLM
 * carries the agent / request value to the model it routes to.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAiModelProviderContract } from '@/lib/providers/contracts/modelContracts';

const hoisted = vi.hoisted(() => ({
  getModelByKey: vi.fn(),
  safeFetch: vi.fn(),
  logModelUsage: vi.fn(),
  createDynamic: vi.fn(),
}));

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/services/models/modelService', () => ({ getModelByKey: hoisted.getModelByKey }));
vi.mock('@/lib/security/outboundFetch', () => ({ safeFetch: hoisted.safeFetch }));
vi.mock('@/lib/services/models/usageLogger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/models/usageLogger')>()),
  logModelUsage: hoisted.logModelUsage,
}));
vi.mock('@/lib/services/agents/dynamicChatModel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/agents/dynamicChatModel')>();
  return {
    ...actual,
    createDynamicChatModel: (deps: Parameters<typeof actual.createDynamicChatModel>[0]) => {
      hoisted.createDynamic(deps);
      return actual.createDynamicChatModel(deps);
    },
  };
});
vi.mock('@/lib/services/agents/agentSpendLimits', () => ({
  resolveAgentSpendScope: vi.fn().mockResolvedValue(undefined),
  assertAgentSpendAllowed: vi.fn().mockResolvedValue(undefined),
  agentSpendSettler: vi.fn().mockReturnValue(vi.fn()),
}));
vi.mock('@/lib/services/models/runtimeService', () => ({
  buildModelRuntime: async () => ({
    runtime: await (OpenAiModelProviderContract.createRuntime as (ctx: unknown) => unknown)({
      tenantId: 't', projectId: 'p', providerKey: 'prov', credentials: { apiKey: 'sk-live' }, settings: {}, metadata: {},
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    }),
    record: { key: 'prov', driver: 'openai' },
  }),
}));

import { buildAgentChatModel } from '@/lib/services/agents/agentService';
import { generateConversationTitle } from '@/lib/services/agents/conversationTitle';

const model = (modelId: string, settings: Record<string, unknown> = {}) => ({
  _id: modelId, tenantId: 't', projectId: 'p', name: modelId, key: modelId, providerKey: 'prov', providerDriver: 'openai',
  category: 'llm', modelId, settings, pricing: { inputTokenPer1M: 1, outputTokenPer1M: 2 },
});

const completion = () => new Response(JSON.stringify({
  id: 'c', object: 'chat.completion', created: 1, model: 'm',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
}), { status: 200, headers: { 'content-type': 'application/json' } });

const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body));

/** Builds the model the way a run does and returns the `reasoning_effort` that went out. */
async function sentEffort(input: { hub?: string; agent?: string; request?: string }) {
  hoisted.getModelByKey.mockImplementation(async (_db: string, key: string) => model(
    key, input.hub ? { reasoning: { effort: input.hub } } : {},
  ));
  const { chatModel } = await buildAgentChatModel(
    'tenant_x', 't', 'p', 'gpt-4o', {},
    input.agent ? { effort: input.agent as 'low' } : undefined,
    input.request ? { effort: input.request as 'low' } : undefined,
  );
  await chatModel.invoke([{ role: 'user', content: 'hi' }]);
  return bodyOf(hoisted.safeFetch.mock.calls.at(-1)!).reasoning_effort as string | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.logModelUsage.mockResolvedValue(undefined);
  hoisted.safeFetch.mockImplementation(async () => completion());
});

describe('reasoning_effort on the wire', () => {
  it.each([
    ['agent + Model Hub + request: the agent wins', { agent: 'low', hub: 'high', request: 'minimal' }, 'low'],
    ['Model Hub + request: Model Hub wins', { hub: 'high', request: 'minimal' }, 'high'],
    ['request only: the request is used', { request: 'minimal' }, 'minimal'],
    ['agent over request', { agent: 'medium', request: 'low' }, 'medium'],
    ['agent over Model Hub', { agent: 'low', hub: 'high' }, 'low'],
    ['Model Hub only', { hub: 'medium' }, 'medium'],
    ['nothing set: nothing is sent', {}, undefined],
  ] as const)('%s', async (_name, input, expected) => {
    expect(await sentEffort(input)).toBe(expected);
  });

  it('an agent "none" is sent (it is a value, not an absence)', async () => {
    expect(await sentEffort({ agent: 'none', hub: 'high' })).toBe('none');
  });
});

describe('title generation', () => {
  it('forces reasoning off above the agent pick, the Model Hub default and the request', async () => {
    hoisted.getModelByKey.mockImplementation(async (_db: string, key: string) => model(key, { reasoning: { effort: 'high' } }));
    await generateConversationTitle({
      tenantDbName: 'tenant_x', tenantId: 't', projectId: 'p', modelKey: 'gpt-4o', agentKey: 'a1',
      exchange: { user: 'plan my trip', assistant: 'sure' },
    });
    expect(bodyOf(hoisted.safeFetch.mock.calls[0]).reasoning_effort).toBe('none');
  });
});

describe('Dynamic LLM', () => {
  const dynamic = (key: string) => ({
    ...model(key, { dynamic: { strategy: 'rule-based', defaultModelKey: 'small', rules: [] } }),
    providerKey: 'dynamic', providerDriver: 'dynamic',
  });

  it('has no reasoning config of its own but carries the agent pick through (else the request value)', async () => {
    hoisted.getModelByKey.mockImplementation(async (_db: string, key: string) => dynamic(key));
    hoisted.createDynamic.mockClear();
    await buildAgentChatModel('tenant_x', 't', 'p', 'router', {}, { effort: 'low' }, { effort: 'high' });
    expect(hoisted.createDynamic.mock.calls[0][0]).toMatchObject({ modelKey: 'router', reasoning: { effort: 'low' } });

    hoisted.createDynamic.mockClear();
    await buildAgentChatModel('tenant_x', 't', 'p', 'router', {}, undefined, { effort: 'high' });
    expect(hoisted.createDynamic.mock.calls[0][0]).toMatchObject({ reasoning: { effort: 'high' } });

    hoisted.createDynamic.mockClear();
    await buildAgentChatModel('tenant_x', 't', 'p', 'router', {});
    expect(hoisted.createDynamic.mock.calls[0][0]).not.toHaveProperty('reasoning');
  });
});
