/**
 * The shared foundation of the Document Store screens, without a DOM: the file-kind and preview rules, the
 * Files API client (routes, error parsing, every fetcher against a mocked `fetch`), the error wording, the
 * query keys and polling rules, the invalidation helpers on a real query client, the access mapping and the
 * message modules of the Files screens (parity in English and Turkish).
 * (The hooks and components are exercised in files-foundation-ui.test.ts.)
 */

import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver, type QueryKey } from '@tanstack/react-query';
import { ApiError } from '@/lib/api/client';
import { classifyFileKind } from '@/lib/database/fileTypeFilter';
import { PREVIEW_MAX_BYTES as SERVER_PREVIEW_MAX_BYTES, planPreview } from '@/lib/services/files/preview';
import { en } from '@/lib/i18n/messages/en';
import { tr } from '@/lib/i18n/messages/tr';
import { filesBucketEn } from '@/lib/i18n/messages/filesBucket.en';
import { filesBucketTr } from '@/lib/i18n/messages/filesBucket.tr';
import { filesCommonEn } from '@/lib/i18n/messages/filesCommon.en';
import { filesCommonTr } from '@/lib/i18n/messages/filesCommon.tr';
import { filesCreateEn } from '@/lib/i18n/messages/filesCreate.en';
import { filesCreateTr } from '@/lib/i18n/messages/filesCreate.tr';
import { filesDetailEn } from '@/lib/i18n/messages/filesDetail.en';
import { filesDetailTr } from '@/lib/i18n/messages/filesDetail.tr';
import { filesListEn } from '@/lib/i18n/messages/filesList.en';
import { filesListTr } from '@/lib/i18n/messages/filesList.tr';
import { filesUploadEn } from '@/lib/i18n/messages/filesUpload.en';
import { filesUploadTr } from '@/lib/i18n/messages/filesUpload.tr';
import {
  FILES_ERROR_CODES,
  FilesApiError,
  archiveFileName,
  archiveObjects,
  batchDeleteObjects,
  clientApiRoutes,
  convertObject,
  createBucket,
  deleteBucket,
  deleteObject,
  downloadObject,
  encodeObjectKey,
  fetchObjectText,
  filesRoutes,
  getBucket,
  getFilesLimits,
  getObject,
  importFromStorage,
  isFilesApiError,
  listBuckets,
  listFileProviders,
  listObjects,
  objectDownloadUrl,
  objectPreviewUrl,
  parseContentDispositionFileName,
  testFileProvider,
  updateBucket,
  uploadObject,
} from '@/components/files/filesApi';
import {
  FILE_KINDS,
  PREVIEW_MAX_BYTES,
  canPreviewMarkdown,
  fileKindOf,
  hasMarkdownCopy,
  markdownFileName,
  previewKindOf,
  type FileKind,
  type FileLike,
} from '@/components/files/shared/fileKind';
import {
  FILES_CONTEXT_ERROR_KEYS,
  FILES_ERROR_CODE_KEYS,
  FILES_ERROR_CODES_IN_SERVER_WORDS,
  filesErrorMessage,
  type FilesTranslator,
} from '@/components/files/shared/filesErrors';
import { formatBytes, formatCount } from '@/components/files/shared/format';
import { providerHref } from '@/components/files/shared/links';
import { filesAccessFromPermissions } from '@/components/files/useFilesAccess';
import {
  DELETE_POLL_MAX_MS,
  MARKDOWN_POLL_MAX_MS,
  deletingBucketsSignature,
  filesKeys,
  flattenObjectPages,
  forgetBucket,
  forgetObjects,
  getFilesProjectScope,
  hasPendingMarkdown,
  invalidateBucketContent,
  invalidateBucketMeta,
  invalidateBuckets,
  invalidateObject,
  invalidateProviderHealth,
  isBucketDeleting,
  normalizeObjectsQuery,
  pendingMarkdownSignature,
  pollDelayMs,
  retryUnlessClientError,
} from '@/components/files/useFilesQueries';

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ── helpers ─────────────────────────────────────────────────────────────── */

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

interface SeenCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  cache?: RequestCache;
}

function mockFetch(handler: (call: SeenCall) => Response | Promise<Response>) {
  const calls: SeenCall[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call: SeenCall = {
      url: String(input),
      method: (init?.method ?? 'GET').toUpperCase(),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
      cache: init?.cache,
    };
    calls.push(call);
    return handler(call);
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

const asView = <T>(value: Record<string, unknown>) => value as unknown as T;

/** A translator over the real `files.common` messages of a language. */
function commonTranslator(language: typeof en | typeof tr): FilesTranslator {
  return (key, values) => {
    const found = key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], language.files.common);
    if (typeof found !== 'string') throw new Error(`missing files.common.${key}`);
    return found.replace(/\{(\w+)\}/g, (_match, name: string) => String(values?.[name] ?? `{${name}}`));
  };
}

/* ── file kinds and previews ─────────────────────────────────────────────── */

describe('fileKindOf', () => {
  const OFFICE = {
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };
  const cases: Array<[string, FileLike, FileKind]> = [
    ['pdf by type', { contentType: 'application/pdf' }, 'pdf'],
    ['type parameters and case are ignored', { contentType: 'Application/PDF; charset=binary' }, 'pdf'],
    ['image by type', { contentType: 'image/png' }, 'image'],
    ['text by type', { contentType: 'text/plain; charset=utf-8' }, 'text'],
    ['json is text', { contentType: 'application/json' }, 'text'],
    ['legacy word', { contentType: 'application/msword' }, 'office'],
    ['legacy excel', { contentType: 'application/vnd.ms-excel' }, 'office'],
    ['legacy powerpoint', { contentType: 'application/vnd.ms-powerpoint' }, 'office'],
    ['docx', { contentType: OFFICE.docx }, 'office'],
    ['xlsx', { contentType: OFFICE.xlsx }, 'office'],
    ['pptx', { contentType: OFFICE.pptx }, 'office'],
    ['opendocument', { contentType: 'application/vnd.oasis.opendocument.text' }, 'office'],
    ['an archive is other', { contentType: 'application/zip', name: 'bundle.zip' }, 'other'],
    ['a generic type falls back to the extension', { contentType: 'application/octet-stream', name: 'Report.PDF' }, 'pdf'],
    ['no type: markdown by extension', { name: 'notes.md' }, 'text'],
    ['no type: an image by extension', { name: 'photo.JPG' }, 'image'],
    ['an empty type: a spreadsheet by extension', { contentType: '', name: 'budget.xlsx' }, 'office'],
    ['the key is used when there is no name', { key: 'a/b/slides.pptx' }, 'office'],
    ['the type wins over the extension', { contentType: 'image/png', name: 'x.pdf' }, 'image'],
    ['nothing known', {}, 'other'],
    ['nulls', { contentType: null, name: null, key: null }, 'other'],
    ['no extension', { name: 'Makefile' }, 'other'],
  ];

  it.each(cases)('%s', (_label, file, expected) => {
    expect(fileKindOf(file)).toBe(expected);
  });

  it('lists the five classes of the server type filter, in its order', () => {
    expect(FILE_KINDS).toEqual(['pdf', 'image', 'text', 'office', 'other']);
  });

  it('is the very decision the server filters with', () => {
    for (const [, file] of cases) {
      expect(fileKindOf(file)).toBe(classifyFileKind(file.contentType, file.name || file.key));
    }
  });
});

describe('previewKindOf', () => {
  it('previews only what the server serves inline', () => {
    expect(previewKindOf({ contentType: 'image/png', size: 10 })).toBe('image');
    expect(previewKindOf({ contentType: 'image/jpeg' })).toBe('image');
    expect(previewKindOf({ contentType: 'image/gif' })).toBe('image');
    expect(previewKindOf({ contentType: 'image/webp' })).toBe('image');
    expect(previewKindOf({ contentType: 'application/pdf; x=y' })).toBe('pdf');
    for (const type of ['text/plain', 'text/markdown', 'text/csv', 'application/json']) {
      expect(previewKindOf({ contentType: type })).toBe('text');
    }
    for (const type of ['image/svg+xml', 'text/html', 'application/octet-stream', 'application/zip', '', null, undefined]) {
      expect(previewKindOf({ contentType: type })).toBeNull();
    }
  });

  it('refuses a file over the size limit, accepts one exactly at it', () => {
    expect(previewKindOf({ contentType: 'image/png', size: PREVIEW_MAX_BYTES })).toBe('image');
    expect(previewKindOf({ contentType: 'image/png', size: PREVIEW_MAX_BYTES + 1 })).toBeNull();
  });

  it('agrees with the server preview planner for every type and size', () => {
    expect(PREVIEW_MAX_BYTES).toBe(SERVER_PREVIEW_MAX_BYTES);
    const types = [
      'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/bmp', 'application/pdf',
      'application/pdf; charset=binary', 'text/plain', 'text/markdown', 'text/csv', 'text/html', 'text/xml',
      'application/json', 'application/xml', 'application/zip', 'application/octet-stream', '',
    ];
    for (const contentType of types) {
      for (const size of [0, 1024, PREVIEW_MAX_BYTES, PREVIEW_MAX_BYTES + 1]) {
        let servable = true;
        try {
          planPreview({ contentType, size });
        } catch {
          servable = false;
        }
        expect(previewKindOf({ contentType, size }) !== null, `${contentType || '(none)'} ${size}`).toBe(servable);
      }
    }
  });

  it('previews a Markdown copy that exists and is small, whatever the status of the last conversion says', () => {
    expect(canPreviewMarkdown({ markdownKey: 'a.md', markdownSize: 100 })).toBe(true);
    expect(canPreviewMarkdown({ markdownKey: 'a.md' })).toBe(true);
    expect(canPreviewMarkdown({ markdownKey: 'a.md', markdownSize: PREVIEW_MAX_BYTES })).toBe(true);
    expect(canPreviewMarkdown({ markdownKey: 'a.md', markdownSize: PREVIEW_MAX_BYTES + 1 })).toBe(false);
    for (const markdownKey of ['', null, undefined]) {
      expect(canPreviewMarkdown({ markdownKey })).toBe(false);
      expect(canPreviewMarkdown({ markdownKey, markdownSize: 100 })).toBe(false);
    }
    expect(canPreviewMarkdown({})).toBe(false);
  });

  it('keeps showing the earlier Markdown copy while a new conversion runs, or after one failed or was skipped', () => {
    // The server keeps the old `markdownKey` through a re-conversion; only a record without a copy has nothing to show.
    expect(hasMarkdownCopy({ markdownKey: 'a.md' })).toBe(true);
    expect(hasMarkdownCopy({ markdownKey: '' })).toBe(false);
    expect(hasMarkdownCopy({ markdownKey: null })).toBe(false);
    expect(hasMarkdownCopy({})).toBe(false);
  });
});

describe('markdownFileName', () => {
  /** The server's own rule for the name of the Markdown copy (`path.extname`), as an oracle. */
  const serverRule = (key: string) => {
    if (key.includes('.')) {
      const ext = path.extname(key);
      if (ext && ext.toLowerCase() !== '.md') return `${key.slice(0, key.length - ext.length)}.md`;
    }
    return `${key}.md`;
  };

  it('replaces the extension, and keeps a Markdown original beside its copy', () => {
    expect(markdownFileName('report.pdf')).toBe('report.md');
    expect(markdownFileName('notes.md')).toBe('notes.md.md');
    expect(markdownFileName('README')).toBe('README.md');
  });

  it('names the copy the way the server does', () => {
    const names = [
      'report.pdf', 'notes.md', 'NOTES.MD', 'archive.tar.gz', 'README', '.env', '.hidden.txt', 'file.',
      'a.b.c.docx', 'dir.v1/readme', 'dir.v1/readme.pdf', 'a/b/c.xlsx', '',
    ];
    for (const name of names) expect(markdownFileName(name), name).toBe(serverRule(name));
  });
});

describe('formatBytes and formatCount', () => {
  it('prints the app’s size style, carried on to GB and TB', () => {
    const GIB = 1024 ** 3;
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(10 * 1024)).toBe('10 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(20 * 1024 * 1024)).toBe('20 MB');
    expect(formatBytes(GIB)).toBe('1.0 GB');
    expect(formatBytes(12 * GIB)).toBe('12 GB');
    expect(formatBytes(2 * 1024 * GIB)).toBe('2.0 TB');
  });

  it('prints a dash for a size that is not known', () => {
    for (const value of [undefined, null, Number.NaN, -1, Number.POSITIVE_INFINITY]) expect(formatBytes(value)).toBe('—');
  });

  it('groups digits in the viewer’s language', () => {
    expect(formatCount(1284, 'en')).toBe('1,284');
    expect(formatCount(1284, 'tr')).toBe('1.284');
    expect(formatCount(undefined, 'en')).toBe('—');
  });

  it('links a provider by its record id', () => {
    expect(providerHref({ _id: 'abc' })).toBe('/dashboard/providers/abc');
    expect(providerHref({ _id: 'a/b' })).toBe('/dashboard/providers/a%2Fb');
    expect(providerHref({})).toBeNull();
    expect(providerHref(null)).toBeNull();
    expect(providerHref({ _id: '' })).toBeNull();
  });
});

/* ── FilesApiError ───────────────────────────────────────────────────────── */

describe('FilesApiError', () => {
  it('reads { error, code } bodies', () => {
    const error = FilesApiError.fromBody(404, { error: 'Bucket not found', code: 'bucket_not_found' });
    expect(error.status).toBe(404);
    expect(error.code).toBe('bucket_not_found');
    expect(error.message).toBe('Bucket not found');
    expect(error.name).toBe('FilesApiError');
  });

  it('reads the reason of a Fastify validation error from `message`', () => {
    const error = FilesApiError.fromBody(400, { statusCode: 400, error: 'Bad Request', message: 'body/keys must NOT have fewer than 1 items' });
    expect(error.message).toBe('body/keys must NOT have fewer than 1 items');
    expect(error.code).toBeUndefined();
  });

  it('reads the { error: { message, code } } envelope of the client API', () => {
    const error = FilesApiError.fromBody(409, { error: { message: 'Key already exists', code: 'conflict' } });
    expect(error.message).toBe('Key already exists');
    expect(error.code).toBe('conflict');
  });

  it('falls back to the status text, then to the status, when the body says nothing', () => {
    expect(FilesApiError.fromBody(502, undefined, 'Bad Gateway').message).toBe('Bad Gateway');
    expect(FilesApiError.fromBody(502, undefined).message).toBe('HTTP 502');
    expect(FilesApiError.fromBody(500, { error: '   ' }, '').message).toBe('HTTP 500');
    expect(FilesApiError.fromBody(500, 'plain text').message).toBe('HTTP 500');
    expect(FilesApiError.fromBody(500, null).message).toBe('HTTP 500');
  });

  it('is an ApiError that keeps the parsed body as its payload', () => {
    const body = { error: 'in use', code: 'bucket_in_use', agents: [{ id: 'a1' }] };
    const error = FilesApiError.fromBody(409, body);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toBeInstanceOf(Error);
    expect(isFilesApiError(error)).toBe(true);
    expect(isFilesApiError(new ApiError('x', 500))).toBe(false);
    expect(error.payload).toEqual(body);
  });

  it('reads the body of a failed response, JSON or not', async () => {
    const json413 = await FilesApiError.fromResponse(
      new Response(JSON.stringify({ error: 'Too big', code: 'file_too_large' }), { status: 413, statusText: 'Payload Too Large' }),
    );
    expect(json413.status).toBe(413);
    expect(json413.code).toBe('file_too_large');
    expect(json413.message).toBe('Too big');

    const html = await FilesApiError.fromResponse(new Response('<html>oops</html>', { status: 502, statusText: 'Bad Gateway' }));
    expect(html.message).toBe('Bad Gateway');
    expect(html.code).toBeUndefined();

    const empty = await FilesApiError.fromResponse(new Response('', { status: 500 }));
    expect(empty.message).toBe('HTTP 500');
  });

  it('marks a request that never got an answer with status 0', () => {
    const error = FilesApiError.network(new TypeError('fetch failed'));
    expect(error.status).toBe(0);
    expect(error.code).toBe('network_error');
    expect(error.message).toBe('fetch failed');
    expect(FilesApiError.network(undefined).message).toBe('Network request failed');
  });

  it('names the codes the Files routes answer with', () => {
    expect([...FILES_ERROR_CODES].sort()).toEqual([
      'archive_too_large', 'bucket_deleting', 'bucket_in_use', 'bucket_inactive', 'bucket_not_empty', 'bucket_not_found',
      'content_type_not_allowed', 'conversion_too_large', 'conversion_unsupported', 'duplicate_key', 'file_not_found',
      'file_too_large', 'import_in_progress', 'internal_error', 'invalid_content_type', 'invalid_request',
      'markdown_unavailable', 'object_too_large', 'prefix_locked', 'preview_unsupported',
      'provider_endpoint_not_allowed', 'provider_inactive', 'provider_invalid', 'provider_mismatch', 'provider_missing',
      'provider_settings_invalid', 'provider_unassigned', 'queue_unavailable', 'quota_exceeded', 'storage_failure',
      'storage_location_shared', 'storage_timeout', 'storage_unavailable',
    ]);
    expect(new Set(FILES_ERROR_CODES).size).toBe(FILES_ERROR_CODES.length);
  });

  it('reads the reason a refusal adds next to its code', () => {
    const tooLarge = FilesApiError.fromBody(415, { error: 'Preview is limited to 5 MB', code: 'preview_unsupported', reason: 'too_large' });
    expect(tooLarge.code).toBe('preview_unsupported');
    expect(tooLarge.reason).toBe('too_large');
    expect(FilesApiError.fromBody(415, { error: 'No preview', code: 'preview_unsupported', reason: 'unsupported_type' }).reason).toBe('unsupported_type');
    // An answer without a reason, or with one that is not a string, has none.
    expect(FilesApiError.fromBody(409, { error: 'x', code: 'bucket_inactive' }).reason).toBeUndefined();
    expect(FilesApiError.fromBody(415, { error: 'x', code: 'preview_unsupported', reason: 7 }).reason).toBeUndefined();
    expect(FilesApiError.fromBody(415, { error: 'x', code: 'preview_unsupported', reason: '  ' }).reason).toBeUndefined();
  });
});

/* ── routes ──────────────────────────────────────────────────────────────── */

describe('routes', () => {
  it('builds the dashboard paths', () => {
    expect(filesRoutes.limits()).toBe('/api/files/limits');
    expect(filesRoutes.limits('my docs')).toBe('/api/files/limits?bucketKey=my%20docs');
    expect(filesRoutes.providers()).toBe('/api/files/providers');
    expect(filesRoutes.buckets()).toBe('/api/files/buckets');
    expect(filesRoutes.bucket('a b')).toBe('/api/files/buckets/a%20b');
    expect(filesRoutes.bucketDelete('b')).toBe('/api/files/buckets/b');
    expect(filesRoutes.bucketDelete('b', { deleteFiles: true })).toBe('/api/files/buckets/b?deleteFiles=true');
    expect(filesRoutes.bucketDelete('b', { force: true })).toBe('/api/files/buckets/b?force=true');
    expect(filesRoutes.bucketDelete('b', {})).toBe('/api/files/buckets/b');
    expect(filesRoutes.bucketDelete('b', { deleteFiles: false, force: false })).toBe('/api/files/buckets/b');
    // Asking for the files to go wins, as it does on the server (the two are never sent together).
    expect(filesRoutes.bucketDelete('a b', { deleteFiles: true, force: true })).toBe('/api/files/buckets/a%20b?deleteFiles=true');
    expect(filesRoutes.objects('b')).toBe('/api/files/buckets/b/objects');
    expect(filesRoutes.batchDelete('b')).toBe('/api/files/buckets/b/objects/batch-delete');
    expect(filesRoutes.archive('b')).toBe('/api/files/buckets/b/objects/archive');
    expect(filesRoutes.convert('b')).toBe('/api/files/buckets/b/convert');
    expect(filesRoutes.import('b')).toBe('/api/files/buckets/b/import');
    expect(filesRoutes.providerTest('p/1')).toBe('/api/providers/p%2F1/test');
  });

  it('encodes each segment of an object key and keeps the slashes', () => {
    expect(encodeObjectKey('dir/my file#1.pdf')).toBe('dir/my%20file%231.pdf');
    expect(filesRoutes.object('b', 'dir/my file#1.pdf')).toBe('/api/files/buckets/b/objects/dir/my%20file%231.pdf');
  });

  it('builds the objects query, keeping an empty prefix (the root) and trimming the search', () => {
    const url = new URL(
      filesRoutes.objects('b', { prefix: '', search: ' q ', type: 'pdf', purpose: 'other', cursor: 'c1', limit: 20 }),
      'http://localhost',
    );
    expect(url.searchParams.get('prefix')).toBe('');
    expect(url.searchParams.has('prefix')).toBe(true);
    expect(url.searchParams.get('search')).toBe('q');
    expect(url.searchParams.get('type')).toBe('pdf');
    expect(url.searchParams.get('purpose')).toBe('other');
    expect(url.searchParams.get('cursor')).toBe('c1');
    expect(url.searchParams.get('limit')).toBe('20');

    const bare = new URL(filesRoutes.objects('b', { search: '   ' }), 'http://localhost');
    expect([...bare.searchParams.keys()]).toEqual([]);
  });

  it('builds the client API paths with the key as ONE segment', () => {
    expect(clientApiRoutes.buckets()).toBe('/api/client/v1/files/buckets');
    expect(clientApiRoutes.bucket('b')).toBe('/api/client/v1/files/buckets/b');
    expect(clientApiRoutes.objects('b')).toBe('/api/client/v1/files/buckets/b/objects');
    expect(clientApiRoutes.object('b', 'dir/x y.pdf')).toBe('/api/client/v1/files/buckets/b/objects/dir%2Fx%20y.pdf');
    expect(clientApiRoutes.download('b', 'k.pdf')).toBe('/api/client/v1/files/buckets/b/objects/k.pdf/download');
    expect(clientApiRoutes.download('b', 'k.pdf', 'markdown')).toBe('/api/client/v1/files/buckets/b/objects/k.pdf/download?variant=markdown');
  });

  it('builds the preview and download addresses of a file and of its Markdown copy', () => {
    expect(objectPreviewUrl('b', 'k.pdf')).toBe('/api/files/buckets/b/objects/k.pdf?preview=1');
    expect(objectPreviewUrl('b', 'k.pdf', 'markdown')).toBe('/api/files/buckets/b/objects/k.pdf?variant=markdown&preview=1');
    expect(objectDownloadUrl('b', 'k.pdf')).toBe('/api/files/buckets/b/objects/k.pdf?download=original&variant=original');
    expect(objectDownloadUrl('b', 'k.pdf', 'markdown')).toBe('/api/files/buckets/b/objects/k.pdf?download=markdown&variant=markdown');
  });

  it('names the zip of an archive download', () => {
    expect(archiveFileName('docs')).toBe('docs-files.zip');
  });
});

describe('parseContentDispositionFileName', () => {
  it.each([
    ['attachment; filename="report.pdf"', 'report.pdf'],
    ['attachment; filename=report.pdf', 'report.pdf'],
    ["attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf", 'résumé.pdf'],
    ['attachment; filename="fallback.pdf"; filename*=UTF-8\'\'real%20name.pdf', 'real name.pdf'],
    ['attachment; filename="a\\"b.pdf"', 'a"b.pdf'],
    ["attachment; filename*=UTF-8''%E0%A4%A; filename=\"ok.txt\"", 'ok.txt'],
  ])('%s', (header, expected) => {
    expect(parseContentDispositionFileName(header)).toBe(expected);
  });

  it('is null when the header names no file', () => {
    for (const header of [null, undefined, '', 'attachment', 'attachment; filename=""']) {
      expect(parseContentDispositionFileName(header)).toBeNull();
    }
  });
});

/* ── fetchers ────────────────────────────────────────────────────────────── */

describe('Files API fetchers', () => {
  it('lists buckets, providers and limits', async () => {
    const calls = mockFetch((call) => {
      if (call.url.endsWith('/buckets')) return json({ buckets: [{ key: 'docs' }] });
      if (call.url.endsWith('/providers')) return json({ providers: [{ key: 'p' }] });
      return json({ maxFileBytes: 5, maxRequestBytes: 9, allowedMimeTypes: null, quota: { usedBytes: 1, limitBytes: null, filesUsed: 2, filesLimit: null } });
    });
    expect(await listBuckets()).toEqual([{ key: 'docs' }]);
    expect(await listFileProviders()).toEqual([{ key: 'p' }]);
    expect((await getFilesLimits()).maxFileBytes).toBe(5);
    expect((await getFilesLimits({ bucketKey: 'docs' })).maxFileBytes).toBe(5);
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /api/files/buckets',
      'GET /api/files/providers',
      'GET /api/files/limits',
      'GET /api/files/limits?bucketKey=docs',
    ]);
    expect(calls[0]!.cache).toBe('no-store');
  });

  it('treats a missing list as empty', async () => {
    mockFetch(() => json({}));
    expect(await listBuckets()).toEqual([]);
    expect(await listFileProviders()).toEqual([]);
  });

  it('reads one bucket, and refuses an answer without it', async () => {
    mockFetch((call) => (call.url.endsWith('/missing') ? json({}) : json({ bucket: { key: 'docs', usedBy: [] } })));
    expect((await getBucket('docs')).key).toBe('docs');
    await expect(getBucket('missing')).rejects.toMatchObject({ name: 'FilesApiError', code: 'invalid_response' });
  });

  it('creates and updates a bucket with JSON bodies', async () => {
    const calls = mockFetch(() => json({ bucket: { key: 'docs', name: 'Docs' } }, 201));
    const created = await createBucket({ key: 'docs', name: 'Docs', providerKey: 'local' });
    expect(created.key).toBe('docs');
    await updateBucket('docs', { name: 'Docs 2', status: 'disabled' });
    expect(calls[0]).toMatchObject({ method: 'POST', url: '/api/files/buckets', body: { key: 'docs', name: 'Docs', providerKey: 'local' } });
    expect(calls[0]!.headers['content-type']).toBe('application/json');
    expect(calls[1]).toMatchObject({ method: 'PATCH', url: '/api/files/buckets/docs', body: { name: 'Docs 2', status: 'disabled' } });
  });

  it('tells a finished bucket delete from one that continues in the background', async () => {
    const calls = mockFetch((call) => (call.url.includes('deleteFiles') ? json({ ok: true }, 202) : json({ ok: true })));
    expect(await deleteBucket('docs')).toEqual({ status: 'deleted' });
    expect(await deleteBucket('docs', { deleteFiles: true })).toEqual({ status: 'deleting' });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'DELETE /api/files/buckets/docs',
      'DELETE /api/files/buckets/docs?deleteFiles=true',
    ]);
  });

  it('removes only the bucket, whatever it holds, when asked to', async () => {
    const calls = mockFetch(() => json({ success: true }));
    expect(await deleteBucket('docs', { force: true })).toEqual({ status: 'deleted' });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['DELETE /api/files/buckets/docs?force=true']);
  });

  it('asks for the files to go when it is asked for both, as the server does', async () => {
    const calls = mockFetch(() => json({ status: 'deleting' }, 202));
    expect(await deleteBucket('docs', { deleteFiles: true, force: true })).toEqual({ status: 'deleting' });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['DELETE /api/files/buckets/docs?deleteFiles=true']);
  });

  it('keeps the code of a delete refused for a storage location another bucket uses', async () => {
    mockFetch(() => json({ error: 'Another bucket uses this storage location.', code: 'storage_location_shared' }, 409));
    const error = await deleteBucket('docs', { deleteFiles: true }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 409, code: 'storage_location_shared' });
  });

  it('also reads a bucket delete that continues in the background from the body', async () => {
    mockFetch(() => json({ status: 'deleting' }));
    expect(await deleteBucket('docs', { deleteFiles: true })).toEqual({ status: 'deleting' });
    mockFetch(() => new Response(null, { status: 204 }));
    expect(await deleteBucket('docs')).toEqual({ status: 'deleted' });
  });

  it('keeps what a refusal says: code, status and the full body', async () => {
    mockFetch(() => json({ error: 'Bucket is used by 1 agent', code: 'bucket_in_use', agents: [{ agentKey: 'support' }] }, 409));
    const error = await deleteBucket('docs').catch((caught: unknown) => caught);
    expect(isFilesApiError(error)).toBe(true);
    expect(error).toMatchObject({ status: 409, code: 'bucket_in_use', message: 'Bucket is used by 1 agent' });
    expect((error as FilesApiError).payload).toMatchObject({ agents: [{ agentKey: 'support' }] });
  });

  it('lists objects with their folders and cursor', async () => {
    const calls = mockFetch((call) =>
      call.url.includes('cursor=c1') ? json({ items: [{ key: 'b' }] }) : json({ items: [{ key: 'a' }], folders: ['x/'], prefix: '', nextCursor: 'c1' }),
    );
    const first = await listObjects('docs', { prefix: '', limit: 1 });
    expect(first).toEqual({ items: [{ key: 'a' }], folders: ['x/'], prefix: '', nextCursor: 'c1' });
    const second = await listObjects('docs', { prefix: '', limit: 1, cursor: 'c1' });
    expect(second).toEqual({ items: [{ key: 'b' }], folders: [] });
    expect(new URL(calls[1]!.url, 'http://localhost').searchParams.get('cursor')).toBe('c1');
  });

  it('reads one record, and refuses an answer without it', async () => {
    mockFetch((call) => (call.url.endsWith('/none') ? json({}) : json({ record: { key: 'dir/a.pdf' } })));
    expect(await getObject('docs', 'dir/a.pdf')).toEqual({ key: 'dir/a.pdf' });
    await expect(getObject('docs', 'none')).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('uploads one file as JSON and returns its record', async () => {
    const calls = mockFetch(() => json({ record: { key: 'dir/a.txt', markdownStatus: 'pending' } }, 201));
    const input = { fileName: 'a.txt', contentType: 'text/plain', data: 'data:text/plain;base64,aGk=', convertToMarkdown: true, folder: 'dir/' };
    const { record } = await uploadObject('docs', input);
    expect(record.key).toBe('dir/a.txt');
    expect(calls[0]).toMatchObject({ method: 'POST', url: '/api/files/buckets/docs/objects', body: input });
  });

  it('uses the plain request when progress is asked for but the environment has no XMLHttpRequest', async () => {
    const calls = mockFetch(() => json({ record: { key: 'a.txt' } }, 201));
    const onProgress = vi.fn();
    await uploadObject('docs', { fileName: 'a.txt', data: 'data:text/plain;base64,aGk=' }, { onProgress });
    expect(calls).toHaveLength(1);
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('refuses an upload answer without a record', async () => {
    mockFetch(() => json({}, 201));
    await expect(uploadObject('docs', { fileName: 'a.txt', data: 'x' })).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('deletes one file, with or without a body in the answer', async () => {
    const calls = mockFetch((call) => (call.url.endsWith('/a') ? new Response(null, { status: 204 }) : json({ deleted: true })));
    await expect(deleteObject('docs', 'a')).resolves.toBeUndefined();
    await expect(deleteObject('docs', 'dir/b')).resolves.toBeUndefined();
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'DELETE /api/files/buckets/docs/objects/a',
      'DELETE /api/files/buckets/docs/objects/dir/b',
    ]);
  });

  it('deletes many files and reports the ones that were refused', async () => {
    const calls = mockFetch((call) => (call.body && (call.body as { keys: string[] }).keys.length === 2
      ? json({ deleted: ['a'], failed: [{ key: 'b', error: 'in use' }] })
      : json({})));
    expect(await batchDeleteObjects('docs', ['a', 'b'])).toEqual({ deleted: ['a'], failed: [{ key: 'b', error: 'in use' }] });
    expect(await batchDeleteObjects('docs', ['a'])).toEqual({ deleted: [], failed: [] });
    expect(calls[0]).toMatchObject({ method: 'POST', url: '/api/files/buckets/docs/objects/batch-delete', body: { keys: ['a', 'b'] } });
  });

  it('downloads an archive as a Blob and reports a too-large selection by code', async () => {
    const calls = mockFetch((call) =>
      (call.body as { keys: string[] }).keys.length > 2
        ? json({ error: 'Too large', code: 'archive_too_large' }, 413)
        : new Response('ZIP', { status: 200, headers: { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="docs-files.zip"' } }),
    );
    const archive = await archiveObjects('docs', ['a', 'b']);
    expect(archive).toBeInstanceOf(Blob);
    expect(await archive.text()).toBe('ZIP');
    expect(calls[0]).toMatchObject({ method: 'POST', url: '/api/files/buckets/docs/objects/archive', body: { keys: ['a', 'b'] } });
    await expect(archiveObjects('docs', ['a', 'b', 'c'])).rejects.toMatchObject({ status: 413, code: 'archive_too_large' });
  });

  it('starts a conversion and registers objects found in storage', async () => {
    const calls = mockFetch((call) =>
      call.url.endsWith('/convert') ? json({ record: { key: 'a.pdf', markdownStatus: 'pending' } }, 202) : json({ scanned: 200, imported: 3, skipped: 197, nextCursor: 'n1' }),
    );
    expect((await convertObject('docs', 'a.pdf')).markdownStatus).toBe('pending');
    expect(await importFromStorage('docs', { cursor: 'c0', limit: 200 })).toEqual({ scanned: 200, imported: 3, skipped: 197, nextCursor: 'n1' });
    expect(calls[0]).toMatchObject({ url: '/api/files/buckets/docs/convert', body: { key: 'a.pdf' } });
    expect(calls[1]).toMatchObject({ url: '/api/files/buckets/docs/import', body: { cursor: 'c0', limit: 200 } });
  });

  it('fills the counts of an import answer that omits them', async () => {
    mockFetch(() => json({}));
    expect(await importFromStorage('docs')).toEqual({ scanned: 0, imported: 0, skipped: 0 });
  });

  it('downloads a file with the name and type the server gave', async () => {
    const calls = mockFetch(() => new Response('hello', { status: 200, headers: { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="a b.txt"' } }));
    const downloaded = await downloadObject('docs', 'dir/a b.txt', { variant: 'markdown' });
    expect(await downloaded.blob.text()).toBe('hello');
    expect(downloaded.fileName).toBe('a b.txt');
    expect(downloaded.contentType).toBe('text/plain');
    expect(calls[0]!.url).toBe('/api/files/buckets/docs/objects/dir/a%20b.txt?download=markdown&variant=markdown');
  });

  it('reads the inline text of a file', async () => {
    const calls = mockFetch(() => new Response('# Title', { status: 200, headers: { 'Content-Type': 'text/plain' } }));
    expect(await fetchObjectText('docs', 'a.md', { variant: 'markdown' })).toBe('# Title');
    expect(calls[0]!.url).toBe('/api/files/buckets/docs/objects/a.md?variant=markdown&preview=1');
  });

  it('answers 415 preview_unsupported by code', async () => {
    mockFetch(() => json({ error: 'No preview', code: 'preview_unsupported' }, 415));
    await expect(fetchObjectText('docs', 'a.bin')).rejects.toMatchObject({ status: 415, code: 'preview_unsupported' });
  });

  it('tells a file too large to preview from a type that cannot be previewed', async () => {
    mockFetch(() => json({ error: 'Preview is limited to 5 MB', code: 'preview_unsupported', reason: 'too_large' }, 415));
    await expect(fetchObjectText('docs', 'big.txt')).rejects.toMatchObject({ status: 415, code: 'preview_unsupported', reason: 'too_large' });
  });

  it('tests a saved provider by its record id', async () => {
    const calls = mockFetch(() => json({ ok: true, latencyMs: 12, message: 'Connected', details: { steps: [{ step: 'list', ok: true }] } }));
    const result = await testFileProvider('rec-1');
    expect(result.ok).toBe(true);
    expect(calls[0]).toMatchObject({ method: 'POST', url: '/api/providers/rec-1/test', body: {} });
  });

  it('turns a lost connection into a status 0 error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed');
    }));
    const error = await listBuckets().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FilesApiError);
    expect(error).toMatchObject({ status: 0, code: 'network_error', message: 'fetch failed' });
  });

  it('lets an abort through untouched', async () => {
    const abort = new DOMException('Aborted', 'AbortError');
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw abort;
    }));
    await expect(listBuckets()).rejects.toBe(abort);
  });

  it('refuses an answer that is not JSON', async () => {
    mockFetch(() => new Response('<html>', { status: 200 }));
    await expect(listBuckets()).rejects.toMatchObject({ code: 'invalid_response', status: 200 });
  });

  it('reports the status of a plain refusal', async () => {
    mockFetch(() => json({ error: 'Forbidden' }, 403));
    await expect(listBuckets()).rejects.toMatchObject({ status: 403, message: 'Forbidden' });
  });
});

/* ── upload progress over XMLHttpRequest ─────────────────────────────────── */

describe('uploadObject with progress', () => {
  class FakeXhr {
    static last: FakeXhr | null = null;
    method = '';
    url = '';
    headers: Record<string, string> = {};
    sent: string | null = null;
    aborted = false;
    status = 0;
    statusText = '';
    responseText = '';
    responseType = '';
    upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    onabort: (() => void) | null = null;
    constructor() {
      FakeXhr.last = this;
    }
    open(method: string, url: string) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(name: string, value: string) {
      this.headers[name] = value;
    }
    send(body: string) {
      this.sent = body;
    }
    abort() {
      this.aborted = true;
      this.onabort?.();
    }
    answer(status: number, body: unknown, statusText = '') {
      this.status = status;
      this.statusText = statusText;
      this.responseText = typeof body === 'string' ? body : JSON.stringify(body);
      this.onload?.();
    }
  }

  const input = { fileName: 'a.txt', data: 'data:text/plain;base64,aGk=' };

  it('reports how much of the body has gone out and resolves with the record', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const progress: number[] = [];
    const pending = uploadObject('docs', input, { onProgress: (p) => progress.push(p.fraction) });
    const xhr = FakeXhr.last!;
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe('/api/files/buckets/docs/objects');
    expect(xhr.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(xhr.sent!)).toEqual(input);
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 25, total: 100 });
    xhr.upload.onprogress?.({ lengthComputable: false, loaded: 50, total: 0 });
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 150, total: 100 });
    xhr.answer(201, { record: { key: 'a.txt' } });
    expect((await pending).record.key).toBe('a.txt');
    expect(progress).toEqual([0.25, 1]);
  });

  it('turns a refusal into a FilesApiError with its code', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const pending = uploadObject('docs', input, { onProgress: () => {} });
    FakeXhr.last!.answer(413, { error: 'Too big', code: 'file_too_large' }, 'Payload Too Large');
    await expect(pending).rejects.toMatchObject({ status: 413, code: 'file_too_large', message: 'Too big' });
  });

  it('turns an unreadable success into invalid_response and a dead connection into status 0', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const garbled = uploadObject('docs', input, { onProgress: () => {} });
    FakeXhr.last!.answer(201, '<html>');
    await expect(garbled).rejects.toMatchObject({ code: 'invalid_response' });

    const dropped = uploadObject('docs', input, { onProgress: () => {} });
    FakeXhr.last!.onerror?.();
    await expect(dropped).rejects.toMatchObject({ status: 0, code: 'network_error' });
  });

  it('aborts the request when the signal fires, and never starts one that is already aborted', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const controller = new AbortController();
    const pending = uploadObject('docs', input, { onProgress: () => {}, signal: controller.signal });
    const xhr = FakeXhr.last!;
    controller.abort();
    expect(xhr.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });

    FakeXhr.last = null;
    const done = new AbortController();
    done.abort();
    await expect(uploadObject('docs', input, { onProgress: () => {}, signal: done.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeXhr.last).toBeNull();
  });
});

/* ── error wording ───────────────────────────────────────────────────────── */

describe('filesErrorMessage', () => {
  const t = commonTranslator(en);
  const errors = en.files.common.errors;
  const make = (status: number, code?: string, message = 'Server said so') => new FilesApiError({ message, status, code });

  it('words the codes that mean one fixed thing', () => {
    expect(filesErrorMessage(make(413, 'file_too_large'), t)).toBe(errors.fileTooLarge);
    expect(filesErrorMessage(make(413, 'archive_too_large'), t)).toBe(errors.archiveTooLarge);
    expect(filesErrorMessage(make(415, 'preview_unsupported'), t)).toBe(errors.previewUnsupported);
    expect(filesErrorMessage(make(415, 'conversion_unsupported'), t)).toBe(errors.conversionUnsupported);
    expect(filesErrorMessage(make(409, 'prefix_locked'), t)).toBe(errors.prefixLocked);
    expect(filesErrorMessage(make(409, 'bucket_inactive'), t)).toBe(errors.bucketInactive);
    expect(filesErrorMessage(make(409, 'provider_inactive'), t)).toBe(errors.providerInactive);
    expect(filesErrorMessage(make(404, 'bucket_not_found'), t)).toBe(errors.bucketNotFound);
    expect(filesErrorMessage(make(200, 'invalid_response'), t)).toBe(errors.generic);
    expect(filesErrorMessage(make(0, 'read_failed'), t)).toBe(errors.readFailed);
    expect(filesErrorMessage(make(413, 'object_too_large'), t)).toBe(errors.objectTooLarge);
    expect(filesErrorMessage(make(409, 'storage_location_shared'), t)).toBe(errors.storageLocationShared);
  });

  it('words the refusals of a bucket that is being deleted, one that still holds files and a key taken', () => {
    expect(filesErrorMessage(make(409, 'bucket_deleting'), t)).toBe(errors.bucketDeleting);
    expect(filesErrorMessage(make(409, 'bucket_not_empty'), t)).toBe(errors.bucketNotEmpty);
    expect(filesErrorMessage(make(409, 'duplicate_key'), t)).toBe(errors.duplicateKey);
    expect(filesErrorMessage(make(404, 'file_not_found'), t)).toBe(errors.fileNotFound);
  });

  it('words a provider the bucket cannot use, and a Markdown copy that is not there', () => {
    expect(filesErrorMessage(make(409, 'provider_missing'), t)).toBe(errors.providerMissing);
    expect(filesErrorMessage(make(409, 'provider_unassigned'), t)).toBe(errors.providerUnassigned);
    expect(filesErrorMessage(make(409, 'provider_invalid'), t)).toBe(errors.providerInvalid);
    expect(filesErrorMessage(make(404, 'markdown_unavailable'), t)).toBe(errors.markdownUnavailable);
  });

  it('words an upload the server refuses for its type, an import already running and a queue that is down', () => {
    // The type that was refused is in the server's sentence, so that is what is shown.
    expect(filesErrorMessage(make(415, 'content_type_not_allowed', 'Content type "text/plain" is not allowed.'), t)).toBe('Content type "text/plain" is not allowed.');
    expect(filesErrorMessage(make(400, 'invalid_content_type'), t)).toBe(errors.invalidContentType);
    expect(filesErrorMessage(make(409, 'import_in_progress'), t)).toBe(errors.importInProgress);
    expect(filesErrorMessage(make(503, 'queue_unavailable'), t)).toBe(errors.queueUnavailable);
  });

  it('words a storage provider that is down or too slow, and an error the server could not explain', () => {
    expect(filesErrorMessage(make(503, 'storage_unavailable'), t)).toBe(errors.storageUnavailable);
    expect(filesErrorMessage(make(504, 'storage_timeout'), t)).toBe(errors.storageTimeout);
    expect(filesErrorMessage(make(500, 'internal_error', 'Internal details'), t)).toBe(errors.generic);
  });

  it('tells a file too large to preview from a type that cannot be previewed', () => {
    const tooLarge = new FilesApiError({ message: 'Preview is limited to 5 MB', status: 415, code: 'preview_unsupported', reason: 'too_large' });
    const unsupported = new FilesApiError({ message: 'No preview', status: 415, code: 'preview_unsupported', reason: 'unsupported_type' });
    expect(filesErrorMessage(tooLarge, t)).toBe(errors.previewTooLarge);
    expect(filesErrorMessage(unsupported, t)).toBe(errors.previewUnsupported);
    expect(filesErrorMessage(make(415, 'preview_unsupported'), t)).toBe(errors.previewUnsupported);
    const trT = commonTranslator(tr);
    expect(filesErrorMessage(tooLarge, trT)).toBe(tr.files.common.errors.previewTooLarge);
    expect(tr.files.common.errors.previewTooLarge).not.toBe(errors.previewTooLarge);
  });

  it('words a storage location that another bucket uses for the place it was met: the import dialog and the delete dialog', () => {
    const shared = make(409, 'storage_location_shared', 'Another bucket uses this storage location, so objects in it cannot be imported.');

    expect(filesErrorMessage(shared, t, 'importFromStorage')).toBe(errors.storageLocationSharedImport);
    expect(filesErrorMessage(shared, t, 'deleteBucket')).toBe(errors.storageLocationSharedDelete);
    expect(filesErrorMessage(shared, t)).toBe(errors.storageLocationShared);
    // The words are the person's language, not the server's.
    const trT = commonTranslator(tr);
    expect(filesErrorMessage(shared, trT, 'importFromStorage')).toBe(tr.files.common.errors.storageLocationSharedImport);
    expect(filesErrorMessage(shared, trT, 'deleteBucket')).toBe(tr.files.common.errors.storageLocationSharedDelete);
    // A context changes nothing for the codes that mean one thing everywhere.
    expect(filesErrorMessage(make(409, 'bucket_inactive'), t, 'deleteBucket')).toBe(errors.bucketInactive);
    expect(filesErrorMessage(make(404), t, 'importFromStorage')).toBe(errors.notFound);
  });

  it('words a lost connection, a missing permission and a missing item', () => {
    expect(filesErrorMessage(FilesApiError.network(new Error('x')), t)).toBe(errors.network);
    expect(filesErrorMessage(make(403), t)).toBe(errors.forbidden);
    expect(filesErrorMessage(make(403), t, 'providerTest')).toBe(errors.providerAccess);
    expect(filesErrorMessage(make(404), t)).toBe(errors.notFound);
  });

  describe('a 403', () => {
    const viewSession = 'This session was started by someone else, and you are not allowed to view it.';
    const changeSession = 'This session was started by someone else, and you are not allowed to change it.';
    const bucketSessions = 'This bucket holds files of sessions started by someone else, and you are not allowed to change them, so it cannot be deleted with its files.';
    const gate = 'Forbidden: files requires write permission';
    const refused = (body: unknown, statusText?: string) => FilesApiError.fromBody(403, body, statusText);

    it('shows the reason a refusal gives in words of its own: a file of a session somebody else started', () => {
      // The answer is { error } alone, or the gates' shape with the sentence in it; neither has a code to translate by.
      expect(filesErrorMessage(refused({ error: viewSession }), t)).toBe(viewSession);
      expect(filesErrorMessage(refused({ error: changeSession, code: 'forbidden', message: changeSession, service: 'agents', required: 'write', decisionId: 'd-1' }), t)).toBe(changeSession);
      // The same words in every place a file or a bucket is opened, changed or deleted.
      expect(filesErrorMessage(refused({ error: bucketSessions }), t, 'deleteBucket')).toBe(bucketSessions);
      expect(filesErrorMessage(refused({ error: viewSession }), t, 'importFromStorage')).toBe(viewSession);
      expect(filesErrorMessage(refused({ error: `  ${changeSession}  ` }), t)).toBe(changeSession);
    });

    it('words the gates’ own answer, which says no more than the viewer’s language does, as a missing permission', () => {
      const bodies: unknown[] = [
        undefined,
        {},
        { error: 'Forbidden' },
        { error: 'forbidden.' },
        { error: gate, code: 'forbidden', message: gate, service: 'files', required: 'write', decisionId: 'd-2' },
        { statusCode: 403, error: 'Forbidden', message: 'Forbidden' },
        { error: '   ', message: '' },
        { error: 42, message: null },
        'Request blocked',
      ];
      for (const body of bodies) {
        expect(filesErrorMessage(refused(body), t), JSON.stringify(body) ?? 'no body').toBe(errors.forbidden);
      }
      // The status line is not a reason either.
      expect(filesErrorMessage(refused(undefined, 'Forbidden'), t)).toBe(errors.forbidden);
      expect(filesErrorMessage(make(403), t)).toBe(errors.forbidden);
    });

    it('reads Fastify’s own shape the way the error does: the reason is `message`', () => {
      expect(filesErrorMessage(refused({ statusCode: 403, error: 'Forbidden', message: 'Origin not allowed' }), t)).toBe('Origin not allowed');
    });

    it('keeps the provider test’s own words, and the message of a code that has one', () => {
      expect(filesErrorMessage(refused({ error: viewSession }), t, 'providerTest')).toBe(errors.providerAccess);
      expect(filesErrorMessage(FilesApiError.fromBody(403, { error: viewSession, code: 'bucket_inactive' }), t)).toBe(errors.bucketInactive);
    });

    it('tells the gates’ answer in the viewer’s language, while a reason stays the words the server wrote', () => {
      const trT = commonTranslator(tr);
      expect(tr.files.common.errors.forbidden).not.toBe(errors.forbidden);
      expect(filesErrorMessage(refused({ error: gate, code: 'forbidden', message: gate }), trT)).toBe(tr.files.common.errors.forbidden);
      expect(filesErrorMessage(refused({ error: viewSession }), trT)).toBe(viewSession);
    });
  });

  it('shows the server’s own words for a refusal that carries details', () => {
    expect(filesErrorMessage(make(409, 'bucket_in_use', 'Bucket is used by 2 agents: a, b'), t)).toBe('Bucket is used by 2 agents: a, b');
    expect(filesErrorMessage(make(429, undefined, 'Storage quota exceeded'), t)).toBe('Storage quota exceeded');
    expect(filesErrorMessage(make(500, undefined, '   '), t)).toBe(errors.generic);
  });

  it('shows the server’s own words for every code listed as carrying details', () => {
    for (const code of FILES_ERROR_CODES_IN_SERVER_WORDS) {
      expect(filesErrorMessage(make(400, code, `Sentence for ${code}`), t), code).toBe(`Sentence for ${code}`);
    }
    // The settings of a provider and the explanation of a storage driver are the server's sentences, field and all.
    expect(filesErrorMessage(make(400, 'provider_settings_invalid', 'Bucket name is not valid.'), t)).toBe('Bucket name is not valid.');
    expect(filesErrorMessage(make(502, 'storage_failure', 'The provider refused the credentials.'), t)).toBe('The provider refused the credentials.');
  });

  it('does not guess about errors that are not Files errors', () => {
    expect(filesErrorMessage(new Error('boom'), t)).toBe(errors.generic);
    expect(filesErrorMessage('boom', t)).toBe(errors.generic);
    expect(filesErrorMessage(undefined, t)).toBe(errors.generic);
  });

  it('has a translated message for every code it maps, and maps every code except the ones with details', () => {
    const trT = commonTranslator(tr);
    for (const [code, key] of Object.entries(FILES_ERROR_CODE_KEYS)) {
      const english = t(key);
      const turkish = trT(key);
      expect(english.length, code).toBeGreaterThan(0);
      expect(turkish.length, code).toBeGreaterThan(0);
      expect(turkish, code).not.toBe(english);
    }
    // Every code the Files routes answer with is worded one way or the other, and never both.
    const inServerWords: readonly string[] = FILES_ERROR_CODES_IN_SERVER_WORDS;
    expect(FILES_ERROR_CODES.filter((code) => !(code in FILES_ERROR_CODE_KEYS)).sort()).toEqual([...inServerWords].sort());
    expect(FILES_ERROR_CODES.filter((code) => code in FILES_ERROR_CODE_KEYS && inServerWords.includes(code))).toEqual([]);
    expect(FILES_ERROR_CODES_IN_SERVER_WORDS.filter((code) => !(FILES_ERROR_CODES as readonly string[]).includes(code))).toEqual([]);
    // What the client raises itself is worded too, though it is not a code the server answers with.
    expect(Object.keys(FILES_ERROR_CODE_KEYS).filter((code) => !(FILES_ERROR_CODES as readonly string[]).includes(code)).sort()).toEqual(['invalid_response', 'read_failed']);
  });

  it('has a translated message for every code it words differently in a place, and only for codes it knows', () => {
    const trT = commonTranslator(tr);
    for (const [context, codes] of Object.entries(FILES_CONTEXT_ERROR_KEYS)) {
      for (const [code, key] of Object.entries(codes)) {
        expect((FILES_ERROR_CODES as readonly string[]).includes(code), `${context}: ${code}`).toBe(true);
        expect(t(key).length, `${context}: ${code}`).toBeGreaterThan(0);
        expect(trT(key), `${context}: ${code}`).not.toBe(t(key));
      }
    }
  });
});

/* ── access ──────────────────────────────────────────────────────────────── */

describe('filesAccessFromPermissions', () => {
  it('lets write and admin change files', () => {
    expect(filesAccessFromPermissions({ files: 'write' })).toEqual({ level: 'write', canWrite: true });
    expect(filesAccessFromPermissions({ files: 'admin' })).toEqual({ level: 'admin', canWrite: true });
  });

  it('hides the controls from read and none', () => {
    expect(filesAccessFromPermissions({ files: 'read' })).toEqual({ level: 'read', canWrite: false });
    expect(filesAccessFromPermissions({ files: 'none' })).toEqual({ level: 'none', canWrite: false });
  });

  it('leaves the decision to the server when the level is not known', () => {
    expect(filesAccessFromPermissions(null)).toEqual({ level: null, canWrite: true });
    expect(filesAccessFromPermissions(undefined)).toEqual({ level: null, canWrite: true });
    expect(filesAccessFromPermissions({})).toEqual({ level: null, canWrite: true });
    expect(filesAccessFromPermissions({ agents: 'admin' })).toEqual({ level: null, canWrite: true });
  });
});

/* ── query keys, polling and invalidation ────────────────────────────────── */

describe('filesKeys', () => {
  const isPrefix = (prefix: QueryKey, key: QueryKey) => prefix.length <= key.length && prefix.every((part, i) => JSON.stringify(part) === JSON.stringify(key[i]));
  const allKeys = (project: string) => [
    filesKeys.project(project),
    filesKeys.buckets(project),
    filesKeys.bucketDetails(project),
    filesKeys.bucket(project, 'docs'),
    filesKeys.objectsOf(project, 'docs'),
    filesKeys.objects(project, 'docs', { prefix: '' }),
    filesKeys.object(project, 'docs', 'a.pdf'),
    filesKeys.objectRecordsOf(project, 'docs'),
    filesKeys.textsOf(project, 'docs'),
    filesKeys.text(project, 'docs', 'a.pdf', 'markdown'),
    filesKeys.providers(project),
    filesKeys.limits(project),
    filesKeys.limits(project, 'docs'),
  ];

  it('puts the project right after the `files` root in every key', () => {
    for (const key of allKeys('project:7')) {
      expect(key[0]).toBe('files');
      expect(key[1]).toBe('project:7');
    }
  });

  it('keeps one project’s keys apart from another’s', () => {
    const first = allKeys('project:1').map((key) => JSON.stringify(key));
    const second = allKeys('project:2').map((key) => JSON.stringify(key));
    expect(first.filter((key) => second.includes(key))).toEqual([]);
    for (const key of allKeys('project:2')) expect(isPrefix(filesKeys.project('project:1'), key)).toBe(false);
  });

  it('nests keys so one invalidation reaches everything below it', () => {
    const p = 'project:0';
    expect(isPrefix(filesKeys.all, filesKeys.project(p))).toBe(true);
    for (const key of allKeys(p)) expect(isPrefix(filesKeys.project(p), key)).toBe(true);
    expect(isPrefix(filesKeys.bucketDetails(p), filesKeys.bucket(p, 'docs'))).toBe(true);
    expect(isPrefix(filesKeys.objectsOf(p, 'docs'), filesKeys.objects(p, 'docs', { search: 'q' }))).toBe(true);
    expect(isPrefix(filesKeys.objectRecordsOf(p, 'docs'), filesKeys.object(p, 'docs', 'a.pdf'))).toBe(true);
    expect(isPrefix(filesKeys.textsOf(p, 'docs'), filesKeys.text(p, 'docs', 'a.pdf', 'original'))).toBe(true);
    expect(isPrefix(filesKeys.objectsOf(p, 'docs'), filesKeys.objects(p, 'other', {}))).toBe(false);
    expect(isPrefix(filesKeys.limits(p), filesKeys.limits(p, 'docs'))).toBe(true);
    expect(isPrefix(filesKeys.limits(p, 'docs'), filesKeys.limits(p, 'other'))).toBe(false);
  });

  it('gives a listing of the same folder and filters one key, whatever the cursor and blanks', () => {
    const plain = filesKeys.objects('project:0', 'docs', normalizeObjectsQuery({ prefix: 'a/' }));
    const noisy = filesKeys.objects('project:0', 'docs', normalizeObjectsQuery({ prefix: 'a/', search: '   ', cursor: 'c9', type: undefined }));
    expect(JSON.stringify(noisy)).toBe(JSON.stringify(plain));
  });

  it('tells the bucket root from a flat listing of the whole bucket', () => {
    const root = JSON.stringify(filesKeys.objects('project:0', 'docs', normalizeObjectsQuery({ prefix: '' })));
    const flat = JSON.stringify(filesKeys.objects('project:0', 'docs', normalizeObjectsQuery({})));
    expect(root).not.toBe(flat);
  });

  it('trims the search and keeps the filters in the key', () => {
    expect(normalizeObjectsQuery({ prefix: 'a/', search: '  report ', type: 'pdf', purpose: 'other', limit: 25, cursor: 'x' })).toEqual({
      prefix: 'a/',
      search: 'report',
      type: 'pdf',
      purpose: 'other',
      limit: 25,
    });
    expect(normalizeObjectsQuery()).toEqual({});
  });

  it('names the project scope', () => {
    expect(getFilesProjectScope()).toMatch(/^project:\d+$/);
  });
});

describe('polling rules', () => {
  it('asks again quickly at first, then less often, then stops', () => {
    expect(pollDelayMs(0, MARKDOWN_POLL_MAX_MS)).toBe(2_000);
    expect(pollDelayMs(29_999, MARKDOWN_POLL_MAX_MS)).toBe(2_000);
    expect(pollDelayMs(30_000, MARKDOWN_POLL_MAX_MS)).toBe(4_000);
    expect(pollDelayMs(119_999, MARKDOWN_POLL_MAX_MS)).toBe(4_000);
    expect(pollDelayMs(120_000, MARKDOWN_POLL_MAX_MS)).toBe(10_000);
    expect(pollDelayMs(MARKDOWN_POLL_MAX_MS - 1, MARKDOWN_POLL_MAX_MS)).toBe(10_000);
    expect(pollDelayMs(MARKDOWN_POLL_MAX_MS, MARKDOWN_POLL_MAX_MS)).toBe(false);
    expect(pollDelayMs(MARKDOWN_POLL_MAX_MS + 1, MARKDOWN_POLL_MAX_MS)).toBe(false);
    expect(DELETE_POLL_MAX_MS).toBeGreaterThan(MARKDOWN_POLL_MAX_MS);
  });

  it('sees a conversion that has not settled', () => {
    expect(hasPendingMarkdown([{ markdownStatus: 'succeeded' }, { markdownStatus: 'pending' }])).toBe(true);
    expect(hasPendingMarkdown([{ markdownStatus: 'succeeded' }, { markdownStatus: 'failed' }, { markdownStatus: 'skipped' }, {}])).toBe(false);
    expect(hasPendingMarkdown([])).toBe(false);
    expect(hasPendingMarkdown(null)).toBe(false);
    expect(hasPendingMarkdown(undefined)).toBe(false);
  });

  it('sees a bucket that is being deleted', () => {
    expect(isBucketDeleting({ deleting: true })).toBe(true);
    expect(isBucketDeleting({ deleting: false })).toBe(false);
    expect(isBucketDeleting({})).toBe(false);
    expect(isBucketDeleting(undefined)).toBe(false);
  });

  it('names what is unsettled, so the clock restarts when another job joins', () => {
    expect(pendingMarkdownSignature([{ key: 'b', markdownStatus: 'pending' }, { key: 'a', markdownStatus: 'pending' }, { key: 'c', markdownStatus: 'succeeded' }])).toBe('a\nb');
    expect(pendingMarkdownSignature([{ key: 'c', markdownStatus: 'succeeded' }])).toBeNull();
    expect(pendingMarkdownSignature(undefined)).toBeNull();
    expect(deletingBucketsSignature([{ key: 'z', deleting: true }, { key: 'y', deleting: true }, { key: 'x' }])).toBe('y\nz');
    expect(deletingBucketsSignature([{ key: 'x' }])).toBeNull();
    expect(deletingBucketsSignature(null)).toBeNull();
  });

  it('restarts the clock when the same job is asked for again', () => {
    const early = '2026-10-20T10:00:00.000Z';
    const late = '2026-10-20T10:10:00.000Z';
    const converting = (updatedAt: string) => [{ key: 'a', markdownStatus: 'pending', updatedAt }];
    expect(pendingMarkdownSignature(converting(early))).not.toBeNull();
    expect(pendingMarkdownSignature(converting(early))).toBe(pendingMarkdownSignature(converting(early)));
    expect(pendingMarkdownSignature(converting(late))).not.toBe(pendingMarkdownSignature(converting(early)));
    const deleting = (updatedAt: string) => [{ key: 'z', deleting: true, updatedAt }];
    expect(deletingBucketsSignature(deleting(late))).not.toBe(deletingBucketsSignature(deleting(early)));
    // A run without a time is named by its key alone.
    expect(pendingMarkdownSignature([{ key: 'a', markdownStatus: 'pending', updatedAt: null }])).toBe('a');
  });

  it('retries a lost connection or a server error once, and never a refusal', () => {
    const status = (code: number) => new FilesApiError({ message: 'x', status: code });
    expect(retryUnlessClientError(0, status(404))).toBe(false);
    expect(retryUnlessClientError(0, status(403))).toBe(false);
    expect(retryUnlessClientError(0, status(409))).toBe(false);
    expect(retryUnlessClientError(0, status(500))).toBe(true);
    expect(retryUnlessClientError(1, status(500))).toBe(false);
    expect(retryUnlessClientError(0, FilesApiError.network(undefined))).toBe(true);
    expect(retryUnlessClientError(0, new Error('x'))).toBe(true);
    expect(retryUnlessClientError(1, new Error('x'))).toBe(false);
  });
});

describe('flattenObjectPages', () => {
  const page = (keys: string[], folders: string[] = []) => ({ items: keys.map((key) => asView<never>({ key })), folders });

  it('joins the pages, each file and folder once and in order', () => {
    const flat = flattenObjectPages([page(['a', 'b'], ['x/', 'y/']), page(['b', 'c'], ['y/', 'z/'])]);
    expect(flat.items.map((item) => item.key)).toEqual(['a', 'b', 'c']);
    expect(flat.folders).toEqual(['x/', 'y/', 'z/']);
  });

  it('handles no pages', () => {
    expect(flattenObjectPages(undefined)).toEqual({ items: [], folders: [] });
    expect(flattenObjectPages([])).toEqual({ items: [], folders: [] });
  });
});

describe('invalidation helpers', () => {
  const P = 'project:0';

  function seeded() {
    const queryClient = new QueryClient();
    const seed = (key: QueryKey, value: unknown = {}) => queryClient.setQueryData(key, value);
    seed(filesKeys.buckets(P), []);
    seed(filesKeys.bucket(P, 'docs'));
    seed(filesKeys.bucket(P, 'other'));
    seed(filesKeys.objects(P, 'docs', { prefix: '' }));
    seed(filesKeys.objects(P, 'docs', { prefix: 'a/' }));
    seed(filesKeys.objects(P, 'other', { prefix: '' }));
    seed(filesKeys.object(P, 'docs', 'a.pdf'));
    seed(filesKeys.object(P, 'docs', 'b.pdf'));
    seed(filesKeys.text(P, 'docs', 'a.pdf', 'original'), 'text');
    seed(filesKeys.text(P, 'docs', 'a.pdf', 'markdown'), 'text');
    seed(filesKeys.text(P, 'docs', 'b.pdf', 'markdown'), 'text');
    seed(filesKeys.limits(P));
    seed(filesKeys.limits(P, 'docs'));
    seed(filesKeys.providers(P), []);
    const stale = (key: QueryKey) => queryClient.getQueryState(key)?.isInvalidated === true;
    const present = (key: QueryKey) => queryClient.getQueryData(key) !== undefined;
    return { queryClient, stale, present };
  }

  it('marks the bucket list stale after the list changed', async () => {
    const { queryClient, stale } = seeded();
    await invalidateBuckets(queryClient, P);
    expect(stale(filesKeys.buckets(P))).toBe(true);
    expect(stale(filesKeys.bucket(P, 'docs'))).toBe(false);
    expect(stale(filesKeys.providers(P))).toBe(false);
  });

  it('marks the bucket and the list stale after the bucket itself changed, and nothing else', async () => {
    const { queryClient, stale } = seeded();
    await invalidateBucketMeta(queryClient, P, 'docs');
    expect(stale(filesKeys.buckets(P))).toBe(true);
    expect(stale(filesKeys.bucket(P, 'docs'))).toBe(true);
    expect(stale(filesKeys.bucket(P, 'other'))).toBe(false);
    expect(stale(filesKeys.objects(P, 'docs', { prefix: '' }))).toBe(false);
    expect(stale(filesKeys.limits(P))).toBe(false);
  });

  it('marks everything about a bucket’s files stale after they changed', async () => {
    const { queryClient, stale } = seeded();
    await invalidateBucketContent(queryClient, P, 'docs');
    for (const key of [
      filesKeys.buckets(P),
      filesKeys.bucket(P, 'docs'),
      filesKeys.objects(P, 'docs', { prefix: '' }),
      filesKeys.objects(P, 'docs', { prefix: 'a/' }),
      filesKeys.object(P, 'docs', 'a.pdf'),
      filesKeys.object(P, 'docs', 'b.pdf'),
      filesKeys.text(P, 'docs', 'a.pdf', 'original'),
      filesKeys.text(P, 'docs', 'b.pdf', 'markdown'),
      filesKeys.limits(P),
      filesKeys.limits(P, 'docs'),
    ]) {
      expect(stale(key), JSON.stringify(key)).toBe(true);
    }
    expect(stale(filesKeys.bucket(P, 'other'))).toBe(false);
    expect(stale(filesKeys.objects(P, 'other', { prefix: '' }))).toBe(false);
    expect(stale(filesKeys.providers(P))).toBe(false);
  });

  it('leaves the records of files that were just deleted alone', async () => {
    const { queryClient, stale } = seeded();
    await invalidateBucketContent(queryClient, P, 'docs', { removedKeys: ['a.pdf'] });
    expect(stale(filesKeys.object(P, 'docs', 'a.pdf'))).toBe(false);
    expect(stale(filesKeys.text(P, 'docs', 'a.pdf', 'markdown'))).toBe(false);
    expect(stale(filesKeys.object(P, 'docs', 'b.pdf'))).toBe(true);
    expect(stale(filesKeys.text(P, 'docs', 'b.pdf', 'markdown'))).toBe(true);
    expect(stale(filesKeys.objects(P, 'docs', { prefix: '' }))).toBe(true);
  });

  it('marks one record, its texts and the listings stale after a conversion restarted', async () => {
    const { queryClient, stale } = seeded();
    await invalidateObject(queryClient, P, 'docs', 'a.pdf');
    expect(stale(filesKeys.object(P, 'docs', 'a.pdf'))).toBe(true);
    expect(stale(filesKeys.text(P, 'docs', 'a.pdf', 'original'))).toBe(true);
    expect(stale(filesKeys.text(P, 'docs', 'a.pdf', 'markdown'))).toBe(true);
    expect(stale(filesKeys.objects(P, 'docs', { prefix: 'a/' }))).toBe(true);
    expect(stale(filesKeys.object(P, 'docs', 'b.pdf'))).toBe(false);
    expect(stale(filesKeys.text(P, 'docs', 'b.pdf', 'markdown'))).toBe(false);
  });

  it('marks everything that shows a provider’s health stale after a test', async () => {
    const { queryClient, stale } = seeded();
    await invalidateProviderHealth(queryClient, P);
    expect(stale(filesKeys.buckets(P))).toBe(true);
    expect(stale(filesKeys.bucket(P, 'docs'))).toBe(true);
    expect(stale(filesKeys.bucket(P, 'other'))).toBe(true);
    expect(stale(filesKeys.providers(P))).toBe(true);
    expect(stale(filesKeys.objects(P, 'docs', { prefix: '' }))).toBe(false);
  });

  it('forgets a bucket that is gone, and only that bucket', () => {
    const { queryClient, present } = seeded();
    forgetBucket(queryClient, P, 'docs');
    for (const key of [
      filesKeys.bucket(P, 'docs'),
      filesKeys.objects(P, 'docs', { prefix: '' }),
      filesKeys.object(P, 'docs', 'a.pdf'),
      filesKeys.text(P, 'docs', 'a.pdf', 'markdown'),
    ]) {
      expect(present(key), JSON.stringify(key)).toBe(false);
    }
    expect(present(filesKeys.bucket(P, 'other'))).toBe(true);
    expect(present(filesKeys.objects(P, 'other', { prefix: '' }))).toBe(true);
    expect(present(filesKeys.buckets(P))).toBe(true);
  });

  it('forgets the records of deleted files, and only those', () => {
    const { queryClient, present } = seeded();
    forgetObjects(queryClient, P, 'docs', ['a.pdf']);
    expect(present(filesKeys.object(P, 'docs', 'a.pdf'))).toBe(false);
    expect(present(filesKeys.text(P, 'docs', 'a.pdf', 'original'))).toBe(false);
    expect(present(filesKeys.text(P, 'docs', 'a.pdf', 'markdown'))).toBe(false);
    expect(present(filesKeys.object(P, 'docs', 'b.pdf'))).toBe(true);
    expect(present(filesKeys.text(P, 'docs', 'b.pdf', 'markdown'))).toBe(true);
  });

  it('does not make a screen that is still open ask about a file that is gone', async () => {
    const { queryClient, present } = seeded();
    const key = filesKeys.object(P, 'docs', 'a.pdf');
    const queryFn = vi.fn(async () => ({ key: 'a.pdf' }));
    const observer = new QueryObserver(queryClient, { queryKey: key, queryFn });
    const unsubscribe = observer.subscribe(() => {});
    await vi.waitFor(() => expect(observer.getCurrentResult().isFetching).toBe(false));
    expect(queryFn).toHaveBeenCalledTimes(1);

    forgetObjects(queryClient, P, 'docs', ['a.pdf']);
    await invalidateBucketContent(queryClient, P, 'docs', { removedKeys: ['a.pdf'] });

    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(present(key)).toBe(true);
    unsubscribe();
  });
});

/* ── message modules ─────────────────────────────────────────────────────── */

describe('Files message modules', () => {
  const MODULES = [
    ['common', filesCommonEn, filesCommonTr],
    ['list', filesListEn, filesListTr],
    ['create', filesCreateEn, filesCreateTr],
    ['bucket', filesBucketEn, filesBucketTr],
    ['upload', filesUploadEn, filesUploadTr],
    ['detail', filesDetailEn, filesDetailTr],
  ] as const;

  const flatten = (node: unknown, prefix = ''): Array<[string, unknown]> =>
    typeof node === 'string'
      ? [[prefix, node]]
      : node && typeof node === 'object'
        ? Object.entries(node).flatMap(([key, value]) => flatten(value, prefix ? `${prefix}.${key}` : key))
        : [[prefix, node]];
  const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

  it.each(MODULES)('files.%s is registered in both languages', (name, english, turkish) => {
    const registeredEn = (en.files as Record<string, unknown>)[name] as Record<string, unknown>;
    const registeredTr = (tr.files as Record<string, unknown>)[name] as Record<string, unknown>;
    expect(registeredEn).toBeDefined();
    expect(registeredTr).toBeDefined();
    expect(registeredEn).toMatchObject(english);
    expect(registeredTr).toMatchObject(turkish);
  });

  it.each(MODULES)('files.%s has the same keys, placeholders and non-empty strings in English and Turkish', (_name, english, turkish) => {
    const englishEntries = flatten(english);
    const turkishEntries = flatten(turkish);
    expect(turkishEntries.map(([key]) => key).sort()).toEqual(englishEntries.map(([key]) => key).sort());
    const turkishByKey = new Map(turkishEntries);
    for (const [key, englishText] of englishEntries) {
      const turkishText = turkishByKey.get(key);
      expect(typeof englishText, key).toBe('string');
      expect(typeof turkishText, key).toBe('string');
      expect((englishText as string).trim().length, key).toBeGreaterThan(0);
      expect((turkishText as string).trim().length, key).toBeGreaterThan(0);
      expect(placeholders(turkishText as string), key).toEqual(placeholders(englishText as string));
    }
  });

  it.each(MODULES)('files.%s is translated rather than copied', (_name, english, turkish) => {
    const turkishByKey = new Map(flatten(turkish));
    const copied = flatten(english).filter(([key, value]) => turkishByKey.get(key) === value).map(([key]) => key);
    expect(copied).toEqual([]);
  });

  it('keeps the refusal title that files.bucket already carried', () => {
    expect(en.files.bucket.refusalTitleUpdate).toBe('Unable to update bucket');
    expect(tr.files.bucket.refusalTitleUpdate).toBe('Bucket güncellenemedi');
  });

  it('keeps the screens’ modules apart from the keys files.* already had', () => {
    const existing = ['browse', 'filter', 'columns', 'createdBy', 'session', 'bucket'];
    for (const [name] of MODULES.filter(([moduleName]) => moduleName !== 'bucket')) expect(existing).not.toContain(name);
  });
});
