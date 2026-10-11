/**
 * Regression tests for the F2 console lane: what the e2e of the files / images /
 * sessions work found and the fixes for it.
 *
 *  - model forms: input types are selectable for every driver and prefilled from
 *    detection; the Model Hub shows detected vision
 *  - carryRecentImages looks at the window the SDK really sends
 *  - the tracing inspector draws pictures and files instead of printing JSON
 *  - attachment chips meet WCAG AA in both colour schemes
 *  - the uploader is a person's name
 *  - the session-file delete uses the app's confirm dialog
 *  - a refused session says so (403) instead of "not found"
 *  - the content route honours one Range
 *
 * Pure functions and static markup only (createElement, not JSX: the suite only
 * collects `.test.ts`); the end-to-end halves live in the integration and API tests.
 */

import React, { createElement as h, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider, Table } from '@mantine/core';

// The inspector pulls in the session pieces, which read the Next router and prefetch through it.
vi.mock('@/components/common/navigation/useNavigationFeedback', () => ({
  useNavigationFeedback: () => ({ push: () => undefined }),
  usePendingNavigationKey: () => null,
  useIntentPrefetch: () => ({ getIntentProps: () => ({}) }),
}));

import { I18nProvider } from '@/lib/i18n';
import { en } from '@/lib/i18n/messages/en';
import { tr } from '@/lib/i18n/messages/tr';
import ModelInputModalitiesField from '@/components/models/ModelInputModalitiesField';
import {
  inferredInputModalities,
  isMultimodalFor,
  modelTakesImages,
  shownInputModalities,
} from '@/components/models/inputModalities';
import { buildTurnInputState } from '@/lib/services/agents/agentTurnState';
import { sdkContextWindow } from '@/lib/services/agents/sdkContextWindow';
import { LlmRequestItemsView } from '@/components/common/llm/LlmRequestDetail';
import { messageImageViews } from '@/components/common/llm/messageImages';
import { parseFlattenedParts, tracedMessageContent } from '@/components/common/llm/tracedMessageContent';
import { CHIP_CONTRAST_PAIRS } from '@/components/agents/session/attachmentChipStyles';
import SessionFilesPanel from '@/components/agents/session/SessionFilesPanel';
import { createdByWho, SessionFileCells } from '@/components/files/FileBrowseParts';
import { sessionLoadFailure } from '@/components/agents/session/sessionLoadFailure';
import { parseByteRange } from '@/lib/services/agents/byteRange';
import { displayNameOf, resolveUserDisplayNames, withUploaderNames } from '@/lib/services/users/userDisplayNames';

(globalThis as { React?: typeof React }).React = React;

const root = join(__dirname, '../..');
const source = (file: string) => readFileSync(join(root, file), 'utf8');
const render = (node: ReactNode, locale: 'en' | 'tr' = 'en') =>
  renderToStaticMarkup(h(MantineProvider, null, h(I18nProvider, { locale, children: node })));
const noop = () => undefined;

// ── Model forms ─────────────────────────────────────────────────────────────

describe('model forms: input types for every driver', () => {
  it('the create form does not gate the boxes on the driver’s "multimodal" capability', () => {
    const create = source('components/models/CreateModelModal.tsx');
    expect(create).not.toContain('model.supports.multimodal');
    expect(create).not.toContain('providerSupportsMultimodal');
    expect(create).not.toContain('allowedModalities');
    // …and a provider switch no longer wipes a choice.
    expect(create).not.toMatch(/setFieldValue\('inputModalities', null\)/);
    // The edit page never did.
    expect(source('app/dashboard/models/[id]/edit/page.tsx')).not.toContain('model.supports.multimodal');
  });

  it('every box except the last ticked one can be changed, whatever is detected', () => {
    const boxes = (html: string) => html.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? [];
    const html = render(h(ModelInputModalitiesField, { value: null, inferred: ['text', 'image'], onChange: noop }));
    expect(boxes(html)).toHaveLength(5);
    expect(boxes(html).filter((tag) => tag.includes('disabled'))).toEqual([]);
    expect(boxes(html).filter((tag) => tag.includes('checked'))).toHaveLength(2);
    // The detection is said out loud.
    expect(html).toContain('Detected from the model id');
    // A text-only detection: text cannot be cleared, nothing else is locked.
    const textOnly = render(h(ModelInputModalitiesField, { value: null, inferred: ['text'], onChange: noop }));
    expect(boxes(textOnly).filter((tag) => tag.includes('disabled'))).toHaveLength(1);
  });

  it('prefills image input from the model id and saves vision with it, so the list can show it', () => {
    const inferred = inferredInputModalities('llm', 'gpt-5.6-x');
    expect(inferred).toContain('image');
    expect(isMultimodalFor(shownInputModalities(null, inferred))).toBe(true);
    // A known text-only id stays text-only, and an explicit choice wins over detection.
    expect(inferredInputModalities('llm', 'llama-2-7b-chat')).toEqual(['text']);
    expect(isMultimodalFor(shownInputModalities(['text'], inferred))).toBe(false);
  });

  it('the Model Hub shows vision for what the model resolves to, not only the stored flag', () => {
    // A model created before detection existed (or through the API): the flag is off, the id is a vision family.
    expect(modelTakesImages({ category: 'llm', isMultimodal: false, capabilities: { inputModalities: ['text', 'image'] } })).toBe(true);
    // An explicit text-only choice wins over a flag left on.
    expect(modelTakesImages({ category: 'llm', isMultimodal: true, capabilities: { inputModalities: ['text'] } })).toBe(false);
    // Without resolved capabilities (an older response), or for another category, the flag decides as before.
    expect(modelTakesImages({ category: 'llm', isMultimodal: true })).toBe(true);
    expect(modelTakesImages({ category: 'embedding', isMultimodal: false, capabilities: { inputModalities: ['text', 'image'] } })).toBe(false);
    expect(modelTakesImages({ category: 'ocr', isMultimodal: true })).toBe(true);
    // The pages use it for the badge, the counter and the filter.
    for (const file of ['app/dashboard/models/page.tsx', 'app/dashboard/models/[id]/page.tsx']) {
      expect(source(file), file).toContain('modelTakesImages(');
    }
    expect(source('app/dashboard/models/page.tsx')).not.toMatch(/\{m\.isMultimodal \?/);
  });
});

// ── The window the SDK sends ────────────────────────────────────────────────

describe('sdkContextWindow: what the SDK sends to the model', () => {
  const turns = (count: number, from = 1) => Array.from({ length: count }, (_, i) => [
    { role: 'user', content: `u${from + i}` },
    { role: 'assistant', content: `a${from + i}` },
  ]).flat();
  const names = (messages: Array<{ content?: unknown }>) => messages.map((m) => m.content);

  it('hybrid keeps the system message, the first user message and the last N user turns', () => {
    const saved = [{ role: 'system', content: 'sys' }, ...turns(11), { role: 'user', content: 'u12' }];
    const sent = sdkContextWindow(saved, { policy: 'hybrid', lastTurnsToKeep: 10 });
    // 1 system + u1 + (u3..u12 with their answers) = 21 messages, the figure the retest measured.
    expect(sent).toHaveLength(21);
    expect(names(sent).slice(0, 3)).toEqual(['sys', 'u1', 'u3']);
    expect(names(sent)).not.toContain('u2');
    expect(names(sent).at(-1)).toBe('u12');
  });

  it('counts assistant replies while the conversation has fewer user turns than the window', () => {
    // Two user turns, window 3: assistant replies are counted (a4, a3, a2), so a1 falls out; the first user message stays.
    const saved = [
      { role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' }, { role: 'assistant', content: 'a2' },
      { role: 'assistant', content: 'a3' }, { role: 'assistant', content: 'a4' }, { role: 'user', content: 'u2' },
    ];
    expect(names(sdkContextWindow(saved, { policy: 'hybrid', lastTurnsToKeep: 3 }))).toEqual(['u1', 'a2', 'a3', 'a4', 'u2']);
    // A window as wide as the conversation drops nothing.
    expect(sdkContextWindow(saved, { policy: 'hybrid', lastTurnsToKeep: 10 })).toHaveLength(saved.length);
  });

  it('raw sends everything; summary_only without a summary windows like hybrid, with one it starts at the summary', () => {
    const saved = [...turns(12), { role: 'user', content: 'u13' }];
    expect(sdkContextWindow(saved, { policy: 'raw', lastTurnsToKeep: 3 })).toHaveLength(saved.length);
    expect(sdkContextWindow(saved, { policy: 'summary_only', lastTurnsToKeep: 10 }))
      .toEqual(sdkContextWindow(saved, { policy: 'hybrid', lastTurnsToKeep: 10 }));

    const summarised = [
      ...turns(5),
      { role: 'assistant', content: '', tool_calls: [{ id: 's1', function: { name: 'summarize_context' } }] },
      { role: 'tool', name: 'summarize_context', content: 'SUMMARY', tool_call_id: 's1' },
      ...turns(2, 6),
      { role: 'user', content: 'u8' },
    ];
    const sent = sdkContextWindow(summarised, { policy: 'summary_only', lastTurnsToKeep: 10, hasSummary: true });
    // The first user message, then what came after the summary (the summary's own messages are carried as context, not here).
    expect(names(sent)).toEqual(['u1', 'u6', 'a6', 'u7', 'a7', 'u8']);
  });

  it('is told apart from the saved list in the retest: the picture is in the list long after it left the window', () => {
    const ref = (id: string) => ({ type: 'image_url', image_url: { url: `session-file://${id}` }, fileId: id, name: `${id}.png` });
    const history = [
      { role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' },
      { role: 'user', content: [{ type: 'text', text: 'is this red?' }, ref('f1')] }, { role: 'assistant', content: 'a2' },
      ...turns(10, 3),
    ];
    const transcript = [
      { role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'is this red?', attachments: [{ fileId: 'f1', name: 'f1.png', mimeType: 'image/png', size: 5 }] },
      { role: 'assistant', content: 'a2' },
      ...turns(10, 3),
    ];
    const lastContent = (state: { messages: Array<{ content?: unknown }> }) => state.messages.at(-1)!.content;

    // The window of 10 turns has dropped the picture's message (u2, with u13 asked): it comes back.
    const withWindow = buildTurnInputState({
      carried: { messages: history as never }, transcript, userMessage: 'u13',
      attachments: { supportsVision: true, carryRecentImages: 2, window: { policy: 'hybrid', lastTurnsToKeep: 10 } },
    });
    expect(JSON.stringify(lastContent(withWindow))).toContain('session-file://f1');
    expect(JSON.stringify(lastContent(withWindow))).toContain('Earlier image');

    // Without the window the whole list counts as seen: the earlier behaviour, kept for callers that do not know it.
    const without = buildTurnInputState({
      carried: { messages: history as never }, transcript, userMessage: 'u13',
      attachments: { supportsVision: true, carryRecentImages: 2 },
    });
    expect(lastContent(without)).toBe('u13');

    // Two turns earlier it is still inside the window (u2 … u11) and is not shown a second time.
    const shorter = buildTurnInputState({
      carried: { messages: history.slice(0, -4) as never }, transcript: transcript.slice(0, -4), userMessage: 'u11',
      attachments: { supportsVision: true, carryRecentImages: 2, window: { policy: 'hybrid', lastTurnsToKeep: 10 } },
    });
    expect(lastContent(shorter)).toBe('u11');
  });

  it('the live and the playground paths hand the agent’s own context settings to the carry', () => {
    const service = source('lib/services/agents/agentService.ts');
    expect(service).toContain('resolveAgentRuntimeOptions(input.config).context');
    expect(service).toMatch(/\.\.\.\(window \? \{ window \} : \{\}\)/);
  });
});

// ── Tracing: pictures and files, never raw JSON ─────────────────────────────

describe('tracing: a recorded message is drawn, not printed as JSON', () => {
  const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  const parts = [
    { type: 'text', text: 'UI check: look at these files\n\n<attachments source="session-files">\nThe person attached 2 files.\n</attachments>' },
    { type: 'text', text: '[Attached image: "scan.png" (id f-scan)]' },
    { type: 'image_url', image_url: { url: 'session-file://f-scan' }, fileId: 'f-scan', name: 'scan.png' },
    { type: 'image_url', image_url: { url: pixel } },
  ];
  /** What the SDK's recorder stores: each part as pretty JSON, joined by newlines. */
  const flattened = (list: unknown[]) => list.map((part) => JSON.stringify(part, null, 2)).join('\n');
  const html = (content: unknown) => render(h(LlmRequestItemsView, { items: [{ itemType: 'message', role: 'user', content }] }));

  it('reads the parts back from the flattened text, in order', () => {
    expect(parseFlattenedParts(flattened(parts))).toEqual(parts);
    expect(tracedMessageContent({ kind: 'message', role: 'user', content: flattened(parts) })).toEqual(parts);
  });

  it('draws the person’s words, the picture’s name as a chip and an inline picture as a thumbnail — no JSON', () => {
    const out = html(tracedMessageContent({ content: flattened(parts) }));
    expect(out).toContain('UI check: look at these files');
    expect(out).toContain('[Attached image: &quot;scan.png&quot; (id f-scan)]');
    // The reference is a named chip, the inline picture a thumbnail with a preview.
    expect(out).toContain('scan.png');
    expect(out).toContain(`src="${pixel}"`);
    // Nothing of the part objects is printed.
    expect(out).not.toContain('&quot;type&quot;');
    expect(out).not.toContain('image_url');
    expect(out).not.toContain('session-file://');
    expect(out).not.toContain('[image]');
  });

  it('prefers the structured parts the SDK (0.10.6) records beside a content that only names the attachment', () => {
    // What the SDK writes for a message with a picture: `content` names it, `parts` carries everything in order.
    const content = 'UI check\n[Attached image: "scan.png" (id f-scan)]\n[image: scan.png]';
    expect(tracedMessageContent({ kind: 'message', role: 'user', content, parts })).toEqual(parts);
    expect(tracedMessageContent({ content: flattened(parts), parts })).toEqual(parts);
    expect(tracedMessageContent({ content, contentParts: parts })).toEqual(parts);
    // Drawn, the placeholder text is not repeated next to the picture it names.
    const out = html(tracedMessageContent({ content, parts }));
    expect(out).toContain('UI check: look at these files');
    expect(out).not.toContain('[image: scan.png]');
    expect(out).toContain(`src="${pixel}"`);
    // An array that is already content is left alone.
    expect(tracedMessageContent({ content: parts })).toBe(parts);
  });

  it('leaves plain text, and a text that merely mentions a type, exactly as it came', () => {
    expect(tracedMessageContent({ content: 'hello there' })).toBe('hello there');
    expect(tracedMessageContent({ content: 'the "type" of this is text' })).toBe('the "type" of this is text');
    expect(tracedMessageContent({ content: '{"type": "weather", "temp": 3}' })).toBe('{"type": "weather", "temp": 3}');
    expect(tracedMessageContent({})).toBeUndefined();
    expect(html('hello there')).toContain('hello there');
  });

  it('keeps text around the parts, and draws files as chips', () => {
    const file = { type: 'input_file', file_id: 'file-9', filename: 'report.pdf' };
    const content = tracedMessageContent({ content: `Before the parts\n${flattened([parts[0], file])}\nAfter` });
    expect(content).toEqual([
      { type: 'text', text: 'Before the parts' },
      parts[0],
      file,
      { type: 'text', text: 'After' },
    ]);
    expect(messageImageViews(content).map((view) => view.name)).toEqual(['report.pdf']);
    const out = html(content);
    expect(out).toContain('report.pdf');
    expect(out).not.toContain('input_file');
  });

  it('a recording cut off inside a part still shows words and names, never the half-printed JSON', () => {
    const whole = flattened(parts);
    // Cut inside the reference picture's object.
    const cutAtImage = whole.slice(0, whole.indexOf('"fileId": "f-scan"') + 8);
    const image = tracedMessageContent({ content: cutAtImage }) as Array<Record<string, unknown>>;
    expect(image.at(-1)).toMatchObject({ type: 'input_image', truncated: true });
    expect(JSON.stringify(image.slice(0, 2))).toContain('UI check');
    const outImage = html(image);
    expect(outImage).not.toContain('&quot;type&quot;');
    expect(outImage).not.toContain('image_url');

    // Cut inside the first text part.
    const cutAtText = whole.slice(0, 60);
    const text = tracedMessageContent({ content: cutAtText }) as Array<{ type: string; text: string }>;
    expect(text).toHaveLength(1);
    expect(text[0].text.endsWith('…')).toBe(true);
    expect(text[0].text).toContain('UI check');
    expect(html(text)).not.toContain('&quot;type&quot;');
  });

  it('both tracing pages hand a message over through it', () => {
    for (const file of [
      'app/dashboard/tracing/threads/[threadId]/page.tsx',
      'app/dashboard/tracing/sessions/[sessionId]/page.tsx',
    ]) {
      expect(source(file), file).toContain("content: tracedMessageContent(section)");
    }
  });

  it('both tracing pages hand the trace’s session to the inspector, in the modal and in the Sections tab', () => {
    for (const file of [
      'app/dashboard/tracing/threads/[threadId]/page.tsx',
      'app/dashboard/tracing/sessions/[sessionId]/page.tsx',
    ]) {
      const page = source(file);
      expect(page, file).toContain('useTraceSessionFiles(');
      expect(page.match(/sessionFiles=\{sessionFiles\}/g)?.length, file).toBeGreaterThanOrEqual(2);
    }
    // A trace session's thread is the conversation; the thread page's own id is that thread.
    expect(source('app/dashboard/tracing/sessions/[sessionId]/page.tsx')).toContain('useTraceSessionFiles(detail?.session?.threadId)');
    expect(source('app/dashboard/tracing/threads/[threadId]/page.tsx')).toContain('useTraceSessionFiles(threadId)');
  });
});

// ── Chip contrast ───────────────────────────────────────────────────────────

describe('attachment chips meet WCAG AA in the light and the dark scheme', () => {
  const css = source('app/globals.css');
  const block = (opening: string) => {
    const open = css.indexOf(opening);
    expect(open, opening).toBeGreaterThanOrEqual(0);
    const start = css.indexOf('{', open);
    let depth = 0;
    for (let i = start; i < css.length; i += 1) {
      if (css[i] === '{') depth += 1;
      if (css[i] === '}') { depth -= 1; if (depth === 0) return css.slice(start + 1, i); }
    }
    throw new Error('unclosed block');
  };
  const read = (body: string) => Object.fromEntries([...body.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1], m[2]]));
  const light = read(block(':root {'));
  const dark = { ...light, ...read(block(":root[data-mantine-color-scheme='dark'] {")) };
  const luminance = (hex: string) => {
    const n = parseInt(hex.slice(1), 16);
    const [r, g, b] = [n >> 16 & 255, n >> 8 & 255, n & 255].map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  for (const [scheme, tokens] of [['light', light], ['dark', dark]] as const) {
    it(`every text/background pair a chip draws is at least 4.5:1 (${scheme})`, () => {
      for (const pair of CHIP_CONTRAST_PAIRS) {
        const text = tokens[pair.text];
        const background = tokens[pair.background];
        expect(text, `${pair.name}: ${pair.text}`).toBeDefined();
        expect(background, `${pair.name}: ${pair.background}`).toBeDefined();
        expect(contrast(text!, background!), `${pair.name} (${scheme})`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  it('what the old chips drew would have failed: faint grey on the wash is under 3:1', () => {
    expect(contrast('#98a1ad', '#f4f4f1')).toBeLessThan(3);
  });

  it('what the Files panel drew would have failed too: Mantine’s dimmed grey and blue link on white', () => {
    expect(contrast('#98a1ad', '#ffffff')).toBeLessThan(3);
    expect(contrast('#228be6', '#ffffff')).toBeLessThan(4.5);
    // …and the tokens it draws now are named in the pairs the loop above holds to AA in both schemes.
    const named = CHIP_CONTRAST_PAIRS.map((pair) => pair.name);
    expect(named).toContain('Files panel title');
    expect(named).toContain('Files panel location link');
  });

  it('the Files panel’s title and bucket link draw in those tokens, in both colour schemes', () => {
    const out = render(h(SessionFilesPanel, {
      files: [{ id: 'f1', name: 'a.pdf', mimeType: 'application/pdf', size: 10, bucketKey: 'docs', path: 'sessions/a/f1.pdf', expiresAt: '2099-01-01T00:00:00Z' }], onDelete: noop, onRetry: noop,
    }));
    const tag = (testid: string) => out.match(new RegExp(`<[^>]*data-testid="${testid}"[^>]*>`))?.[0] ?? '';
    expect(tag('files-panel-title')).toContain('color:var(--ds-text-soft)');
    expect(tag('file-location-link')).toContain('color:var(--ds-link-text)');
    // Not Mantine's dimmed grey nor its default anchor blue.
    expect(tag('files-panel-title')).not.toMatch(/data-c="dimmed"|mantine-dimmed|--text-color/);
    expect(out).not.toContain('mantine-dimmed');
    // The empty state is soft text as well.
    const empty = render(h(SessionFilesPanel, { files: [], onDelete: noop, onRetry: noop }));
    expect(empty).not.toContain('mantine-dimmed');
    expect(empty).toContain('color:var(--ds-text-soft)');
  });

  it('the chips use those tokens, not Mantine’s light gray and not an opacity', () => {
    const chips = source('components/agents/session/SessionAttachments.tsx');
    expect(chips).not.toContain('opacity: 0.7');
    expect(chips).not.toContain('c="dimmed"');
    expect(chips).not.toContain('orange.7');
    // The Files tab's small lines draw in the same token, not in Mantine's dimmed grey.
    const out = render(h(SessionFilesPanel, {
      files: [{ id: 'f1', name: 'a.pdf', mimeType: 'application/pdf', size: 10, conversionStatus: 'succeeded', expiresAt: '2099-01-01T00:00:00Z' }], onDelete: noop, onRetry: noop,
    }));
    expect(out).toContain('color:var(--ds-text-soft)');
    expect(out).not.toContain('mantine-dimmed');
    expect(out).not.toContain('data-c="dimmed"');
  });
});

// ── Uploader names ──────────────────────────────────────────────────────────

describe('the uploader is a person, not an id', () => {
  const users: Record<string, { name?: string; email?: string } | null> = {
    u1: { name: 'Ada Lovelace', email: 'ada@example.com' },
    u2: { name: '  ', email: 'grace@example.com' },
    u3: null,
  };
  const db = { findUserById: vi.fn(async (id: string) => {
    if (id === 'boom') throw new Error('malformed id');
    return (users[id] ?? null) as never;
  }) };

  it('names a person by name, else by e-mail, and skips actors that are not users', async () => {
    expect(displayNameOf({ name: ' Ada ', email: 'a@b.c' })).toBe('Ada');
    expect(displayNameOf({ name: '', email: 'a@b.c' })).toBe('a@b.c');
    expect(displayNameOf(null)).toBeUndefined();

    db.findUserById.mockClear();
    const names = await resolveUserDisplayNames('tenant_x', ['u1', 'u2', 'u3', 'boom', 'system:cron', undefined, 'u1'], { db });
    expect([...names.entries()]).toEqual([['u1', 'Ada Lovelace'], ['u2', 'grace@example.com']]);
    // One lookup per distinct id, none for a system actor.
    expect(db.findUserById.mock.calls.map((call) => call[0]).sort()).toEqual(['boom', 'u1', 'u2', 'u3']);
  });

  it('adds uploadedByName to the records that have a known uploader, and touches nothing else', async () => {
    const records = [{ id: 'a', uploadedBy: 'u1' }, { id: 'b', uploadedBy: 'system:cron' }, { id: 'c' }];
    const out = await withUploaderNames('tenant_x', records, { db });
    expect(out).toEqual([{ id: 'a', uploadedBy: 'u1', uploadedByName: 'Ada Lovelace' }, records[1], records[2]]);
    // No uploader to look up: the same array comes back and the database is not asked.
    db.findUserById.mockClear();
    const nobody: Array<{ id: string; uploadedBy?: string }> = [{ id: 'z' }];
    expect(await withUploaderNames('tenant_x', nobody, { db })).toBe(nobody);
    expect(db.findUserById).not.toHaveBeenCalled();
  });

  it('a lookup that fails never fails the list', async () => {
    const broken = { findUserById: vi.fn(async () => { throw new Error('down'); }) };
    expect(await withUploaderNames('t', [{ uploadedBy: 'u1' }], { db: broken })).toEqual([{ uploadedBy: 'u1' }]);
  });

  it('the session Files panel says who by name, and falls back to what it has', () => {
    const file = { id: 'f1', name: 'a.pdf', mimeType: 'application/pdf', size: 10, uploadedBy: 'u1', expiresAt: '2099-01-01T00:00:00Z' };
    const named = render(h(SessionFilesPanel, { files: [{ ...file, uploadedByName: 'Ada Lovelace' }], onDelete: noop, onRetry: noop }));
    expect(named).toContain('Uploaded by Ada Lovelace');
    expect(named).not.toContain('Uploaded by u1');
    const unnamed = render(h(SessionFilesPanel, { files: [file], onDelete: noop, onRetry: noop }));
    expect(unnamed).toContain('Uploaded by u1');
  });

  it('the Document Store row shows the name too, the id only as its tooltip', () => {
    const row = (uploadedByName?: string) => render(h(Table, null, h(Table.Tbody, null, h(Table.Tr, null, h(SessionFileCells, {
      record: { purpose: 'conversation', conversationId: 'c1', agentKey: 'ag', expiresAt: new Date('2099-01-01T00:00:00Z'), uploadedBy: 'u1', ...(uploadedByName ? { uploadedByName } : {}) },
      agentId: 'a1', now: new Date('2026-10-11T00:00:00Z'), locale: 'en',
    })))));
    const named = row('Ada Lovelace');
    expect(named).toContain('Ada Lovelace');
    expect(named).toContain('title="u1"');
    expect(row()).toContain('u1');
  });

  it('names who created a file too (createdBy), in the same lookup', async () => {
    db.findUserById.mockClear();
    const records = [{ id: 'a', createdBy: 'u1' }, { id: 'b', createdBy: 'system:cron' }, { id: 'c', uploadedBy: 'u1', createdBy: 'u1' }, { id: 'd', createdBy: 'u3' }];
    const out = await withUploaderNames('tenant_x', records, { db });
    expect(out[0]).toEqual({ id: 'a', createdBy: 'u1', createdByName: 'Ada Lovelace' });
    expect(out[1]).toBe(records[1]);
    expect(out[2]).toEqual({ id: 'c', uploadedBy: 'u1', createdBy: 'u1', uploadedByName: 'Ada Lovelace', createdByName: 'Ada Lovelace' });
    expect(out[3]).toBe(records[3]);
    // u1 is asked once for the three places it appears.
    expect(db.findUserById.mock.calls.map((call) => call[0]).sort()).toEqual(['u1', 'u3']);
  });

  describe('the Name cell of the Document Store', () => {
    const session = { purpose: 'conversation' as const, uploadedBy: 'u1', createdBy: 'u1', createdByName: 'Ada Lovelace' };
    const rawId = '2383e3cb-06b3-4357-b23e-420c6ae1a6d3';

    it('drops the "Created by" line of a session file whose Uploaded-by column already says who', () => {
      expect(createdByWho(session, true)).toBeNull();
      expect(createdByWho({ ...session, createdByName: undefined, createdBy: rawId, uploadedBy: rawId }, true)).toBeNull();
    });

    it('names the person instead of printing the id', () => {
      expect(createdByWho({ createdBy: rawId, createdByName: 'Ada Lovelace' }, false)).toBe('Ada Lovelace');
      // A file the column does not cover (not a session file, or no column) keeps the line, with the name.
      expect(createdByWho({ ...session }, false)).toBe('Ada Lovelace');
      expect(createdByWho({ createdBy: rawId, createdByName: 'Ada Lovelace' }, true)).toBe('Ada Lovelace');
    });

    it('never prints a raw user id: an id that is nobody’s name has no line; a system actor is shown as it is', () => {
      expect(createdByWho({ createdBy: rawId }, false)).toBeNull();
      expect(createdByWho({ createdBy: '665f1c2e9b1e8a3d4c5b6a79' }, false)).toBeNull();
      expect(createdByWho({ createdBy: 'system:cron' }, false)).toBe('system:cron');
      expect(createdByWho({ createdBy: 'system' }, false)).toBe('system');
      expect(createdByWho({ createdBy: undefined as unknown as string }, false)).toBe('system');
    });

    it('the Document Store prints it through the helper and the translated line', () => {
      const manager = source('components/files/FileObjectManager.tsx');
      expect(manager).toContain('createdByWho(record, showSessionColumns)');
      expect(manager).toContain("t('createdBy', { who })");
      expect(manager).not.toMatch(/Created by \{record\.createdBy/);
      expect(en.files.createdBy).toBe('Created by {who}');
      expect(tr.files.createdBy).toContain('{who}');
    });
  });

  it('the list routes add the names', () => {
    expect(source('server/api/plugins/files.ts')).toContain('withUploaderNames(');
    expect(source('server/api/plugins/agent-session-files.ts')).toContain('{ withNames: true }');
    expect(source('lib/services/agents/sessionFiles.ts')).toContain('withUploaderNames(scope.tenantDbName, views, { db })');
  });
});

// ── Confirm dialog ──────────────────────────────────────────────────────────

describe('deleting a session file asks in the app’s own dialog', () => {
  it('the session page no longer uses the browser’s confirm', () => {
    const view = source('components/agents/session/AgentSessionView.tsx');
    expect(view).not.toContain('window.confirm');
    expect(view).not.toMatch(/\bconfirm\(/);
    expect(view).toContain('<ConfirmModal');
    expect(view).toContain('setFileToDelete(file)');
    // Asking is not deleting: the panel's button only opens the dialog.
    expect(view).toMatch(/onDelete: \(file\) => setFileToDelete\(file\)/);
  });

  it('the dialog has a title, the question, a cancel and a red confirm, in both languages', () => {
    for (const messages of [en, tr]) {
      const a = messages.agents.attachments as Record<string, string>;
      for (const key of ['filesDelete', 'filesDeleteConfirm', 'filesDeleteAction', 'cancel']) {
        expect(a[key], key).toBeTruthy();
      }
    }
    expect((tr.agents.attachments as Record<string, string>).filesDeleteAction).not.toBe((en.agents.attachments as Record<string, string>).filesDeleteAction);
    const dialog = source('components/common/ui/ConfirmModal.tsx');
    expect(dialog).toContain("confirmColor = 'red'");
    expect(dialog).toContain('<Modal');
  });
});

// ── A refused session ───────────────────────────────────────────────────────

describe('a session the person may not open says so', () => {
  const ok = { ok: true, status: 200 };

  it('tells a refusal (403) from a missing session (404)', () => {
    expect(sessionLoadFailure(ok, ok)).toBeNull();
    expect(sessionLoadFailure(ok, { ok: false, status: 403 })).toBe('forbidden');
    expect(sessionLoadFailure(ok, { ok: false, status: 404 })).toBe('notFound');
    expect(sessionLoadFailure({ ok: false, status: 403 }, ok)).toBe('forbidden');
    expect(sessionLoadFailure({ ok: false, status: 404 }, ok)).toBe('notFound');
    // The session's own answer decides first.
    expect(sessionLoadFailure({ ok: false, status: 403 }, { ok: false, status: 404 })).toBe('notFound');
    expect(sessionLoadFailure(ok, { ok: false, status: 500 })).toBe('notFound');
  });

  it('the page says "You don’t have access to this session" for the first and keeps "not found" for the second', () => {
    const page = (messages: typeof en | typeof tr) => messages.agents.sessionPage as Record<string, string>;
    expect(page(en).accessDeniedTitle).toBe('You don’t have access to this session');
    expect(page(en).notFoundTitle).toBe('Session not found');
    expect(page(tr).accessDeniedTitle).not.toBe(page(en).accessDeniedTitle);
    expect(page(tr).notFoundTitle).not.toBe(page(en).notFoundTitle);
    const view = source('components/agents/session/AgentSessionView.tsx');
    expect(view).toContain("tp('accessDeniedTitle')");
    expect(view).toContain("tp('notFoundTitle')");
    expect(view).not.toContain('title="Session not found"');
  });
});

// ── Range ───────────────────────────────────────────────────────────────────

describe('parseByteRange', () => {
  it('reads one range: a-b, a- and the suffix -n, clamped to the size', () => {
    expect(parseByteRange('bytes=0-9', 100)).toEqual({ kind: 'partial', start: 0, end: 9 });
    expect(parseByteRange('bytes=90-', 100)).toEqual({ kind: 'partial', start: 90, end: 99 });
    expect(parseByteRange('bytes=-10', 100)).toEqual({ kind: 'partial', start: 90, end: 99 });
    expect(parseByteRange('bytes=-500', 100)).toEqual({ kind: 'partial', start: 0, end: 99 });
    expect(parseByteRange('bytes=50-5000', 100)).toEqual({ kind: 'partial', start: 50, end: 99 });
    expect(parseByteRange(' Bytes = 1 - 2 ', 100)).toEqual({ kind: 'partial', start: 1, end: 2 });
    expect(parseByteRange(['bytes=2-3'], 100)).toEqual({ kind: 'partial', start: 2, end: 3 });
  });

  it('answers 416 for a range past the end, and for an empty body', () => {
    expect(parseByteRange('bytes=100-', 100)).toEqual({ kind: 'unsatisfiable' });
    expect(parseByteRange('bytes=500-600', 100)).toEqual({ kind: 'unsatisfiable' });
    expect(parseByteRange('bytes=-0', 100)).toEqual({ kind: 'unsatisfiable' });
    expect(parseByteRange('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' });
    expect(parseByteRange('bytes=-5', 0)).toEqual({ kind: 'unsatisfiable' });
  });

  it('ignores what it does not honour: no header, several ranges, another unit, nonsense', () => {
    for (const header of [undefined, '', 'bytes=0-1,5-6', 'items=0-1', 'bytes=a-b', 'bytes=5-2', 'bytes=-', 'bytes 0-1']) {
      expect(parseByteRange(header, 100), String(header)).toEqual({ kind: 'whole' });
    }
  });
});
