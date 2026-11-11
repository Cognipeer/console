import { createElement as h, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { I18nProvider } from '@/lib/i18n';
// The inspector pulls in the session pieces, which read the Next router and prefetch through it.
vi.mock('@/components/common/navigation/useNavigationFeedback', () => ({
    useNavigationFeedback: () => ({ push: () => undefined }),
    usePendingNavigationKey: () => null,
    useIntentPrefetch: () => ({ getIntentProps: () => ({}) }),
}));

import { LlmRequestItemsView } from '@/components/common/llm/LlmRequestDetail';
import LatestMessageBar from '@/components/agents/session/LatestMessageBar';
import { toItems } from '@/components/agents/studio/SessionDetailDrawer';
import {
    answerAnchorId,
    INSPECTOR_LATEST_ANCHOR_ID,
    latestMessageOf,
    LIVE_LATEST_ANCHOR_ID,
    previewText,
} from '@/components/agents/session/latestMessageUi';
import type { LiveSegment } from '@/components/agents/session/liveFlow';
import type { ChatMessage } from '@/components/agents/session/sessionTypes';

const render = (node: ReactNode, locale: 'en' | 'tr' = 'en') =>
    renderToStaticMarkup(h(MantineProvider, null, h(I18nProvider, { locale, children: node })));

const user = (content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ role: 'user', content, ...extra }) as ChatMessage;
const assistant = (content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ role: 'assistant', content, ...extra }) as ChatMessage;

describe('latestMessageOf', () => {
    it('is null for an empty session', () => {
        expect(latestMessageOf({ messages: [], liveSegments: [], liveActive: false })).toBeNull();
    });

    it("picks the newest answer and points at the answer's own anchor", () => {
        const view = latestMessageOf({
            messages: [user('hi'), assistant('first'), user('again'), assistant('  done  ', { timestamp: '2026-11-10T10:00:00Z' })],
            liveSegments: [],
            liveActive: false,
        });
        expect(view).toEqual({
            live: false,
            role: 'agent',
            text: 'done',
            timestamp: '2026-11-10T10:00:00Z',
            messageIndex: 3,
            anchorId: answerAnchorId(3),
        });
    });

    it("falls back to a turn's last narration when it has no answer text", () => {
        const view = latestMessageOf({
            messages: [user('go'), assistant('', {
                steps: [
                    { name: 'a', narration: 'Looking at the files' },
                    { name: 'b', narration: 'Now running the tests' },
                    { name: 'c' },
                ],
            } as Partial<ChatMessage>)],
            liveSegments: [],
            liveActive: false,
        });
        expect(view).toMatchObject({ role: 'agent', text: 'Now running the tests', messageIndex: 1 });
        expect(view?.anchorId).toBeUndefined();
    });

    it('skips a turn with no text at all', () => {
        const view = latestMessageOf({
            messages: [user('go'), assistant('earlier'), assistant('', { steps: [{ name: 'tool' }] } as Partial<ChatMessage>)],
            liveSegments: [],
            liveActive: false,
        });
        expect(view).toMatchObject({ text: 'earlier', messageIndex: 1 });
    });

    it('shows a user message and a failure as they are', () => {
        expect(latestMessageOf({ messages: [assistant('a'), user('my question')], liveSegments: [], liveActive: false }))
            .toMatchObject({ role: 'user', text: 'my question', messageIndex: 1 });
        expect(latestMessageOf({ messages: [user('q'), { role: 'error', content: 'Boom' } as ChatMessage], liveSegments: [], liveActive: false }))
            .toMatchObject({ role: 'error', text: 'Boom', messageIndex: 1 });
    });

    it("reads a reminder's own note, not the framed prompt", () => {
        const view = latestMessageOf({
            messages: [user('[framed reminder prompt]', { metadata: { origin: 'reminder', reminder: { runId: 'r1', message: 'Check the deploy' } } } as Partial<ChatMessage>)],
            liveSegments: [],
            liveActive: false,
        });
        expect(view).toMatchObject({ role: 'user', text: 'Check the deploy' });
    });

    it("prefers the running turn's newest text over the stored transcript", () => {
        const liveSegments: LiveSegment[] = [
            { kind: 'text', text: 'Starting' },
            { kind: 'tools', calls: [] },
            { kind: 'text', text: 'Halfway there' },
            { kind: 'tools', calls: [] },
        ];
        expect(latestMessageOf({ messages: [user('go'), assistant('old')], liveSegments, liveActive: true }))
            .toEqual({ live: true, role: 'agent', text: 'Halfway there', anchorId: LIVE_LATEST_ANCHOR_ID });
    });

    it('ignores live segments once the turn is no longer running', () => {
        expect(latestMessageOf({ messages: [assistant('stored')], liveSegments: [{ kind: 'text', text: 'stale' }], liveActive: false }))
            .toMatchObject({ live: false, text: 'stored' });
    });

    it('shows the followed user message until the running turn has written text', () => {
        expect(latestMessageOf({ messages: [assistant('old')], liveSegments: [{ kind: 'tools', calls: [] }], liveActive: true, followedUserText: 'do it' }))
            .toEqual({ live: true, role: 'user', text: 'do it' });
        expect(latestMessageOf({ messages: [assistant('old')], liveSegments: [], liveActive: true }))
            .toMatchObject({ live: false, text: 'old' });
    });
});

describe('previewText', () => {
    it('reads markdown as one plain line', () => {
        expect(previewText('# Title\n\n- **bold** item\n- [link](https://x.y) and `code`\n\n```ts\nconst a = 1;\n```'))
            .toBe('Title bold item link and code const a = 1;');
    });

    it('keeps identifiers with underscores', () => {
        expect(previewText('Called read_file on my_notes.md')).toBe('Called read_file on my_notes.md');
    });

    it('cuts long text with an ellipsis', () => {
        const out = previewText('word '.repeat(200), 50);
        expect(out.length).toBeLessThanOrEqual(50);
        expect(out.endsWith('…')).toBe(true);
    });
});

describe('the inspector anchors the newest message', () => {
    const messages = [user('q1'), assistant('a1'), user('q2'), assistant('a2')];

    it('puts the anchor on that one message item only', () => {
        const items = toItems(messages, undefined, { messageIndex: 3, anchorId: INSPECTOR_LATEST_ANCHOR_ID });
        const anchored = items.filter((item) => item.itemType === 'message' && item.anchorId);
        expect(anchored).toEqual([{ itemType: 'message', role: 'assistant', content: 'a2', anchorId: INSPECTOR_LATEST_ANCHOR_ID }]);
    });

    it('leaves the stream as it was without an anchor', () => {
        expect(toItems(messages).some((item) => item.itemType === 'message' && 'anchorId' in item)).toBe(false);
    });

    it('draws the anchor as an element id the bar can scroll to', () => {
        const html = render(h(LlmRequestItemsView, { items: toItems(messages, undefined, { messageIndex: 3, anchorId: INSPECTOR_LATEST_ANCHOR_ID }) }));
        expect(html).toContain(`id="${INSPECTOR_LATEST_ANCHOR_ID}"`);
        expect(html.match(/id="agent-inspector-latest"/g)).toHaveLength(1);
    });
});

describe('LatestMessageBar', () => {
    const noop = () => undefined;

    it("shows who wrote it and the first lines, folded", () => {
        const html = render(h(LatestMessageBar, {
            view: { live: false, role: 'agent', text: '## Done\n\nAll **3** releases shipped.', messageIndex: 3 },
            agentName: 'Release Manager',
            running: false,
            onJump: noop,
        }));
        expect(html).toContain('Latest message');
        expect(html).toContain('Release Manager');
        expect(html).toContain('Done All 3 releases shipped.');
        expect(html).toContain('aria-expanded="false"');
        expect(html).toContain('Go to');
    });

    it('falls back to a generic author and speaks Turkish', () => {
        const html = render(h(LatestMessageBar, { view: { live: true, role: 'agent', text: 'Çalışıyorum' }, running: true, framed: true, onJump: noop }), 'tr');
        expect(html).toContain('Son mesaj');
        expect(html).toContain('Ajan');
        expect(html).toContain('yazıyor…');
    });
});
