/**
 * The Compare versions stream consumer: one side's stateless `/chat/stream` turn,
 * fed by a mocked SSE body. Answer text and reasoning arrive live as separate
 * events, `result` completes the turn, and a failure or a Stop stays on its side.
 */
import { describe, expect, it, vi } from 'vitest';
import { runCompareSide, type CompareLive } from '@/components/agents/studio/compareVersionsStream';

const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** An SSE response that delivers each piece as its own chunk (so the consumer sees them one at a time). */
function sse(pieces: string[], status = 200): Response {
    const encoder = new TextEncoder();
    return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
            for (const piece of pieces) controller.enqueue(encoder.encode(piece));
            controller.close();
        },
    }), { status, headers: { 'Content-Type': 'text/event-stream' } });
}

const base = { agentId: 'agent-1', message: 'hello', history: [], onLive: () => {} };

describe('runCompareSide', () => {
    it('streams answer and reasoning into onLive, then returns the completed turn', async () => {
        const seen: CompareLive[] = [];
        const fetchImpl = vi.fn(async () => sse([
            frame('reasoning', { text: 'Weighing ' }),
            frame('reasoning', { text: 'the options. ' }),
            frame('text', { text: 'Hel' }),
            frame('text', { text: 'lo' }),
            frame('result', {
                content: 'Hello', reasoning: 'Weighing the options. ', latencyMs: 1200,
                usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.002 },
                steps: [{ name: 'search', status: 'success' }],
            }),
        ]));
        const turn = await runCompareSide({ ...base, onLive: (live) => seen.push(live), fetchImpl: fetchImpl as never });

        expect(seen.map((live) => live.reasoning)).toEqual(['Weighing ', 'Weighing the options. ', 'Weighing the options. ', 'Weighing the options. ']);
        expect(seen.map((live) => live.content)).toEqual(['', '', 'Hel', 'Hello']);
        expect(turn).toMatchObject({
            role: 'assistant', content: 'Hello', reasoning: 'Weighing the options. ', latencyMs: 1200,
            inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.002,
        });
        expect(turn.steps).toHaveLength(1);
    });

    it('keeps the streamed reasoning when the result carries none, and omits it when there was none', async () => {
        const withStream = await runCompareSide({
            ...base,
            fetchImpl: (async () => sse([frame('reasoning', { text: 'thinking' }), frame('result', { content: 'ok' })])) as never,
        });
        expect(withStream.reasoning).toBe('thinking');
        const without = await runCompareSide({ ...base, fetchImpl: (async () => sse([frame('result', { content: 'ok' })])) as never });
        expect(without.reasoning).toBeUndefined();
    });

    it('posts a stateless, reasoning-visible turn pinned to the version, with history minus errors', async () => {
        const fetchImpl = vi.fn(async (..._args: unknown[]) => sse([frame('result', { content: 'ok' })]));
        await runCompareSide({
            ...base,
            version: 3,
            history: [
                { role: 'user', content: 'a' },
                { role: 'error', content: 'boom' },
                { role: 'assistant', content: 'b', reasoning: 'hidden from history' },
            ],
            fetchImpl: fetchImpl as never,
        });
        const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('/api/agents/agent-1/chat/stream');
        const body = JSON.parse(String(init.body));
        expect(body).toEqual({
            message: 'hello',
            history: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }],
            showReasoning: true,
            version: 3,
        });
        expect(body.conversationId).toBeUndefined();
    });

    it('runs the draft when no version is given', async () => {
        const fetchImpl = vi.fn(async (..._args: unknown[]) => sse([frame('result', { content: 'ok' })]));
        await runCompareSide({ ...base, fetchImpl: fetchImpl as never });
        expect(JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body)).version).toBeUndefined();
    });

    it('turns an error event into an error turn on that side only', async () => {
        const turn = await runCompareSide({
            ...base,
            fetchImpl: (async () => sse([frame('text', { text: 'par' }), frame('error', { error: 'Provider rate limited', type: 'rate_limit_error' })])) as never,
        });
        expect(turn).toEqual({ role: 'error', content: 'Provider rate limited' });
    });

    it('reports a refused request with the server message', async () => {
        const turn = await runCompareSide({
            ...base,
            fetchImpl: (async () => new Response(JSON.stringify({ error: 'Version 9 not found' }), { status: 404 })) as never,
        });
        expect(turn).toEqual({ role: 'error', content: 'Version 9 not found' });
        const bare = await runCompareSide({ ...base, fetchImpl: (async () => new Response('x', { status: 502 })) as never });
        expect(bare.content).toBe('HTTP 502');
    });

    it('says so when the stream ends with neither an answer nor an error', async () => {
        const turn = await runCompareSide({ ...base, noAnswerMessage: 'No answer', fetchImpl: (async () => sse([])) as never });
        expect(turn).toEqual({ role: 'error', content: 'No answer' });
    });

    it('Stop keeps what had streamed, marked stopped, without usage', async () => {
        const controller = new AbortController();
        const encoder = new TextEncoder();
        const fetchImpl = async (_url: unknown, init: RequestInit) => new Response(new ReadableStream<Uint8Array>({
            start(c) {
                c.enqueue(encoder.encode(frame('reasoning', { text: 'so far' })));
                c.enqueue(encoder.encode(frame('text', { text: 'Partial' })));
                init.signal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')));
            },
        }));
        const turn = await runCompareSide({
            ...base,
            signal: controller.signal,
            onLive: (live) => { if (live.content) controller.abort(); },
            fetchImpl: fetchImpl as never,
        });
        expect(turn).toMatchObject({ role: 'assistant', content: 'Partial', reasoning: 'so far', stopped: true });
        expect(turn.totalTokens).toBeUndefined();
    });

    it('a Stop before the response arrives is an empty stopped answer, not an error', async () => {
        const controller = new AbortController();
        controller.abort();
        const turn = await runCompareSide({
            ...base,
            signal: controller.signal,
            fetchImpl: (async () => { throw new DOMException('aborted', 'AbortError'); }) as never,
        });
        expect(turn).toMatchObject({ role: 'assistant', content: '', stopped: true });
    });
});
