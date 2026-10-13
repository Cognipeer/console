/**
 * Model Hub showed no statistics for an agent's model: agents call the
 * provider through a native model built straight from the provider record, so
 * their calls never reached `logModelUsage`, which only the gateway called.
 * The tap records one usage row per model call. These tests pin that it
 * does so for invoke, stream, errors and tool-bound models alike.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/models/usageLogger', () => ({
    logModelUsage: vi.fn().mockResolvedValue(undefined),
}));

import { logModelUsage } from '@/lib/services/models/usageLogger';
import { extractTokenUsage, withModelUsageLogging } from '@/lib/services/agents/modelUsageTap';

const MODEL = { key: 'gpt-5.6-luna', tenantId: 't1', projectId: 'p1' } as never;
const CTX = { tenantDbName: 'tenant_x', model: MODEL, route: 'agent.chat', agentKey: 'field-ops' };
const logged = () => vi.mocked(logModelUsage).mock.calls.map((c) => c[2]);

beforeEach(() => vi.mocked(logModelUsage).mockClear());

describe('model usage tap', () => {
    it('records a non-streamed call with its tokens', async () => {
        const model = withModelUsageLogging({
            invoke: async () => ({
                role: 'assistant',
                content: 'ok',
                usage_metadata: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
            }),
        }, CTX);
        await model.invoke();
        expect(logged()).toHaveLength(1);
        expect(logged()[0]).toMatchObject({
            route: 'agent.chat',
            status: 'success',
            usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        });
        expect(vi.mocked(logModelUsage).mock.calls[0][1]).toBe(MODEL);
    });

    it('records a streamed call from the usage on the assembled message a native stream ends with', async () => {
        const model = withModelUsageLogging({
            async *stream() {
                yield 'hel';
                yield { type: 'reasoning', reasoning_content: 'thinking' };
                yield 'lo';
                yield {
                    role: 'assistant',
                    content: 'hello',
                    usage: {
                        prompt_tokens: 7, completion_tokens: 2, total_tokens: 9,
                        prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 0 },
                        completion_tokens_details: { reasoning_tokens: 1 },
                    },
                    response_metadata: { finish_reason: 'length', model_name: 'gpt-x' },
                };
            },
        }, CTX);
        const out: unknown[] = [];
        for await (const chunk of model.stream()) out.push(chunk);
        expect(out).toHaveLength(4);
        expect(logged()).toHaveLength(1);
        expect(logged()[0]).toMatchObject({
            status: 'success',
            usage: { inputTokens: 7, outputTokens: 2, totalTokens: 9, cachedInputTokens: 3, reasoningTokens: 1 },
            finishReason: 'length',
        });
    });

    it('a REAL native model: the tap reads cached + reasoning tokens and the finish reason off the SDK message (invoke and stream)', async () => {
        const { createProvider, fromNativeProvider } = await import('@cognipeer/agent-sdk');
        const usage = { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140, prompt_tokens_details: { cached_tokens: 60 }, completion_tokens_details: { reasoning_tokens: 12 } };
        const fakeFetch = (async (_url: unknown, init?: RequestInit) => {
            const streamed = JSON.parse(String(init?.body)).stream === true;
            if (!streamed) {
                return new Response(JSON.stringify({ id: 'a', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            const frames = [
                { id: 'a', model: 'm', choices: [{ index: 0, delta: { content: 'ok' } }] },
                { id: 'a', model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'length' }] },
                { id: 'a', model: 'm', choices: [], usage },
            ];
            return new Response(`${frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('')}data: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
        }) as unknown as typeof fetch;
        const native = fromNativeProvider(createProvider({ provider: 'openai-compatible', apiKey: 'k', baseURL: 'https://x.example/v1', fetch: fakeFetch }), { model: 'm' });
        const model = withModelUsageLogging(native, CTX);

        await model.invoke([{ role: 'user', content: 'hi' }]);
        for await (const part of model.stream!([{ role: 'user', content: 'hi' }])) void part;

        expect(logged()).toHaveLength(2);
        expect(logged()[0]).toMatchObject({ usage: { inputTokens: 100, outputTokens: 40, cachedInputTokens: 60, reasoningTokens: 12 }, finishReason: 'stop' });
        expect(logged()[1]).toMatchObject({ usage: { inputTokens: 100, outputTokens: 40, cachedInputTokens: 60, reasoningTokens: 12 }, finishReason: 'length' });
    });

    it('records a failed call as an error and still throws', async () => {
        const model = withModelUsageLogging({ invoke: async () => { throw new Error('rate limited'); } }, CTX);
        await expect(model.invoke()).rejects.toThrow('rate limited');
        expect(logged()[0]).toMatchObject({ status: 'error', errorMessage: 'rate limited' });
    });

    it('keeps tapping after tools are bound — the bound model is the one that runs', async () => {
        const inner = {
            invoke: async () => ({ content: '', tool_calls: [{ name: 'web_search' }], usage_metadata: { input_tokens: 5, output_tokens: 1 } }),
            bindTools() { return inner; },
        };
        const bound = withModelUsageLogging(inner, CTX).bindTools();
        await bound.invoke();
        expect(logged()[0]).toMatchObject({ usage: { toolCalls: 1 }, providerResponse: { toolCalls: 1 } });
    });

    it('never fails the answer when the usage write fails', async () => {
        vi.mocked(logModelUsage).mockRejectedValueOnce(new Error('db down'));
        const model = withModelUsageLogging({ invoke: async () => ({ content: 'fine' }) }, CTX);
        await expect(model.invoke()).resolves.toMatchObject({ content: 'fine' });
    });
});

describe('extractTokenUsage', () => {
    it('reads the SDK usage shape (cached and reasoning inside the totals)', () => {
        expect(extractTokenUsage({
            usage: {
                prompt_tokens: 50, completion_tokens: 30, total_tokens: 80,
                prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 5 },
                completion_tokens_details: { reasoning_tokens: 12 },
            },
        })).toEqual({ inputTokens: 50, outputTokens: 30, totalTokens: 80, cachedInputTokens: 40, reasoningTokens: 12 });
    });

    it('falls back to the mirror in response_metadata.token_usage', () => {
        expect(extractTokenUsage({ response_metadata: { token_usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } } }))
            .toEqual({ inputTokens: 5, outputTokens: 1, totalTokens: 6 });
    });

    it('still reads a restored LangChain usage_metadata with cache and reasoning details', () => {
        expect(extractTokenUsage({
            usage_metadata: {
                input_tokens: 50, output_tokens: 30, total_tokens: 80,
                input_token_details: { cache_read: 40 }, output_token_details: { reasoning: 12 },
            },
        })).toEqual({ inputTokens: 50, outputTokens: 30, totalTokens: 80, cachedInputTokens: 40, reasoningTokens: 12 });
    });

    it('reads an OpenAI-shaped usage in response_metadata', () => {
        expect(extractTokenUsage({ response_metadata: { tokenUsage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 } } }))
            .toEqual({ inputTokens: 3, outputTokens: 4, totalTokens: 7 });
    });

    it('reports nothing when the call carried no usage', () => {
        expect(extractTokenUsage({ content: 'x' })).toBeUndefined();
        expect(extractTokenUsage(undefined)).toBeUndefined();
    });
});
