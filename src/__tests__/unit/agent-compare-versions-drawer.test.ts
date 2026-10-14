// @vitest-environment jsdom
/**
 * The Compare versions screen end to end in jsdom, with each side's `/chat/stream`
 * mocked as a stream the test feeds by hand: both sides start at once, reasoning and
 * answer text show up in their own pane while the stream is still open, a failure
 * stays on its side, Stop ends what is still running, and the two panes share one
 * structure (header, transcript, footer) however either side went.
 */
import { createElement } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { click, installDomStubs, mount, q, qa, setInput, settle, wait, type Mounted } from '../helpers/iamCenterUi';
import CompareVersionsDrawer from '@/components/agents/studio/CompareVersionsDrawer';

const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

interface Feed {
    url: string;
    body: Record<string, unknown>;
    signal?: AbortSignal | null;
    push: (event: string, data: unknown) => Promise<void>;
    end: () => Promise<void>;
}

/** Replaces `fetch` with one that opens a hand-fed SSE stream per call and records it. */
function installStreams(): Feed[] {
    const feeds: Feed[] = [];
    const encoder = new TextEncoder();
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({
            start(c) { controller = c; },
        });
        init.signal?.addEventListener('abort', () => { try { controller.error(new DOMException('aborted', 'AbortError')); } catch { /* closed */ } });
        feeds.push({
            url,
            body: JSON.parse(String(init.body)),
            signal: init.signal,
            push: async (event, data) => { controller.enqueue(encoder.encode(frame(event, data))); await wait(5); },
            end: async () => { controller.close(); await wait(5); },
        });
        return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }));
    return feeds;
}

let mounted: Mounted;
beforeAll(() => installDomStubs());
afterEach(async () => {
    await mounted?.unmount();
    vi.unstubAllGlobals();
});
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

async function open() {
    mounted = await mount(createElement(CompareVersionsDrawer, {
        opened: true, onClose: () => {}, agentId: 'agent-1', publishedVersion: 2, versions: [2, 1],
    }));
    await settle(50);
}

const pane = (side: 'left' | 'right') => q(`[data-testid="compare-pane-${side}"]`)!;
const send = async (message: string) => {
    await setInput(q<HTMLTextAreaElement>('textarea')!, message);
    await click(q('[data-testid="compare-send"]'));
    await wait(5);
};

describe('Compare versions layout', () => {
    it('renders both panes with a header, a scrolling transcript and a stats footer each, before anything is sent', async () => {
        await open();
        const panes = q('[data-testid="compare-panes"]')!;
        expect([...panes.children]).toEqual([pane('left'), pane('right')]);
        for (const side of ['left', 'right'] as const) {
            const children = [...pane(side).children];
            // header, transcript, footer - in that order, the footer being the last thing in the pane
            expect(children).toHaveLength(3);
            expect(children[1]).toBe(q(`[data-testid="compare-pane-${side}-transcript"]`));
            expect(children[2]).toBe(q(`[data-testid="compare-pane-${side}-footer"]`));
            expect(children[2]!.textContent).toMatch(/Latency/);
            expect(children[2]!.textContent).toMatch(/Tokens/);
        }
        expect(qa('[data-testid$="-footer"]')).toHaveLength(2);
    });

    it('keeps two footers when one side has answered and the other failed', async () => {
        const feeds = installStreams();
        await open();
        await send('hi');
        await feeds[0].push('result', { content: 'Done', latencyMs: 900, usage: { inputTokens: 3, outputTokens: 4 } });
        await feeds[0].end();
        await feeds[1].push('error', { error: 'Provider down' });
        await feeds[1].end();
        await settle(20);
        expect(qa('[data-testid$="-footer"]')).toHaveLength(2);
        expect(pane('left').textContent).toContain('Done');
        expect(pane('right').textContent).toContain('Provider down');
        // The failed side still has its footer, with dashes where it has nothing to report.
        expect(q('[data-testid="compare-pane-right-footer"]')!.textContent).toContain('—');
    });
});

describe('Compare versions streaming', () => {
    it('starts both sides at once, each pinned to its own version, statelessly', async () => {
        const feeds = installStreams();
        await open();
        await send('compare me');
        expect(feeds).toHaveLength(2);
        expect(feeds.map((feed) => feed.url)).toEqual(['/api/agents/agent-1/chat/stream', '/api/agents/agent-1/chat/stream']);
        expect(feeds[0].body).toMatchObject({ message: 'compare me', showReasoning: true });
        expect(feeds[0].body.version).toBeUndefined(); // left = draft
        expect(feeds[1].body).toMatchObject({ message: 'compare me', version: 2 });
        expect(feeds.every((feed) => feed.body.conversationId === undefined)).toBe(true);
    });

    it('draws reasoning and answer text in the pane while the stream is still open, independently per side', async () => {
        const feeds = installStreams();
        await open();
        await send('why?');

        await feeds[0].push('reasoning', { text: 'First I check the policy. ' });
        expect(pane('left').querySelector('[data-testid="compare-reasoning-text"]')!.textContent).toBe('First I check the policy. ');
        // The other side has streamed nothing yet.
        expect(pane('right').querySelector('[data-testid="compare-reasoning"]')).toBeNull();
        expect(q('[data-testid="compare-stop"]')).not.toBeNull();

        await feeds[0].push('reasoning', { text: 'Then the exceptions.' });
        await feeds[0].push('text', { text: 'Because ' });
        await feeds[0].push('text', { text: 'of the policy.' });
        await feeds[1].push('text', { text: 'Right side answer' });
        expect(pane('left').querySelector('[data-testid="compare-reasoning-text"]')!.textContent).toBe('First I check the policy. Then the exceptions.');
        expect(pane('left').textContent).toContain('Because of the policy.');
        expect(pane('right').textContent).toContain('Right side answer');
        expect(pane('right').textContent).not.toContain('Because of the policy.');
    });

    it('keeps the reasoning on the final message once the result arrives', async () => {
        const feeds = installStreams();
        await open();
        await send('why?');
        await feeds[0].push('reasoning', { text: 'Thinking it through.' });
        await feeds[0].push('result', { content: 'Final answer', reasoning: 'Thinking it through.', latencyMs: 1500, usage: { inputTokens: 1, outputTokens: 2 } });
        await feeds[0].end();
        await feeds[1].push('result', { content: 'Other answer' });
        await feeds[1].end();
        await settle(20);

        expect(q('[data-testid="compare-stop"]')).toBeNull();
        const reasoning = pane('left').querySelector('[data-testid="compare-reasoning"]')!;
        expect(reasoning.textContent).toContain('Thinking it through.');
        expect(pane('left').textContent).toContain('Final answer');
        // The reasoning block sits above the answer.
        const answer = [...pane('left').querySelectorAll('p, div, span')].find((node) => node.children.length === 0 && node.textContent === 'Final answer')!;
        expect(reasoning.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(pane('right').querySelector('[data-testid="compare-reasoning"]')).toBeNull();
    });

    it('Stop ends what is still running and keeps what had streamed', async () => {
        const feeds = installStreams();
        await open();
        await send('long one');
        await feeds[0].push('text', { text: 'Half an answ' });
        await click(q('[data-testid="compare-stop"]'));
        await settle(20);

        expect(feeds.every((feed) => feed.signal?.aborted)).toBe(true);
        expect(pane('left').textContent).toContain('Half an answ');
        expect(pane('left').textContent).toContain('Stopped');
        expect(q('[data-testid="compare-stop"]')).toBeNull();
        expect(q('[data-testid="compare-send"]')).not.toBeNull();
    });
});
