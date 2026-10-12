// @vitest-environment jsdom
/**
 * The tracing inspector and a session's pictures: a message recorded in an agent
 * session names its pictures by reference (`session-file://<id>`). When the trace
 * is that session's they are drawn from the session's content route; when the route
 * refuses (or the file is gone) or the trace is not a session's, the named chip
 * stays. (createElement, not JSX: the suite only collects `.test.ts`.)
 */

import React, { createElement as h, act } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';

// The inspector pulls in the session pieces, which read the Next router and prefetch through it.
vi.mock('@/components/common/navigation/useNavigationFeedback', () => ({
  useNavigationFeedback: () => ({ push: () => undefined }),
  usePendingNavigationKey: () => null,
  useIntentPrefetch: () => ({ getIntentProps: () => ({}) }),
}));

import { I18nProvider } from '@/lib/i18n';
import { LlmRequestItemsView } from '@/components/common/llm/LlmRequestDetail';
import { messageImageViews } from '@/components/common/llm/messageImages';
import { parseTraceSession, traceSessionUrl, useTraceSessionFiles } from '@/components/common/llm/useTraceSessionFiles';
import { tracedMessageContent } from '@/components/common/llm/tracedMessageContent';
import type { TraceSessionFiles } from '@/components/common/llm/messageImages';

(globalThis as { React?: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  window.matchMedia = window.matchMedia || ((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => undefined, removeListener: () => undefined,
    addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false,
  }) as unknown as MediaQueryList);
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

const wrap = (node: React.ReactElement) => h(MantineProvider, null, h(I18nProvider, { locale: 'en', children: node }));
function mount(node: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(wrap(node)));
}
const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };

const SESSION: TraceSessionFiles = { agentId: 'agent-1', sessionId: 'conv-1' };
const SCAN_URL = '/api/agents/agent-1/sessions/conv-1/files/f-scan/content?variant=original&disposition=inline';
const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const parts = [
  { type: 'text', text: 'UI check: look at these files' },
  { type: 'image_url', image_url: { url: 'session-file://f-scan' }, fileId: 'f-scan', name: 'scan.png' },
  { type: 'image_url', image_url: { url: pixel } },
];
/** What the SDK's recorder stores for an older recording: each part as pretty JSON, joined by newlines. */
const flattened = parts.map((part) => JSON.stringify(part, null, 2)).join('\n');
const items = (content: unknown) => [{ itemType: 'message' as const, role: 'user', content }];
const thumbs = () => [...document.querySelectorAll('[data-testid="attachment-thumbnail"] img')] as HTMLImageElement[];
const text = () => document.body.textContent ?? '';

describe('messageImageViews: a session-file reference', () => {
  it('is a named reference chip when the trace is no session’s', () => {
    expect(messageImageViews(parts)[0]).toMatchObject({ fileId: 'f-scan', name: 'scan.png', reference: true });
    expect(messageImageViews(parts)[0].url).toBeUndefined();
    expect(messageImageViews(parts, { sessionFiles: null })[0]).toMatchObject({ reference: true });
  });

  it('is drawn from the session’s content route when the trace is the session’s', () => {
    const view = messageImageViews(parts, { sessionFiles: SESSION })[0];
    expect(view).toMatchObject({ fileId: 'f-scan', name: 'scan.png', url: SCAN_URL, fallbackToChip: true });
    expect(view.reference).toBeUndefined();
    expect(view.downloadUrl).toContain('/files/f-scan/content?variant=original&disposition=attachment');
  });

  it('builds the address from the ids it is given, encoded, never from the reference’s own text', () => {
    const view = messageImageViews([{ type: 'input_image', image_url: 'session-file://a b/../c' }], { sessionFiles: { agentId: 'a/1', sessionId: 's?2' } })[0];
    expect(view.url).toBe('/api/agents/a%2F1/sessions/s%3F2/files/a%20b%2F..%2Fc/content?variant=original&disposition=inline');
  });

  it('leaves an inline picture and an address on another site exactly as they were drawn', () => {
    const inline = messageImageViews(parts, { sessionFiles: SESSION })[1];
    expect(inline.url).toBe(pixel);
    expect(inline.fallbackToChip).toBeUndefined();
    const external = messageImageViews([{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }], { sessionFiles: SESSION })[0];
    expect(external).toMatchObject({ external: true });
    expect(external.fallbackToChip).toBeUndefined();
  });

  it('also draws a picture read back from a flattened (older) recording', () => {
    const content = tracedMessageContent({ content: flattened });
    expect(messageImageViews(content, { sessionFiles: SESSION })[0].url).toBe(SCAN_URL);
  });
});

describe('the inspector, mounted', () => {
  it('draws the session’s picture as a thumbnail of the content route', () => {
    mount(h(LlmRequestItemsView, { items: items(parts), sessionFiles: SESSION }));
    const sources = thumbs().map((img) => img.getAttribute('src'));
    expect(sources).toContain(SCAN_URL);
    expect(sources).toContain(pixel);
    // Drawn once, as a picture: no chip for it, no raw reference.
    expect(text()).not.toContain('session image');
    expect(text()).not.toContain('session-file://');
  });

  it('shows the named chip in its place when the route refuses or the file is gone', () => {
    mount(h(LlmRequestItemsView, { items: items(parts), sessionFiles: SESSION }));
    const scan = thumbs().find((img) => img.getAttribute('src') === SCAN_URL)!;
    act(() => { scan.dispatchEvent(new Event('error')); });
    expect(thumbs().map((img) => img.getAttribute('src'))).toEqual([pixel]);
    expect(text()).toContain('scan.png · session image');
    // The picture that did load stays a thumbnail.
    expect(document.querySelectorAll('[data-testid="attachment-thumbnail"]')).toHaveLength(1);
  });

  it('keeps the named chip, and loads nothing, when the trace is no session’s', () => {
    mount(h(LlmRequestItemsView, { items: items(parts) }));
    expect(thumbs().map((img) => img.getAttribute('src'))).toEqual([pixel]);
    expect(text()).toContain('scan.png · session image');
    expect(document.querySelector(`img[src="${SCAN_URL}"]`)).toBeNull();
  });
});

describe('useTraceSessionFiles', () => {
  let answers: Record<string, { status: number; body: unknown } | 'throw'>;
  let requested: string[];
  beforeEach(() => {
    answers = {};
    requested = [];
    (globalThis as { fetch?: unknown }).fetch = async (input: string) => {
      const url = String(input);
      requested.push(url);
      const answer = answers[url];
      if (answer === 'throw') throw new Error('offline');
      const { status, body } = answer ?? { status: 404, body: {} };
      return { ok: status < 400, status, json: async () => body };
    };
  });

  function Probe({ threadId }: { threadId?: string | null }) {
    const session = useTraceSessionFiles(threadId);
    return h('output', { 'data-testid': 'probe' }, session ? `${session.agentId}/${session.sessionId}` : 'none');
  }
  const probe = () => document.querySelector('[data-testid="probe"]')!.textContent;
  const rerender = (threadId?: string | null) => act(() => root!.render(wrap(h(Probe, { threadId }))));

  it('asks which session the thread is, and returns it', async () => {
    answers[traceSessionUrl('conv-1')] = { status: 200, body: { agentId: 'agent-1', sessionId: 'conv-1' } };
    mount(h(Probe, { threadId: 'conv-1' }));
    expect(probe()).toBe('none');
    await flush();
    expect(probe()).toBe('agent-1/conv-1');
    expect(requested).toEqual(['/api/tracing/threads/conv-1/session']);
  });

  it('is none for a thread that is no session, for a failing lookup and for no thread at all', async () => {
    mount(h(Probe, { threadId: 'api-thread' }));
    await flush();
    expect(probe()).toBe('none');
    answers[traceSessionUrl('broken')] = 'throw';
    rerender('broken');
    await flush();
    expect(probe()).toBe('none');
    requested.length = 0;
    rerender(undefined);
    await flush();
    expect(probe()).toBe('none');
    expect(requested).toEqual([]);
  });

  it('never carries one thread’s session over to the next thread', async () => {
    answers[traceSessionUrl('conv-1')] = { status: 200, body: { agentId: 'agent-1', sessionId: 'conv-1' } };
    mount(h(Probe, { threadId: 'conv-1' }));
    await flush();
    expect(probe()).toBe('agent-1/conv-1');
    rerender('conv-2');
    expect(probe()).toBe('none');
    await flush();
    expect(probe()).toBe('none');
  });

  it('reads only a body with both ids', () => {
    expect(parseTraceSession({ agentId: 'a', sessionId: 's' })).toEqual({ agentId: 'a', sessionId: 's' });
    expect(parseTraceSession({ agentId: 'a' })).toBeNull();
    expect(parseTraceSession({ agentId: '', sessionId: 's' })).toBeNull();
    expect(parseTraceSession(null)).toBeNull();
    expect(parseTraceSession('x')).toBeNull();
  });
});
