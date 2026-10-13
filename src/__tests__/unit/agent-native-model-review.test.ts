/**
 * Review fixes on the agent model path (an agent calls the gateway core in process):
 *  - a title only asks for reasoning where the model takes it (a chat model answers 400 to
 *    `reasoning_effort`, and the failure used to cost the agent its generated titles);
 *  - `unsupportedParams: ['reasoning']` keeps the agent's pick off the wire too;
 *  - Model Hub "Return reasoning to callers" off hides the thinking text from agent outputs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAiModelProviderContract } from '@/lib/providers/contracts/modelContracts';
import { stubUpstream, type Upstream } from '../helpers/nativeGateway';

const hoisted = vi.hoisted(() => ({
  getModelByKey: vi.fn(),
  logModelUsage: vi.fn(),
}));

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/services/models/modelService', () => ({ getModelByKey: hoisted.getModelByKey }));
vi.mock('@/lib/services/models/usageLogger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/models/usageLogger')>()),
  logModelUsage: hoisted.logModelUsage,
}));
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
import { titleReasoningForModel } from '@/lib/services/agents/agentReasoning';

const model = (modelId: string, extra: Record<string, unknown> = {}) => ({
  _id: modelId, tenantId: 't', projectId: 'p', name: modelId, key: modelId, providerKey: 'prov', providerDriver: 'openai',
  category: 'llm', modelId, settings: {}, pricing: { inputTokenPer1M: 1, outputTokenPer1M: 2 }, ...extra,
});

const completion = (message: Record<string, unknown>) => new Response(JSON.stringify({
  id: 'c', object: 'chat.completion', created: 1, model: 'm',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Trip planning help', ...message }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
}), { status: 200, headers: { 'content-type': 'application/json' } });

const sse = (deltas: Array<Record<string, unknown>>) => new Response(
  [...deltas.map((delta) => `data: ${JSON.stringify({ id: 's', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`), 'data: [DONE]\n\n'].join(''),
  { status: 200, headers: { 'content-type': 'text/event-stream' } },
);

let upstream: Upstream;
const serve = (respond: () => Response) => { upstream = stubUpstream(respond); };

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.logModelUsage.mockResolvedValue(undefined);
  serve(() => completion({}));
});
afterEach(() => vi.unstubAllGlobals());

describe('a title asks for reasoning only where the model takes it', () => {
  const input = { tenantDbName: 'tenant_x', tenantId: 't', projectId: 'p', modelKey: 'gpt-4o', agentKey: 'a1', exchange: { user: 'plan my trip', assistant: 'sure, where to?' } };
  const titleBody = async (modelId: string, extra: Record<string, unknown> = {}) => {
    upstream.calls.length = 0;
    hoisted.getModelByKey.mockImplementation(async (_db: string, key: string) => model(key, extra));
    expect(await generateConversationTitle({ ...input, modelKey: modelId })).toBe('Trip planning help');
    return upstream.calls[0].body;
  };

  it('a chat model gets no reasoning_effort at all', async () => {
    expect(await titleBody('gpt-4o')).not.toHaveProperty('reasoning_effort');
    expect(await titleBody('gpt-4.1-mini')).not.toHaveProperty('reasoning_effort');
  });

  it('a reasoning model gets the lowest effort its family accepts', async () => {
    expect((await titleBody('gpt-5.2')).reasoning_effort).toBe('none');
    expect((await titleBody('gpt-5-mini')).reasoning_effort).toBe('minimal');
    expect((await titleBody('o3')).reasoning_effort).toBe('low');
  });

  it('a model the operator gave a reasoning default is turned down, an unconfigured custom id is left alone', async () => {
    expect((await titleBody('my-reasoner', { settings: { reasoning: { effort: 'high' } } })).reasoning_effort).toBe('none');
    expect(await titleBody('my-reasoner')).not.toHaveProperty('reasoning_effort');
  });

  it('is decided per model, never for a Dynamic LLM', () => {
    expect(titleReasoningForModel({ modelId: 'gpt-5.2', providerDriver: 'openai' }, { dynamic: true })).toBeUndefined();
    expect(titleReasoningForModel({ modelId: 'claude-sonnet-4-5', providerDriver: 'anthropic' })).toBeUndefined();
    expect(titleReasoningForModel({ modelId: 'claude-sonnet-4-5', providerDriver: 'anthropic', settings: { reasoning: { effort: 'high' } } })).toEqual({ effort: 'none' });
    expect(titleReasoningForModel({ modelId: 'gpt-5-chat-latest', providerDriver: 'openai' })).toBeUndefined();
  });
});

describe('unsupportedParams on the agent path', () => {
  it.each(['reasoning', 'reasoning_effort'])('listing "%s" keeps the agent pick off the wire', async (name) => {
    hoisted.getModelByKey.mockImplementation(async (_db: string, key: string) => model(key, { settings: { unsupportedParams: [name] } }));
    const { chatModel } = await buildAgentChatModel('tenant_x', 't', 'p', 'gpt-4o', {}, { effort: 'low' }, { effort: 'high' });
    await chatModel.invoke([{ role: 'user', content: 'hi' }]);
    expect(upstream.calls[0].body).not.toHaveProperty('reasoning_effort');
  });

  it('without it the pick is sent', async () => {
    hoisted.getModelByKey.mockImplementation(async (_db: string, key: string) => model(key));
    const { chatModel } = await buildAgentChatModel('tenant_x', 't', 'p', 'gpt-4o', {}, { effort: 'low' });
    await chatModel.invoke([{ role: 'user', content: 'hi' }]);
    expect(upstream.calls[0].body.reasoning_effort).toBe('low');
  });
});

describe('Model Hub "Return reasoning to callers" on the agent path', () => {
  const thinking = { reasoning_content: 'let me think' };
  const build = async (settings: Record<string, unknown>) => {
    hoisted.getModelByKey.mockImplementation(async (_db: string, key: string) => model(key, { settings }));
    return (await buildAgentChatModel('tenant_x', 't', 'p', 'gpt-4o')).chatModel;
  };
  const collect = async (chatModel: { stream?: (m: unknown) => AsyncIterable<unknown> }) => {
    const out: unknown[] = [];
    for await (const chunk of chatModel.stream!([{ role: 'user', content: 'hi' }])) out.push(chunk);
    return out;
  };

  it('on (default): the message carries the thinking text', async () => {
    serve(() => completion(thinking));
    const reply = await (await build({})).invoke([{ role: 'user', content: 'hi' }]);
    expect((reply as { reasoning?: { summary?: string } }).reasoning?.summary).toBe('let me think');
  });

  it('off: invoke() returns no thinking text, but the tokens are still on the message', async () => {
    serve(() => completion(thinking));
    const reply = await (await build({ returnReasoning: false })).invoke([{ role: 'user', content: 'hi' }]) as Record<string, unknown>;
    expect(reply.reasoning).toBeUndefined();
    expect(reply.content).toBe('Trip planning help');
    expect(reply.usage).toMatchObject({ prompt_tokens: 20, completion_tokens: 4 });
  });

  it('off: a stream carries no reasoning part and the assembled message no summary; on: both are there', async () => {
    const frames = () => sse([{ role: 'assistant', reasoning_content: 'let me ' }, { reasoning_content: 'think' }, { content: 'Hi' }]);
    serve(() => frames());
    const hidden = await collect(await build({ returnReasoning: false }) as never);
    expect(hidden.some((c) => (c as { type?: string })?.type === 'reasoning')).toBe(false);
    expect(JSON.stringify(hidden)).not.toContain('think');
    expect(hidden.some((c) => (c as { content?: string })?.content === 'Hi')).toBe(true);

    serve(() => frames());
    const shown = await collect(await build({}) as never);
    expect(shown.some((c) => (c as { type?: string })?.type === 'reasoning')).toBe(true);
    expect((shown.at(-1) as { reasoning?: { summary?: string } }).reasoning?.summary).toBe('let me think');
  });

  it('survives tools being bound afterwards', async () => {
    serve(() => completion(thinking));
    const chatModel = await build({ returnReasoning: false }) as { bindTools: (t: unknown[]) => { invoke: (m: unknown) => Promise<Record<string, unknown>> } };
    const reply = await chatModel.bindTools([]).invoke([{ role: 'user', content: 'hi' }]);
    expect(reply.reasoning).toBeUndefined();
  });
});
