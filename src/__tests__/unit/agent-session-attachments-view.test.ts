/**
 * Uploaded files wherever a transcript is shown: the session inspector (the
 * drawer) passes a message's attachments through, the shared request inspector
 * draws them — image thumbnails, chips for other files, a muted chip for a file
 * that is gone — and a request in tracing shows the pictures in its content
 * parts. One attachment component serves the session page, the pending chips
 * and the Files tab too. (createElement, not JSX: the suite only collects
 * `.test.ts`.)
 */

import React, { createElement as h, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';

// The inspector pulls in the session pieces, which read the Next router and prefetch through it.
vi.mock('@/components/common/navigation/useNavigationFeedback', () => ({
  useNavigationFeedback: () => ({ push: () => undefined }),
  usePendingNavigationKey: () => null,
  useIntentPrefetch: () => ({ getIntentProps: () => ({}) }),
}));

import { I18nProvider } from '@/lib/i18n';
import { LlmRequestItemsView, type LlmRequestItem } from '@/components/common/llm/LlmRequestDetail';
import { messageImageViews, MAX_MESSAGE_IMAGES } from '@/components/common/llm/messageImages';
import MessageBlock from '@/components/common/ui/MessageBlock';
import { AttachmentChips, MessageAttachments } from '@/components/agents/session/SessionAttachments';
import SessionFilesPanel from '@/components/agents/session/SessionFilesPanel';
import { toItems } from '@/components/agents/studio/SessionDetailDrawer';
import {
  attachmentKind,
  isFileGone,
  sessionFileContentUrl,
  sessionFileLinks,
  toAttachmentViews,
  type AttachmentView,
  type SessionFileItem,
} from '@/components/agents/session/sessionFilesUi';
import type { ChatMessage } from '@/components/agents/session/sessionTypes';
import { en } from '@/lib/i18n/messages/en';
import { tr } from '@/lib/i18n/messages/tr';

(globalThis as { React?: typeof React }).React = React;

const render = (node: ReactNode, locale: 'en' | 'tr' = 'en') =>
  renderToStaticMarkup(h(MantineProvider, null, h(I18nProvider, { locale, children: node })));
const noop = () => undefined;

const photo = { fileId: 'f-photo', name: 'photo.png', mimeType: 'image/png', size: 2048 };
const report = { fileId: 'f-report', name: 'report.pdf', mimeType: 'application/pdf', size: 4096 };
const now = new Date('2026-10-11T12:00:00Z');
// Far in the future: some calls below read the real clock, so a near date turns these files expired once it passes.
const listed = (...ids: string[]): SessionFileItem[] => ids.map((id) => ({ id, name: id, mimeType: 'x/y', size: 1, expiresAt: '2099-01-01T00:00:00Z' }));

describe('the content route addresses', () => {
  it('builds /files/:fileId/content with the variant and disposition asked for', () => {
    expect(sessionFileContentUrl('ag1', 's 1', 'f/1')).toBe('/api/agents/ag1/sessions/s%201/files/f%2F1/content');
    expect(sessionFileContentUrl('ag1', 's1', 'f1', { variant: 'markdown', disposition: 'attachment' }))
      .toBe('/api/agents/ag1/sessions/s1/files/f1/content?variant=markdown&disposition=attachment');
    expect(sessionFileLinks('ag1', 's1', 'f1')).toEqual({
      url: '/api/agents/ag1/sessions/s1/files/f1/content?variant=original&disposition=inline',
      downloadUrl: '/api/agents/ag1/sessions/s1/files/f1/content?variant=original&disposition=attachment',
    });
  });

  it('reads a file’s kind from its type, and its name when the type says too little', () => {
    expect(attachmentKind({ mimeType: 'image/svg+xml' })).toBe('image');
    expect(attachmentKind({ mimeType: 'application/pdf' })).toBe('pdf');
    expect(attachmentKind({ mimeType: 'application/octet-stream', name: 'Report.PDF' })).toBe('pdf');
    expect(attachmentKind({ mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })).toBe('document');
    expect(attachmentKind({ mimeType: 'text/csv' })).toBe('spreadsheet');
    expect(attachmentKind({ mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' })).toBe('presentation');
    expect(attachmentKind({ mimeType: 'application/zip' })).toBe('archive');
    expect(attachmentKind({ mimeType: 'application/json' })).toBe('code');
    expect(attachmentKind({ mimeType: 'text/plain' })).toBe('text');
    expect(attachmentKind({ mimeType: 'application/octet-stream', name: 'blob' })).toBe('other');
  });
});

describe('which files are gone', () => {
  it('calls nothing expired until the session’s files have been listed', () => {
    expect(isFileGone('f1', null, now)).toBe(false);
    expect(isFileGone('f1', undefined, now)).toBe(false);
  });

  it('is gone when the server no longer lists it, or when its expiry has passed', () => {
    expect(isFileGone('f1', listed('f1'), now)).toBe(false);
    expect(isFileGone('f2', listed('f1'), now)).toBe(true);
    expect(isFileGone('f1', [{ id: 'f1', expiresAt: '2026-10-11T11:59:59Z' }], now)).toBe(true);
    expect(isFileGone('f1', [{ id: 'f1', expiresAt: null }], now)).toBe(false);
  });

  it('links the files that are there and marks the others expired, without a link', () => {
    const views = toAttachmentViews([photo, report], { agentId: 'ag1', sessionId: 's1', files: listed('f-photo'), now });
    expect(views[0]).toMatchObject({ fileId: 'f-photo', url: expect.stringContaining('/files/f-photo/content?variant=original&disposition=inline') });
    expect(views[0].downloadUrl).toContain('disposition=attachment');
    expect(views[0].expired).toBeUndefined();
    expect(views[1]).toMatchObject({ fileId: 'f-report', expired: true });
    expect(views[1].url).toBeUndefined();
    expect(views[1].downloadUrl).toBeUndefined();
  });

  it('marks none expired while the list is not there', () => {
    const views = toAttachmentViews([report], { agentId: 'ag1', sessionId: 's1', files: null });
    expect(views[0].expired).toBeUndefined();
    expect(views[0].url).toBeDefined();
    expect(toAttachmentViews(undefined, { agentId: 'a', sessionId: 's' })).toEqual([]);
  });
});

describe('the files on a message', () => {
  const linked = toAttachmentViews([photo, report], { agentId: 'ag1', sessionId: 's1', files: null });

  it('draws an image as a thumbnail that opens full size, and any other file as a chip that saves it', () => {
    const html = render(h(MessageAttachments, { attachments: linked }));
    expect(html).toContain('data-testid="attachment-thumbnails"');
    expect(html).toContain('<img');
    expect(html).toContain('src="/api/agents/ag1/sessions/s1/files/f-photo/content?variant=original&amp;disposition=inline"');
    expect(html).toContain('alt="photo.png"');
    expect(html).toContain('aria-label="Preview photo.png"');
    // The document: a type icon chip with its size, linking to the attachment copy.
    expect(html).toContain('report.pdf · 4.0 KB');
    expect(html).toContain('href="/api/agents/ag1/sessions/s1/files/f-report/content?variant=original&amp;disposition=attachment"');
    expect(html).toContain('download="report.pdf"');
    expect(html).not.toContain('src="/api/agents/ag1/sessions/s1/files/f-report');
  });

  it('lets a PDF or a text file also be opened in a tab; a spreadsheet only saved', () => {
    const views = toAttachmentViews([
      report,
      { fileId: 'f-notes', name: 'notes.txt', mimeType: 'text/plain', size: 10 },
      { fileId: 'f-sheet', name: 'sheet.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 10 },
    ], { agentId: 'ag1', sessionId: 's1', files: null });
    const html = render(h(MessageAttachments, { attachments: views }));
    expect((html.match(/aria-label="Open in a new tab"/g) ?? [])).toHaveLength(2);
    expect(html).toContain('href="/api/agents/ag1/sessions/s1/files/f-report/content?variant=original&amp;disposition=inline"');
    expect(html).toContain('target="_blank"');
    expect(html).not.toContain('f-sheet/content?variant=original&amp;disposition=inline');
  });

  it('draws a file that is gone as a muted “expired” chip with no link and no picture request', () => {
    const gone = toAttachmentViews([photo, report], { agentId: 'ag1', sessionId: 's1', files: [], now });
    const html = render(h(MessageAttachments, { attachments: gone }));
    expect(html).toContain('data-expired="true"');
    expect(html).toContain('photo.png · 2.0 KB · Expired');
    expect(html).toContain('report.pdf · 4.0 KB · Expired');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('href=');
    expect(render(h(MessageAttachments, { attachments: gone }), 'tr')).toContain('Süresi doldu');
  });

  it('shows a file with no address as a plain chip, and nothing when there are none', () => {
    const html = render(h(MessageAttachments, { attachments: [{ fileId: 'a', name: 'notes.txt', mimeType: 'text/plain', size: 2048 }] }));
    expect(html).toContain('notes.txt · 2.0 KB');
    expect(html).not.toContain('href=');
    expect(render(h(MessageAttachments, { attachments: undefined }))).not.toContain('message-attachments');
    expect(render(h(MessageAttachments, { attachments: [] }))).not.toContain('message-attachments');
  });

  it('leaves out the size when the file has none (a picture inside a request)', () => {
    const html = render(h(MessageAttachments, { attachments: [{ fileId: 'a', name: 'notes.txt', mimeType: 'text/plain' }] }));
    expect(html).toContain('notes.txt');
    expect(html).not.toContain('notes.txt ·');
  });

  it('says in Turkish how to preview and save', () => {
    const html = render(h(MessageAttachments, { attachments: linked }), 'tr');
    expect(html).toContain('aria-label="photo.png önizlemesi"');
  });
});

describe('the pictures inside a request’s content parts (tracing)', () => {
  const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

  it('finds a Chat Completions image_url, a Responses input_image and an Anthropic base64 source', () => {
    const views = messageImageViews([
      { type: 'text', text: 'look' },
      { type: 'image_url', image_url: { url: pixel } },
      { type: 'input_image', image_url: pixel },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
    ]);
    expect(views).toHaveLength(3);
    expect(views[0]).toMatchObject({ mimeType: 'image/png', url: pixel, name: 'Image 2' });
    expect(views[0].size).toBeGreaterThan(0);
    expect(views[2]).toMatchObject({ mimeType: 'image/jpeg', url: 'data:image/jpeg;base64,AAAA' });
  });

  it('keeps a session-file reference as a pointer, with the name it was given, and never as an address to load', () => {
    const [view] = messageImageViews([
      { type: 'image_url', image_url: { url: 'session-file://file_123' }, fileId: 'file_123', name: 'scan.png' },
    ]);
    expect(view).toEqual({ fileId: 'file_123', name: 'scan.png', mimeType: 'image/*', reference: true });
    expect(messageImageViews([{ type: 'image_url', image_url: { url: 'session-file://file_9' } }])[0]).toMatchObject({ fileId: 'file_9', name: 'file_9', reference: true });
  });

  it('keeps an address on another site as a link, not as a picture to fetch', () => {
    const [view] = messageImageViews([{ type: 'input_image', image_url: 'https://cdn.example.com/a/b/cat.png' }]);
    expect(view).toMatchObject({ external: true, url: 'https://cdn.example.com/a/b/cat.png', name: 'cdn.example.com/…/cat.png' });
    const html = render(h(MessageAttachments, { attachments: [view] }));
    expect(html).not.toContain('<img');
    expect(html).toContain('href="https://cdn.example.com/a/b/cat.png"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer noopener"');
  });

  it('ignores a plain string, text parts and anything it cannot show, and caps the number drawn', () => {
    expect(messageImageViews('hello')).toEqual([]);
    expect(messageImageViews([{ type: 'text', text: 'x' }, { type: 'image_url', image_url: { url: 'javascript:alert(1)' } }, { type: 'image_url', image_url: {} }, null, 3])).toEqual([]);
    const many = Array.from({ length: MAX_MESSAGE_IMAGES + 5 }, () => ({ type: 'image_url', image_url: { url: pixel } }));
    expect(messageImageViews(many)).toHaveLength(MAX_MESSAGE_IMAGES);
  });

  it('draws them under the message in the request inspector', () => {
    const items: LlmRequestItem[] = [{
      itemType: 'message', role: 'user', content: [{ type: 'text', text: 'what is this?' }, { type: 'image_url', image_url: { url: pixel } }],
    }];
    const html = render(h(LlmRequestItemsView, { items }));
    expect(html).toContain('what is this?');
    expect(html).toContain(`src="${pixel}"`);
    expect(html).toContain('aria-label="Preview Image 2"');
  });

  it('shows a plain-text message exactly as before', () => {
    const html = render(h(LlmRequestItemsView, { items: [{ itemType: 'message', role: 'user', content: 'hello there' }] }));
    expect(html).toContain('hello there');
    expect(html).not.toContain('message-attachments');
  });
});

describe('the request inspector draws the files a message carried', () => {
  const attachments: AttachmentView[] = [
    ...toAttachmentViews([photo], { agentId: 'ag1', sessionId: 's1', files: null }),
    ...toAttachmentViews([report], { agentId: 'ag1', sessionId: 's1', files: [], now }),
  ];

  it('puts thumbnails, chips and expired chips under the message', () => {
    const html = render(h(LlmRequestItemsView, { items: [{ itemType: 'message', role: 'user', content: 'see these', attachments }] }));
    expect(html).toContain('see these');
    expect(html).toContain('data-testid="attachment-thumbnails"');
    expect(html).toContain('/files/f-photo/content');
    expect(html).toContain('report.pdf · 4.0 KB · Expired');
  });

  it('still shows a message that is only files, under its role', () => {
    const html = render(h(LlmRequestItemsView, { items: [{ itemType: 'message', role: 'user', content: '', attachments }] }));
    expect(html).toContain('User');
    expect(html).toContain('/files/f-photo/content');
  });

  it('shows nothing for a message with neither text nor files', () => {
    expect(render(h(MessageBlock, { messageRole: 'user', content: '' }))).not.toContain('User');
    expect(render(h(LlmRequestItemsView, { items: [{ itemType: 'message', role: 'user', content: '', attachments: [] }] }))).not.toContain('User');
  });
});

describe('the session inspector hands a message’s attachments to the request inspector', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'read this', attachments: [photo, report], timestamp: '2026-10-11T10:00:00Z' },
    { role: 'assistant', content: 'done', steps: [{ id: 's1', name: 'read', args: {}, output: 'x' }] },
    { role: 'user', content: 'and no files here', timestamp: '2026-10-11T10:05:00Z' },
  ];

  it('puts the files on the user message of the turn, linked to the session’s content route', () => {
    const items = toItems(messages, { agentId: 'ag1', sessionId: 's1', files: null });
    const user = items.filter((item) => item.itemType === 'message' && item.role === 'user');
    expect(user).toHaveLength(2);
    const first = user[0] as Extract<LlmRequestItem, { itemType: 'message' }>;
    expect(first.attachments?.map((file) => file.fileId)).toEqual(['f-photo', 'f-report']);
    expect(first.attachments?.[0].url).toContain('/api/agents/ag1/sessions/s1/files/f-photo/content');
    expect((user[1] as Extract<LlmRequestItem, { itemType: 'message' }>).attachments).toBeUndefined();
    // The assistant's answer and the tool call are untouched.
    expect(items.some((item) => item.itemType === 'call')).toBe(true);
  });

  it('marks the files the server no longer lists as expired', () => {
    const items = toItems(messages, { agentId: 'ag1', sessionId: 's1', files: listed('f-photo') });
    const first = items.find((item) => item.itemType === 'message' && item.role === 'user') as Extract<LlmRequestItem, { itemType: 'message' }>;
    expect(first.attachments?.[0].expired).toBeUndefined();
    expect(first.attachments?.[1]).toMatchObject({ fileId: 'f-report', expired: true });
  });

  it('carries no attachments when it is not told which session it is reading (the old call shape)', () => {
    const items = toItems(messages);
    for (const item of items) if (item.itemType === 'message') expect(item.attachments).toBeUndefined();
  });

  it('renders the whole path: a session’s files appear in the inspector stream', () => {
    const html = render(h(LlmRequestItemsView, { items: toItems(messages, { agentId: 'ag1', sessionId: 's1', files: listed('f-photo') }) }));
    expect(html).toContain('read this');
    expect(html).toContain('/files/f-photo/content');
    expect(html).toContain('report.pdf · 4.0 KB · Expired');
  });
});

describe('the pending chips and the Files tab share the look', () => {
  it('shows an image waiting to be sent as a thumbnail when it has an address', () => {
    const html = render(h(AttachmentChips, {
      files: [{ fileId: 'f-photo', name: 'photo.png', mimeType: 'image/png', size: 2048 }, { fileId: 'f-report', name: 'report.pdf', mimeType: 'application/pdf', size: 1024 }],
      uploading: [],
      onRemove: noop,
      linksFor: (file) => sessionFileLinks('ag1', 's1', file.fileId),
    }));
    expect(html).toContain('src="/api/agents/ag1/sessions/s1/files/f-photo/content?variant=original&amp;disposition=inline"');
    expect(html.match(/<img/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Preview photo.png"');
  });

  it('keeps the plain chip (and the warning) for an image the model cannot take', () => {
    const html = render(h(AttachmentChips, {
      files: [{ fileId: 'f-photo', name: 'photo.png', mimeType: 'image/png', size: 2048 }],
      uploading: [],
      onRemove: noop,
      textOnlyModel: { name: 'gpt-6-luna', href: '/dashboard/models/m1/edit' },
      linksFor: (file) => sessionFileLinks('ag1', 's1', file.fileId),
    }));
    expect(html).toContain('data-testid="image-warning"');
    expect(html).not.toContain('<img');
  });

  const files: SessionFileItem[] = [
    { id: 'f1', name: 'report.pdf', mimeType: 'application/pdf', size: 2048, conversionStatus: 'succeeded', bucketKey: 'docs', path: 'x/report.pdf', expiresAt: '2026-10-23T12:00:00Z' },
    { id: 'f2', name: 'photo.png', mimeType: 'image/png', size: 4096, bucketKey: 'docs', path: 'x/photo.png', expiresAt: '2026-10-23T12:00:00Z' },
    { id: 'f3', name: 'old.pdf', mimeType: 'application/pdf', size: 10, conversionStatus: 'succeeded', bucketKey: 'docs', path: 'x/old.pdf', expiresAt: '2026-10-10T12:00:00Z' },
  ];
  const panel = (props: Partial<Parameters<typeof SessionFilesPanel>[0]>) =>
    render(h(SessionFilesPanel, { files, maxFiles: 10, onDelete: noop, onRetry: noop, now, ...props }));

  it('offers each file to open and save from the session’s content route, and a converted document as text too', () => {
    const html = panel({ agentId: 'ag1', sessionId: 's1' });
    expect(html).toContain('href="/api/agents/ag1/sessions/s1/files/f1/content?variant=original&amp;disposition=attachment"');
    expect(html).toContain('href="/api/agents/ag1/sessions/s1/files/f1/content?variant=markdown&amp;disposition=attachment"');
    expect(html).toContain('aria-label="Download as text"');
    // The image is a thumbnail, and an image has no text copy.
    expect(html).toContain('src="/api/agents/ag1/sessions/s1/files/f2/content?variant=original&amp;disposition=inline"');
    expect(html).not.toContain('/files/f2/content?variant=markdown');
  });

  it('offers nothing to open for a file past its expiry', () => {
    const html = panel({ agentId: 'ag1', sessionId: 's1' });
    expect(html).not.toContain('/files/f3/content');
  });

  it('stays as it was without the session’s ids', () => {
    const html = panel({});
    expect(html).not.toContain('/content');
    expect(html).not.toContain('<img');
    expect(html).toContain('Delete file');
  });
});

describe('strings', () => {
  const lookup = (language: typeof en | typeof tr, key: string) =>
    key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], language);

  it('every key the shared attachment components ask for exists in English and in Turkish', () => {
    const files = [
      'components/agents/session/SessionAttachments.tsx',
      'components/agents/session/SessionFilesPanel.tsx',
    ];
    const missing: string[] = [];
    let checked = 0;
    for (const file of files) {
      const source = readFileSync(join(__dirname, '../..', file), 'utf8');
      const spaces: Record<string, string> = {};
      for (const match of source.matchAll(/const\s+(\w+)\s*=\s*useTranslations\('([\w.]+)'\)/g)) spaces[match[1]] = match[2];
      for (const match of source.matchAll(/\b(\w+)\(\s*'([\w.]+)'/g)) {
        const namespace = spaces[match[1]];
        if (!namespace) continue;
        checked += 1;
        const key = `${namespace}.${match[2]}`;
        for (const [name, language] of [['en', en], ['tr', tr]] as const) {
          if (typeof lookup(language, key) !== 'string') missing.push(`${file}: ${key} (${name})`);
        }
      }
    }
    expect(checked).toBeGreaterThan(20);
    expect(missing).toEqual([]);
  });

  it('the new attachment strings are translated and keep their placeholders', () => {
    const keys = ['preview', 'download', 'downloadFile', 'downloadText', 'openInTab', 'expiredHint', 'imageUnavailable', 'referenceLabel', 'referenceHint', 'externalHint'] as const;
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of keys) {
      const english = en.agents.attachments[key];
      const turkish = tr.agents.attachments[key];
      expect(turkish, key).toBeTruthy();
      expect(turkish, key).not.toBe(english);
      expect(placeholders(turkish), key).toEqual(placeholders(english));
    }
  });
});
