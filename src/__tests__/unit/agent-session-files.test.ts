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
    findProviderByKey: vi.fn(),
    deleteFileRecord: vi.fn(),
  },
  uploadFile: vi.fn(),
  deleteFile: vi.fn(),
  warn: vi.fn(),
  perRequest: vi.fn(),
  rate: vi.fn(),
  resource: vi.fn(),
}));

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn(async () => hoisted.db) }));
vi.mock('@/lib/core/logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: hoisted.warn }),
}));
vi.mock('@/lib/services/files', () => ({
  uploadFile: hoisted.uploadFile,
  deleteFile: hoisted.deleteFile,
  generateFileRelativeKey: (name: string) => `${name.replace(/\.[^.]+$/, '')}-1700000000000-abcd1234${name.includes('.') ? `.${name.split('.').pop()}` : ''}`,
  downloadFile: vi.fn(async (_db: string, _t: string, _p: string, _bucket: string, key: string, options?: { variant?: string }) => {
    const text = hoisted.downloads.get(`${key}${options?.variant === 'markdown' ? ':md' : ''}`);
    if (text === undefined) throw new Error('File record not found.');
    return { data: Buffer.from(text, 'utf8') };
  }),
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
  attachmentsAvailability,
  cleanupExpiredSessionFiles,
  buildUserTurnContent,
  contentDispositionHeader,
  estimateBase64Size,
  estimateTokens,
  findUnsentSessionFiles,
  isImageMime,
  isMimeAllowed,
  pageCount,
  pageText,
  resolveAttachmentsConfig,
  resolveSessionFilesBucket,
  resolveUploadMimeType,
  sessionFileDisposition,
  stripAttachmentBlock,
  toSessionFileView,
  uploadSessionFile,
  agentTakesAttachments,
  SESSION_FILES_DEFAULTS,
} from '@/lib/services/agents/sessionFiles';
import { normalizeAttachmentsFolder } from '@/lib/services/agents/sessionFilesConfig';
import { sessionFileObjectKey } from '@/lib/services/agents/sessionFilesBucket';
import { extractResponseUserInput, namedFileIds } from '@/lib/services/agents/responseInputFiles';
import { isReadOnlyTool, HITL_READ_ONLY_TOOLS } from '@/lib/services/agents/agentHumanInTheLoop';
import { serializeForStorage, MAX_STATE_BYTES } from '@/lib/services/agents/agentTurnState';
import { validateAgentConfigShape } from '@/lib/services/agents/agentConfigValidation';
import { AgentAttachmentError, classifyAgentRunError } from '@/lib/services/agents/agentErrors';

const scope = { tenantDbName: 'tenant_x', tenantId: 't1', projectId: 'p1' };

function fileRecord(id: string, overrides: Partial<IFileRecord> = {}): IFileRecord {
  return {
    _id: id, tenantId: 't1', projectId: 'p1', providerKey: 'local', bucketKey: 'docs', key: id,
    name: `${id}.txt`, size: 10, contentType: 'text/plain', markdownStatus: 'succeeded', markdownKey: `${id}.md`,
    purpose: 'conversation', conversationId: 'c1', createdBy: 'u1', ...overrides,
  };
}

describe('the settings and their defaults', () => {
  it('an agent with no attachments config gets the documented defaults — and files are OFF', () => {
    expect(resolveAttachmentsConfig(undefined)).toEqual({
      enabled: false, maxFiles: 10, maxFileSizeMb: 20, allowedMimeTypes: [], inlineMaxTokens: 30_000, readPageChars: 20_000, retentionDays: 30,
      folder: 'agent-sessions', attachNewUploads: true, maxImages: 6, maxBytes: 12_000_000, carryRecentImages: 2,
    });
    expect(SESSION_FILES_DEFAULTS).toMatchObject({
      enabled: false, maxFiles: 10, maxFileSizeMb: 20, inlineMaxTokens: 30_000, readPageChars: 20_000, retentionDays: 30,
      folder: 'agent-sessions', attachNewUploads: true, maxImages: 6, maxBytes: 12_000_000, carryRecentImages: 2,
    });
  });

  it('takes a stored value over the default, and ignores values that make no sense', () => {
    expect(resolveAttachmentsConfig({ enabled: true, maxFiles: 3, maxFileSizeMb: 1.5, inlineMaxTokens: 500, readPageChars: 1000, retentionDays: 2, allowedMimeTypes: ['image/*', ' '], bucketKey: ' mine ', folder: '/uploads//2024/', attachNewUploads: false, maxImages: 3, maxBytes: 5_000_000, carryRecentImages: 0 }))
      .toEqual({
        enabled: true, maxFiles: 3, maxFileSizeMb: 1.5, allowedMimeTypes: ['image/*'], inlineMaxTokens: 500, readPageChars: 1000, retentionDays: 2,
        bucketKey: 'mine', folder: 'uploads/2024', attachNewUploads: false, maxImages: 3, maxBytes: 5_000_000, carryRecentImages: 0,
      });
    expect(resolveAttachmentsConfig({ maxFiles: -1, maxFileSizeMb: 0, readPageChars: Number.NaN, maxImages: 0, maxBytes: -5, carryRecentImages: -1 }))
      .toMatchObject({ maxFiles: 10, maxFileSizeMb: 20, readPageChars: 20_000, maxImages: 6, maxBytes: 12_000_000, carryRecentImages: 2 });
    // 0 is a real choice for "never re-attach", unlike the limits above.
    expect(resolveAttachmentsConfig({ carryRecentImages: 0 }).carryRecentImages).toBe(0);
  });

  it('only "on, with a bucket" takes attachments — not by default, not without a bucket, not a connected agent', () => {
    expect(agentTakesAttachments({ modelKey: 'm' })).toBe(false);
    expect(agentTakesAttachments({ modelKey: 'm', attachments: { enabled: true, bucketKey: 'docs' } })).toBe(true);
    // Older data: switched on, no bucket named — treated as off.
    expect(agentTakesAttachments({ modelKey: 'm', attachments: { enabled: true } })).toBe(false);
    expect(agentTakesAttachments({ modelKey: 'm', attachments: { enabled: true, bucketKey: '  ' } })).toBe(false);
    // A bucket alone does not switch it on.
    expect(agentTakesAttachments({ modelKey: 'm', attachments: { bucketKey: 'docs' } })).toBe(false);
    expect(agentTakesAttachments({ modelKey: 'm', attachments: { enabled: false, bucketKey: 'docs' } })).toBe(false);
    expect(agentTakesAttachments({ kind: 'external', connection: { protocol: 'a2a', url: 'https://x' }, attachments: { enabled: true, bucketKey: 'docs' } } as never)).toBe(false);
    expect(agentTakesAttachments(undefined)).toBe(false);
  });

  it('says why an agent takes no attachments', () => {
    expect(attachmentsAvailability({ modelKey: 'm' })).toEqual({ available: false, reason: 'disabled' });
    expect(attachmentsAvailability({ modelKey: 'm', attachments: { enabled: true } })).toEqual({ available: false, reason: 'not_configured' });
    expect(attachmentsAvailability({ kind: 'external', connection: { protocol: 'a2a', url: 'https://x' } } as never)).toEqual({ available: false, reason: 'external' });
    expect(attachmentsAvailability({ modelKey: 'm', attachments: { enabled: true, bucketKey: 'docs' } })).toMatchObject({ available: true, cfg: { bucketKey: 'docs' } });
  });

  it('normalises the folder: slashes trimmed and collapsed, nothing that could escape the layout', () => {
    expect(normalizeAttachmentsFolder('  /a//b/c/ ')).toEqual({ folder: 'a/b/c' });
    expect(normalizeAttachmentsFolder('a\\b')).toEqual({ folder: 'a/b' });
    expect(normalizeAttachmentsFolder('')).toEqual({ folder: '' });
    expect(normalizeAttachmentsFolder(undefined)).toEqual({ folder: '' });
    expect(normalizeAttachmentsFolder('a.b_c-d/E1')).toEqual({ folder: 'a.b_c-d/E1' });
    for (const bad of ['../x', 'a/../b', 'a/./b', 'a b', 'ü', 'a*', 'x'.repeat(201)]) {
      expect(normalizeAttachmentsFolder(bad).error, bad).toBeTruthy();
    }
    expect(normalizeAttachmentsFolder(5).error).toBeTruthy();
    // A stored folder that is not valid cannot steer where files go: the default applies.
    expect(resolveAttachmentsConfig({ folder: '../../etc' }).folder).toBe('agent-sessions');
    expect(resolveAttachmentsConfig({ folder: '' }).folder).toBe('agent-sessions');
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
    const image = { type: 'image_url' as const, image_url: { url: 'session-file://pic' }, fileId: 'pic', name: 'cat "1".png' };
    // Each image is a reference with a text handle in front of it that names the file.
    expect(buildUserTurnContent('look', { ...none, images: [image] })).toEqual([
      { type: 'text', text: 'look' },
      { type: 'text', text: '[Attached image: "cat &quot;1&quot;.png" (id pic)]' },
      image,
    ]);
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
    // A reference, not the bytes: nothing was read from the bucket to build the turn.
    expect(withVision.images).toEqual([{ type: 'image_url', image_url: { url: 'session-file://pic' }, fileId: 'pic', name: 'pic.png' }]);
    expect(JSON.stringify(withVision)).not.toContain(Buffer.from('PNGBYTES').toString('base64'));
    // The block names the attachment even when it is the only one.
    expect(withVision.block).toBe(`${ATTACHMENT_BLOCK_MARKER}The person attached 1 file: 1 image shown below.\n</attachments>`);
    expect(withVision.attachments[0]).toMatchObject({ name: 'pic.png', mimeType: 'image/png' });

    const without = await assembleTurnAttachments({ scope, records: [image], cfg: cfg(1), supportsVision: false });
    expect(without.images).toEqual([]);
    expect(without.block).toContain('The person attached 1 file: 1 image not shown.');
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
  const bucket = { key: 'docs', providerKey: 'local', status: 'active' };
  const provider = { key: 'local', type: 'file', driver: 'local-filesystem', status: 'active', label: 'Local' };
  /** The attachments setting of an agent that takes files: on, with a bucket, plus any overrides. */
  const on = (attachments: Record<string, unknown> = {}) => ({ enabled: true, bucketKey: 'docs', ...attachments });

  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.db.listFileRecordsByConversation.mockResolvedValue([]);
    hoisted.db.countFileRecords.mockResolvedValue(3);
    hoisted.db.sumFileRecordBytes.mockResolvedValue(1000);
    hoisted.db.findFileBucketByKey.mockResolvedValue(bucket);
    hoisted.db.findProviderByKey.mockResolvedValue(provider);
    hoisted.perRequest.mockResolvedValue(allowed);
    hoisted.rate.mockResolvedValue({ allowed: true });
    hoisted.resource.mockResolvedValue({ allowed: true });
    hoisted.uploadFile.mockResolvedValue({ record: { id: 'f1', name: 'a.txt', contentType: 'text/plain', size: 1, markdownStatus: 'succeeded', bucketKey: 'docs', key: 'agent-sessions/agent/c1/a.txt' } });
  });

  const upload = (data: Buffer | string = Buffer.from('a'), attachments: Record<string, unknown> | null = {}) => uploadSessionFile({
    scope, conversation, agentConfig: { modelKey: 'm', ...(attachments ? { attachments: on(attachments) } : {}) }, fileName: 'a.txt', contentType: 'text/plain', data, actor,
  });

  it('runs the same quota checks the Files API runs, with the file’s size', async () => {
    await upload(Buffer.from('12345'));
    expect(hoisted.perRequest).toHaveBeenCalledWith(expect.objectContaining({ domain: 'file', projectId: 'p1', resourceKey: 'docs' }), { fileSize: 5, filesPerRequest: 1 });
    expect(hoisted.rate).toHaveBeenCalledWith(expect.anything(), { files: 1, requests: 1, storageBytes: 5 });
    expect(hoisted.resource).toHaveBeenCalledWith(expect.anything(), 'filesTotal', 3);
    expect(hoisted.uploadFile).toHaveBeenCalledWith('tenant_x', 't1', 'p1', expect.objectContaining({
      bucketKey: 'docs', convertToMarkdown: true,
      recordExtras: expect.objectContaining({ purpose: 'conversation', conversationId: 'c1', agentKey: 'agent', uploadedBy: 'u1' }),
    }));
  });

  it('puts the object at <folder>/<agentKey>/<sessionId>/<unique name> and reports where', async () => {
    const view = await upload(Buffer.from('a'));
    expect(hoisted.uploadFile.mock.calls[0]![3].keyHint).toBe('agent-sessions/agent/c1/a-1700000000000-abcd1234.txt');
    expect(view).toMatchObject({ bucketKey: 'docs', path: 'agent-sessions/agent/c1/a.txt' });

    await upload(Buffer.from('a'), { folder: '/team//uploads/' });
    expect(hoisted.uploadFile.mock.calls[1]![3].keyHint).toBe('team/uploads/agent/c1/a-1700000000000-abcd1234.txt');
  });

  it('builds the object key from safe segments only', () => {
    expect(sessionFileObjectKey({ folder: 'f', agentKey: 'my agent/../x', conversationId: '64f0c0ffee', uniqueName: 'u.txt' })).toBe('f/my-agent-.-x/64f0c0ffee/u.txt');
    expect(sessionFileObjectKey({ folder: 'f', agentKey: '..', conversationId: 'c', uniqueName: 'u' })).toBe('f/x/c/u');
  });

  it('answers 403 for an agent that takes no files: off by default, no bucket, or a connected agent', async () => {
    const off = await upload(Buffer.from('a'), null).catch((e) => e);
    expect(off).toMatchObject({ status: 403, code: 'attachments_disabled', message: 'This agent does not take attachments.' });
    const noBucket = await upload(Buffer.from('a'), { bucketKey: undefined }).catch((e) => e);
    expect(noBucket).toMatchObject({ status: 403, code: 'attachments_disabled', message: 'Files are not set up for this agent.' });
    expect(hoisted.uploadFile).not.toHaveBeenCalled();
  });

  it('answers 409 storage_unavailable, naming the bucket, when it cannot take a file — before any quota is spent', async () => {
    const refusal = async () => classifyAgentRunError(await upload(Buffer.from('a')).catch((e) => e));

    hoisted.db.findFileBucketByKey.mockResolvedValue(null);
    expect(await refusal()).toMatchObject({ status: 409, error: { code: 'storage_unavailable', message: expect.stringContaining('the bucket "docs" does not exist in this project') } });

    hoisted.db.findFileBucketByKey.mockResolvedValue({ ...bucket, status: 'disabled' });
    expect(await refusal()).toMatchObject({ status: 409, error: { code: 'storage_unavailable', message: expect.stringContaining('the bucket "docs" is disabled') } });

    hoisted.db.findFileBucketByKey.mockResolvedValue(bucket);
    hoisted.db.findProviderByKey.mockResolvedValue({ ...provider, status: 'disabled' });
    expect(await refusal()).toMatchObject({ status: 409, error: { code: 'storage_unavailable', message: expect.stringContaining('"local" of the bucket "docs" is not active') } });

    // Not assigned to this project: exists unscoped, not with the project.
    hoisted.db.findProviderByKey.mockImplementation(async (_t: string, _k: string, projectId?: string) => (projectId ? null : provider));
    expect(await refusal()).toMatchObject({ status: 409, error: { code: 'storage_unavailable', message: expect.stringContaining('is not assigned to this project') } });

    // Gone altogether.
    hoisted.db.findProviderByKey.mockResolvedValue(null);
    expect(await refusal()).toMatchObject({ status: 409, error: { code: 'storage_unavailable', message: expect.stringContaining('no longer exists') } });

    expect(hoisted.perRequest).not.toHaveBeenCalled();
    expect(hoisted.uploadFile).not.toHaveBeenCalled();
  });

  it('resolves the bucket only when one is named: 409 storage_not_configured otherwise', async () => {
    await expect(resolveSessionFilesBucket(scope, resolveAttachmentsConfig({ enabled: true, bucketKey: 'docs' }))).resolves.toBe('docs');
    const error = await resolveSessionFilesBucket(scope, resolveAttachmentsConfig({ enabled: true })).catch((e) => e);
    expect(classifyAgentRunError(error)).toMatchObject({ status: 409, error: { code: 'storage_not_configured' } });
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
    expect(await upload(big, { maxFileSizeMb: 0.001 }).catch((e) => e)).toMatchObject({ status: 413 });
    expect(await upload(Buffer.from('a'), { allowedMimeTypes: ['image/*'] }).catch((e) => e)).toMatchObject({ status: 415 });
    hoisted.db.listFileRecordsByConversation.mockResolvedValue([fileRecord('x'), fileRecord('y')]);
    expect(await upload(Buffer.from('a'), { maxFiles: 2 }).catch((e) => e)).toMatchObject({ status: 409, code: 'too_many_files' });
    expect(hoisted.perRequest).not.toHaveBeenCalled();
  });

  it('does not convert an image to markdown', async () => {
    await uploadSessionFile({ scope, conversation, agentConfig: { modelKey: 'm', attachments: on() }, fileName: 'p.png', contentType: 'image/png', data: Buffer.from([1, 2]), actor });
    expect(hoisted.uploadFile).toHaveBeenCalledWith('tenant_x', 't1', 'p1', expect.objectContaining({ convertToMarkdown: false }));
  });

  it('decodes a data URL', async () => {
    await upload(`data:text/plain;base64,${Buffer.from('hello').toString('base64')}`);
    expect(hoisted.uploadFile.mock.calls[0]![3].data.toString()).toBe('hello');
  });

  it('the file view carries where the file is stored', () => {
    expect(toSessionFileView(fileRecord('a', { key: 'agent-sessions/agent/c1/a.txt' }))).toMatchObject({ id: 'a', bucketKey: 'docs', path: 'agent-sessions/agent/c1/a.txt' });
  });
});

describe('the retention sweep when storage is gone', () => {
  const expired = (id: string, overrides: Partial<IFileRecord> = {}) => fileRecord(id, { expiresAt: new Date(0), ...overrides });
  const sweepDb = (rows: IFileRecord[]) => ({ ...hoisted.db, listExpiredConversationFiles: vi.fn(async () => rows) });

  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.db.deleteFileRecord.mockResolvedValue(true);
    hoisted.db.findFileBucketByKey.mockResolvedValue({ key: 'docs', providerKey: 'local', status: 'active' });
    hoisted.db.findProviderByKey.mockResolvedValue({ key: 'local', type: 'file', status: 'active' });
    hoisted.deleteFile.mockResolvedValue(true);
  });

  it('drops the record of an expired file whose bucket is gone and logs the orphaned object with a stable code', async () => {
    hoisted.db.findFileBucketByKey.mockResolvedValue(null);
    const deleted = await cleanupExpiredSessionFiles(sweepDb([expired('a', { key: 'agent-sessions/bot/c1/a.txt' })]) as never, 'tenant_x', new Date());

    expect(deleted).toBe(1);
    expect(hoisted.deleteFile).not.toHaveBeenCalled();
    expect(hoisted.db.deleteFileRecord).toHaveBeenCalledWith('a');
    expect(hoisted.warn).toHaveBeenCalledWith(expect.stringContaining('storage is unavailable'), expect.objectContaining({
      code: 'session_file_orphaned', fileId: 'a', bucketKey: 'docs', objectKey: 'agent-sessions/bot/c1/a.txt', reason: 'bucket_missing',
    }));
  });

  it('does the same for a disabled bucket, and an inactive or unassigned provider — none of them comes back by retrying', async () => {
    const reasons: string[] = [];
    for (const [bucket, provider] of [
      [{ key: 'docs', providerKey: 'local', status: 'disabled' }, { key: 'local', type: 'file', status: 'active' }],
      [{ key: 'docs', providerKey: 'local', status: 'active' }, { key: 'local', type: 'file', status: 'disabled' }],
      [{ key: 'docs', providerKey: 'local', status: 'active' }, null],
    ] as const) {
      hoisted.warn.mockClear();
      hoisted.db.findFileBucketByKey.mockResolvedValue(bucket);
      hoisted.db.findProviderByKey.mockResolvedValue(provider);
      expect(await cleanupExpiredSessionFiles(sweepDb([expired('a')]) as never, 'tenant_x', new Date())).toBe(1);
      reasons.push((hoisted.warn.mock.calls[0]![1] as { reason: string }).reason);
    }
    expect(reasons).toEqual(['bucket_disabled', 'provider_inactive', 'provider_missing']);
    expect(hoisted.deleteFile).not.toHaveBeenCalled();
  });

  it('a file in a healthy bucket is deleted through the file service, not dropped', async () => {
    expect(await cleanupExpiredSessionFiles(sweepDb([expired('a')]) as never, 'tenant_x', new Date())).toBe(1);
    expect(hoisted.deleteFile).toHaveBeenCalledWith('tenant_x', 't1', 'p1', 'docs', 'a', 'system');
    expect(hoisted.warn).not.toHaveBeenCalled();
  });

  it('skips a row without a project instead of asking for it again in every batch', async () => {
    const rows = [expired('orphan', { projectId: undefined }), expired('ok')];
    const listing = vi.fn(async (_now: Date, limit: number) => rows.slice(0, limit));
    hoisted.deleteFile.mockImplementation(async (...args: unknown[]) => {
      rows.splice(rows.findIndex((row) => String(row._id) === args[4]), 1);
      return true;
    });
    const deleted = await cleanupExpiredSessionFiles({ ...hoisted.db, listExpiredConversationFiles: listing } as never, 'tenant_x', new Date(), { batchSize: 2, maxBatches: 3 });
    expect(deleted).toBe(1);
    // The second ask is for the batch plus the row it had to skip.
    expect(listing.mock.calls.map((call) => call[1])).toEqual([2, 3]);
  });
});

describe('files nobody has sent yet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('are the session’s files no message has carried, oldest first, of this project only', async () => {
    hoisted.db.listFileRecordsByConversation.mockResolvedValue([
      fileRecord('sent'),
      fileRecord('new-1'),
      fileRecord('elsewhere', { projectId: 'other' }),
      fileRecord('not-a-session-file', { purpose: undefined }),
      fileRecord('new-2'),
    ]);
    const conversation = {
      _id: 'c1',
      messages: [
        { role: 'user' as const, content: 'hi', timestamp: new Date(), attachments: [{ fileId: 'sent', name: 'sent.txt', mimeType: 'text/plain', size: 1 }] },
        { role: 'assistant' as const, content: 'ok', timestamp: new Date() },
      ],
    };
    const unsent = await findUnsentSessionFiles(scope, conversation);
    expect(unsent.map((record) => String(record._id))).toEqual(['new-1', 'new-2']);
  });

  it('are all of them for a session with no messages (upload before the first message)', async () => {
    hoisted.db.listFileRecordsByConversation.mockResolvedValue([fileRecord('a'), fileRecord('b')]);
    expect((await findUnsentSessionFiles(scope, { _id: 'c1', messages: [] })).map((record) => String(record._id))).toEqual(['a', 'b']);
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
  it('holds an image as a short reference, so it never decides whether a state fits', () => {
    const reference = { type: 'image_url', image_url: { url: 'session-file://pic' }, fileId: 'pic', name: 'cat.png' };
    const text = serializeForStorage({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'look at this' }, reference] },
        { role: 'assistant', content: 'a cat' },
      ],
    } as never)!;
    expect(text).toContain('session-file://pic');
    expect(text).toContain('look at this');
    expect(text.length).toBeLessThan(400);
  });

  it('no longer rewrites image parts to fit: bytes that cannot shrink mean no stored state (the transcript replay takes over)', () => {
    const inline = { type: 'image_url', image_url: { base64: 'A'.repeat(MAX_STATE_BYTES), media_type: 'image/png' } };
    expect(serializeForStorage({ messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, inline] }] } as never)).toBeNull();
  });
});

describe('serving a file’s bytes', () => {
  it('pictures open in place; everything else downloads unless an inline-safe type is asked to open', () => {
    expect(sessionFileDisposition('image/png')).toBe('inline');
    expect(sessionFileDisposition('image/jpeg; charset=binary')).toBe('inline');
    expect(sessionFileDisposition('image/png', 'attachment')).toBe('attachment');
    expect(sessionFileDisposition('application/pdf')).toBe('attachment');
    expect(sessionFileDisposition('application/pdf', 'inline')).toBe('inline');
    expect(sessionFileDisposition('text/markdown; charset=utf-8', 'inline')).toBe('inline');
    expect(sessionFileDisposition('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'inline')).toBe('attachment');
  });

  it('SVG, HTML and the other active types always download, whatever is asked', () => {
    for (const type of ['image/svg+xml', 'text/html', 'TEXT/HTML; charset=utf-8', 'application/xhtml+xml', 'text/xml', 'application/xml', 'text/javascript', 'application/javascript', 'text/css']) {
      expect(sessionFileDisposition(type, 'inline'), type).toBe('attachment');
      expect(sessionFileDisposition(type), type).toBe('attachment');
    }
  });

  it('puts only a safe file name in Content-Disposition, and keeps the real one in filename*', () => {
    expect(contentDispositionHeader('inline', 'cat.png')).toBe('inline; filename="cat.png"; filename*=UTF-8\'\'cat.png');
    const header = contentDispositionHeader('attachment', 'a"b;c\r\nX-Evil: 1/../../etc\\passwd.txt');
    expect(header).not.toMatch(/[\r\n]/);
    expect(header).toContain('filename="a_b_cX-Evil: 1_.._.._etc_passwd.txt"');
    expect(header.split('filename="')[1]!.split('"')[0]).not.toMatch(/["/\\;%]/);
    const turkish = contentDispositionHeader('attachment', 'Çeviri özeti (1).pdf');
    expect(turkish).toContain('filename="_eviri _zeti (1).pdf"');
    expect(turkish).toContain("filename*=UTF-8''%C3%87eviri%20%C3%B6zeti%20%281%29.pdf");
    expect(contentDispositionHeader('attachment', '  \u0000 ')).toContain('filename="file"');
    expect(contentDispositionHeader('attachment', 'x'.repeat(500)).length).toBeLessThan(500);
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
    expect(shape({ enabled: true, bucketKey: 'docs', maxFiles: 5, maxFileSizeMb: 10, inlineMaxTokens: 20_000, readPageChars: 10_000, retentionDays: 14, allowedMimeTypes: ['image/*'], folder: 'uploads/x', attachNewUploads: false }).errors).toEqual([]);
    const errors = shape({ maxFiles: 0, maxFileSizeMb: 100_000, inlineMaxTokens: 5, readPageChars: 10, retentionDays: 0, allowedMimeTypes: [1] }).errors.map((e) => e.field);
    expect(errors).toEqual(expect.arrayContaining([
      'attachments.maxFiles', 'attachments.maxFileSizeMb', 'attachments.inlineMaxTokens', 'attachments.readPageChars', 'attachments.retentionDays', 'attachments.allowedMimeTypes',
    ]));
  });

  it('switching files on needs a bucket; off needs nothing', () => {
    const shape = (attachments: unknown) => validateAgentConfigShape({ modelKey: 'm', attachments } as never);
    expect(shape({ enabled: true }).errors).toEqual([{ field: 'attachments.bucketKey', message: 'Choose a bucket to keep the files in' }]);
    expect(shape({ enabled: true, bucketKey: '  ' }).errors.map((e) => e.field)).toEqual(['attachments.bucketKey']);
    expect(shape({ enabled: false }).errors).toEqual([]);
    expect(shape({ retentionDays: 7 }).errors).toEqual([]);
    expect(shape({ enabled: true, bucketKey: 5 }).errors.map((e) => e.field)).toEqual(['attachments.bucketKey']);
  });

  it('rejects a folder that could leave the layout, and flags that are not flags', () => {
    const shape = (attachments: unknown) => validateAgentConfigShape({ modelKey: 'm', attachments } as never);
    expect(shape({ folder: '../x' }).errors.map((e) => e.field)).toEqual(['attachments.folder']);
    expect(shape({ folder: 'a b' }).errors.map((e) => e.field)).toEqual(['attachments.folder']);
    expect(shape({ enabled: 'yes', attachNewUploads: 1 }).errors.map((e) => e.field)).toEqual(['attachments.enabled', 'attachments.attachNewUploads']);
  });
});
