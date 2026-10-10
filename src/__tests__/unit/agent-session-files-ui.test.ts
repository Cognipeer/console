/**
 * The session composer's attachments: the pre-upload checks and request pieces
 * (pure), that the paperclip, the chips and the message attachments mount and
 * say what they should, that Configure → Execution edits the settings, and that
 * both languages carry the strings.
 */

import React, { createElement as h, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { AttachButton, AttachmentChips, MessageAttachments } from '@/components/agents/session/SessionAttachments';
import AgentExecutionPanel from '@/components/agents/studio/AgentExecutionPanel';
import {
  attachmentIds,
  checkAttachmentCandidate,
  formatFileSize,
  heldFileCount,
  lacksReadableText,
  sessionFileUploadUrl,
  uploadContentType,
  type PendingAttachment,
} from '@/components/agents/session/sessionAttachmentsUi';
import { resolveAttachmentsConfig } from '@/lib/services/agents/sessionFilesConfig';
import type { ChatMessage } from '@/components/agents/session/sessionTypes';
import { CONFIG_SECTION_KEYS } from '@/components/agents/studio/configSections';
import { en } from '@/lib/i18n/messages/en';
import { tr } from '@/lib/i18n/messages/tr';

(globalThis as { React?: typeof React }).React = React;

const render = (node: ReactNode) => renderToStaticMarkup(h(MantineProvider, null, node));
const noop = () => undefined;
const cfg = resolveAttachmentsConfig({ maxFiles: 2, maxFileSizeMb: 1, allowedMimeTypes: ['application/pdf', 'image/*'] });
const pdf = { name: 'a.pdf', size: 1000, type: 'application/pdf' };

describe('checking a file before it is uploaded', () => {
  it('accepts a file within the agent’s limits', () => {
    expect(checkAttachmentCandidate(pdf, cfg, 0)).toBeNull();
    expect(checkAttachmentCandidate({ name: 'p.png', size: 5, type: 'image/png' }, cfg, 1)).toBeNull();
  });

  it('refuses a file too large, a type not accepted, and one past the count', () => {
    expect(checkAttachmentCandidate({ ...pdf, size: 1024 * 1024 + 1 }, cfg, 0)).toEqual({ code: 'file_too_large', max: 1 });
    expect(checkAttachmentCandidate({ name: 'a.txt', size: 5, type: 'text/plain' }, cfg, 0)).toEqual({ code: 'unsupported_file_type' });
    expect(checkAttachmentCandidate(pdf, cfg, 2)).toEqual({ code: 'too_many_files', max: 2 });
  });

  it('leaves a file with no type to the server, which also reads the name', () => {
    expect(checkAttachmentCandidate({ name: 'a.pdf', size: 5, type: '' }, cfg, 0)).toBeNull();
  });

  it('counts the session’s files once each: earlier messages plus those waiting', () => {
    const sent: ChatMessage[] = [
      { role: 'user', content: 'x', attachments: [{ fileId: 'a', name: 'a', mimeType: 'text/plain', size: 1 }] },
      { role: 'assistant', content: 'y' },
    ];
    const waiting: PendingAttachment[] = [
      { fileId: 'a', name: 'a', mimeType: 'text/plain', size: 1 },
      { fileId: 'b', name: 'b', mimeType: 'text/plain', size: 1 },
    ];
    expect(heldFileCount(sent, waiting)).toBe(2);
    expect(heldFileCount([], [])).toBe(0);
  });
});

describe('the upload request', () => {
  it('sends the name as ?name= and the bytes raw, with the file’s own type', () => {
    expect(sessionFileUploadUrl('ag1', 's1', 'my report (1).pdf')).toBe('/api/agents/ag1/sessions/s1/files?name=my%20report%20(1).pdf');
    expect(uploadContentType({ type: 'application/pdf' })).toBe('application/pdf');
    expect(uploadContentType({ type: '' })).toBe('application/octet-stream');
  });

  it('sends a JSON file as opaque bytes — a JSON body is the server’s base64 envelope', () => {
    expect(uploadContentType({ type: 'application/json' })).toBe('application/octet-stream');
    expect(uploadContentType({ type: 'application/vnd.api+json' })).toBe('application/octet-stream');
  });

  it('names the files of a message by id', () => {
    expect(attachmentIds([{ fileId: 'a', name: 'a', mimeType: 'x', size: 1 }, { fileId: 'b', name: 'b', mimeType: 'x', size: 1 }])).toEqual(['a', 'b']);
  });

  it('formats sizes', () => {
    expect([0, 512, 1536, 20 * 1024, 5 * 1024 * 1024, 30 * 1024 * 1024].map(formatFileSize)).toEqual(['0 B', '512 B', '1.5 KB', '20 KB', '5.0 MB', '30 MB']);
  });

  it('flags a document whose text could not be extracted, but never an image', () => {
    const base = { fileId: 'a', name: 'a', size: 1 };
    expect(lacksReadableText({ ...base, mimeType: 'application/pdf', conversionStatus: 'failed' })).toBe(true);
    expect(lacksReadableText({ ...base, mimeType: 'application/pdf', conversionStatus: 'succeeded' })).toBe(false);
    expect(lacksReadableText({ ...base, mimeType: 'image/png', conversionStatus: 'skipped' })).toBe(false);
  });
});

describe('the composer pieces', () => {
  it('the paperclip is labelled and opens a multi-file picker restricted to the accepted types', () => {
    const html = render(h(AttachButton, { accept: 'application/pdf,image/*', onFiles: noop }));
    expect(html).toContain('aria-label="Attach files"');
    expect(html).toContain('type="file"');
    expect(html).toContain('multiple');
    expect(html).toContain('accept="application/pdf,image/*"');
  });

  it('the chips show each waiting file with its size, what is uploading, and warn about unreadable text', () => {
    const html = render(h(AttachmentChips, {
      files: [
        { fileId: 'a', name: 'report.pdf', mimeType: 'application/pdf', size: 2048, conversionStatus: 'succeeded' },
        { fileId: 'b', name: 'scan.pdf', mimeType: 'application/pdf', size: 1024, conversionStatus: 'failed' },
      ],
      uploading: ['big.docx'],
      onRemove: noop,
    }));
    expect(html).toContain('report.pdf');
    expect(html).toContain('2.0 KB');
    expect(html).toContain('scan.pdf');
    expect(html).toContain('big.docx');
    expect(html).toContain('aria-label="Remove file"');
    expect(render(h(AttachmentChips, { files: [], uploading: [], onRemove: noop }))).not.toContain('attachment-chips');
  });

  it('a user message shows its attachments; one without shows nothing', () => {
    const html = render(h(MessageAttachments, { attachments: [{ fileId: 'a', name: 'notes.txt', mimeType: 'text/plain', size: 2048 }] }));
    expect(html).toContain('notes.txt · 2.0 KB');
    expect(render(h(MessageAttachments, { attachments: undefined }))).not.toContain('message-attachments');
    expect(render(h(MessageAttachments, { attachments: [] }))).not.toContain('message-attachments');
  });
});

describe('Configure → Execution: attachments', () => {
  it('is not shown unless the page passes the settings', () => {
    expect(render(h(AgentExecutionPanel, { value: undefined, onChange: noop }))).not.toContain('Accept attached files');
  });

  it('shows every setting with its default as the placeholder', () => {
    const html = render(h(AgentExecutionPanel, { value: undefined, onChange: noop, attachments: undefined, onAttachmentsChange: noop }));
    for (const label of ['Accept attached files', 'Files per session', 'Largest file (MB)', 'Put in the message up to (tokens)',
      'Page size when reading (characters)', 'Keep files for (days)', 'Allowed file types', 'Storage bucket']) {
      expect(html).toContain(label);
    }
    for (const placeholder of ['placeholder="10"', 'placeholder="20"', 'placeholder="30000"', 'placeholder="20000"', 'placeholder="30"']) {
      expect(html).toContain(placeholder);
    }
  });

  it('shows the stored values, and hides the details when attachments are switched off', () => {
    const on = render(h(AgentExecutionPanel, { value: undefined, onChange: noop, attachments: { maxFiles: 4, allowedMimeTypes: ['image/*', 'application/pdf'] }, onAttachmentsChange: noop }));
    expect(on).toContain('value="4"');
    expect(on).toContain('value="image/*, application/pdf"');
    const off = render(h(AgentExecutionPanel, { value: undefined, onChange: noop, attachments: { enabled: false }, onAttachmentsChange: noop }));
    expect(off).toContain('Accept attached files');
    expect(off).not.toContain('Files per session');
  });

  it('is part of the Execution section, so a change there marks it changed', () => {
    expect(CONFIG_SECTION_KEYS.execution).toEqual(['execution', 'attachments']);
  });
});

describe('strings', () => {
  it('every attachment string exists in English and in Turkish', () => {
    expect(Object.keys(tr.agents.attachments).sort()).toEqual(Object.keys(en.agents.attachments).sort());
  });
});
