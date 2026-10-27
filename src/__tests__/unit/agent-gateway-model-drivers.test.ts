/**
 * An agent's model is a call into the gateway core (gatewayChatModel.ts). Every
 * driver is exercised through the real provider contract, the real gateway core
 * and the real agent-sdk with a scripted `fetch`: what is asserted is the wire
 * request an agent turn sends (model id, tools, token-limit field, extra fields,
 * credentials) and what the turn parses back (text, tool calls, usage, reasoning,
 * streaming).
 */
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AnthropicModelProviderContract,
  AzureModelProviderContract,
  BedrockModelProviderContract,
  OpenAiCompatibleModelProviderContract,
  OpenAiModelProviderContract,
  TogetherModelProviderContract,
  VertexModelProviderContract,
} from '@/lib/providers/contracts/modelContracts';

const hoisted = vi.hoisted(() => ({
  providers: {} as Record<string, { driver: string; credentials: Record<string, unknown>; settings: Record<string, unknown> }>,
  model: null as unknown,
}));

vi.mock('@/lib/core/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/core/config')>();
  return {
    ...actual,
    getConfig: () => {
      const config = actual.getConfig();
      return { ...config, gateway: { ...config.gateway, retryEnabled: true, retryMaxAttempts: 3, retryInitialDelayMs: 1, circuitBreakerEnabled: false } };
    },
  };
});
vi.mock('@/lib/services/models/modelService', () => ({ getModelByKey: async () => hoisted.model }));
vi.mock('@/lib/services/models/usageLogger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/models/usageLogger')>()),
  logModelUsage: vi.fn().mockResolvedValue(undefined),
}));

const CONTRACTS = {
  openai: OpenAiModelProviderContract,
  'openai-compatible': OpenAiCompatibleModelProviderContract,
  together: TogetherModelProviderContract,
  anthropic: AnthropicModelProviderContract,
  bedrock: BedrockModelProviderContract,
  vertex: VertexModelProviderContract,
  azure: AzureModelProviderContract,
} as const;

// The runtime is the REAL contract runtime built from the provider "record"
// below: credentials and endpoints reach the native provider the way they do in
// production, from inside the contract's closure.
vi.mock('@/lib/services/models/runtimeService', () => ({
  buildModelRuntime: async (_db: string, _tenant: string, providerKey: string) => {
    const record = hoisted.providers[providerKey];
    if (!record) throw new Error(`no provider ${providerKey}`);
    const contract = CONTRACTS[record.driver as keyof typeof CONTRACTS];
    const runtime = await (contract.createRuntime as (ctx: unknown) => unknown)({
      tenantId: 't', projectId: 'p', providerKey,
      credentials: record.credentials, settings: record.settings, metadata: {},
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    });
    return { runtime, record: { key: providerKey, driver: record.driver } };
  },
}));

import { buildGatewayChatModel, normalizeNativeReasoning, type GatewayChatModelInput } from '@/lib/services/agents/gatewayChatModel';

/* ── helpers ─────────────────────────────────────────────────────────────── */

interface Call { url: string; headers: Record<string, string>; body: Record<string, any>; raw: string }

function headersOf(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, name) => { out[name.toLowerCase()] = value; });
  return out;
}

function recorder(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fakeFetch = (async (input: unknown, init?: RequestInit) => {
    const raw = typeof init?.body === 'string' ? init.body : '';
    let body: Record<string, any> = {};
    try { body = raw && raw.trim().startsWith('{') ? JSON.parse(raw) : {}; } catch { /* form body */ }
    const call = { url: String(input), headers: headersOf(init), body, raw };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;
  return { calls, fetch: fakeFetch };
}

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
const sse = (events: unknown[]) => new Response(
  `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')}data: [DONE]\n\n`,
  { status: 200, headers: { 'content-type': 'text/event-stream' } },
);

function modelRecord(over: Record<string, unknown> = {}) {
  return {
    _id: 'm1', tenantId: 't', projectId: 'p', name: 'm', key: 'm', providerKey: 'prov', providerDriver: 'openai',
    category: 'llm' as const, modelId: 'gpt-4o', settings: {}, pricing: {}, ...over,
  };
}

function useProvider(driver: string, credentials: Record<string, unknown>, settings: Record<string, unknown> = {}) {
  hoisted.providers.prov = { driver, credentials, settings };
}

async function build(over: Record<string, unknown>, extra: Partial<Pick<GatewayChatModelInput, 'overrides' | 'reasoning' | 'requestReasoning'>> & { fetch: typeof fetch }) {
  const { fetch: scripted, ...rest } = extra;
  vi.stubGlobal('fetch', scripted);
  const model = modelRecord({ providerDriver: hoisted.providers.prov.driver, ...over });
  hoisted.model = model;
  return buildGatewayChatModel({ tenantDbName: 'tenant_x', tenantId: 't', projectId: 'p', model: model as never, ...rest });
}

async function lookupTool() {
  const { createTool } = await import('@cognipeer/agent-sdk');
  const { z } = await import('zod');
  return createTool({ name: 'lookup', description: 'Find a thing', schema: z.object({ q: z.string() }), func: async () => 'ok' });
}

const USER = [{ role: 'user', content: 'hi' }];

const chatCompletion = (message: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id: 'chatcmpl-1', object: 'chat.completion', created: 1, model: 'gpt-4o',
  choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: 'stop' }],
  ...extra,
});

beforeEach(() => { hoisted.providers = {}; });
afterEach(() => vi.unstubAllGlobals());

/* ── OpenAI ──────────────────────────────────────────────────────────────── */

describe('openai', () => {
  beforeEach(() => useProvider('openai', { apiKey: 'sk-live' }, { organization: 'org-1' }));

  it('sends the model record on the wire and parses text, tool calls, usage and reasoning', async () => {
    const { calls, fetch } = recorder(() => json(chatCompletion(
      {
        content: 'Hello',
        reasoning_content: 'because',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }],
      },
      { usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140, prompt_tokens_details: { cached_tokens: 60 }, completion_tokens_details: { reasoning_tokens: 12 } } },
    )));
    const model = await build(
      { settings: { temperature: 0.4, topP: 0.9, maxTokens: 256, presencePenalty: 0.2, requestDefaults: { seed: 7 } } },
      { fetch },
    );
    const reply = await model.bindTools!([await lookupTool()]).invoke(USER);

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(call.headers.authorization).toBe('Bearer sk-live');
    expect(call.headers['openai-organization']).toBe('org-1');
    expect(call.body).toMatchObject({
      model: 'gpt-4o', temperature: 0.4, top_p: 0.9, max_tokens: 256, presence_penalty: 0.2, seed: 7,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'lookup', description: 'Find a thing' } }],
    });
    expect(call.body.max_completion_tokens).toBeUndefined();

    expect(reply.content).toBe('Hello');
    expect(reply.tool_calls).toEqual([{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }]);
    expect(reply.usage).toMatchObject({
      prompt_tokens: 100, completion_tokens: 40, total_tokens: 140,
      prompt_tokens_details: { cached_tokens: 60 }, completion_tokens_details: { reasoning_tokens: 12 },
    });
    expect(reply.reasoning).toMatchObject({ summary: 'because' });
    expect(reply.response_metadata).toMatchObject({ finish_reason: 'stop' });
  });

  it('per-call agent settings override the record (temperature, top_p, max_tokens)', async () => {
    const { calls, fetch } = recorder(() => json(chatCompletion({ content: 'ok' })));
    const model = await build({ settings: { temperature: 0.4 } }, { fetch, overrides: { temperature: 0.9, top_p: 0.5, max_tokens: 33 } });
    await model.invoke(USER);
    expect(calls[0].body).toMatchObject({ temperature: 0.9, top_p: 0.5, max_tokens: 33 });
  });

  it('GPT-5 family: max_completion_tokens, no sampling parameters', async () => {
    const { calls, fetch } = recorder(() => json(chatCompletion({ content: 'ok' })));
    const model = await build({ modelId: 'gpt-5.2', settings: { temperature: 0.4, topP: 0.9, maxTokens: 500 } }, { fetch });
    await model.invoke(USER);
    expect(calls[0].body.max_completion_tokens).toBe(500);
    expect(calls[0].body.max_tokens).toBeUndefined();
    expect(calls[0].body.temperature).toBeUndefined();
    expect(calls[0].body.top_p).toBeUndefined();
  });

  it('GPT-5 + function tools: reasoning_effort is forced to "none" on Chat Completions; without tools the asked effort stays', async () => {
    const { calls, fetch } = recorder(() => json(chatCompletion({ content: 'ok' })));
    const model = await build({ modelId: 'gpt-5.2' }, { fetch, reasoning: { effort: 'high' } });

    await model.invoke(USER);
    expect(calls[0].url).toBe('https://api.openai.com/v1/chat/completions');
    expect(calls[0].body.reasoning_effort).toBe('high');

    await model.bindTools!([await lookupTool()]).invoke(USER);
    expect(calls[1].url).toBe('https://api.openai.com/v1/chat/completions');
    expect(calls[1].body.reasoning_effort).toBe('none');
  });

  it('an SDK-level reasoning request (agent runtime config) is sent as reasoning_effort, never routed to /responses', async () => {
    const { calls, fetch } = recorder(() => json(chatCompletion({ content: 'ok' })));
    const model = await build({ modelId: 'o4-mini' }, { fetch });
    await model.invoke(USER, { reasoning: { effort: 'low' } } as never);
    expect(calls[0].url).toBe('https://api.openai.com/v1/chat/completions');
    expect(calls[0].body.reasoning_effort).toBe('low');
    expect(calls[0].body.reasoning).toBeUndefined();
  });

  it('settings.unsupportedParams strips a parameter; declaring max_tokens unsupported renames the budget', async () => {
    const { calls, fetch } = recorder(() => json(chatCompletion({ content: 'ok' })));
    const model = await build(
      { modelId: 'vanity-model', settings: { temperature: 0.5, presencePenalty: 0.3, maxTokens: 64, unsupportedParams: ['presence_penalty', 'max_tokens'] } },
      { fetch },
    );
    await model.invoke(USER);
    expect(calls[0].body.presence_penalty).toBeUndefined();
    expect(calls[0].body.max_tokens).toBeUndefined();
    expect(calls[0].body.max_completion_tokens).toBe(64);
    expect(calls[0].body.temperature).toBe(0.5);
  });

  it('streams text and reasoning deltas, then one assembled message with tool calls and usage', async () => {
    const { calls, fetch } = recorder(() => sse([
      { id: 's1', model: 'gpt-4o', choices: [{ index: 0, delta: { reasoning_content: 'think ' } }] },
      { id: 's1', model: 'gpt-4o', choices: [{ index: 0, delta: { content: 'Hel' } }] },
      { id: 's1', model: 'gpt-4o', choices: [{ index: 0, delta: { content: 'lo' } }] },
      { id: 's1', model: 'gpt-4o', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"q":' } }] } }] },
      { id: 's1', model: 'gpt-4o', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] } }] },
      { id: 's1', model: 'gpt-4o', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      { id: 's1', model: 'gpt-4o', choices: [], usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 } },
    ]));
    const model = await build({}, { fetch });
    const parts: any[] = [];
    for await (const part of model.bindTools!([await lookupTool()]).stream!(USER)) parts.push(part);

    expect(calls[0].body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(parts.filter((p) => typeof p === 'string').join('')).toBe('Hello');
    expect(parts.filter((p) => p?.type === 'reasoning').map((p) => p.reasoning_content).join('')).toBe('think ');
    const final = parts[parts.length - 1];
    expect(final).toMatchObject({
      role: 'assistant', content: 'Hello',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }],
      usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
      reasoning: { summary: 'think ' },
      response_metadata: { finish_reason: 'tool_calls', model_name: 'gpt-4o' },
    });
  });

  it('disableStreamingWithTools: a streamed, tool-carrying turn is ONE non-streaming request (the gateway decides, per request)', async () => {
    const { calls, fetch } = recorder(() => json(chatCompletion({ content: 'whole answer' })));
    const model = await build({ settings: { disableStreamingWithTools: true } }, { fetch });
    const parts: any[] = [];
    for await (const part of model.bindTools!([await lookupTool()]).stream!(USER)) parts.push(part);
    expect(calls).toHaveLength(1);
    expect(calls[0].body.stream).toBeFalsy();
    expect(parts.at(-1)).toMatchObject({ role: 'assistant', content: 'whole answer' });
    // Without tools the same model streams.
    const plain = recorder(() => sse([{ id: 's', object: 'chat.completion.chunk', model: 'gpt-4o', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }] }]));
    const streaming = await build({ settings: { disableStreamingWithTools: true } }, { fetch: plain.fetch });
    for await (const part of streaming.stream!(USER)) void part;
    expect(plain.calls[0].body.stream).toBe(true);
  });

  it('a provider error carries its status', async () => {
    const { fetch } = recorder(() => new Response('{"error":{"message":"bad key"}}', { status: 401 }));
    const model = await build({}, { fetch });
    await expect(model.invoke(USER)).rejects.toMatchObject({ statusCode: 401 });
  });
});

/* ── Azure ───────────────────────────────────────────────────────────────── */

describe('azure', () => {
  beforeEach(() => useProvider('azure', { apiKey: 'az-key' }, { instanceName: 'res', deploymentName: 'fallback-dep', apiVersion: '2024-10-21' }));

  it('addresses the DEPLOYMENT (the model id) with api-key auth and the per-model api-version', async () => {
    const { calls, fetch } = recorder(() => json(chatCompletion({ content: 'ok' })));
    const model = await build({ providerDriver: 'azure', modelId: 'prod-chat-deployment', settings: { maxTokens: 90, azureApiVersion: '2025-04-01-preview' } }, { fetch });
    await model.invoke(USER);
    expect(calls[0].url).toBe('https://res.openai.azure.com/openai/deployments/prod-chat-deployment/chat/completions?api-version=2025-04-01-preview');
    expect(calls[0].headers['api-key']).toBe('az-key');
    expect(calls[0].body.model).toBeUndefined();
    expect(calls[0].body.max_tokens).toBe(90);
  });

  it('a reasoning deployment sends max_completion_tokens and keeps Chat Completions when reasoning is asked for', async () => {
    const { calls, fetch } = recorder(() => json(chatCompletion({ content: 'ok' })));
    const model = await build({ modelId: 'gpt-5', settings: { maxTokens: 90 } }, { fetch, reasoning: { effort: 'medium' } });
    await model.invoke(USER);
    expect(calls[0].url).toContain('/openai/deployments/gpt-5/chat/completions');
    expect(calls[0].body.max_completion_tokens).toBe(90);
    expect(calls[0].body.reasoning_effort).toBe('medium');
  });

  it('retries a 429 (Azure now retries on the SDK side)', async () => {
    let n = 0;
    const { calls, fetch } = recorder(() => (n++ === 0 ? new Response('slow down', { status: 429, headers: { 'retry-after': '0' } }) : json(chatCompletion({ content: 'ok' }))));
    const model = await build({ modelId: 'dep' }, { fetch });
    expect((await model.invoke(USER)).content).toBe('ok');
    expect(calls).toHaveLength(2);
  });
});

/* ── OpenAI-compatible / Together ───────────────────────────────────────── */

describe('openai-compatible', () => {
  beforeEach(() => useProvider('openai-compatible', { apiKey: 'k' }, { baseUrl: 'https://llm.internal.example/v1', organization: 'team-9' }));

  it('talks to the configured base URL; extraBody reaches the upstream verbatim', async () => {
    const { calls, fetch } = recorder(() => json(chatCompletion({ content: 'ok' })));
    const model = await build({ providerDriver: 'openai-compatible', modelId: 'qwen3-32b', settings: { requestDefaults: { chat_template_kwargs: { enable_thinking: false }, top_k: 20 } } }, { fetch });
    await model.invoke(USER);
    expect(calls[0].url).toBe('https://llm.internal.example/v1/chat/completions');
    expect(calls[0].headers.authorization).toBe('Bearer k');
    expect(calls[0].headers['openai-organization']).toBe('team-9');
    expect(calls[0].body).toMatchObject({ model: 'qwen3-32b', chat_template_kwargs: { enable_thinking: false }, top_k: 20 });
  });

  it('a reasoning block leaked into a non-streamed answer is moved to the reasoning', async () => {
    const { fetch } = recorder(() => json(chatCompletion({ content: '<reasoning>The user wants a greeting</reasoning>Hey there' })));
    const model = await build({ providerDriver: 'openai-compatible', modelId: 'gpt-oss-120b' }, { fetch });
    const reply = await model.invoke(USER);
    expect(reply.content).toBe('Hey there');
    expect(reply.reasoning).toMatchObject({ summary: 'The user wants a greeting' });
  });

  it('a reasoning block leaked into a STREAMED answer is cut out of the deltas and the final message', async () => {
    const delta = (content: string) => ({ id: 's', model: 'gpt-oss-120b', choices: [{ index: 0, delta: { content } }] });
    const { fetch } = recorder(() => sse([delta('<reasoning>The user wants'), delta(' a greeting</reasoning>'), delta('Hey there')]));
    const model = await build({ providerDriver: 'openai-compatible', modelId: 'gpt-oss-120b' }, { fetch });
    const parts: any[] = [];
    for await (const part of model.stream!(USER)) parts.push(part);
    expect(parts.filter((p) => typeof p === 'string').join('')).toBe('Hey there');
    expect(parts.filter((p) => p?.type === 'reasoning').map((p) => p.reasoning_content).join('')).toBe('The user wants a greeting');
    expect(parts[parts.length - 1]).toMatchObject({ role: 'assistant', content: 'Hey there', reasoning: { summary: 'The user wants a greeting' } });
  });

  it('never routes to the Responses API', async () => {
    const { calls, fetch } = recorder(() => json(chatCompletion({ content: 'ok' })));
    const model = await build({ providerDriver: 'openai-compatible', modelId: 'o3-mini' }, { fetch, reasoning: { effort: 'high' } });
    await model.invoke(USER);
    expect(calls[0].url).toBe('https://llm.internal.example/v1/chat/completions');
  });
});

describe('together', () => {
  it('uses the Together endpoint through the OpenAI-compatible provider', async () => {
    useProvider('together', { apiKey: 'tg' });
    const { calls, fetch } = recorder(() => json(chatCompletion({ content: 'ok' })));
    const model = await build({ providerDriver: 'together', modelId: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' }, { fetch });
    await model.invoke(USER);
    expect(calls[0].url).toBe('https://api.together.xyz/v1/chat/completions');
    expect(calls[0].headers.authorization).toBe('Bearer tg');
    expect(calls[0].body.model).toBe('meta-llama/Llama-3.3-70B-Instruct-Turbo');
  });
});

/* ── Anthropic ───────────────────────────────────────────────────────────── */

describe('anthropic', () => {
  beforeEach(() => useProvider('anthropic', { apiKey: 'sk-ant' }, {}));
  const messageResponse = (content: unknown[], usage: Record<string, unknown> = {}) => ({
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', stop_reason: 'end_turn', content,
    usage: { input_tokens: 10, output_tokens: 5, ...usage },
  });

  it('sends Messages-API wire: key header, a max_tokens floor, tools as input_schema', async () => {
    const { calls, fetch } = recorder(() => json(messageResponse(
      [{ type: 'text', text: 'Hi' }, { type: 'tool_use', id: 'tu1', name: 'lookup', input: { q: 'x' } }],
      { cache_read_input_tokens: 7 },
    )));
    const model = await build({ providerDriver: 'anthropic', modelId: 'claude-sonnet-4-5', settings: { temperature: 0.2 } }, { fetch });
    const reply = await model.bindTools!([await lookupTool()]).invoke([{ role: 'system', content: 'be brief' }, ...USER]);

    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0].headers['x-api-key']).toBe('sk-ant');
    expect(calls[0].headers['anthropic-version']).toBeTruthy();
    expect(calls[0].body).toMatchObject({
      model: 'claude-sonnet-4-5', max_tokens: 8192, temperature: 0.2, system: 'be brief',
      tools: [{ name: 'lookup', description: 'Find a thing', input_schema: { type: 'object' } }],
    });
    expect(reply.content).toBe('Hi');
    expect(reply.tool_calls).toMatchObject([{ id: 'tu1', function: { name: 'lookup', arguments: '{"q":"x"}' } }]);
    expect(reply.usage).toMatchObject({ completion_tokens: 5, prompt_tokens_details: { cached_tokens: 7 } });
  });

  it('hands the agent inclusive usage: cache read + write folded into the prompt, kept as subsets', async () => {
    const { fetch } = recorder(() => json(messageResponse(
      [{ type: 'text', text: 'Hi' }],
      { input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 500, cache_creation_input_tokens: 30 },
    )));
    const model = await build({ providerDriver: 'anthropic', modelId: 'claude-sonnet-4-5' }, { fetch });
    const reply = await model.invoke(USER);
    expect(reply.usage).toMatchObject({
      prompt_tokens: 550, completion_tokens: 5, total_tokens: 555,
      prompt_tokens_details: { cached_tokens: 500, cache_write_tokens: 30 },
    });
  });

  it('streamed: the final usage is inclusive too', async () => {
    const event = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    const body = [
      event('message_start', { message: { id: 'msg_1', model: 'claude-sonnet-4-5', usage: { input_tokens: 20, output_tokens: 1, cache_read_input_tokens: 500, cache_creation_input_tokens: 30 } } }),
      event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hi' } }),
      event('content_block_stop', { index: 0 }),
      event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }),
      event('message_stop', {}),
    ].join('');
    const { fetch } = recorder(() => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const model = await build({ providerDriver: 'anthropic', modelId: 'claude-sonnet-4-5' }, { fetch });
    const parts: any[] = [];
    for await (const part of model.stream!(USER)) parts.push(part);
    expect(parts[parts.length - 1]).toMatchObject({
      usage: {
        prompt_tokens: 550, completion_tokens: 5, total_tokens: 555,
        prompt_tokens_details: { cached_tokens: 500, cache_write_tokens: 30 },
      },
    });
  });

  it('a configured token limit wins over the floor; a custom base URL is honoured', async () => {
    useProvider('anthropic', { apiKey: 'sk-ant' }, { baseUrl: 'https://claude-proxy.example' });
    const { calls, fetch } = recorder(() => json(messageResponse([{ type: 'text', text: 'ok' }])));
    const model = await build({ providerDriver: 'anthropic', modelId: 'claude-sonnet-4-5', settings: { maxTokens: 321 } }, { fetch });
    await model.invoke(USER);
    expect(calls[0].url).toBe('https://claude-proxy.example/v1/messages');
    expect(calls[0].body.max_tokens).toBe(321);
  });

  it('reasoning effort becomes a thinking block: budget below max_tokens, sampling dropped', async () => {
    const { calls, fetch } = recorder(() => json(messageResponse([
      { type: 'thinking', thinking: 'hmm', signature: 'sig-1' },
      { type: 'text', text: 'done' },
    ])));
    const model = await build({ providerDriver: 'anthropic', modelId: 'claude-sonnet-4-5', settings: { temperature: 0.2, maxTokens: 2000 } }, { fetch, reasoning: { effort: 'medium' } });
    const reply = await model.invoke(USER);
    const { thinking, max_tokens } = calls[0].body;
    expect(thinking.type).toBe('enabled');
    expect(thinking.budget_tokens).toBeGreaterThanOrEqual(1024);
    expect(max_tokens).toBeGreaterThan(thinking.budget_tokens);
    expect(calls[0].body.temperature).toBeUndefined();
    expect(reply.reasoning).toMatchObject({ summary: 'hmm', blocks: [{ type: 'thinking', signature: 'sig-1' }] });
  });

  it('an explicit thinking block in the model\'s extra body wins', async () => {
    const { calls, fetch } = recorder(() => json(messageResponse([{ type: 'text', text: 'ok' }])));
    const model = await build(
      { providerDriver: 'anthropic', modelId: 'claude-sonnet-4-5', settings: { requestDefaults: { thinking: { type: 'enabled', budget_tokens: 2048 } } } },
      { fetch, reasoning: { effort: 'low' } },
    );
    await model.invoke(USER);
    expect(calls[0].body.thinking).toMatchObject({ type: 'enabled', budget_tokens: 2048 });
  });

  it('streams text and assembles the tool call', async () => {
    const event = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    const body = [
      event('message_start', { message: { id: 'msg_1', model: 'claude-sonnet-4-5', usage: { input_tokens: 11, output_tokens: 1 } } }),
      event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hel' } }),
      event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'lo' } }),
      event('content_block_stop', { index: 0 }),
      event('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'tu1', name: 'lookup', input: {} } }),
      event('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"q":"x"}' } }),
      event('content_block_stop', { index: 1 }),
      event('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } }),
      event('message_stop', {}),
    ].join('');
    const { calls, fetch } = recorder(() => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const model = await build({ providerDriver: 'anthropic', modelId: 'claude-sonnet-4-5' }, { fetch });
    const parts: any[] = [];
    for await (const part of model.bindTools!([await lookupTool()]).stream!(USER)) parts.push(part);
    expect(calls[0].body.stream).toBe(true);
    expect(parts.filter((p) => typeof p === 'string').join('')).toBe('Hello');
    expect(parts[parts.length - 1]).toMatchObject({
      role: 'assistant', content: 'Hello',
      tool_calls: [{ id: 'tu1', function: { name: 'lookup', arguments: '{"q":"x"}' } }],
      usage: { prompt_tokens: 11, completion_tokens: 8 },
    });
  });
});

/* ── Bedrock ─────────────────────────────────────────────────────────────── */

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** One AWS event-stream frame (prelude + headers + payload, both CRCs). */
function eventFrame(eventType: string, payload: unknown): Uint8Array {
  const enc = new TextEncoder();
  const header = (name: string, value: string) => {
    const n = enc.encode(name);
    const v = enc.encode(value);
    const out = new Uint8Array(1 + n.length + 1 + 2 + v.length);
    out[0] = n.length;
    out.set(n, 1);
    out[1 + n.length] = 7;
    new DataView(out.buffer).setUint16(2 + n.length, v.length);
    out.set(v, 4 + n.length);
    return out;
  };
  const headers = [header(':message-type', 'event'), header(':event-type', eventType), header(':content-type', 'application/json')];
  const headersLen = headers.reduce((sum, h) => sum + h.length, 0);
  const body = enc.encode(JSON.stringify(payload));
  const total = 12 + headersLen + body.length + 4;
  const frame = new Uint8Array(total);
  const view = new DataView(frame.buffer);
  view.setUint32(0, total);
  view.setUint32(4, headersLen);
  view.setUint32(8, crc32(frame.subarray(0, 8)));
  let offset = 12;
  for (const h of headers) { frame.set(h, offset); offset += h.length; }
  frame.set(body, offset);
  view.setUint32(total - 4, crc32(frame.subarray(0, total - 4)));
  return frame;
}

describe('bedrock', () => {
  beforeEach(() => useProvider('bedrock', { accessKeyId: 'AKIA1', secretAccessKey: 'secret', sessionToken: 'tok' }, { region: 'eu-central-1' }));

  it('Converse: signed request to the regional endpoint; inferenceConfig, tools, additionalModelRequestFields', async () => {
    const { calls, fetch } = recorder(() => json({
      output: { message: { role: 'assistant', content: [{ text: 'Hi' }, { toolUse: { toolUseId: 'tu1', name: 'lookup', input: { q: 'x' } } }] } },
      stopReason: 'tool_use',
      usage: { inputTokens: 20, outputTokens: 6, totalTokens: 26, cacheReadInputTokens: 4 },
    }));
    const model = await build(
      { providerDriver: 'bedrock', modelId: 'eu.anthropic.claude-sonnet-4-5-v1:0', settings: { temperature: 0.1, topP: 0.8, maxTokens: 700, requestDefaults: { top_k: 40 } } },
      { fetch },
    );
    const reply = await model.bindTools!([await lookupTool()]).invoke(USER);

    expect(calls[0].url).toBe('https://bedrock-runtime.eu-central-1.amazonaws.com/model/eu.anthropic.claude-sonnet-4-5-v1%3A0/converse');
    expect(calls[0].headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIA1\//);
    expect(calls[0].headers['x-amz-security-token']).toBe('tok');
    expect(calls[0].body).toMatchObject({
      inferenceConfig: { maxTokens: 700, temperature: 0.1, topP: 0.8 },
      additionalModelRequestFields: { top_k: 40 },
      toolConfig: { tools: [{ toolSpec: { name: 'lookup' } }] },
    });
    expect(reply.content).toBe('Hi');
    expect(reply.tool_calls).toMatchObject([{ id: 'tu1', function: { name: 'lookup', arguments: '{"q":"x"}' } }]);
    // Bedrock's input excludes the cache read: the agent gets the prompt whole (20 + 4), the read stays a subset.
    expect(reply.usage).toMatchObject({ prompt_tokens: 24, completion_tokens: 6, total_tokens: 30, prompt_tokens_details: { cached_tokens: 4 } });
  });

  it('hands the agent inclusive usage: cache read + write folded into the prompt, kept as subsets', async () => {
    const { fetch } = recorder(() => json({
      output: { message: { role: 'assistant', content: [{ text: 'Hi' }] } },
      stopReason: 'end_turn',
      usage: { inputTokens: 20, outputTokens: 6, totalTokens: 26, cacheReadInputTokens: 500, cacheWriteInputTokens: 30 },
    }));
    const model = await build({ providerDriver: 'bedrock', modelId: 'eu.anthropic.claude-sonnet-4-5-v1:0' }, { fetch });
    const reply = await model.invoke(USER);
    expect(reply.usage).toMatchObject({
      prompt_tokens: 550, completion_tokens: 6, total_tokens: 556,
      prompt_tokens_details: { cached_tokens: 500, cache_write_tokens: 30 },
    });
  });

  it('reasoning effort goes into additionalModelRequestFields.thinking next to the operator\'s extra body', async () => {
    const { calls, fetch } = recorder(() => json({ output: { message: { role: 'assistant', content: [{ text: 'ok' }] } }, stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }));
    const model = await build({ providerDriver: 'bedrock', modelId: 'anthropic.claude-sonnet-4-5-v1:0', settings: { requestDefaults: { top_k: 40 } } }, { fetch, reasoning: { effort: 'low' } });
    await model.invoke(USER);
    await model.invoke(USER);
    for (const call of calls) {
      expect(call.body.additionalModelRequestFields).toMatchObject({ top_k: 40, thinking: { type: 'enabled' } });
    }
  });

  it('really streams: ConverseStream frames become text deltas and one assembled message', async () => {
    const frames = [
      eventFrame('messageStart', { role: 'assistant' }),
      eventFrame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'Hel' } }),
      eventFrame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'lo' } }),
      eventFrame('contentBlockStart', { contentBlockIndex: 1, start: { toolUse: { toolUseId: 'tu1', name: 'lookup' } } }),
      eventFrame('contentBlockDelta', { contentBlockIndex: 1, delta: { toolUse: { input: '{"q":"x"}' } } }),
      eventFrame('messageStop', { stopReason: 'tool_use' }),
      eventFrame('metadata', { usage: { inputTokens: 30, outputTokens: 9, totalTokens: 39 } }),
    ];
    const total = frames.reduce((n, f) => n + f.length, 0);
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const f of frames) { bytes.set(f, at); at += f.length; }
    const { calls, fetch } = recorder(() => new Response(bytes, { status: 200, headers: { 'content-type': 'application/vnd.amazon.eventstream' } }));
    const model = await build({ providerDriver: 'bedrock', modelId: 'amazon.nova-pro-v1:0' }, { fetch });
    const parts: any[] = [];
    for await (const part of model.bindTools!([await lookupTool()]).stream!(USER)) parts.push(part);

    expect(calls[0].url).toMatch(/\/converse-stream$/);
    expect(calls[0].headers.accept).toBe('application/vnd.amazon.eventstream');
    expect(parts.filter((p) => typeof p === 'string').join('')).toBe('Hello');
    expect(parts[parts.length - 1]).toMatchObject({
      role: 'assistant', content: 'Hello',
      tool_calls: [{ id: 'tu1', function: { name: 'lookup', arguments: '{"q":"x"}' } }],
      usage: { prompt_tokens: 30, completion_tokens: 9 },
    });
  });
});

/* ── Vertex ──────────────────────────────────────────────────────────────── */

describe('vertex', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  beforeEach(() => useProvider(
    'vertex',
    { serviceAccountKey: JSON.stringify({ client_email: 'svc@proj.iam.gserviceaccount.com', private_key: privateKey }) },
    { projectId: 'proj-1', location: 'europe-west4' },
  ));

  it('exchanges the service account for a token and calls generateContent — both through the injected transport', async () => {
    const { calls, fetch } = recorder((call) => {
      if (call.url === 'https://oauth2.googleapis.com/token') return json({ access_token: 'ya29.token' });
      return json({
        candidates: [{ content: { role: 'model', parts: [{ text: 'Hi' }, { functionCall: { name: 'lookup', args: { q: 'x' } }, thoughtSignature: 'sig-9' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3, totalTokenCount: 15, cachedContentTokenCount: 2, thoughtsTokenCount: 1 },
      });
    });
    const model = await build({ providerDriver: 'vertex', modelId: 'gemini-2.5-pro', settings: { temperature: 0.3, maxTokens: 400 } }, { fetch });
    const reply = await model.bindTools!([await lookupTool()]).invoke(USER);

    expect(calls[0].url).toBe('https://oauth2.googleapis.com/token');
    const generate = calls[1];
    expect(generate.url).toContain('https://europe-west4-aiplatform.googleapis.com/');
    expect(generate.url).toContain('/projects/proj-1/locations/europe-west4/publishers/google/models/gemini-2.5-pro:generateContent');
    expect(generate.headers.authorization).toBe('Bearer ya29.token');
    expect(generate.body.generationConfig).toMatchObject({ temperature: 0.3, maxOutputTokens: 400 });
    expect(generate.body.tools[0].functionDeclarations[0]).toMatchObject({ name: 'lookup' });
    expect(reply.content).toBe('Hi');
    expect(reply.tool_calls).toMatchObject([{ function: { name: 'lookup', arguments: '{"q":"x"}' }, thoughtSignature: 'sig-9' }]);
    // Vertex leaves the thinking tokens out of the candidates count; the agent gets them in the completion, as a subset.
    expect(reply.usage).toMatchObject({
      prompt_tokens: 12, completion_tokens: 4, total_tokens: 16,
      prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 1 },
    });
  });

  it('reasoning effort becomes thinkingConfig.thinkingBudget; "none" is a zero budget', async () => {
    const { calls, fetch } = recorder((call) => (call.url.includes('oauth2') ? json({ access_token: 't' }) : json({
      candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    })));
    const asked = await build({ providerDriver: 'vertex', modelId: 'gemini-2.5-pro' }, { fetch, reasoning: { effort: 'high', includeThoughts: true } });
    await asked.invoke(USER);
    const off = await build({ providerDriver: 'vertex', modelId: 'gemini-2.5-pro' }, { fetch, reasoning: { effort: 'none' } });
    await off.invoke(USER);
    const bodies = calls.filter((c) => c.url.includes('generateContent')).map((c) => c.body.generationConfig?.thinkingConfig);
    expect(bodies[0]).toMatchObject({ includeThoughts: true });
    expect(bodies[0].thinkingBudget).toBeGreaterThan(0);
    expect(bodies[1]).toMatchObject({ thinkingBudget: 0 });
  });
});

/* ── a whole agent turn on a native model ───────────────────────────────── */

describe('an agent turn (real SDK agent loop) on a native model', () => {
  beforeEach(() => useProvider('openai', { apiKey: 'sk-live' }));

  it('runs a tool round trip: the tool result goes back on the wire and the answer, usage and reasoning come out', async () => {
    const { createSmartAgent, createTool } = await import('@cognipeer/agent-sdk');
    const { z } = await import('zod');
    const executed: unknown[] = [];
    const lookup = createTool({
      name: 'lookup', description: 'Find a thing', schema: z.object({ q: z.string() }),
      func: async (args: { q: string }) => { executed.push(args); return `found ${args.q}`; },
    });
    let turn = 0;
    const { calls, fetch } = recorder(() => json(turn++ === 0
      ? chatCompletion({ content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"q":"apples"}' } }] }, { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } })
      : chatCompletion({ content: 'Apples are found.', reasoning_content: 'ok' }, { usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100, completion_tokens_details: { reasoning_tokens: 5 } } })));
    const model = await build({ modelId: 'gpt-4o' }, { fetch });

    const agent = createSmartAgent({ model, tools: [lookup], systemPrompt: 'Be brief.' } as never);
    const result = await agent.invoke({ messages: [{ role: 'user', content: 'find apples' }] } as never) as { content?: string; messages: Array<Record<string, any>> };

    expect(executed).toEqual([{ q: 'apples' }]);
    expect(calls).toHaveLength(2);
    expect(calls[0].body.tools.map((t: any) => t.function.name)).toContain('lookup');
    const second = calls[1].body.messages as Array<Record<string, any>>;
    expect(second.some((m) => m.role === 'assistant' && m.tool_calls?.[0]?.id === 'c1')).toBe(true);
    expect(second.some((m) => m.role === 'tool' && m.tool_call_id === 'c1' && String(m.content).includes('found apples'))).toBe(true);
    expect(result.content).toBe('Apples are found.');
    const last = result.messages[result.messages.length - 1];
    expect(last.reasoning?.summary).toBe('ok');
  });

  it('streams a turn: text reaches onStream chunk by chunk and the tool call still executes', async () => {
    const { createSmartAgent, createTool } = await import('@cognipeer/agent-sdk');
    const { z } = await import('zod');
    const executed: unknown[] = [];
    const lookup = createTool({
      name: 'lookup', description: 'Find a thing', schema: z.object({ q: z.string() }),
      func: async (args: { q: string }) => { executed.push(args); return 'found'; },
    });
    const frame = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ id: 's', model: 'gpt-4o', choices: [{ index: 0, delta, ...extra }] });
    let turn = 0;
    const { calls, fetch } = recorder(() => (turn++ === 0
      ? sse([
        frame({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"q":' } }] }),
        frame({ tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] }),
        frame({}, { finish_reason: 'tool_calls' }),
        { id: 's', model: 'gpt-4o', choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
      ])
      : sse([frame({ content: 'All ' }), frame({ content: 'done' }), frame({}, { finish_reason: 'stop' }),
        { id: 's', model: 'gpt-4o', choices: [], usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 } }])));
    const model = await build({ modelId: 'gpt-4o' }, { fetch });
    const chunks: string[] = [];
    const agent = createSmartAgent({ model, tools: [lookup] } as never);
    const result = await agent.invoke({ messages: [{ role: 'user', content: 'go' }] } as never, { stream: true, onStream: (c: { text?: string; isFinal?: boolean }) => { if (c.text && !c.isFinal) chunks.push(c.text); } } as never) as { content?: string };

    expect(calls.every((c) => c.body.stream === true)).toBe(true);
    expect(executed).toEqual([{ q: 'x' }]);
    expect(chunks.join('')).toBe('All done');
    expect(chunks.length).toBeGreaterThan(1);
    expect(result.content).toBe('All done');
  });
});
/* ── the normalized reasoning value ─────────────────────────────────────── */

describe('normalizeNativeReasoning', () => {
  it('reads the normalized and the legacy shapes, and nothing else', () => {
    expect(normalizeNativeReasoning({ effort: 'high', budgetTokens: 2048, includeThoughts: true })).toEqual({ effort: 'high', budgetTokens: 2048, includeThoughts: true });
    expect(normalizeNativeReasoning({ effort: 'low', summary: 'auto' })).toEqual({ effort: 'low' });
    expect(normalizeNativeReasoning({ effort: 'extreme' })).toBeUndefined();
    expect(normalizeNativeReasoning(undefined)).toBeUndefined();
  });

  it('the Model Hub default (legacy settings.reasoning) is sent when the caller asks for nothing', async () => {
    useProvider('openai', { apiKey: 'k' });
    const { calls, fetch } = recorder(() => json(chatCompletion({ content: 'ok' })));
    const model = await build({ modelId: 'o4-mini', settings: { reasoning: { effort: 'low', summary: 'auto' } } }, { fetch });
    await model.invoke(USER);
    expect(calls[0].body.reasoning_effort).toBe('low');
  });

  it('nothing set anywhere: nothing is sent', async () => {
    useProvider('openai', { apiKey: 'k' });
    const { calls, fetch } = recorder(() => json(chatCompletion({ content: 'ok' })));
    const model = await build({ modelId: 'o4-mini' }, { fetch });
    await model.invoke(USER);
    expect(calls[0].body.reasoning_effort).toBeUndefined();
    expect(calls[0].body.reasoning).toBeUndefined();
  });
});

/* ── guards ──────────────────────────────────────────────────────────────── */

describe('provider support', () => {
  it('a driver without a chat client cannot serve an agent turn', async () => {
    hoisted.providers.prov = { driver: 'openai', credentials: { apiKey: 'k' }, settings: {} };
    const original = OpenAiModelProviderContract.createRuntime as unknown as (c: unknown) => Record<string, unknown>;
    vi.spyOn(OpenAiModelProviderContract, 'createRuntime').mockImplementation(((ctx: unknown) => {
      const runtime = original(ctx);
      delete runtime.createNativeChatClient;
      return runtime;
    }) as never);
    const model = await build({}, { fetch: recorder(() => json({})).fetch });
    await expect(model.invoke(USER)).rejects.toThrow(/does not support chat completions/);
    vi.restoreAllMocks();
  });
});
