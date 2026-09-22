/**
 * The streamed-turn regression, reproduced against the REAL agent-sdk.
 *
 * A live session asked an agent with web_search to research a company: over
 * `/chat` it ran 8 searches and used 4.7k tokens; over `/chat/stream` it made
 * one model call, ran nothing, answered with an empty string and recorded 0
 * tokens. agent-sdk 0.10.1 only keeps a streamed chunk as the response when
 * it carries a `role`, and LangChain chunks carry none — so the tool call and
 * the usage, which live on the chunks, were dropped.
 *
 * The fake model here streams exactly what a provider does: the tool call's
 * argument JSON split across chunks, and usage on the last chunk only.
 */
import { describe, expect, it } from 'vitest';
import { AIMessageChunk } from '@langchain/core/messages';
import { createSmartAgent, createTool, fromLangchainModel } from '@cognipeer/agent-sdk';
import { z } from 'zod';
import { assembleStreamedMessage, chunkText, withAssembledStream } from '@/lib/services/agents/assembledStream';

function fakeStreamingModel() {
    let call = 0;
    const model = {
        bindTools() { return model; },
        async invoke() { throw new Error('this test must stream'); },
        async *stream() {
            call += 1;
            if (call === 1) {
                // Turn 1: a tool call only, no text — the shape that came back empty.
                yield new AIMessageChunk({
                    content: '',
                    tool_call_chunks: [{ name: 'web_search', args: '{"que', id: 'call_1', index: 0, type: 'tool_call_chunk' }],
                });
                yield new AIMessageChunk({
                    content: '',
                    tool_call_chunks: [{ args: 'ry":"cognipeer"}', index: 0, type: 'tool_call_chunk' }],
                });
                yield new AIMessageChunk({
                    content: '',
                    usage_metadata: { input_tokens: 120, output_tokens: 18, total_tokens: 138 },
                });
                return;
            }
            // Turn 2: the answer, streamed.
            yield new AIMessageChunk({ content: 'Cognipeer is ' });
            yield new AIMessageChunk({ content: 'an AI company.' });
            yield new AIMessageChunk({
                content: '',
                usage_metadata: { input_tokens: 300, output_tokens: 9, total_tokens: 309 },
            });
        },
    };
    return model;
}

async function runStreamedTurn(wrap: boolean) {
    const searches: string[] = [];
    const deltas: string[] = [];
    const tool = createTool({
        name: 'web_search',
        description: 'search',
        schema: z.object({ query: z.string() }),
        func: async ({ query }: { query: string }) => {
            searches.push(query);
            return 'Cognipeer builds enterprise AI agents.';
        },
    });
    const adapted = fromLangchainModel(fakeStreamingModel());
    const agent = createSmartAgent({
        name: 'researcher',
        model: (wrap ? withAssembledStream(adapted) : adapted) as never,
        tools: [tool],
    });
    const result = await agent.invoke(
        { messages: [{ role: 'user', content: 'research cognipeer' }] } as never,
        { stream: true, onStream: (chunk) => { if (!chunk.isFinal && chunk.text) deltas.push(chunk.text); } },
    );
    return { result, searches, deltas };
}

describe('streamed turns keep their tool calls and usage', () => {
    it('reproduces the bug without the wrapper', async () => {
        // Kept deliberately: if a future SDK fixes this upstream, this test
        // fails and says the wrapper can go.
        const { result, searches } = await runStreamedTurn(false);
        expect(searches).toEqual([]);
        expect(result.content).toBe('');
    });

    it('runs the tool the model streamed, with its reassembled arguments', async () => {
        const { searches } = await runStreamedTurn(true);
        expect(searches).toEqual(['cognipeer']);
    });

    it('answers with the streamed text, still streamed as deltas', async () => {
        const { result, deltas } = await runStreamedTurn(true);
        expect(result.content).toBe('Cognipeer is an AI company.');
        // The assembled message must not be re-emitted as one more delta.
        expect(deltas.join('')).toBe('Cognipeer is an AI company.');
    });

    it('records the usage the provider put on the last chunk', async () => {
        const { result } = await runStreamedTurn(true);
        const totals = (result.metadata?.usage as { totals?: Record<string, { input: number; output: number }> })?.totals;
        const sum = Object.values(totals ?? {}).reduce(
            (acc, t) => ({ input: acc.input + t.input, output: acc.output + t.output }),
            { input: 0, output: 0 },
        );
        expect(sum).toEqual({ input: 420, output: 27 });
    });
});

describe('assembled message', () => {
    it('reads text from string and part-array content', () => {
        expect(chunkText('a')).toBe('a');
        expect(chunkText([{ type: 'text', text: 'b' }, 'c'])).toBe('bc');
        expect(chunkText(undefined)).toBe('');
    });

    it('omits empty tool_calls and falls back to response_metadata usage', () => {
        const message = assembleStreamedMessage(
            { tool_calls: [], response_metadata: { token_usage: { prompt_tokens: 5 } } },
            'hi',
        );
        expect(message).toEqual({
            role: 'assistant',
            content: 'hi',
            usage: { prompt_tokens: 5 },
            response_metadata: { token_usage: { prompt_tokens: 5 } },
        });
    });
});

