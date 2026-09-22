/**
 * Model Hub showed no statistics for an agent's model: agents call the
 * provider through a LangChain model built straight from the runtime, so
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
import { withAssembledStream } from '@/lib/services/agents/assembledStream';
import { AIMessageChunk } from '@langchain/core/messages';

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

    it('records a streamed call from the usage on its last chunk', async () => {
        const model = withModelUsageLogging(withAssembledStream({
            async *stream() {
                yield new AIMessageChunk({ content: 'hel' });
                yield new AIMessageChunk({ content: 'lo', usage_metadata: { input_tokens: 7, output_tokens: 2, total_tokens: 9 } });
            },
        }), CTX);
        const out: unknown[] = [];
        for await (const chunk of model.stream()) out.push(chunk);
        expect(out.length).toBeGreaterThan(0);
        expect(logged()).toHaveLength(1);
        expect(logged()[0]).toMatchObject({ status: 'success', usage: { inputTokens: 7, outputTokens: 2 } });
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
    it('reads LangChain usage_metadata with cache and reasoning details', () => {
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
