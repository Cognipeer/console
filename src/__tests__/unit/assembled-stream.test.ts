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

/**
 * A model whose upstream leaks the reasoning channel into `content` (Bedrock's
 * `/openai/v1` with gpt-oss, MiniMax): the markup rides in the streamed deltas,
 * split wherever the network cut it. The streamed counterpart of the JSON
 * normaliser in `wireNormalization.ts`, which never sees an event stream.
 */
function streamOf(...chunks: AIMessageChunk[]) {
    const model = {
        bindTools() { return model; },
        async invoke() { throw new Error('this test must stream'); },
        async *stream() {
            for (const chunk of chunks) yield chunk;
        },
    };
    return model;
}

const delta = (content: string) => new AIMessageChunk({ content });

async function collect(model: { stream: (...args: unknown[]) => AsyncIterable<unknown> }) {
    const out: Array<Record<string, unknown>> = [];
    for await (const chunk of model.stream([{ role: 'user', content: 'hi' }])) out.push(chunk as Record<string, unknown>);
    return out;
}

/** The text a consumer reads off the live stream: every chunk's string content, in order. */
const liveText = (chunks: Array<Record<string, unknown>>) =>
    chunks.filter((c) => !c.role).map((c) => chunkText(c.content)).join('');

describe('a reasoning block the upstream leaked into the streamed content', () => {
    it('never reaches the live text, the assembled answer or the history; it rides on additional_kwargs', async () => {
        const out = await collect(withAssembledStream(streamOf(
            delta('<reasoning>The user wants'),
            delta(' a greeting</reasoning>'),
            delta('Hey there'),
        )));
        expect(liveText(out)).toBe('Hey there');
        const assembled = out.at(-1)!;
        expect(assembled).toMatchObject({
            role: 'assistant',
            content: 'Hey there',
            additional_kwargs: { reasoning_content: 'The user wants a greeting' },
        });
    });

    it('is recognised however the tags are split across deltas', async () => {
        const out = await collect(withAssembledStream(streamOf(
            delta('<reas'), delta('oning>thin'), delta('king</reas'), delta('oning>'), delta('\n\nHi'), delta(' there'),
        )));
        expect(liveText(out)).toBe('Hi there');
        expect(out.at(-1)).toMatchObject({ content: 'Hi there', additional_kwargs: { reasoning_content: 'thinking' } });
    });

    it('drops a reasoning-only delta out of the stream instead of forwarding its text', async () => {
        const out = await collect(withAssembledStream(streamOf(delta('<think>pondering</think>'), delta('Answer'))));
        const leaked = out.filter((c) => chunkText(c.content).includes('pondering'));
        expect(leaked).toEqual([]);
        expect(liveText(out)).toBe('Answer');
    });

    it('a call cut off inside its reasoning yields no answer and no leak', async () => {
        const out = await collect(withAssembledStream(streamOf(delta('<reasoning>half a thou'))));
        expect(liveText(out)).toBe('');
        expect(out.at(-1)).toMatchObject({ role: 'assistant', content: '', additional_kwargs: { reasoning_content: 'half a thou' } });
    });

    it('a call that ends while a tag might still open releases what it held', async () => {
        const out = await collect(withAssembledStream(streamOf(delta('<'))));
        expect(liveText(out)).toBe('<');
        expect(out.at(-1)).toMatchObject({ content: '<' });
    });

    it('keeps the tool calls and usage of the call, which ride on other chunks', async () => {
        const out = await collect(withAssembledStream(streamOf(
            delta('<reasoning>I should look it up</reasoning>'),
            new AIMessageChunk({
                content: '',
                tool_call_chunks: [{ name: 'web_search', args: '{"query":"x"}', id: 'call_1', index: 0, type: 'tool_call_chunk' }],
            }),
            new AIMessageChunk({ content: '', usage_metadata: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } }),
        )));
        const assembled = out.at(-1)!;
        expect(assembled.content).toBe('');
        expect(assembled.tool_calls).toMatchObject([{ name: 'web_search', args: { query: 'x' } }]);
        expect(assembled.usage_metadata).toMatchObject({ total_tokens: 14 });
        expect(assembled.additional_kwargs).toEqual({ reasoning_content: 'I should look it up' });
    });

    it('a stream without a leak is passed through as it is: the very same chunk objects', async () => {
        const chunks = [delta('Hel'), delta('lo'), new AIMessageChunk({ content: '', usage_metadata: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } })];
        const out = await collect(withAssembledStream(streamOf(...chunks)));
        expect(out.slice(0, 3)).toEqual(chunks);
        out.slice(0, 3).forEach((chunk, index) => expect(chunk).toBe(chunks[index]));
        expect(out.at(-1)).toMatchObject({ content: 'Hello' });
        expect(out.at(-1)).not.toHaveProperty('additional_kwargs');
    });

    it('text that merely starts with a tag-like character is not touched', async () => {
        const out = await collect(withAssembledStream(streamOf(delta('<'), delta('p>Use <think> sparingly</p>'))));
        expect(liveText(out)).toBe('<p>Use <think> sparingly</p>');
        expect(out.at(-1)).toMatchObject({ content: '<p>Use <think> sparingly</p>' });
    });

    it('a rebuilt chunk is a copy of the same kind: the original is not mutated', async () => {
        const original = delta('<reasoning>x</reasoning>y');
        const out = await collect(withAssembledStream(streamOf(original)));
        expect(original.content).toBe('<reasoning>x</reasoning>y');
        const rebuilt = out[0];
        expect(rebuilt).toBeInstanceOf(AIMessageChunk);
        expect(rebuilt).not.toBe(original);
        expect(rebuilt.content).toBe('y');
    });

    it('carries the reasoning the provider streams on its own, as a non-streamed message does', async () => {
        const out = await collect(withAssembledStream(streamOf(
            new AIMessageChunk({ content: '', additional_kwargs: { reasoning_content: 'Let me ' } }),
            new AIMessageChunk({ content: '', additional_kwargs: { reasoning_content: 'think.' } }),
            delta('Done.'),
        )));
        expect(liveText(out)).toBe('Done.');
        expect(out.at(-1)).toMatchObject({ content: 'Done.', additional_kwargs: { reasoning_content: 'Let me think.' } });
    });

    it('applies to the tool-bound model too, which is the one that streams', async () => {
        const out = await collect((withAssembledStream(streamOf(delta('<reasoning>r</reasoning>ok'))) as unknown as {
            bindTools: () => { stream: (...args: unknown[]) => AsyncIterable<unknown> };
        }).bindTools());
        expect(liveText(out)).toBe('ok');
    });

    it('is clean end to end through the real agent-sdk: streamed deltas, answer and recorded reasoning', async () => {
        const deltas: string[] = [];
        const agent = createSmartAgent({
            name: 'greeter',
            model: withAssembledStream(fromLangchainModel(streamOf(
                delta('<reasoning>The user wants'),
                delta(' a greeting</reasoning>'),
                delta('Hey there'),
            ))) as never,
        });
        const result = await agent.invoke(
            { messages: [{ role: 'user', content: 'hi' }] } as never,
            { stream: true, onStream: (chunk) => { if (!chunk.isFinal && chunk.text) deltas.push(chunk.text); } },
        );
        expect(deltas.join('')).toBe('Hey there');
        expect(result.content).toBe('Hey there');
        const last = (result.messages as Array<{ role?: string; additional_kwargs?: Record<string, unknown> }>).at(-1);
        expect(last?.additional_kwargs?.reasoning_content).toBe('The user wants a greeting');
    });
});

describe('assembled message reasoning', () => {
    it('joins the provider reasoning and the inline block, and omits the field when there is none', () => {
        expect(assembleStreamedMessage({ additional_kwargs: { reasoning_content: 'a' } }, 'x', 'b'))
            .toMatchObject({ additional_kwargs: { reasoning_content: 'ab' } });
        expect(assembleStreamedMessage({}, 'x')).not.toHaveProperty('additional_kwargs');
        expect(assembleStreamedMessage({ additional_kwargs: { reasoning_content: 5 } }, 'x'))
            .not.toHaveProperty('additional_kwargs');
    });
});
