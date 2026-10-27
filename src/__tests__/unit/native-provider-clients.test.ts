/**
 * `createNativeChatClient` / `createNativeEmbedder` of every model provider
 * contract. Each driver is exercised through the REAL contract runtime and the
 * real agent-sdk provider with an injected `fetch`: what is asserted is the wire
 * request (model, token-limit field, tools, response_format, reasoning, extra /
 * requestDefaults, unsupportedParams stripping, credentials) and the parsed
 * native output (text, tool calls, usage, reasoning, raw finish reason).
 */
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AnthropicModelProviderContract,
  AzureModelProviderContract,
  BedrockModelProviderContract,
  OpenAiCompatibleModelProviderContract,
  OpenAiModelProviderContract,
  TogetherModelProviderContract,
  VertexModelProviderContract,
} from '@/lib/providers/contracts/modelContracts';
import type { ModelProviderRuntime, NativeChatRequest } from '@/lib/providers/domains/model';

interface Call { url: string; headers: Record<string, string>; body: Record<string, any> }

function recorder(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const raw = typeof init?.body === 'string' ? init.body : '';
    let body: Record<string, any> = {};
    try { body = raw.trim().startsWith('{') ? JSON.parse(raw) : {}; } catch { /* not json */ }
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { headers[k.toLowerCase()] = v; });
    const call = { url: String(input), headers, body };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;
  return { calls, fetch: fetchImpl };
}
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
const sse = (events: unknown[]) => new Response(
  `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')}data: [DONE]\n\n`,
  { status: 200, headers: { 'content-type': 'text/event-stream' } },
);

const logger = { info() {}, warn() {}, error() {}, debug() {} };
async function runtimeOf(
  contract: { createRuntime: unknown },
  credentials: Record<string, unknown>,
  settings: Record<string, unknown> = {},
): Promise<ModelProviderRuntime> {
  return (contract.createRuntime as (ctx: unknown) => Promise<ModelProviderRuntime>)({
    tenantId: 't', projectId: 'p', providerKey: 'prov', credentials, settings, metadata: {}, logger,
  });
}

const config = (modelId: string, modelSettings: Record<string, unknown> = {}, category: 'llm' | 'embedding' = 'llm', options?: { maxRetries?: number }) =>
  ({ modelId, category, modelSettings, options }) as never;

const USER: NativeChatRequest = { messages: [{ role: 'user', content: 'hi' }] };
const LOOKUP = { name: 'lookup', description: 'Find a thing', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } };
const SCHEMA = { type: 'json_schema' as const, name: 'answer', schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } };

const chatCompletion = (message: Record<string, unknown>, extra: Record<string, unknown> = {}, finish = 'stop') => ({
  id: 'chatcmpl-1', object: 'chat.completion', created: 1, model: 'gpt-4o',
  choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finish }],
  ...extra,
});

/* ── OpenAI ─────────────────────────────────────────────────────────────── */

describe('openai native client', () => {
  const make = () => runtimeOf(OpenAiModelProviderContract, { apiKey: 'sk-live' }, { organization: 'org-1' });

  it('wire body: model, token field, sampling, tools, response_format, requestDefaults; parsed output', async () => {
    const runtime = await make();
    const { calls, fetch } = recorder(() => json(chatCompletion(
      { content: 'Hello', reasoning_content: 'because', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }] },
      { system_fingerprint: 'fp_1', usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140, prompt_tokens_details: { cached_tokens: 60 }, completion_tokens_details: { reasoning_tokens: 12 } } },
      'tool_calls',
    )));
    const client = await runtime.createNativeChatClient!(
      config('gpt-4o', { temperature: 0.4, topP: 0.9, maxTokens: 256, presencePenalty: 0.2, requestDefaults: { seed: 7 } }),
      { fetch },
    );
    const res = await client.complete({ ...USER, tools: [LOOKUP], responseFormat: SCHEMA });

    const [call] = calls;
    expect(call.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(call.headers.authorization).toBe('Bearer sk-live');
    expect(call.headers['openai-organization']).toBe('org-1');
    expect(call.body).toMatchObject({
      model: 'gpt-4o', temperature: 0.4, top_p: 0.9, max_tokens: 256, presence_penalty: 0.2, seed: 7,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'lookup' } }],
      response_format: { type: 'json_schema', json_schema: { name: 'answer' } },
    });
    expect(call.body.max_completion_tokens).toBeUndefined();

    expect(res.content).toBe('Hello');
    expect(res.toolCalls).toMatchObject([{ id: 'c1', name: 'lookup', arguments: '{"q":"x"}' }]);
    expect(res.finishReason).toBe('tool_calls');
    expect(res.rawFinishReason).toBe('tool_calls');
    expect(res.usage).toMatchObject({ inputTokens: 100, outputTokens: 40, cachedInputTokens: 60, reasoningTokens: 12 });
    expect(res.reasoning?.summary).toBe('because');
    expect(res.providerFields?.system_fingerprint).toBe('fp_1');
  });

  it('request values win over the model record; the record fills only what is unset', async () => {
    const { calls, fetch } = recorder(() => json(chatCompletion({ content: 'ok' })));
    const client = await (await make()).createNativeChatClient!(config('gpt-4o', { temperature: 0.4, topP: 0.9 }), { fetch });
    await client.complete({ ...USER, temperature: 0.9, maxTokens: 33, extra: { seed: 1 } });
    expect(calls[0].body).toMatchObject({ temperature: 0.9, top_p: 0.9, max_tokens: 33, seed: 1 });
  });

  it('GPT-5: max_completion_tokens, no sampling; reasoning goes as reasoning_effort on Chat Completions and is forced to none next to tools', async () => {
    const { calls, fetch } = recorder(() => json(chatCompletion({ content: 'ok' })));
    const client = await (await make()).createNativeChatClient!(config('gpt-5.2', { temperature: 0.4, topP: 0.9, maxTokens: 500 }), { fetch });
    await client.complete({ ...USER, reasoning: { effort: 'high' } });
    expect(calls[0].url).toBe('https://api.openai.com/v1/chat/completions');
    // Reasoning tokens count against the limit: the model's small 500 is raised to the table value of effort high.
    expect(calls[0].body).toMatchObject({ max_completion_tokens: 32768, reasoning_effort: 'high' });
    expect(calls[0].body.max_tokens).toBeUndefined();
    expect(calls[0].body.temperature).toBeUndefined();
    expect(calls[0].body.top_p).toBeUndefined();
    expect(calls[0].body.reasoning).toBeUndefined();

    await client.complete({ ...USER, tools: [LOOKUP], reasoning: { effort: 'high' } });
    expect(calls[1].body.reasoning_effort).toBe('none');
  });

  it('the Model Hub reasoning default is used when the request has none; a request value wins', async () => {
    const { calls, fetch } = recorder(() => json(chatCompletion({ content: 'ok' })));
    const client = await (await make()).createNativeChatClient!(config('o4-mini', { reasoning: { effort: 'low' } }), { fetch });
    await client.complete(USER);
    await client.complete({ ...USER, reasoning: { effort: 'high' } });
    expect(calls.map((c) => c.body.reasoning_effort)).toEqual(['low', 'high']);
  });

  it('unsupportedParams strips a parameter; declaring max_tokens unsupported renames the budget', async () => {
    const { calls, fetch } = recorder(() => json(chatCompletion({ content: 'ok' })));
    const client = await (await make()).createNativeChatClient!(
      config('vanity-model', { temperature: 0.5, presencePenalty: 0.3, maxTokens: 64, unsupportedParams: ['presence_penalty', 'max_tokens'] }),
      { fetch },
    );
    await client.complete(USER);
    expect(calls[0].body.presence_penalty).toBeUndefined();
    expect(calls[0].body.max_tokens).toBeUndefined();
    expect(calls[0].body.max_completion_tokens).toBe(64);
    expect(calls[0].body.temperature).toBe(0.5);
  });

  it('a stripped reasoning_effort is also stripped from the request-level value', async () => {
    const { calls, fetch } = recorder(() => json(chatCompletion({ content: 'ok' })));
    const client = await (await make()).createNativeChatClient!(config('o4-mini', { unsupportedParams: ['reasoning_effort'] }), { fetch });
    await client.complete({ ...USER, reasoning: { effort: 'high' } });
    expect(calls[0].body.reasoning_effort).toBeUndefined();
  });

  it('streams: tool-call deltas keep their index, raw finish reason and the usage frame survive', async () => {
    const frame = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ id: 's1', model: 'gpt-4o', choices: [{ index: 0, delta, ...extra }] });
    const { calls, fetch } = recorder(() => sse([
      frame({ content: 'Hel' }),
      frame({ content: 'lo' }),
      frame({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"q":' } }] }),
      frame({ tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] }),
      frame({}, { finish_reason: 'tool_calls' }),
      { id: 's1', model: 'gpt-4o', choices: [], usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 } },
    ]));
    const client = await (await make()).createNativeChatClient!(config('gpt-4o'), { fetch });
    const chunks = [];
    for await (const chunk of client.stream({ ...USER, tools: [LOOKUP] })) chunks.push(chunk);

    expect(calls[0].body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(chunks.map((c) => c.delta.content ?? '').join('')).toBe('Hello');
    const calls0 = chunks.flatMap((c) => c.delta.toolCalls ?? []);
    expect(calls0[0]).toMatchObject({ id: 'c1', name: 'lookup', index: 0 });
    expect(calls0.map((c) => c.arguments ?? '').join('')).toBe('{"q":"x"}');
    // Mid-stream chunks carry a placeholder finishReason 'stop'; only the closing chunk has the raw one.
    expect(chunks.find((c) => c.rawFinishReason)).toMatchObject({ finishReason: 'tool_calls', rawFinishReason: 'tool_calls' });
    expect(chunks.find((c) => c.usage)?.usage).toMatchObject({ inputTokens: 9, outputTokens: 4 });
  });

  it('a model that declares stream_options unsupported streams without include_usage', async () => {
    const { calls, fetch } = recorder(() => sse([{ id: 's', model: 'm', choices: [{ index: 0, delta: { content: 'x' }, finish_reason: 'stop' }] }]));
    const client = await (await make()).createNativeChatClient!(config('gpt-4o', { unsupportedParams: ['stream_options'] }), { fetch });
    for await (const chunk of client.stream(USER)) void chunk;
    expect(calls[0].body.stream).toBe(true);
    expect(calls[0].body.stream_options).toBeUndefined();
  });

  it('a provider error carries its status; maxRetries 0 means one attempt only', async () => {
    const { calls, fetch } = recorder(() => new Response('{"error":{"message":"slow"}}', { status: 429, headers: { 'retry-after': '0' } }));
    const client = await (await make()).createNativeChatClient!(config('gpt-4o', {}, 'llm', { maxRetries: 0 }), { fetch });
    await expect(client.complete(USER)).rejects.toMatchObject({ statusCode: 429 });
    expect(calls).toHaveLength(1);
  });

  it('prepare() exposes the finished request without calling the upstream', async () => {
    const client = await (await make()).createNativeChatClient!(config('gpt-4o', { temperature: 0.2 }), { fetch: (() => { throw new Error('no network'); }) as never });
    expect(await client.prepare(USER)).toMatchObject({ model: 'gpt-4o', temperature: 0.2, messages: USER.messages });
  });
});

/* ── Azure ──────────────────────────────────────────────────────────────── */

describe('azure native client', () => {
  const make = () => runtimeOf(AzureModelProviderContract, { apiKey: 'az-key' }, { instanceName: 'res', deploymentName: 'fallback-dep', apiVersion: '2024-10-21' });

  it('addresses the DEPLOYMENT with api-key auth and the per-model api-version', async () => {
    const { calls, fetch } = recorder(() => json(chatCompletion({ content: 'ok' })));
    const client = await (await make()).createNativeChatClient!(
      config('prod-chat', { maxTokens: 90, azureApiVersion: '2025-04-01-preview' }), { fetch });
    await client.complete({ ...USER, tools: [LOOKUP] });
    expect(calls[0].url).toBe('https://res.openai.azure.com/openai/deployments/prod-chat/chat/completions?api-version=2025-04-01-preview');
    expect(calls[0].headers['api-key']).toBe('az-key');
    expect(calls[0].body.max_tokens).toBe(90);
    expect(calls[0].body.tools[0].function.name).toBe('lookup');
  });

  it('a reasoning deployment sends max_completion_tokens and reasoning_effort', async () => {
    const { calls, fetch } = recorder(() => json(chatCompletion({ content: 'ok' })));
    const client = await (await make()).createNativeChatClient!(config('gpt-5', { maxTokens: 90 }), { fetch });
    await client.complete({ ...USER, reasoning: { effort: 'medium' } });
    expect(calls[0].url).toContain('/openai/deployments/gpt-5/chat/completions');
    // The model's small 90 is raised to the table value of effort medium.
    expect(calls[0].body).toMatchObject({ max_completion_tokens: 16384, reasoning_effort: 'medium' });
  });

  it('embeds against the embedding DEPLOYMENT, not the chat one', async () => {
    const { calls, fetch } = recorder(() => json({ data: [{ index: 0, embedding: [0.1, 0.2] }], model: 'text-embedding-3-small', usage: { prompt_tokens: 3, total_tokens: 3 } }));
    const embedder = await (await make()).createNativeEmbedder!(config('emb-dep', {}, 'embedding'), { fetch });
    const res = await embedder.embed(['hello']);
    expect(calls[0].url).toBe('https://res.openai.azure.com/openai/deployments/emb-dep/embeddings?api-version=2024-10-21');
    expect(calls[0].headers['api-key']).toBe('az-key');
    expect(res.vectors).toEqual([[0.1, 0.2]]);
    expect(res.usage).toEqual({ inputTokens: 3, totalTokens: 3 });
  });
});

/* ── OpenAI-compatible / Together ───────────────────────────────────────── */

describe('openai-compatible native client', () => {
  const make = () => runtimeOf(OpenAiCompatibleModelProviderContract, { apiKey: 'k' }, { baseUrl: 'https://llm.internal.example/v1', organization: 'team-9' });

  it('talks to the base URL; requestDefaults reach the upstream verbatim; never the Responses API', async () => {
    const { calls, fetch } = recorder(() => json(chatCompletion({ content: 'ok' })));
    const client = await (await make()).createNativeChatClient!(
      config('qwen3-32b', { requestDefaults: { chat_template_kwargs: { enable_thinking: false }, top_k: 20 } }), { fetch });
    await client.complete({ ...USER, responseFormat: { type: 'json_object' } });
    expect(calls[0].url).toBe('https://llm.internal.example/v1/chat/completions');
    expect(calls[0].headers.authorization).toBe('Bearer k');
    expect(calls[0].headers['openai-organization']).toBe('team-9');
    expect(calls[0].body).toMatchObject({ model: 'qwen3-32b', chat_template_kwargs: { enable_thinking: false }, top_k: 20, response_format: { type: 'json_object' } });

    await client.complete({ ...USER, model: 'o3-mini', reasoning: { effort: 'high' } });
    expect(calls[1].url).toBe('https://llm.internal.example/v1/chat/completions');
    expect(calls[1].body.reasoning_effort).toBe('high');
  });

  it('a reasoning block leaked into a non-streamed answer is normalized by the transport; the client flags the stream case', async () => {
    const { fetch } = recorder(() => json(chatCompletion({ content: '<reasoning>The user wants a greeting</reasoning>Hey there' })));
    const client = await (await make()).createNativeChatClient!(config('gpt-oss-120b'), { fetch });
    const res = await client.complete(USER);
    expect(res.content).toBe('Hey there');
    expect(res.reasoning?.summary).toBe('The user wants a greeting');
    expect(client.normalizeInlineReasoning).toBe(true);
  });

  it('embeds through /embeddings with dimensions', async () => {
    const { calls, fetch } = recorder(() => json({ data: [{ index: 1, embedding: [2] }, { index: 0, embedding: [1] }], usage: { prompt_tokens: 4, total_tokens: 4 } }));
    const embedder = await (await make()).createNativeEmbedder!(config('bge-m3', {}, 'embedding'), { fetch });
    const res = await embedder.embed(['a', 'b'], { dimensions: 256 });
    expect(calls[0].url).toBe('https://llm.internal.example/v1/embeddings');
    expect(calls[0].body).toMatchObject({ model: 'bge-m3', input: ['a', 'b'], dimensions: 256 });
    expect(res.vectors).toEqual([[1], [2]]);
  });
});

describe('together native client', () => {
  it('uses the Together endpoint through the OpenAI-compatible provider, chat and embeddings', async () => {
    const runtime = await runtimeOf(TogetherModelProviderContract, { apiKey: 'tg' });
    const { calls, fetch } = recorder((call) => (call.url.endsWith('/embeddings')
      ? json({ data: [{ index: 0, embedding: [0.5] }], usage: { prompt_tokens: 1, total_tokens: 1 } })
      : json(chatCompletion({ content: 'ok' }))));
    const chat = await runtime.createNativeChatClient!(config('meta-llama/Llama-3.3-70B-Instruct-Turbo', { maxTokens: 50 }), { fetch });
    await chat.complete(USER);
    expect(calls[0].url).toBe('https://api.together.xyz/v1/chat/completions');
    expect(calls[0].headers.authorization).toBe('Bearer tg');
    expect(calls[0].body).toMatchObject({ model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', max_tokens: 50 });

    const embedder = await runtime.createNativeEmbedder!(config('BAAI/bge-base-en-v1.5', {}, 'embedding'), { fetch });
    expect((await embedder.embed(['x'])).vectors).toEqual([[0.5]]);
    expect(calls[1].url).toBe('https://api.together.xyz/v1/embeddings');
  });
});

/* ── Anthropic ──────────────────────────────────────────────────────────── */

describe('anthropic native client', () => {
  const make = (settings: Record<string, unknown> = {}) => runtimeOf(AnthropicModelProviderContract, { apiKey: 'sk-ant' }, settings);
  const messageResponse = (content: unknown[], usage: Record<string, unknown> = {}) => ({
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', stop_reason: 'end_turn', content,
    usage: { input_tokens: 10, output_tokens: 5, ...usage },
  });

  it('Messages wire: key header, the capped default max_tokens, system, tools as input_schema; parsed output', async () => {
    const { calls, fetch } = recorder(() => json(messageResponse(
      [{ type: 'text', text: 'Hi' }, { type: 'tool_use', id: 'tu1', name: 'lookup', input: { q: 'x' } }], { cache_read_input_tokens: 7 })));
    const client = await (await make()).createNativeChatClient!(config('claude-sonnet-4-5', { temperature: 0.2 }), { fetch });
    const res = await client.complete({ messages: [{ role: 'system', content: 'be brief' }, ...USER.messages], tools: [LOOKUP] });
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0].headers['x-api-key']).toBe('sk-ant');
    expect(calls[0].body).toMatchObject({
      model: 'claude-sonnet-4-5', max_tokens: 21333, temperature: 0.2, system: 'be brief',
      tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
    });
    expect(res.content).toBe('Hi');
    expect(res.toolCalls).toMatchObject([{ id: 'tu1', name: 'lookup', arguments: '{"q":"x"}' }]);
    expect(res.usage).toMatchObject({ inputTokens: expect.any(Number), outputTokens: 5, cachedInputTokens: 7 });
    expect(res.rawFinishReason).toBe('end_turn');
  });

  it('an unset limit is the model maximum when streaming, the capped default otherwise, the 8192 floor for an unknown model', async () => {
    const event = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    const stream = [
      event('message_start', { message: { id: 'msg_1', model: 'claude-sonnet-4-5', usage: { input_tokens: 1, output_tokens: 1 } } }),
      event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hi' } }),
      event('content_block_stop', { index: 0 }),
      event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }),
      event('message_stop', {}),
    ].join('');
    const streaming = recorder(() => new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const known = await (await make()).createNativeChatClient!(config('claude-sonnet-4-5', {}), { fetch: streaming.fetch });
    for await (const chunk of known.stream(USER)) void chunk;
    expect(streaming.calls[0].body.max_tokens).toBe(64000);

    const plain = recorder(() => json(messageResponse([{ type: 'text', text: 'ok' }])));
    const unknown = await (await make()).createNativeChatClient!(config('claude-3-7-sonnet-20250219', {}), { fetch: plain.fetch });
    await unknown.complete(USER);
    expect(plain.calls[0].body.max_tokens).toBe(8192);
  });

  it('a configured limit wins over the default; a custom base URL is honoured', async () => {
    const { calls, fetch } = recorder(() => json(messageResponse([{ type: 'text', text: 'ok' }])));
    const client = await (await make({ baseUrl: 'https://claude-proxy.example' })).createNativeChatClient!(config('claude-sonnet-4-5', { maxTokens: 321 }), { fetch });
    await client.complete(USER);
    expect(calls[0].url).toBe('https://claude-proxy.example/v1/messages');
    expect(calls[0].body.max_tokens).toBe(321);
  });

  it('reasoning becomes a thinking block (budget below max_tokens, sampling dropped); signed blocks are returned', async () => {
    const { calls, fetch } = recorder(() => json(messageResponse([{ type: 'thinking', thinking: 'hmm', signature: 'sig-1' }, { type: 'text', text: 'done' }])));
    const client = await (await make()).createNativeChatClient!(config('claude-sonnet-4-5', { temperature: 0.2, maxTokens: 2000 }), { fetch });
    const res = await client.complete({ ...USER, reasoning: { effort: 'medium' } });
    const { thinking, max_tokens } = calls[0].body;
    expect(thinking.type).toBe('enabled');
    expect(max_tokens).toBeGreaterThan(thinking.budget_tokens);
    expect(calls[0].body.temperature).toBeUndefined();
    expect(res.reasoning).toMatchObject({ summary: 'hmm', blocks: [{ type: 'thinking', signature: 'sig-1' }] });
  });

  it('an explicit thinking block in requestDefaults wins over the reasoning default', async () => {
    const { calls, fetch } = recorder(() => json(messageResponse([{ type: 'text', text: 'ok' }])));
    const client = await (await make()).createNativeChatClient!(
      config('claude-sonnet-4-5', { reasoning: { effort: 'low' }, requestDefaults: { thinking: { type: 'enabled', budget_tokens: 2048 } } }), { fetch });
    await client.complete(USER);
    expect(calls[0].body.thinking).toMatchObject({ type: 'enabled', budget_tokens: 2048 });
  });

  it('no embedder: Anthropic has no embeddings endpoint', async () => {
    const embedder = await (await make()).createNativeEmbedder!(config('x', {}, 'embedding'), { fetch: (async () => json({})) as never });
    await expect(embedder.embed(['a'])).rejects.toMatchObject({ statusCode: 400 });
  });
});

/* ── Bedrock ────────────────────────────────────────────────────────────── */

describe('bedrock native client', () => {
  const make = () => runtimeOf(BedrockModelProviderContract, { accessKeyId: 'AKIA1', secretAccessKey: 'secret', sessionToken: 'tok' }, { region: 'eu-central-1' });

  it('Converse: signed regional request; inferenceConfig, tools, extra in additionalModelRequestFields; parsed output', async () => {
    const { calls, fetch } = recorder(() => json({
      output: { message: { role: 'assistant', content: [{ text: 'Hi' }, { toolUse: { toolUseId: 'tu1', name: 'lookup', input: { q: 'x' } } }] } },
      stopReason: 'tool_use',
      usage: { inputTokens: 20, outputTokens: 6, totalTokens: 26 },
    }));
    const client = await (await make()).createNativeChatClient!(
      config('eu.anthropic.claude-sonnet-4-5-v1:0', { temperature: 0.1, topP: 0.8, maxTokens: 700, requestDefaults: { top_k: 40 } }), { fetch });
    const res = await client.complete({ ...USER, tools: [LOOKUP], reasoning: { effort: 'low' } });
    expect(calls[0].url).toBe('https://bedrock-runtime.eu-central-1.amazonaws.com/model/eu.anthropic.claude-sonnet-4-5-v1%3A0/converse');
    expect(calls[0].headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIA1\//);
    expect(calls[0].headers['x-amz-security-token']).toBe('tok');
    expect(calls[0].body.inferenceConfig.maxTokens).toBeGreaterThanOrEqual(700);
    expect(calls[0].body.toolConfig.tools[0].toolSpec.name).toBe('lookup');
    expect(calls[0].body.additionalModelRequestFields).toMatchObject({ top_k: 40, thinking: { type: 'enabled' } });
    expect(res.content).toBe('Hi');
    expect(res.toolCalls).toMatchObject([{ id: 'tu1', name: 'lookup' }]);
    expect(res.usage).toMatchObject({ inputTokens: 20, outputTokens: 6 });
  });

  it('without reasoning: sampling and the 700 limit are sent as configured', async () => {
    const { calls, fetch } = recorder(() => json({ output: { message: { role: 'assistant', content: [{ text: 'ok' }] } }, stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }));
    const client = await (await make()).createNativeChatClient!(config('amazon.nova-pro-v1:0', { temperature: 0.1, topP: 0.8, maxTokens: 700 }), { fetch });
    await client.complete(USER);
    expect(calls[0].body.inferenceConfig).toMatchObject({ maxTokens: 700, temperature: 0.1, topP: 0.8 });
  });

  it('Titan embeddings through InvokeModel with dimensions', async () => {
    const { calls, fetch } = recorder(() => json({ embedding: [0.1, 0.2], inputTextTokenCount: 5 }));
    const embedder = await (await make()).createNativeEmbedder!(config('amazon.titan-embed-text-v2:0', {}, 'embedding'), { fetch });
    const res = await embedder.embed(['hello'], { dimensions: 256 });
    expect(calls[0].url).toBe('https://bedrock-runtime.eu-central-1.amazonaws.com/model/amazon.titan-embed-text-v2%3A0/invoke');
    expect(calls[0].body).toMatchObject({ inputText: 'hello', dimensions: 256 });
    expect(res.vectors).toEqual([[0.1, 0.2]]);
    expect(res.usage.inputTokens).toBe(5);
  });
});

/* ── Vertex ─────────────────────────────────────────────────────────────── */

describe('vertex native client', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const make = () => runtimeOf(
    VertexModelProviderContract,
    { serviceAccountKey: JSON.stringify({ client_email: 'svc@proj.iam.gserviceaccount.com', private_key: privateKey }) },
    { projectId: 'proj-1', location: 'europe-west4' },
  );
  const generate = (call: Call) => (call.url.includes('oauth2') ? json({ access_token: 'ya29.token' }) : json({
    candidates: [{ content: { role: 'model', parts: [{ text: 'Hi' }, { functionCall: { name: 'lookup', args: { q: 'x' } }, thoughtSignature: 'sig-9' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3, totalTokenCount: 15, thoughtsTokenCount: 1 },
  }));

  it('generateContent with the minted token: generationConfig, tools, thinkingConfig; thoughtSignature kept; requestDefaults are NOT forwarded', async () => {
    const { calls, fetch } = recorder(generate);
    const client = await (await make()).createNativeChatClient!(
      config('gemini-2.5-pro', { temperature: 0.3, maxTokens: 400, requestDefaults: { top_k: 5 } }), { fetch });
    const res = await client.complete({ ...USER, tools: [LOOKUP], reasoning: { effort: 'high', includeThoughts: true } });
    const call = calls.find((c) => c.url.includes('generateContent'))!;
    expect(call.url).toContain('/projects/proj-1/locations/europe-west4/publishers/google/models/gemini-2.5-pro:generateContent');
    expect(call.headers.authorization).toBe('Bearer ya29.token');
    // effort 'high' (budget 16384) raises the small 400 limit to budget + 2048 so thinking leaves room for the answer
    expect(call.body.generationConfig).toMatchObject({ temperature: 0.3, maxOutputTokens: 18432 });
    expect(call.body.generationConfig.thinkingConfig).toMatchObject({ includeThoughts: true });
    expect(call.body.tools[0].functionDeclarations[0].name).toBe('lookup');
    expect(call.body.top_k).toBeUndefined();
    expect(res.toolCalls).toMatchObject([{ name: 'lookup', arguments: '{"q":"x"}', thoughtSignature: 'sig-9' }]);
    expect(res.usage).toMatchObject({ inputTokens: 12, totalTokens: 15 });
  });

  it('"none" is a zero thinking budget', async () => {
    const { calls, fetch } = recorder(generate);
    const client = await (await make()).createNativeChatClient!(config('gemini-2.5-pro'), { fetch });
    await client.complete({ ...USER, reasoning: { effort: 'none' } });
    expect(calls.find((c) => c.url.includes('generateContent'))!.body.generationConfig.thinkingConfig).toMatchObject({ thinkingBudget: 0 });
  });

  it('embeds through the :predict endpoint', async () => {
    const { calls, fetch } = recorder((call) => (call.url.includes('oauth2')
      ? json({ access_token: 't' })
      : json({ predictions: [{ embeddings: { values: [0.3, 0.4], statistics: { token_count: 2 } } }] })));
    const embedder = await (await make()).createNativeEmbedder!(config('text-embedding-005', {}, 'embedding'), { fetch });
    const res = await embedder.embed(['hello'], { inputType: 'search_query' });
    expect(calls.find((c) => c.url.includes(':predict'))!.url).toContain('/models/text-embedding-005:predict');
    expect(res.vectors).toEqual([[0.3, 0.4]]);
  });
});

/* ── Transport ──────────────────────────────────────────────────────────── */

describe('transport', () => {
  it('without a transport the global fetch is used (the gateway adds no guard of its own)', async () => {
    const { calls, fetch } = recorder(() => json(chatCompletion({ content: 'ok' })));
    const original = globalThis.fetch;
    globalThis.fetch = fetch;
    try {
      const runtime = await runtimeOf(OpenAiModelProviderContract, { apiKey: 'sk' });
      const client = await runtime.createNativeChatClient!(config('gpt-4o'));
      await client.complete(USER);
      expect(calls).toHaveLength(1);
    } finally { globalThis.fetch = original; }
  });
});
