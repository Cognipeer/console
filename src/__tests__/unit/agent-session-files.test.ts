/**
 * Session files — the parts that need no database: the settings and their
 * defaults, the inline / paged decision and its boundary, paging, the transcript
 * marker, the Responses `input_file` / `input_image` parsing, the config checks,
 * the approval exemption, and the upload service's quota handling (the object
 * store and the quota guard are faked).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  downloads: new Map<string, string>(),
  db: {
    switchToTenant: vi.fn(),
    listFileRecordsByConversation: vi.fn(),
    countFileRecords: vi.fn(),
    sumFileRecordBytes: vi.fn(),
    findFileBucketByKey: vi.fn(),
  },
  uploadFile: vi.fn(),
  perRequest: vi.fn(),
  rate: vi.fn(),
  resource: vi.fn(),
}));

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn(async () => hoisted.db) }));
vi.mock('@/lib/services/files', () => ({
  uploadFile: hoisted.uploadFile,
  deleteFile: vi.fn(),
  createFileBucket: vi.fn(),
  downloadFile: vi.fn(async (_db: string, _t: string, _p: string, _bucket: string, key: string, options?: { variant?: string }) => {
    const text = hoisted.downloads.get(`${key}${options?.variant === 'markdown' ? ':md' : ''}`);
    if (text === undefined) throw new Error('File record not found.');
    return { data: Buffer.from(text, 'utf8') };
  }),
}));
vi.mock('@/lib/services/providers/builtinProviders', () => ({
  BUILTIN_FILE_PROVIDER_KEY: 'builtin-files',
  ensureBuiltinProviders: vi.fn(),
}));
vi.mock('@/lib/quota/quotaGuard', () => ({
  checkPerRequestLimits: hoisted.perRequest,
  checkRateLimit: hoisted.rate,
  checkResourceQuota: hoisted.resource,
}));

import type { IFileRecord } from '@/lib/database';
import {
  ATTACHMENT_BLOCK_MARKER,
  assembleTurnAttachments,
  buildUserTurnContent,
  estimateBase64Size,
  estimateTokens,
  isImageMime,
  isMimeAllowed,
  pageCount,
  pageText,
  resolveAttachmentsConfig,
  resolveUploadMimeType,
  stripAttachmentBlock,
  uploadSessionFile,
  agentTakesAttachments,
  SESSION_FILES_DEFAULTS,
} from '@/lib/services/agents/sessionFiles';
import { extractResponseUserInput, namedFileIds } from '@/lib/services/agents/responseInputFiles';
import { isReadOnlyTool, HITL_READ_ONLY_TOOLS } from '@/lib/services/agents/agentHumanInTheLoop';
import { serializeForStorage, MAX_STATE_BYTES } from '@/lib/services/agents/agentTurnState';
import { validateAgentConfigShape } from '@/lib/services/agents/agentConfigValidation';
import { AgentAttachmentError, classifyAgentRunError } from '@/lib/services/agents/agentErrors';

const scope = { tenantDbName: 'tenant_x', tenantId: 't1', projectId: 'p1' };

function fileRecord(id: string, overrides: Partial<IFileRecord> = {}): IFileRecord {
  return {
    _id: id, tenantId: 't1', projectId: 'p1', providerKey: 'builtin-files', bucketKey: 'conversation-files', key: id,
    name: `${id}.txt`, size: 10, contentType: 'text/plain', markdownStatus: 'succeeded', markdownKey: `${id}.md`,
    purpose: 'conversation', conversationId: 'c1', createdBy: 'u1', ...overrides,
  };
}

describe('the settings and their defaults', () => {
  it('an agent with no attachments config gets the documented defaults', () => {
    expect(resolveAttachmentsConfig(undefined)).toEqual({
      enabled: true, maxFiles: 10, maxFileSizeMb: 20, allowedMimeTypes: [], inlineMaxTokens: 30_000, readPageChars: 20_000, retentionDays: 30,
    });
    expect(SESSION_FILES_DEFAULTS).toMatchObject({ maxFiles: 10, maxFileSizeMb: 20, inlineMaxTokens: 30_000, readPageChars: 20_000, retentionDays: 30 });
  });

  it('takes a stored value over the default, and ignores values that make no sense', () => {
    expect(resolveAttachmentsConfig({ maxFiles: 3, maxFileSizeMb: 1.5, inlineMaxTokens: 500, readPageChars: 1000, retentionDays: 2, allowedMimeTypes: ['image/*', ' '], bucketKey: ' mine ' }))
      .toEqual({ enabled: true, maxFiles: 3, maxFileSizeMb: 1.5, allowedMimeTypes: ['image/*'], inlineMaxTokens: 500, readPageChars: 1000, retentionDays: 2, bucketKey: 'mine' });
    expect(resolveAttachmentsConfig({ maxFiles: -1, maxFileSizeMb: 0, readPageChars: Number.NaN })).toMatchObject({ maxFiles: 10, maxFileSizeMb: 20, readPageChars: 20_000 });
  });

  it('only a connected agent or enabled:false takes no attachments', () => {
    expect(agentTakesAttachments({ modelKey: 'm' })).toBe(true);
    expect(agentTakesAttachments({ modelKey: 'm', attachments: { enabled: false } })).toBe(false);
    expect(agentTakesAttachments({ kind: 'external', connection: { protocol: 'a2a', url: 'https://x' } } as never)).toBe(false);
    expect(agentTakesAttachments(undefined)).toBe(false);
  });

  it('the file types: wildcard, exact, none (= any), and a guess from the name when the upload is opaque', () => {
    expect(isMimeAllowed('image/png', ['image/*'])).toBe(true);
    expect(isMimeAllowed('application/pdf', ['image/*', 'application/pdf; charset=x'])).toBe(true);
    expect(isMimeAllowed('text/plain', ['image/*'])).toBe(false);
    expect(isMimeAllowed('anything/at-all', [])).toBe(true);
    expect(resolveUploadMimeType('application/octet-stream', 'Report.PDF')).toBe('application/pdf');
    expect(resolveUploadMimeType('text/csv; charset=utf-8', 'x.bin')).toBe('text/csv');
    expect(resolveUploadMimeType(undefined, 'noextension')).toBe('application/octet-stream');
    expect(isImageMime('IMAGE/PNG')).toBe(true);
    expect(isImageMime('application/pdf')).toBe(false);
  });

  it('measures a base64 body without decoding it', () => {
    expect(estimateBase64Size(Buffer.from('hello world').toString('base64'))).toBe(11);
    expect(estimateBase64Size(`data:text/plain;base64,${Buffer.from('abc').toString('base64')}`)).toBe(3);
    expect(estimateBase64Size('')).toBe(0);
  });
});

describe('paging', () => {
  it('splits text into pages of readPageChars and reports how many there are', () => {
    const text = 'a'.repeat(1050);
    expect(pageCount(text.length, 500)).toBe(3);
    expect(pageText(text, 1, 500)).toEqual({ text: 'a'.repeat(500), page: 1, pages: 3 });
    expect(pageText(text, 3, 500)).toEqual({ text: 'a'.repeat(50), page: 3, pages: 3 });
  });

  it('is null past the end or for a page that is not a positive whole number; an empty file is one empty page', () => {
    expect(pageText('abc', 2, 500)).toBeNull();
    expect(pageText('abc', 0, 500)).toBeNull();
    expect(pageText('abc', 1.5, 500)).toBeNull();
    expect(pageText('', 1, 500)).toEqual({ text: '', page: 1, pages: 1 });
    expect(pageCount(500, 500)).toBe(1);
    expect(pageCount(501, 500)).toBe(2);
  });
});

describe('the transcript marker', () => {
  it('strips everything the turn added, and nothing from a message without it', () => {
    expect(stripAttachmentBlock(`What is this?${ATTACHMENT_BLOCK_MARKER}<document name="a" id="1">x</document>\n</attachments>`)).toBe('What is this?');
    expect(stripAttachmentBlock('plain message')).toBe('plain message');
    expect(stripAttachmentBlock('')).toBe('');
  });

  it('is the text alone when nothing is attached; text plus image parts when there are images', () => {
    const none = { block: '', images: [], attachments: [], mode: 'none' as const, warnings: [] };
    expect(buildUserTurnContent('hello', none)).toBe('hello');
    const withBlock = { ...none, block: `${ATTACHMENT_BLOCK_MARKER}note\n</attachments>`, mode: 'inline' as const };
    expect(buildUserTurnContent('hello', withBlock)).toBe(`hello${ATTACHMENT_BLOCK_MARKER}note\n</attachments>`);
    const image = { type: 'image_url' as const, image_url: { base64: 'AA==', media_type: 'image/png' } };
    expect(buildUserTurnContent('look', { ...none, images: [image] })).toEqual([{ type: 'text', text: 'look' }, image]);
  });
});

describe('inline or paged', () => {
  beforeEach(() => {
    hoisted.downloads.clear();
  });
  const cfg = (inlineMaxTokens: number, readPageChars = 100) => resolveAttachmentsConfig({ inlineMaxTokens, readPageChars });

  it('inlines when the text is at most inlineMaxTokens (chars / 4) — the boundary is inclusive', async () => {
    hoisted.downloads.set('a:md', 'x'.repeat(400)); // exactly 100 tokens
    expect(estimateTokens(400)).toBe(100);
    const fits = await assembleTurnAttachments({ scope, records: [fileRecord('a')], cfg: cfg(100), supportsVision: false });
    expect(fits.mode).toBe('inline');
    expect(fits.block).toContain('<document name="a.txt" id="a">');
    expect(fits.block).toContain('x'.repeat(400));

    const over = await assembleTurnAttachments({ scope, records: [fileRecord('a')], cfg: cfg(99), supportsVision: false });
    expect(over.mode).toBe('paged');
    expect(over.block).not.toContain('xxxx');
    expect(over.block).toContain('session_files_read');
    expect(over.block).toContain('(id a, 4 pages)');
  });

  it('decides for the message as a whole: two files that fit alone but not together are both paged', async () => {
    hoisted.downloads.set('a:md', 'x'.repeat(240));
    hoisted.downloads.set('b:md', 'y'.repeat(240));
    const together = await assembleTurnAttachments({
      scope, records: [fileRecord('a'), fileRecord('b')], cfg: cfg(100), supportsVision: false,
    });
    expect(together.mode).toBe('paged');
    expect(together.block).toContain('"a.txt"');
    expect(together.block).toContain('"b.txt"');
    const alone = await assembleTurnAttachments({ scope, records: [fileRecord('a')], cfg: cfg(100), supportsVision: false });
    expect(alone.mode).toBe('inline');
  });

  it('reads a plain-text file’s own bytes when it was not converted, and says so when nothing is readable', async () => {
    hoisted.downloads.set('raw', 'raw bytes');
    const raw = await assembleTurnAttachments({
      scope, records: [fileRecord('raw', { markdownStatus: 'failed', markdownKey: undefined })], cfg: cfg(1000), supportsVision: false,
    });
    expect(raw.block).toContain('raw bytes');

    const pdf = await assembleTurnAttachments({
      scope, records: [fileRecord('scan', { contentType: 'application/pdf', markdownStatus: 'failed', markdownKey: undefined })], cfg: cfg(1000), supportsVision: false,
    });
    expect(pdf.mode).toBe('none');
    expect(pdf.block).toContain('its text could not be extracted (failed)');
    expect(pdf.attachments).toEqual([{ fileId: 'scan', name: 'scan.txt', mimeType: 'application/pdf', size: 10 }]);
  });

  it('a file that cannot be downloaded is a warning, never a failure', async () => {
    const result = await assembleTurnAttachments({ scope, records: [fileRecord('gone')], cfg: cfg(1000), supportsVision: false });
    expect(result.warnings).toEqual(['File "gone.txt" could not be read.']);
    expect(result.block).toContain('could not be extracted');
  });

  it('images: a part with vision, a note without, and neither counts toward the text budget', async () => {
    hoisted.downloads.set('pic', 'PNGBYTES');
    const image = fileRecord('pic', { name: 'pic.png', contentType: 'image/png', markdownStatus: 'skipped', markdownKey: undefined });
    const withVision = await assembleTurnAttachments({ scope, records: [image], cfg: cfg(1), supportsVision: true });
    expect(withVision.images).toEqual([{ type: 'image_url', image_url: { base64: Buffer.from('PNGBYTES').toString('base64'), media_type: 'image/png' } }]);
    expect(withVision.block).toBe('');
    expect(withVision.attachments[0]).toMatchObject({ name: 'pic.png', mimeType: 'image/png' });

    const without = await assembleTurnAttachments({ scope, records: [image], cfg: cfg(1), supportsVision: false });
    expect(without.images).toEqual([]);
    expect(without.block).toContain('cannot read images');
  });

  it('nothing attached adds nothing', async () => {
    expect(await assembleTurnAttachments({ scope, records: [], cfg: cfg(1000), supportsVision: true })).toMatchObject({ block: '', images: [], attachments: [], mode: 'none' });
  });
});

describe('uploads and the project’s file quotas', () => {
  const conversation = { _id: 'c1', agentKey: 'agent' };
  const actor = { userId: 'u1', licenseType: 'FREE' };
  const allowed = { allowed: true, effectiveLimits: { quotas: {} } };

  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.db.listFileRecordsByConversation.mockResolvedValue([]);
    hoisted.db.countFileRecords.mockResolvedValue(3);
    hoisted.db.sumFileRecordBytes.mockResolvedValue(1000);
    hoisted.db.findFileBucketByKey.mockResolvedValue({ key: 'conversation-files' });
    hoisted.perRequest.mockResolvedValue(allowed);
    hoisted.rate.mockResolvedValue({ allowed: true });
    hoisted.resource.mockResolvedValue({ allowed: true });
    hoisted.uploadFile.mockResolvedValue({ record: { id: 'f1', name: 'a.txt', contentType: 'text/plain', size: 1, markdownStatus: 'succeeded' } });
  });

  const upload = (data: Buffer | string = Buffer.from('a'), config = {}) => uploadSessionFile({
    scope, conversation, agentConfig: { modelKey: 'm', ...config }, fileName: 'a.txt', contentType: 'text/plain', data, actor,
  });

  it('runs the same quota checks the Files API runs, with the file’s size', async () => {
    await upload(Buffer.from('12345'));
    expect(hoisted.perRequest).toHaveBeenCalledWith(expect.objectContaining({ domain: 'file', projectId: 'p1', resourceKey: 'conversation-files' }), { fileSize: 5, filesPerRequest: 1 });
    expect(hoisted.rate).toHaveBeenCalledWith(expect.anything(), { files: 1, requests: 1, storageBytes: 5 });
    expect(hoisted.resource).toHaveBeenCalledWith(expect.anything(), 'filesTotal', 3);
    expect(hoisted.uploadFile).toHaveBeenCalledWith('tenant_x', 't1', 'p1', expect.objectContaining({
      bucketKey: 'conversation-files', convertToMarkdown: true,
      recordExtras: expect.objectContaining({ purpose: 'conversation', conversationId: 'c1', agentKey: 'agent', uploadedBy: 'u1' }),
    }));
  });

  it('answers 429 when a quota refuses, before anything is stored', async () => {
    for (const [mock, value] of [
      [hoisted.perRequest, { allowed: false, reason: 'file too big for plan', effectiveLimits: {} }],
      [hoisted.rate, { allowed: false, reason: 'slow down' }],
      [hoisted.resource, { allowed: false, reason: 'filesTotal exceeded' }],
    ] as const) {
      hoisted.perRequest.mockResolvedValue(allowed); hoisted.rate.mockResolvedValue({ allowed: true }); hoisted.resource.mockResolvedValue({ allowed: true });
      mock.mockResolvedValue(value);
      const error = await upload().catch((e) => e);
      expect(error).toBeInstanceOf(AgentAttachmentError);
      expect(classifyAgentRunError(error)).toMatchObject({ status: 429, error: { type: 'rate_limit_error', code: 'quota_exceeded' } });
    }
    expect(hoisted.uploadFile).not.toHaveBeenCalled();
  });

  it('answers 429 when the plan’s storage is used up', async () => {
    hoisted.perRequest.mockResolvedValue({ allowed: true, effectiveLimits: { quotas: { maxStorageBytes: 1002 } } });
    const error = await upload(Buffer.from('12345')).catch((e) => e);
    expect(error).toMatchObject({ status: 429, message: expect.stringContaining('storageBytes limit exceeded (1005/1002)') });
    hoisted.perRequest.mockResolvedValue({ allowed: true, effectiveLimits: { quotas: { maxStorageBytes: -1 } } });
    await expect(upload(Buffer.from('12345'))).resolves.toMatchObject({ id: 'f1' });
  });

  it('checks the agent’s limits first: size from a base64 body without decoding it, then type, then count', async () => {
    const big = Buffer.alloc(2048, 1).toString('base64');
    expect(await upload(big, { attachments: { maxFileSizeMb: 0.001 } }).catch((e) => e)).toMatchObject({ status: 413 });
    expect(await upload(Buffer.from('a'), { attachments: { allowedMimeTypes: ['image/*'] } }).catch((e) => e)).toMatchObject({ status: 415 });
    hoisted.db.listFileRecordsByConversation.mockResolvedValue([fileRecord('x'), fileRecord('y')]);
    expect(await upload(Buffer.from('a'), { attachments: { maxFiles: 2 } }).catch((e) => e)).toMatchObject({ status: 409, code: 'too_many_files' });
    expect(hoisted.perRequest).not.toHaveBeenCalled();
  });

  it('does not convert an image to markdown', async () => {
    await uploadSessionFile({ scope, conversation, agentConfig: { modelKey: 'm' }, fileName: 'p.png', contentType: 'image/png', data: Buffer.from([1, 2]), actor });
    expect(hoisted.uploadFile).toHaveBeenCalledWith('tenant_x', 't1', 'p1', expect.objectContaining({ convertToMarkdown: false }));
  });

  it('decodes a data URL', async () => {
    await upload(`data:text/plain;base64,${Buffer.from('hello').toString('base64')}`);
    expect(hoisted.uploadFile.mock.calls[0]![3].data.toString()).toBe('hello');
  });
});

describe('the Responses input', () => {
  it('reads the text and the files of the last user message', () => {
    expect(extractResponseUserInput('hi')).toEqual({ text: 'hi', files: [] });
    const input = [
      { role: 'user', content: 'older' },
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'compare these' },
          { type: 'input_file', file_id: 'f1' },
          { type: 'input_file', file_data: 'data:application/pdf;base64,QUJD', filename: 'a.pdf' },
          { type: 'input_image', image_url: 'data:image/png;base64,QUJD' },
          { type: 'input_image', image_url: 'https://example.com/cat.png' },
          { type: 'input_image', file_id: 'f2' },
        ],
      },
    ];
    expect(extractResponseUserInput(input)).toEqual({
      text: 'compare these',
      files: [
        { kind: 'file', fileId: 'f1' },
        { kind: 'file', data: 'data:application/pdf;base64,QUJD', filename: 'a.pdf' },
        { kind: 'image', data: 'data:image/png;base64,QUJD' },
        { kind: 'image', url: 'https://example.com/cat.png' },
        { kind: 'image', fileId: 'f2' },
      ],
    });
    expect(namedFileIds(extractResponseUserInput(input).files)).toEqual(['f1', 'f2']);
  });

  it('a message with files and no text is still a message; unusable parts are skipped; no user message is null', () => {
    expect(extractResponseUserInput([{ role: 'user', content: [{ type: 'input_file', file_id: 'f1' }] }])).toEqual({ text: null, files: [{ kind: 'file', fileId: 'f1' }] });
    expect(extractResponseUserInput([{ role: 'user', content: [{ type: 'input_file' }, { type: 'input_image' }] }])).toEqual({ text: null, files: [] });
    expect(extractResponseUserInput([{ role: 'assistant', content: 'x' }])).toEqual({ text: null, files: [] });
    expect(extractResponseUserInput(undefined)).toEqual({ text: null, files: [] });
  });

  it('keeps the old behaviour for text: the first input_text of the last user message', () => {
    expect(extractResponseUserInput([{ role: 'user', content: [{ type: 'input_text', text: 'a' }, { type: 'input_text', text: 'b' }] }]).text).toBe('a');
  });
});

describe('the saved state', () => {
  it('drops the images of an oversized state, keeps them when it fits, and keeps everything else', () => {
    const image = { type: 'image_url', image_url: { base64: 'A'.repeat(MAX_STATE_BYTES), media_type: 'image/png' } };
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'look at this' }, image] },
      { role: 'assistant', content: 'a cat' },
    ];
    const small = serializeForStorage({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { base64: 'AA==', media_type: 'image/png' } }] }] } as never);
    expect(small).toContain('image_url');

    const text = serializeForStorage({ messages } as never)!;
    expect(text).not.toBeNull();
    expect(text.length).toBeLessThan(MAX_STATE_BYTES);
    expect(text).not.toContain('image_url');
    expect(text).toContain('look at this');
    expect(text).toContain('a cat');
  });
});

describe('approvals and config checks', () => {
  it('the two file tools are read-only: never asked about by default', () => {
    expect(HITL_READ_ONLY_TOOLS).toEqual(expect.arrayContaining(['session_files_list', 'session_files_read']));
    expect(isReadOnlyTool('session_files_read')).toBe(true);
    expect(isReadOnlyTool('session_files_list')).toBe(true);
  });

  it('validates the stored settings', () => {
    const shape = (attachments: unknown) => validateAgentConfigShape({ modelKey: 'm', attachments } as never);
    expect(shape(undefined).errors).toEqual([]);
    expect(shape({ maxFiles: 5, maxFileSizeMb: 10, inlineMaxTokens: 20_000, readPageChars: 10_000, retentionDays: 14, allowedMimeTypes: ['image/*'] }).errors).toEqual([]);
    const errors = shape({ maxFiles: 0, maxFileSizeMb: 100_000, inlineMaxTokens: 5, readPageChars: 10, retentionDays: 0, allowedMimeTypes: [1] }).errors.map((e) => e.field);
    expect(errors).toEqual(expect.arrayContaining([
      'attachments.maxFiles', 'attachments.maxFileSizeMb', 'attachments.inlineMaxTokens', 'attachments.readPageChars', 'attachments.retentionDays', 'attachments.allowedMimeTypes',
    ]));
  });
});
