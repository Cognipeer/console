/**
 * Review fixes of the native gateway: each test is the failing case a reviewer
 * probed, run through the REAL provider contracts and agent-sdk providers with only
 * the network scripted.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeModelCall, handleChatCompletion } from '@/lib/services/models/inferenceService';
import type { GatewayChatRequest, ModelStreamEvent } from '@/lib/services/models/gatewayTypes';
import type { ModelProviderRuntime } from '@/lib/providers/domains/model';
import {
  anthropicRuntime,
  bedrockRuntime,
  chunk,
  completion,
  controlledStream,
  flush,
  json,
  openAiRuntime,
  sse,
  stubUpstream,
} from '../helpers/nativeGateway';

vi.mock('@/lib/core/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/core/config')>();
  return {
    ...actual,
    getConfig: () => {
      const config = actual.getConfig();
      return {
        ...config,
        gateway: {
          ...config.gateway,
          retryEnabled: true,
          retryMaxAttempts: 3,
          retryInitialDelayMs: 1,
          circuitBreakerEnabled: false,
        },
      };
    },
  };
});
vi.mock('@/lib/services/models/modelService', () => ({ getModelByKey: vi.fn() }));
vi.mock('@/lib/services/models/runtimeService', () => ({ buildModelRuntime: vi.fn() }));
vi.mock('@/lib/services/models/semanticCacheService', () => ({
  buildCacheVariantKey: vi.fn().mockReturnValue('variant-key'),
  isSemanticCacheEnabled: vi.fn().mockReturnValue(false),
  lookupCache: vi.fn().mockResolvedValue({ hit: false, response: null }),
  storeInCache: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/services/models/usageLogger', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/services/models/usageLogger')>();
  return { ...original, logModelUsage: vi.fn().mockResolvedValue(undefined) };
});
vi.mock('@/lib/services/models/dynamicRoutingState', () => ({
  getConversationState: vi.fn().mockResolvedValue({}),
  getConversationCostUsd: vi.fn().mockResolvedValue(0),
  getRouterSpendUsd: vi.fn().mockResolvedValue(0),
  getSegmentIoRatio: vi.fn().mockReturnValue(undefined),
  getModelProfiles: vi.fn().mockResolvedValue(new Map()),
  recordRoutedUsage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/services/guardrail/hooks/recordCache', () => ({ getCachedGuardrail: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/services/guardrail', () => ({
  evaluateGuardrail: vi.fn().mockResolvedValue({
    passed: true, blocked: false, action: 'allow', findings: [], guardrailKey: 'g', guardrailName: 'g',
  }),
  createStreamGate: vi.fn(),
}));

import { getModelByKey } from '@/lib/services/models/modelService';
import { buildModelRuntime } from '@/lib/services/models/runtimeService';
import { isSemanticCacheEnabled, lookupCache, storeInCache } from '@/lib/services/models/semanticCacheService';
import { logModelUsage } from '@/lib/services/models/usageLogger';
import { createStreamGate, evaluateGuardrail } from '@/lib/services/guardrail';

const model = (overrides: object = {}) => ({
  _id: 'm1',
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  name: 'M',
  key: 'm',
  providerKey: 'prov',
  providerDriver: 'openai',
  category: 'llm' as const,
  modelId: 'gpt-4o',
  settings: {},
  pricing: { inputTokenPer1M: 10, outputTokenPer1M: 30 },
  ...overrides,
});

const BASE = { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', projectId: 'proj-1', modelKey: 'm' };
const ASK: GatewayChatRequest = { messages: [{ role: 'user', content: 'hello' }] };

const runtimes = new Map<string, ModelProviderRuntime>();
let anthropic: ModelProviderRuntime;
let bedrock: ModelProviderRuntime;
beforeAll(async () => {
  anthropic = await anthropicRuntime();
  bedrock = await bedrockRuntime();
});

/** A runtime per provider key; the key is the API key, so the upstream knows who is calling. */
const openAiPerKey = () => (buildModelRuntime as ReturnType<typeof vi.fn>).mockImplementation(
  async (_db: string, _t: string, providerKey: string) => {
    if (!runtimes.has(providerKey)) runtimes.set(providerKey, await openAiRuntime({}, providerKey));
    return { runtime: runtimes.get(providerKey) };
  },
);
const useModel = (m: object) => (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(m);
const apiKeyOf = (call: { headers: Record<string, string> }) => call.headers.authorization?.replace('Bearer ', '');
const rows = () => (logModelUsage as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[2]);

async function collect(stream: AsyncGenerator<ModelStreamEvent, void, void>) {
  const events: ModelStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  (isSemanticCacheEnabled as ReturnType<typeof vi.fn>).mockReturnValue(false);
  (lookupCache as ReturnType<typeof vi.fn>).mockResolvedValue({ hit: false, response: null });
  (createStreamGate as ReturnType<typeof vi.fn>).mockReset();
  (evaluateGuardrail as ReturnType<typeof vi.fn>).mockResolvedValue({
    passed: true, blocked: false, action: 'allow', findings: [], guardrailKey: 'g', guardrailName: 'g',
  });
  openAiPerKey();
});
afterEach(() => vi.unstubAllGlobals());

import { normalizeInferenceError } from '@/lib/services/models/openaiErrors';
import { OpenAiStreamFramer } from '@/lib/services/models/openaiAdapter';
import { finishWithToolCalls } from '@/lib/services/models/gatewayStream';
import { buildCacheVariantKey } from '@/lib/services/models/semanticCacheService';
import {
  anthropicRequestToOpenAi,
  isThinkingRequested,
  openAiResponseToAnthropic,
  openAiStreamToAnthropic,
} from '@/lib/services/models/anthropicWire';
import { requestReasoningEffortAccepted } from '@/lib/providers/unsupportedParams';

const tool = { name: 'lookup', description: 'd', parameters: { type: 'object' } };

describe('extended thinking and a tool loop', () => {
  const useClaude = (settings: object = {}) => {
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({ runtime: anthropic });
    useModel(model({ providerDriver: 'anthropic', modelId: 'claude-sonnet-4-5', settings: { maxTokens: 9000, ...settings } }));
  };
  const answer = () => stubUpstream(() => json({
    id: 'msg_2', model: 'claude', type: 'message', role: 'assistant',
    content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 2 },
  }));

  it('drops thinking for a /messages tool turn whose signed blocks the client could not send back', async () => {
    useClaude();
    const upstream = answer();
    const body = anthropicRequestToOpenAi({
      model: 'm', max_tokens: 9000, thinking: { type: 'enabled', budget_tokens: 4000 },
      tools: [{ name: 'lookup', description: 'd', input_schema: { type: 'object' } }],
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [
          { type: 'thinking', thinking: 'hm', signature: 'SIG' },
          { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 1 } },
        ] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'r' }] },
      ],
    } as never);
    await handleChatCompletion({ ...BASE, body: body as never });
    expect(upstream.calls[0].body.thinking).toBeUndefined();
    expect(JSON.stringify(upstream.calls[0].body.messages)).toContain('tool_use');
  });

  it('keeps thinking on the first turn of the loop, and on a Model Hub default there too', async () => {
    useClaude({ reasoning: { effort: 'low' } });
    const upstream = answer();
    await handleChatCompletion({ ...BASE, body: { messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function', function: tool }] } });
    expect(upstream.calls[0].body.thinking).toMatchObject({ type: 'enabled' });
  });

  it('drops a Model Hub reasoning default for a /chat/completions tool turn that carries no blocks', async () => {
    useClaude({ reasoning: { effort: 'low' } });
    const upstream = answer();
    await handleChatCompletion({
      ...BASE,
      body: {
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: 'toolu_1', content: 'r' },
        ],
      },
    });
    expect(upstream.calls[0].body.thinking).toBeUndefined();
  });

  it('keeps thinking when the loop replays the signed blocks (an agent)', async () => {
    useClaude({ reasoning: { effort: 'low' } });
    const upstream = answer();
    await executeModelCall({
      ...BASE,
      request: {
        messages: [
          { role: 'user', content: 'hello' },
          {
            role: 'assistant', content: '',
            toolCalls: [{ id: 'toolu_1', name: 'lookup', arguments: '{}' }],
            reasoning: { blocks: [{ type: 'thinking', text: 'let me check', signature: 'SIG-123' }] },
          },
          { role: 'tool', content: 'result', toolCallId: 'toolu_1' },
        ],
      },
    });
    expect(upstream.calls[0].body.thinking).toMatchObject({ type: 'enabled' });
    expect(upstream.calls[0].body.messages[1].content[0]).toMatchObject({ type: 'thinking', signature: 'SIG-123' });
  });
});

describe('a request-sourced reasoning effort', () => {
  const ask = (modelId: string, extra: object = {}, settings: object = {}) => {
    useModel(model({ modelId, settings }));
    const upstream = stubUpstream(() => json(completion()));
    return handleChatCompletion({ ...BASE, body: { messages: [{ role: 'user', content: 'x' }], ...extra } }).then(() => upstream.calls[0].body);
  };

  it('is not sent to a model that does not reason', async () => {
    expect((await ask('gpt-4o', { reasoning_effort: 'low' })).reasoning_effort).toBeUndefined();
  });

  it('is sent to the models that take it', async () => {
    expect((await ask('o3', { reasoning_effort: 'low' })).reasoning_effort).toBe('low');
    expect((await ask('gpt-5.2', { reasoning_effort: 'high' })).reasoning_effort).toBe('high');
  });

  it('never sends none to a model that does not accept it, so /messages thinking:disabled is harmless there', async () => {
    const translated = anthropicRequestToOpenAi({
      model: 'm', max_tokens: 100, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: 'x' }],
    } as never);
    expect((await ask('gpt-4o', translated as object)).reasoning_effort).toBeUndefined();
    expect((await ask('o3', { reasoning_effort: 'none' })).reasoning_effort).toBeUndefined();
    expect((await ask('gpt-5.2', { reasoning_effort: 'none' })).reasoning_effort).toBe('none');
  });

  it('never gates the operator\'s own Model Hub pin', async () => {
    expect((await ask('gpt-4o', {}, { reasoning: { effort: 'low' } })).reasoning_effort).toBe('low');
  });

  it('leaves providers with their own reasoning envelope alone', () => {
    expect(requestReasoningEffortAccepted('anthropic', 'claude-sonnet-4-5', 'low')).toBe(true);
    expect(requestReasoningEffortAccepted('bedrock', 'x', 'none')).toBe(true);
    expect(requestReasoningEffortAccepted('openai', 'global.openai.gpt-oss-120b', 'low')).toBe(true);
  });
});

describe('the semantic cache', () => {
  const enableCache = () => {
    useModel(model({ semanticCache: { indexKey: 'i', threshold: 0.9 } }));
    (isSemanticCacheEnabled as ReturnType<typeof vi.fn>).mockReturnValue(true);
    stubUpstream(() => json(completion()));
  };

  it('answers a plain question through the cache', async () => {
    enableCache();
    await executeModelCall({ ...BASE, request: ASK });
    expect(lookupCache).toHaveBeenCalledTimes(1);
    expect(storeInCache).toHaveBeenCalledTimes(1);
  });

  it('is bypassed when the call offers tools, replays a tool turn or comes from an agent', async () => {
    enableCache();
    await executeModelCall({ ...BASE, request: { ...ASK, tools: [tool] } });
    await executeModelCall({
      ...BASE,
      request: { messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'lookup', arguments: '{}' }] },
        { role: 'tool', content: 'r', toolCallId: 'c' },
      ] },
    });
    await executeModelCall({ ...BASE, request: ASK, context: { route: 'agent.chat' } });
    await handleChatCompletion({ ...BASE, body: { messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'function', function: tool }] } });
    expect(lookupCache).not.toHaveBeenCalled();
    expect(storeInCache).not.toHaveBeenCalled();
  });

  it('keys an entry on whether reasoning is shown: it is stored as rendered', async () => {
    enableCache();
    await executeModelCall({ ...BASE, request: ASK });
    useModel(model({ semanticCache: { indexKey: 'i', threshold: 0.9 }, settings: { returnReasoning: false } }));
    await executeModelCall({ ...BASE, request: ASK });
    await handleChatCompletion({ ...BASE, body: { messages: [{ role: 'user', content: 'x' }], include_reasoning: false } });
    const keyed = (buildCacheVariantKey as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].__returnReasoning);
    expect(keyed).toEqual([true, false, false]);
  });
});

describe('the error message a client sees', () => {
  const providerError = (status: number, body: unknown) => Object.assign(
    new Error(`OpenAI API error ${status}: ${JSON.stringify(body)}`),
    { statusCode: status, responseBody: JSON.stringify(body) },
  );

  it('is the upstream\'s own sentence, not the wrapper and its raw JSON', () => {
    const out = normalizeInferenceError(providerError(400, { error: { message: "Unsupported parameter: 'x'", type: 'invalid_request_error', param: 'x' } }));
    expect(out.status).toBe(400);
    expect(out.error.message).toBe("Unsupported parameter: 'x'");
    expect(out.error.param).toBe('x');
  });

  it('reads a top-level message too, and classifies on the clean text', () => {
    const out = normalizeInferenceError(providerError(429, { message: 'Rate limit reached for gpt-4o' }));
    expect(out.status).toBe(429);
    expect(out.error.message).toBe('Rate limit reached for gpt-4o');
  });

  it('falls back to the error\'s own message when the body does not parse', () => {
    const out = normalizeInferenceError(Object.assign(new Error('Anthropic API error 500: upstream exploded'), { statusCode: 500, responseBody: 'upstream exploded' }));
    expect(out.error.message).toBe('Anthropic API error 500: upstream exploded');
  });
});

describe('thinking blocks on the Messages edge', () => {
  const withReasoning = completion({ content: 'answer', reasoning: 'because' });

  it('appear only when the request enabled thinking', () => {
    expect(isThinkingRequested({ thinking: { type: 'enabled' } })).toBe(true);
    expect(isThinkingRequested({})).toBe(false);
    expect(isThinkingRequested({ thinking: { type: 'disabled' } })).toBe(false);
    const shown = openAiResponseToAnthropic(withReasoning as never, 'm', { emitThinking: true }) as any;
    const hidden = openAiResponseToAnthropic(withReasoning as never, 'm', { emitThinking: false }) as any;
    expect(shown.content.map((b: any) => b.type)).toEqual(['thinking', 'text']);
    expect(hidden.content.map((b: any) => b.type)).toEqual(['text']);
  });

  it('are left out of a stream the same way', async () => {
    useModel(model());
    const run = async (emitThinking: boolean) => {
      stubUpstream(() => sse([chunk.reasoning('hmm'), chunk.text('hi'), chunk.finish('stop')]));
      const result = await handleChatCompletion({ ...BASE, body: { messages: [{ role: 'user', content: 'x' }] }, stream: true });
      const text = await new Response(openAiStreamToAnthropic(result.stream!, 'm', { emitThinking })).text();
      return text.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)));
    };
    expect((await run(true)).some((e) => e.content_block?.type === 'thinking')).toBe(true);
    const quiet = await run(false);
    expect(quiet.some((e) => e.content_block?.type === 'thinking' || e.delta?.type === 'thinking_delta')).toBe(false);
    expect(quiet.some((e) => e.delta?.text === 'hi')).toBe(true);
  });
});

describe('finish_reason of a turn that ended in tool calls', () => {
  it('says tool_calls for a provider whose own STOP means both, and leaves the rest as they are', () => {
    expect(finishWithToolCalls('vertex', 'stop', true)).toBe('tool_calls');
    expect(finishWithToolCalls('bedrock', 'stop', true)).toBe('tool_calls');
    expect(finishWithToolCalls('vertex', 'stop', false)).toBe('stop');
    expect(finishWithToolCalls('vertex', 'length', true)).toBe('length');
    expect(finishWithToolCalls('vertex', 'content_filter', true)).toBe('content_filter');
    // An OpenAI-schema upstream is passed through exactly as it said.
    expect(finishWithToolCalls('openai', 'stop', true)).toBe('stop');
  });
});

describe('streamed tool-call names', () => {
  it('reaches the client when the upstream sends the id and the name in separate deltas', () => {
    const framer = new OpenAiStreamFramer({ model: 'm', completionId: 'c', created: 1 } as never);
    expect(framer.toolCalls([{ index: 0, id: 'call_1' }])).toEqual([
      { index: 0, id: 'call_1', type: 'function', function: { name: '', arguments: '' } },
    ]);
    expect(framer.toolCalls([{ index: 0, name: 'lookup', arguments: '{"q":' }])).toEqual([
      { index: 0, function: { name: 'lookup', arguments: '{"q":' } },
    ]);
    // Said once: the SDK repeats the name on every fragment.
    expect(framer.toolCalls([{ index: 0, name: 'lookup', arguments: '1}' }])).toEqual([
      { index: 0, function: { arguments: '1}' } },
    ]);
  });
});

describe('file parts', () => {
  const content = [{ type: 'text', text: 'read it' }, { type: 'file', file: { file_id: 'file-abc' } }];

  it('sends an uploaded-file reference to an OpenAI-schema upstream as the caller wrote it', async () => {
    useModel(model());
    const upstream = stubUpstream(() => json(completion()));
    await handleChatCompletion({ ...BASE, body: { messages: [{ role: 'user', content }] } });
    expect(upstream.calls[0].body.messages[0].content).toEqual(content);
  });

  it('does not break a provider that cannot read it', async () => {
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({ runtime: anthropic });
    useModel(model({ providerDriver: 'anthropic', modelId: 'claude-sonnet-4-5' }));
    const upstream = stubUpstream(() => json({
      id: 'm', model: 'c', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
    }));
    await handleChatCompletion({ ...BASE, body: { messages: [{ role: 'user', content }] } });
    expect(JSON.stringify(upstream.calls[0].body.messages)).not.toContain('file-abc');
  });
});

describe('the stream gate keeps what only a native consumer needs', () => {
  it('puts a tool call\'s thoughtSignature and the provider fields back on the steps the gate releases', async () => {
    useModel(model({ outputGuardrailKey: 'gr' }));
    const gate = {
      push: vi.fn(async (frame: unknown) => ({ emit: [frame], blocked: false })),
      end: vi.fn(async () => ({ emit: [], blocked: false })),
    };
    (createStreamGate as ReturnType<typeof vi.fn>).mockImplementation(() => gate);
    const real = await openAiRuntime({});
    const runtime = {
      ...real,
      createNativeChatClient: async (input: never) => {
        const client = await (real.createNativeChatClient as (i: never) => Promise<any>)(input);
        return {
          ...client,
          async *stream() {
            yield {
              id: 'c1', model: 'gemini',
              delta: { toolCalls: [{ index: 0, id: 'call_1', name: 'lookup', arguments: '{"q":1}', thoughtSignature: 'TS-1' }] },
              providerFields: { systemFingerprint: 'fp_1' },
            };
            yield {
              id: 'c1', model: 'gemini', delta: {}, finishReason: 'stop', rawFinishReason: 'STOP',
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        };
      },
    };
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({ runtime });

    const outcome = await executeModelCall({ ...BASE, request: ASK, stream: true });
    const events = await collect(outcome.stream!);
    const calls = events.flatMap((e) => (e.type === 'delta' ? e.toolCalls ?? [] : []));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ id: 'call_1', name: 'lookup', thoughtSignature: 'TS-1' });
    expect(events.some((e) => e.type === 'delta' && e.providerFields && Object.keys(e.providerFields).length > 0)).toBe(true);
    expect(events.at(-1)?.type).toBe('done');
  });
});
