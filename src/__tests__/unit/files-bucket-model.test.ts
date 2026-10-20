/**
 * The bucket page's rules, without a DOM: the address (`?tab=&path=&q=&type=&show=`), the Files tab's listing,
 * rows, selection and bulk delete, the import scan, the Settings tab's form / prefix / gauges / delete rules, and
 * the API tab's code samples pinned to the routes of the client API they document. The components that draw all of
 * this are tested in `files-bucket-ui.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import type { FileRecordView } from '@/lib/services/files';
import { FilesApiError, clientApiRoutes, filesRoutes, type FileLimits } from '@/components/files/filesApi';
import {
  DEFAULT_FILES_TAB_STATE,
  MAX_SEARCH_LENGTH,
  hasListingFilters,
  hrefWithQuery,
  isFlatListing,
  parseFilesTabState,
  readOpenFile,
  resolveBucketTab,
  withFilesTabState,
} from '@/components/files/bucket/filesTabState';
import {
  ARCHIVE_MAX_KEYS,
  BATCH_DELETE_MAX_KEYS,
  PAGE_SIZE,
  buildRows,
  chunk,
  deleteInBatches,
  fileRowsOf,
  folderOfKey,
  hasMarkdownCopy,
  listingQuery,
  mergeBatchResults,
  modifiedAt,
  previewFailures,
  selectedVisibleKeys,
  selectionState,
  showsSessionColumns,
  toggleSelection,
} from '@/components/files/bucket/filesTabModel';
import {
  EMPTY_IMPORT_PROGRESS,
  IMPORT_PAGE_SIZE,
  MAX_IMPORT_PAGES,
  addImportPage,
  canRetryImport,
  runImportScan,
} from '@/components/files/bucket/importScan';
import {
  DESCRIPTION_MAX_LENGTH,
  NAME_MAX_LENGTH,
  PREFIX_MAX_LENGTH,
  agentFilesHref,
  deleteErrorOf,
  deleteRules,
  descriptionProblem,
  driverNameOf,
  effectivePrefix,
  gaugeOf,
  isDirty,
  isPrefixLocked,
  mayOpenProviders,
  nameProblem,
  normalizePrefixInput,
  prefixProblem,
  quotaOf,
  settingsPatch,
  valuesOf,
} from '@/components/files/bucket/settingsModel';
import {
  BUCKET_DESCRIPTION_MAX,
  BUCKET_NAME_MAX,
  BUCKET_PREFIX_MAX,
  normalizeBucketPrefix,
} from '@/components/files/shared/bucketRules';
import { DELETE_STALLED_AFTER_MS } from '@/components/files/shared/jobClock';
import {
  BUCKET_DESCRIPTION_MAX_LENGTH as SERVER_BUCKET_DESCRIPTION_MAX_LENGTH,
  BUCKET_NAME_MAX_LENGTH as SERVER_BUCKET_NAME_MAX_LENGTH,
  BUCKET_PREFIX_MAX_LENGTH as SERVER_BUCKET_PREFIX_MAX_LENGTH,
  parseBucketDescription,
  parseBucketName,
  parseBucketPrefix,
} from '@/lib/services/files/bucketRules';
import {
  API_LANGUAGES,
  API_OPERATIONS,
  PLACEHOLDER_ORIGIN,
  SAMPLE_FILE_KEY,
  SAMPLE_FOLDER,
  TOKEN_PLACEHOLDER,
  apiBaseUrl,
  buildSnippet,
  listResponseExample,
  routeOf,
  uploadResponseExample,
} from '@/components/files/bucket/apiSnippets';
import { bucketErrorMessage, isBucketGone } from '@/components/files/bucket/bucketErrors';
import { en } from '@/lib/i18n/messages/en';
import { tr } from '@/lib/i18n/messages/tr';

/* ── Fixtures ────────────────────────────────────────────────────────────── */

function rec(key: string, extra: Partial<FileRecordView> = {}): FileRecordView {
  return {
    id: `id-${key}`,
    tenantId: 't1',
    providerKey: 'minio',
    bucketKey: 'docs',
    key,
    name: key.split('/').pop() ?? key,
    size: 10,
    markdownStatus: 'skipped',
    createdBy: 'u1',
    ...extra,
  } as FileRecordView;
}

const state = (patch: Partial<typeof DEFAULT_FILES_TAB_STATE> = {}) => ({ ...DEFAULT_FILES_TAB_STATE, ...patch });

/* ── The address ─────────────────────────────────────────────────────────── */

describe('the bucket page’s address', () => {
  it('opens the Files tab unless the address names another one', () => {
    expect(resolveBucketTab(null)).toBe('files');
    expect(resolveBucketTab(undefined)).toBe('files');
    expect(resolveBucketTab('')).toBe('files');
    expect(resolveBucketTab('files')).toBe('files');
    expect(resolveBucketTab('settings')).toBe('settings');
    expect(resolveBucketTab('API')).toBe('api');
    expect(resolveBucketTab('nonsense')).toBe('files');
  });

  it('keeps the names of the tabs it replaced working', () => {
    // The page used to have Overview / Files / Usage: links and bookmarks to them still land on the successor.
    expect(resolveBucketTab('overview')).toBe('settings');
    expect(resolveBucketTab('usage')).toBe('api');
    expect(resolveBucketTab(' Usage ')).toBe('api');
  });

  it('reads the Files tab’s state, and anything that means nothing is the default', () => {
    expect(parseFilesTabState(new URLSearchParams(''))).toEqual(DEFAULT_FILES_TAB_STATE);
    expect(parseFilesTabState(null)).toEqual(DEFAULT_FILES_TAB_STATE);
    expect(parseFilesTabState(new URLSearchParams('path=reports%2F2026&q=%20invoice%20&type=PDF&show=session'))).toEqual({
      path: 'reports/2026/',
      q: 'invoice',
      type: 'pdf',
      show: 'session',
    });
    expect(parseFilesTabState(new URLSearchParams('type=video&show=everything'))).toEqual(DEFAULT_FILES_TAB_STATE);
    // Not the same object every time: a caller may change what it gets.
    expect(parseFilesTabState(null)).not.toBe(DEFAULT_FILES_TAB_STATE);
  });

  it('never lets a path climb out of the bucket, and cuts an endless search', () => {
    for (const path of ['../secrets', 'a/../../b', './a', 'a/./b']) {
      expect(parseFilesTabState(new URLSearchParams({ path })).path, path).toBe('');
    }
    expect(parseFilesTabState(new URLSearchParams({ path: '/a//b' })).path).toBe('a/b/');
    expect(parseFilesTabState(new URLSearchParams({ q: 'x'.repeat(MAX_SEARCH_LENGTH + 50) })).q).toHaveLength(MAX_SEARCH_LENGTH);
  });

  it('writes only what differs from the default and keeps the parameters it does not own', () => {
    expect(withFilesTabState('', {})).toBe('');
    expect(withFilesTabState('', { path: 'a/b', q: ' x ', type: 'pdf', show: 'session' })).toBe('path=a%2Fb%2F&q=x&type=pdf&show=session');
    // Defaults take their parameter out of the address.
    expect(withFilesTabState('path=a%2F&q=x&type=pdf&show=other&utm=1', { path: '', q: '', type: null, show: 'all' })).toBe('utm=1');
    expect(withFilesTabState('q=old', { q: 'new' })).toBe('q=new');
    // A key the patch leaves out stays.
    expect(withFilesTabState('path=a%2F&q=x', { type: 'image' })).toBe('path=a%2F&q=x&type=image');
    // A path that would leave the bucket is written as the root.
    expect(withFilesTabState('path=a%2F', { path: '../x' })).toBe('');
  });

  it('puts the tab in the address, except the Files tab which is the default', () => {
    expect(withFilesTabState('', { tab: 'settings' })).toBe('tab=settings');
    expect(withFilesTabState('tab=settings&path=a%2F', { tab: 'files' })).toBe('path=a%2F');
    expect(withFilesTabState(new URLSearchParams('tab=api'), { tab: 'settings' })).toBe('tab=settings');
    expect(hrefWithQuery('/dashboard/files/docs', '')).toBe('/dashboard/files/docs');
    expect(hrefWithQuery('/dashboard/files/docs', 'tab=api')).toBe('/dashboard/files/docs?tab=api');
  });

  it('reads the file whose drawer is open from `file`, and no file from anything empty', () => {
    expect(readOpenFile(new URLSearchParams('file=reports%2F2026%2Fq1.pdf'))).toBe('reports/2026/q1.pdf');
    expect(readOpenFile(new URLSearchParams('file=%20a.txt%20'))).toBe('a.txt');
    expect(readOpenFile(new URLSearchParams('file='))).toBeNull();
    expect(readOpenFile(new URLSearchParams('file=%20%20'))).toBeNull();
    expect(readOpenFile(new URLSearchParams('path=a%2F'))).toBeNull();
    expect(readOpenFile(null)).toBeNull();
    expect(readOpenFile(undefined)).toBeNull();
  });

  it('writes the open file next to the rest of the address, and takes it out with null', () => {
    expect(withFilesTabState('path=a%2F', { file: 'a/b.pdf' })).toBe('path=a%2F&file=a%2Fb.pdf');
    expect(withFilesTabState('path=a%2F&file=a%2Fb.pdf', { file: null })).toBe('path=a%2F');
    expect(withFilesTabState('file=a.txt', { file: '' })).toBe('');
    expect(withFilesTabState('file=old.txt', { file: ' new.txt ' })).toBe('file=new.txt');
    // A change that does not name the file leaves it where it is, whatever else changes.
    expect(withFilesTabState('file=a.txt&q=x', { q: 'y' })).toBe('file=a.txt&q=y');
    expect(withFilesTabState('file=a.txt', { tab: 'settings', file: null })).toBe('tab=settings');
    // A key with characters of an address survives the round trip.
    const key = 'Q3 report & notes/summary (final)+v2.pdf';
    expect(readOpenFile(new URLSearchParams(withFilesTabState('', { file: key })))).toBe(key);
  });

  it('knows a flat listing (a search or a type) from a folder listing, and a narrowed one from a plain one', () => {
    expect(isFlatListing(state())).toBe(false);
    expect(isFlatListing(state({ q: 'x' }))).toBe(true);
    expect(isFlatListing(state({ type: 'pdf' }))).toBe(true);
    expect(isFlatListing(state({ show: 'session' }))).toBe(false);
    expect(hasListingFilters(state())).toBe(false);
    expect(hasListingFilters(state({ path: 'a/' }))).toBe(false);
    expect(hasListingFilters(state({ show: 'other' }))).toBe(true);
    expect(hasListingFilters(state({ q: 'x' }))).toBe(true);
  });
});

/* ── The listing and its rows ────────────────────────────────────────────── */

describe('what the Files tab asks the server for', () => {
  it('always sends the folder, so a search is scoped to it', () => {
    expect(listingQuery(state())).toEqual({ prefix: '', limit: PAGE_SIZE });
    expect(listingQuery(state({ path: 'a/b/', q: 'inv', type: 'pdf', show: 'session' }))).toEqual({
      prefix: 'a/b/',
      limit: PAGE_SIZE,
      search: 'inv',
      type: 'pdf',
      purpose: 'conversation',
    });
    expect(listingQuery(state({ show: 'other' })).purpose).toBe('other');
    expect(PAGE_SIZE).toBe(50);
  });

  it('is the address of the dashboard API, in the order the server documents it', () => {
    expect(filesRoutes.objects('docs', listingQuery(state()))).toBe('/api/files/buckets/docs/objects?limit=50&prefix=');
    expect(filesRoutes.objects('docs', { ...listingQuery(state({ path: 'a/', q: 'x', type: 'text', show: 'session' })), cursor: 'c1' })).toBe(
      '/api/files/buckets/docs/objects?limit=50&prefix=a%2F&search=x&type=text&purpose=conversation&cursor=c1',
    );
  });

  it('keeps the limits the server enforces', () => {
    expect(ARCHIVE_MAX_KEYS).toBe(50);
    expect(BATCH_DELETE_MAX_KEYS).toBe(100);
  });
});

describe('the rows of the grid', () => {
  const items = [rec('root.txt'), rec('reports/a.pdf'), rec('reports/2026/b.pdf'), rec('reports/2026/c.pdf'), rec('zeta/z.txt')];

  it('lists the sub-folders first, then the files directly in the folder', () => {
    const root = buildRows({ items, folders: ['reports/', 'zeta/'], state: state() });
    expect(root.map((row) => row.id)).toEqual(['folder:reports/', 'folder:zeta/', 'file:root.txt']);
    const inReports = buildRows({ items, folders: ['reports/2026/'], state: state({ path: 'reports/' }) });
    expect(inReports.map((row) => row.id)).toEqual(['folder:reports/2026/', 'file:reports/a.pdf']);
  });

  it('derives a folder from a nested key even when the server did not name it', () => {
    const rows = buildRows({ items: [rec('a/b/c.txt')], folders: [], state: state() });
    expect(rows).toEqual([{ kind: 'folder', id: 'folder:a/', name: 'a', path: 'a/' }]);
  });

  it('is flat for a search or a type: only the matches, wherever they sit', () => {
    const rows = buildRows({ items, folders: ['reports/'], state: state({ q: 'pdf' }) });
    expect(rows.every((row) => row.kind === 'file')).toBe(true);
    expect(rows).toHaveLength(items.length);
    expect(fileRowsOf(rows).map((row) => row.record.key)).toEqual(items.map((item) => item.key));
  });

  it('applies the session filter again, in case the server ignored it', () => {
    const mixed = [rec('a.txt'), rec('s.txt', { purpose: 'conversation' })];
    expect(fileRowsOf(buildRows({ items: mixed, folders: [], state: state({ show: 'session' }) })).map((row) => row.record.key)).toEqual(['s.txt']);
    expect(fileRowsOf(buildRows({ items: mixed, folders: [], state: state({ show: 'other' }) })).map((row) => row.record.key)).toEqual(['a.txt']);
  });

  it('names the folder a file sits in', () => {
    expect(folderOfKey('reports/2026/a.pdf')).toBe('reports/2026/');
    expect(folderOfKey('a.pdf')).toBe('');
  });

  it('draws the session columns for the session filter or when the list holds a session file', () => {
    expect(showsSessionColumns(state(), [rec('a'), rec('b')])).toBe(false);
    expect(showsSessionColumns(state(), [rec('a'), rec('s', { purpose: 'conversation' })])).toBe(true);
    expect(showsSessionColumns(state({ show: 'session' }), [])).toBe(true);
  });

  it('offers the Markdown download for a copy that exists, whatever the last conversion did', () => {
    // A re-conversion that fails, is skipped or is still running leaves the earlier copy where it was.
    expect(hasMarkdownCopy(rec('a', { markdownKey: 'a.md', markdownStatus: 'succeeded' }))).toBe(true);
    expect(hasMarkdownCopy(rec('a', { markdownKey: 'a.md', markdownStatus: 'failed' }))).toBe(true);
    expect(hasMarkdownCopy(rec('a', { markdownKey: 'a.md', markdownStatus: 'pending' }))).toBe(true);
    expect(hasMarkdownCopy(rec('a', { markdownKey: 'a.md', markdownStatus: 'skipped' }))).toBe(true);
    // A record without a copy has nothing to download, even when its status says the conversion went well.
    expect(hasMarkdownCopy(rec('a', { markdownStatus: 'succeeded' }))).toBe(false);
    expect(hasMarkdownCopy(rec('a', { markdownKey: '', markdownStatus: 'succeeded' }))).toBe(false);
    expect(hasMarkdownCopy(rec('a', { markdownStatus: 'pending' }))).toBe(false);
  });

  it('says a file changed when it last changed, else when it was created', () => {
    expect(modifiedAt({ updatedAt: '2026-02-01T00:00:00Z' as unknown as Date, createdAt: '2026-01-01T00:00:00Z' as unknown as Date })).toBe('2026-02-01T00:00:00Z');
    expect(modifiedAt({ createdAt: '2026-01-01T00:00:00Z' as unknown as Date })).toBe('2026-01-01T00:00:00Z');
    expect(modifiedAt({})).toBeNull();
  });
});

describe('the selection behind the bulk bar', () => {
  const keys = ['a', 'b', 'c'];

  it('toggles a key without touching the set it was given', () => {
    const none = new Set<string>();
    const one = toggleSelection(none, 'a');
    expect([...one]).toEqual(['a']);
    expect(none.size).toBe(0);
    expect(toggleSelection(one, 'a').size).toBe(0);
  });

  it('says how much of what is on screen is selected', () => {
    expect(selectionState(new Set(), keys)).toBe('none');
    expect(selectionState(new Set(['a']), keys)).toBe('some');
    expect(selectionState(new Set(keys), keys)).toBe('all');
    expect(selectionState(new Set(['gone']), keys)).toBe('none');
    expect(selectionState(new Set(['a']), [])).toBe('none');
  });

  it('acts only on the selected keys that are still shown, in screen order', () => {
    expect(selectedVisibleKeys(new Set(['c', 'gone', 'a']), keys)).toEqual(['a', 'c']);
  });
});

describe('deleting several files', () => {
  const many = Array.from({ length: 250 }, (_, index) => `f${index}`);
  const describeError = (error: unknown) => (error instanceof Error ? error.message : 'failed');

  it('splits the keys into requests of at most 100', () => {
    expect(chunk(many, 100).map((batch) => batch.length)).toEqual([100, 100, 50]);
    expect(chunk([], 100)).toEqual([]);
  });

  it('sends the batches one after the other and reports the progress', async () => {
    const seen: number[] = [];
    const progress: Array<[number, number]> = [];
    const result = await deleteInBatches(
      many,
      async (batch) => {
        seen.push(batch.length);
        return { deleted: batch, failed: [] };
      },
      { describeError, onProgress: (done, total) => progress.push([done, total]) },
    );
    expect(seen).toEqual([100, 100, 50]);
    expect(progress).toEqual([[100, 250], [200, 250], [250, 250]]);
    expect(result.deleted).toEqual(many);
    expect(result.failed).toEqual([]);
  });

  it('accounts for every key when some are refused one by one', async () => {
    const result = await deleteInBatches(
      ['a', 'b', 'c'],
      async (batch) => ({ deleted: batch.filter((key) => key !== 'b'), failed: batch.filter((key) => key === 'b').map((key) => ({ key, error: 'in use' })) }),
      { describeError },
    );
    expect(result).toEqual({ deleted: ['a', 'c'], failed: [{ key: 'b', error: 'in use' }] });
  });

  it('fails the keys of a request that failed as a whole, and the ones after it, and stops', async () => {
    const deleteBatch = vi.fn(async (batch: string[]) => {
      if (deleteBatch.mock.calls.length === 2) throw new Error('connection lost');
      return { deleted: batch, failed: [] };
    });
    const result = await deleteInBatches(many, deleteBatch, { describeError });
    expect(deleteBatch).toHaveBeenCalledTimes(2);
    expect(result.deleted).toEqual(many.slice(0, 100));
    expect(result.failed.map((entry) => entry.key)).toEqual(many.slice(100));
    expect(new Set(result.failed.map((entry) => entry.error))).toEqual(new Set(['connection lost']));
    // Every key is in exactly one of the two lists.
    expect(result.deleted.length + result.failed.length).toBe(many.length);
  });

  it('merges the answers of several requests', () => {
    expect(
      mergeBatchResults([
        { deleted: ['a'], failed: [{ key: 'x', error: 'no' }] },
        { deleted: ['b'], failed: [] },
      ]),
    ).toEqual({ deleted: ['a', 'b'], failed: [{ key: 'x', error: 'no' }] });
  });

  it('shows the first failures and counts the rest', () => {
    const failed = Array.from({ length: 8 }, (_, index) => ({ key: `k${index}`, error: 'no' }));
    const preview = previewFailures(failed);
    expect(preview.shown.map((entry) => entry.key)).toEqual(['k0', 'k1', 'k2', 'k3', 'k4']);
    expect(preview.more).toBe(3);
    expect(previewFailures(failed.slice(0, 2))).toEqual({ shown: failed.slice(0, 2), more: 0 });
  });
});

/* ── Import from storage ─────────────────────────────────────────────────── */

describe('the import scan', () => {
  it('adds a page to the progress and keeps the cursor only while there is one', () => {
    const first = addImportPage(EMPTY_IMPORT_PROGRESS, { scanned: 200, imported: 150, skipped: 50, nextCursor: 'c1' });
    expect(first).toEqual({ pages: 1, scanned: 200, imported: 150, skipped: 50, cursor: 'c1' });
    const last = addImportPage(first, { scanned: 30, imported: 30, skipped: 0 });
    expect(last).toEqual({ pages: 2, scanned: 230, imported: 180, skipped: 50 });
    expect(last).not.toHaveProperty('cursor');
  });

  it('reads page after page until the server has no cursor, summing the counts', async () => {
    const step = vi
      .fn()
      .mockResolvedValueOnce({ scanned: 200, imported: 100, skipped: 100, nextCursor: 'c1' })
      .mockResolvedValueOnce({ scanned: 200, imported: 0, skipped: 200, nextCursor: 'c2' })
      .mockResolvedValueOnce({ scanned: 7, imported: 7, skipped: 0 });
    const updates: number[] = [];
    const run = await runImportScan({ step, onProgress: (progress) => updates.push(progress.scanned) });
    expect(run.outcome).toBe('done');
    expect(run.progress).toMatchObject({ pages: 3, scanned: 407, imported: 107, skipped: 300 });
    expect(step.mock.calls.map((call) => call[0])).toEqual([
      { limit: IMPORT_PAGE_SIZE },
      { cursor: 'c1', limit: IMPORT_PAGE_SIZE },
      { cursor: 'c2', limit: IMPORT_PAGE_SIZE },
    ]);
    expect(updates).toEqual([200, 400, 407]);
  });

  it('stops when asked, with the progress to continue from, and continues from there', async () => {
    let asked = 0;
    const step = vi
      .fn()
      .mockResolvedValueOnce({ scanned: 200, imported: 10, skipped: 190, nextCursor: 'c1' })
      .mockResolvedValueOnce({ scanned: 5, imported: 5, skipped: 0 });
    const first = await runImportScan({ step, shouldStop: () => (asked += 1) > 1 });
    expect(first.outcome).toBe('stopped');
    expect(first.progress).toMatchObject({ pages: 1, scanned: 200, cursor: 'c1' });
    expect(step).toHaveBeenCalledTimes(1);

    const second = await runImportScan({ step, from: first.progress });
    expect(second.outcome).toBe('done');
    expect(step.mock.calls[1]![0]).toEqual({ cursor: 'c1', limit: IMPORT_PAGE_SIZE });
    // The counts of both runs add up.
    expect(second.progress).toMatchObject({ pages: 2, scanned: 205, imported: 15, skipped: 190 });
  });

  it('fails with the progress made and the error of the request, and can be resumed', async () => {
    const boom = new FilesApiError({ message: 'The bucket is disabled.', status: 409, code: 'bucket_inactive' });
    const step = vi
      .fn()
      .mockResolvedValueOnce({ scanned: 200, imported: 200, skipped: 0, nextCursor: 'c1' })
      .mockRejectedValueOnce(boom);
    const run = await runImportScan({ step });
    expect(run.outcome).toBe('failed');
    expect(run.error).toBe(boom);
    expect(run.progress).toMatchObject({ pages: 1, imported: 200, cursor: 'c1' });
  });

  it('refuses to loop on a cursor that does not advance', async () => {
    const step = vi.fn().mockResolvedValue({ scanned: 1, imported: 0, skipped: 1, nextCursor: 'same' });
    const run = await runImportScan({ step });
    expect(run.outcome).toBe('failed');
    expect(String((run.error as Error).message)).toMatch(/advance/);
    expect(step).toHaveBeenCalledTimes(2);
  });

  it('offers a second try for every failure but a storage location another bucket uses', () => {
    expect(canRetryImport(FilesApiError.fromBody(409, { error: 'x', code: 'storage_location_shared' }))).toBe(false);
    expect(canRetryImport(FilesApiError.fromBody(409, { error: 'x', code: 'import_in_progress' }))).toBe(true);
    expect(canRetryImport(FilesApiError.fromBody(409, { error: 'x', code: 'bucket_inactive' }))).toBe(true);
    expect(canRetryImport(FilesApiError.fromBody(503, { error: 'x', code: 'storage_unavailable' }))).toBe(true);
    expect(canRetryImport(FilesApiError.network(new Error('offline')))).toBe(true);
    expect(canRetryImport(new Error('odd'))).toBe(true);
  });

  it('gives up on a scan that never ends', async () => {
    const step = vi.fn();
    const run = await runImportScan({ step, from: { ...EMPTY_IMPORT_PROGRESS, pages: MAX_IMPORT_PAGES, cursor: 'c' } });
    expect(run.outcome).toBe('failed');
    expect(step).not.toHaveBeenCalled();
  });
});

/* ── Settings ────────────────────────────────────────────────────────────── */

describe('the General form', () => {
  it('starts from the saved bucket', () => {
    expect(valuesOf({ name: 'Docs', description: undefined, status: 'active' })).toEqual({ name: 'Docs', description: '', status: 'active' });
    expect(valuesOf({ name: 'Docs', description: 'x', status: 'disabled' }).status).toBe('disabled');
  });

  it('asks for a name of at most 120 characters', () => {
    expect(nameProblem('')).toBe('required');
    expect(nameProblem('   ')).toBe('required');
    expect(nameProblem('Docs')).toBeNull();
    expect(nameProblem('x'.repeat(NAME_MAX_LENGTH))).toBeNull();
    expect(nameProblem('x'.repeat(NAME_MAX_LENGTH + 1))).toBe('tooLong');
  });

  it('sends only what changed, trimmed', () => {
    const saved = { name: 'Docs', description: 'Old', status: 'active' as const };
    expect(settingsPatch(valuesOf(saved), saved)).toEqual({});
    expect(settingsPatch({ name: ' Docs ', description: 'Old ', status: 'active' }, saved)).toEqual({});
    expect(settingsPatch({ name: 'Docs 2', description: 'Old', status: 'active' }, saved)).toEqual({ name: 'Docs 2' });
    expect(settingsPatch({ name: 'Docs', description: '', status: 'active' }, saved)).toEqual({ description: '' });
    expect(settingsPatch({ name: 'Docs', description: 'Old', status: 'disabled' }, saved)).toEqual({ status: 'disabled' });
    expect(settingsPatch({ name: 'D', description: 'N', status: 'disabled' }, saved)).toEqual({ name: 'D', description: 'N', status: 'disabled' });
    expect(isDirty(valuesOf(saved), saved)).toBe(false);
    expect(isDirty({ ...valuesOf(saved), name: 'Other' }, saved)).toBe(true);
  });
});

describe('the Storage card’s rules', () => {
  it('names the driver from the catalog, and by its id when the catalog does not know it', () => {
    expect(driverNameOf({ driver: 'aws-s3-files', key: 'minio' })).toBe('Amazon S3');
    expect(driverNameOf({ driver: 'local-filesystem', key: 'local' })).toBe('Local filesystem');
    expect(driverNameOf({ driver: 'some-new-driver' })).toBe('some-new-driver');
  });

  it('links into Providers only for owners and admins; an unknown role is a hint, never the gate', () => {
    expect(mayOpenProviders('owner')).toBe(true);
    expect(mayOpenProviders('admin')).toBe(true);
    expect(mayOpenProviders('project_admin')).toBe(false);
    expect(mayOpenProviders('user')).toBe(false);
    expect(mayOpenProviders(undefined)).toBe(true);
  });

  it('resolves the prefix the way the server does: its own, else the bucket key, "" being the root', () => {
    expect(effectivePrefix({ key: 'docs' })).toBe('docs');
    expect(effectivePrefix({ key: 'docs', prefix: undefined })).toBe('docs');
    expect(effectivePrefix({ key: 'docs', prefix: '' })).toBe('');
    expect(effectivePrefix({ key: 'docs', prefix: '/team/files/' })).toBe('team/files');
  });

  it('reads a typed prefix without its surrounding blanks and slashes, and a doubled slash as one', () => {
    expect(normalizePrefixInput('  /team//files/ ')).toBe('team/files');
    expect(normalizePrefixInput('team///files')).toBe('team/files');
    expect(normalizePrefixInput('///')).toBe('');
    expect(normalizePrefixInput('')).toBe('');
  });

  it('refuses a prefix with dot segments, control characters or too many characters', () => {
    expect(prefixProblem('')).toBeNull();
    expect(prefixProblem('team/files')).toBeNull();
    expect(prefixProblem('team/../x')).toBe('dotSegments');
    expect(prefixProblem('./x')).toBe('dotSegments');
    expect(prefixProblem('a/b.c/d')).toBeNull();
    expect(prefixProblem('bad\u0007name')).toBe('controlChars');
    expect(prefixProblem('x'.repeat(PREFIX_MAX_LENGTH))).toBeNull();
    expect(prefixProblem('x'.repeat(PREFIX_MAX_LENGTH + 1))).toBe('tooLong');
  });

  it('refuses what the server refuses in a prefix: two dots anywhere, a backslash, the delete character', () => {
    expect(PREFIX_MAX_LENGTH).toBe(200);
    // Two dots are refused inside a name too, not only as a folder of their own.
    expect(prefixProblem('a..b')).toBe('dotSegments');
    expect(prefixProblem('team/..hidden')).toBe('dotSegments');
    expect(prefixProblem('v1.2/notes')).toBeNull();
    expect(prefixProblem('team\\files')).toBe('controlChars');
    expect(prefixProblem('bad\u007fname')).toBe('controlChars');
    // The limit counts what is kept: the slashes and blanks around the prefix do not.
    expect(prefixProblem(`/${'x'.repeat(PREFIX_MAX_LENGTH)}/ `)).toBeNull();
    expect(prefixProblem(' '.repeat(5) + 'x'.repeat(PREFIX_MAX_LENGTH + 1))).toBe('tooLong');
  });

  it('keeps the limits and the checks of the forms the same as the server’s', () => {
    expect(BUCKET_NAME_MAX).toBe(SERVER_BUCKET_NAME_MAX_LENGTH);
    expect(BUCKET_DESCRIPTION_MAX).toBe(SERVER_BUCKET_DESCRIPTION_MAX_LENGTH);
    expect(BUCKET_PREFIX_MAX).toBe(SERVER_BUCKET_PREFIX_MAX_LENGTH);
    expect(NAME_MAX_LENGTH).toBe(SERVER_BUCKET_NAME_MAX_LENGTH);
    expect(PREFIX_MAX_LENGTH).toBe(SERVER_BUCKET_PREFIX_MAX_LENGTH);

    const serverRefusesPrefix = (text: string) => {
      try {
        parseBucketPrefix(normalizeBucketPrefix(text));
        return false;
      } catch {
        return true;
      }
    };
    const prefixes = [
      '', 'team', 'team/files', 'a/b.c/d', 'v1.2/notes', '  /team//files/ ', '///', 'a//b', 'a/./b', './a', 'a/b/.', '.',
      'a..b', '../x', 'x/..', 'x/..y', 'team\\files', 'bad\u0007name', 'bad\u007fname', 'tab\tname', 'new\nline',
      'x'.repeat(PREFIX_MAX_LENGTH), 'x'.repeat(PREFIX_MAX_LENGTH + 1), `/${'x'.repeat(PREFIX_MAX_LENGTH)}/`, ' é/ü ',
    ];
    for (const text of prefixes) expect(prefixProblem(text) !== null, JSON.stringify(text)).toBe(serverRefusesPrefix(text));

    const serverRefusesName = (text: string) => {
      try {
        parseBucketName(text);
        return false;
      } catch {
        return true;
      }
    };
    for (const text of ['', '  ', 'Docs', ' Docs ', 'x'.repeat(BUCKET_NAME_MAX), 'x'.repeat(BUCKET_NAME_MAX + 1), ` ${'x'.repeat(BUCKET_NAME_MAX)} `]) {
      expect(nameProblem(text) !== null, JSON.stringify(text)).toBe(serverRefusesName(text));
    }

    const serverRefusesDescription = (text: string) => {
      try {
        parseBucketDescription(text);
        return false;
      } catch {
        return true;
      }
    };
    for (const text of ['', 'Notes', 'two\nlines', 'x'.repeat(BUCKET_DESCRIPTION_MAX), 'x'.repeat(BUCKET_DESCRIPTION_MAX + 1), ` ${'x'.repeat(BUCKET_DESCRIPTION_MAX)} `]) {
      expect(descriptionProblem(text) !== null, JSON.stringify(text)).toBe(serverRefusesDescription(text));
    }
  });

  it('asks for a description of at most 1000 characters', () => {
    expect(descriptionProblem('')).toBeNull();
    expect(descriptionProblem('x'.repeat(DESCRIPTION_MAX_LENGTH))).toBeNull();
    expect(descriptionProblem(` ${'x'.repeat(DESCRIPTION_MAX_LENGTH)} `)).toBeNull();
    expect(descriptionProblem('x'.repeat(DESCRIPTION_MAX_LENGTH + 1))).toBe('tooLong');
  });

  it('fixes the prefix once the bucket holds a file', () => {
    expect(isPrefixLocked({ stats: { fileCount: 1 } })).toBe(true);
    expect(isPrefixLocked({ stats: { fileCount: 0 } })).toBe(false);
    expect(isPrefixLocked({})).toBe(false);
    expect(isPrefixLocked({ stats: null })).toBe(false);
  });
});

describe('the Usage card’s gauges', () => {
  it('fills a bar to the share used, in three tones', () => {
    expect(gaugeOf(0, 100)).toEqual({ percent: 0, tone: 'ok' });
    expect(gaugeOf(79, 100)).toEqual({ percent: 79, tone: 'ok' });
    expect(gaugeOf(80, 100)).toEqual({ percent: 80, tone: 'warn' });
    expect(gaugeOf(94, 100)).toEqual({ percent: 94, tone: 'warn' });
    expect(gaugeOf(95, 100)).toEqual({ percent: 95, tone: 'err' });
    expect(gaugeOf(400, 100)).toEqual({ percent: 100, tone: 'err' });
    expect(gaugeOf(-5, 100)).toEqual({ percent: 0, tone: 'ok' });
  });

  it('draws no bar for an unlimited quota', () => {
    expect(gaugeOf(50, null)).toEqual({ percent: null, tone: 'ok' });
    expect(gaugeOf(50, undefined)).toEqual({ percent: null, tone: 'ok' });
    expect(gaugeOf(50, 0)).toEqual({ percent: null, tone: 'ok' });
    expect(gaugeOf(50, Number.NaN)).toEqual({ percent: null, tone: 'ok' });
  });

  it('reads the project’s quota from the limits', () => {
    expect(quotaOf(null)).toBeNull();
    const noQuota = { maxFileBytes: 1, maxRequestBytes: 1, allowedMimeTypes: null } as unknown as FileLimits;
    expect(quotaOf(noQuota)).toBeNull();
    const limits: FileLimits = {
      maxFileBytes: 10,
      maxRequestBytes: 10,
      allowedMimeTypes: null,
      quota: { usedBytes: 90, limitBytes: 100, filesUsed: 5, filesLimit: null },
    };
    expect(quotaOf(limits)).toEqual({
      storage: { percent: 90, tone: 'warn', used: 90, limit: 100 },
      files: { percent: null, tone: 'ok', used: 5, limit: null },
    });
  });
});

describe('deleting the bucket', () => {
  const agent = { agentId: 'a 1', agentKey: 'support', name: 'Support' };

  it('is blocked while an agent keeps its session files in the bucket', () => {
    const rules = deleteRules({ usedBy: [agent], stats: { fileCount: 2, totalBytes: 1 }, deleting: false });
    expect(rules).toMatchObject({ blocked: true, agents: [agent], fileCount: 2, holdsFiles: true, deleting: false, stalled: false });
  });

  it('asks what becomes of the files only when there are some', () => {
    expect(deleteRules({ usedBy: [], stats: { fileCount: 0, totalBytes: 0 } })).toMatchObject({ blocked: false, holdsFiles: false, fileCount: 0 });
    expect(deleteRules({ usedBy: [], stats: { fileCount: 3, totalBytes: 0 } })).toMatchObject({ holdsFiles: true });
    // Missing numbers count as an empty bucket.
    expect(deleteRules({} as never)).toMatchObject({ blocked: false, fileCount: 0, agents: [], deleting: false, stalled: false, lastError: null });
  });

  it('knows a delete job is already running', () => {
    expect(deleteRules({ usedBy: [], deleting: true })).toMatchObject({ deleting: true });
  });

  describe('a delete job that was most likely lost', () => {
    const askedAt = Date.parse('2026-10-20T10:00:00.000Z');
    const deleting = { usedBy: [], deleting: true, updatedAt: '2026-10-20T10:00:00.000Z' as unknown as Date };

    it('is told from a running one by how long the bucket has been deleting', () => {
      expect(deleteRules(deleting, askedAt)).toMatchObject({ deleting: true, stalled: false });
      expect(deleteRules(deleting, askedAt + DELETE_STALLED_AFTER_MS - 1)).toMatchObject({ stalled: false });
      expect(deleteRules(deleting, askedAt + DELETE_STALLED_AFTER_MS)).toMatchObject({ stalled: true });
      expect(deleteRules(deleting, askedAt + 24 * 3_600_000)).toMatchObject({ stalled: true });
    });

    it('is never taken for lost without a time to judge by, or with one in the future', () => {
      expect(deleteRules({ usedBy: [], deleting: true }, askedAt + 24 * 3_600_000)).toMatchObject({ deleting: true, stalled: false });
      expect(deleteRules({ usedBy: [], deleting: true, updatedAt: 'not a date' as unknown as Date }, askedAt)).toMatchObject({ stalled: false });
      expect(deleteRules(deleting, askedAt - 60_000)).toMatchObject({ stalled: false });
    });

    it('is not a thing for a bucket that is not deleting', () => {
      expect(deleteRules({ usedBy: [], deleting: false, updatedAt: deleting.updatedAt }, askedAt + 24 * 3_600_000)).toMatchObject({ deleting: false, stalled: false });
      expect(deleteRules({ usedBy: [], updatedAt: deleting.updatedAt }, askedAt + 24 * 3_600_000)).toMatchObject({ deleting: false, stalled: false });
    });
  });

  describe('a delete that stopped with an error', () => {
    it('carries the reason, so the person can read it and ask again', () => {
      expect(deleteRules({ usedBy: [], deleting: false, deleteError: 'Access denied' })).toMatchObject({ deleting: false, lastError: 'Access denied' });
      expect(deleteRules({ usedBy: [], metadata: { deleteError: 'Access denied' } })).toMatchObject({ lastError: 'Access denied' });
      expect(deleteRules({ usedBy: [] })).toMatchObject({ lastError: null });
    });

    it('is not shown while a run is going: the reason belongs to the run before it', () => {
      expect(deleteRules({ usedBy: [], deleting: true, deleteError: 'Access denied' })).toMatchObject({ deleting: true, lastError: null });
    });
  });

  it('links the blocking agent to its Files settings', () => {
    expect(agentFilesHref(agent)).toBe('/dashboard/agents/a%201?tab=files');
  });

  it('reads why the last delete failed from the bucket’s record', () => {
    expect(deleteErrorOf({})).toBeNull();
    expect(deleteErrorOf({ metadata: { deleteError: '  Access denied ' } })).toBe('Access denied');
    expect(deleteErrorOf({ metadata: { deleteError: { message: 'Timeout' } } })).toBe('Timeout');
    expect(deleteErrorOf({ metadata: { deleteError: '   ' } })).toBeNull();
    expect(deleteErrorOf({ metadata: { deleteError: 42 } })).toBeNull();
  });

  it('prefers the reason the list and the bucket state outright, over the one in the metadata', () => {
    expect(deleteErrorOf({ deleteError: ' Access denied ' })).toBe('Access denied');
    expect(deleteErrorOf({ deleteError: 'Newer', metadata: { deleteError: 'Older' } })).toBe('Newer');
    expect(deleteErrorOf({ deleteError: '   ', metadata: { deleteError: 'Older' } })).toBe('Older');
    expect(deleteErrorOf({ deleteError: '' })).toBeNull();
  });
});

describe('the words of a failed bucket call', () => {
  const t = (key: string) => `[${key}]`;

  it('uses the server’s sentence for a bucket that agents keep in use, with the agents it names', () => {
    const reason = 'The bucket "docs" is where this agent keeps session files: Support.';
    const refused = FilesApiError.fromBody(409, { error: reason, code: 'bucket_in_use', agents: [{ key: 'support', name: 'Support' }, { key: 'sales' }] });
    expect(bucketErrorMessage(refused, t)).toBe(`${reason} (sales)`);
  });

  it('uses the shared wording for everything else', () => {
    expect(bucketErrorMessage(FilesApiError.fromBody(409, { error: 'x', code: 'prefix_locked' }), t)).toBe('[errors.prefixLocked]');
    expect(bucketErrorMessage(FilesApiError.fromBody(403, {}), t)).toBe('[errors.forbidden]');
    expect(bucketErrorMessage(new Error('odd'), t)).toBe('[errors.generic]');
  });

  describe('a bucket delete that failed', () => {
    const sentence = 'This bucket holds files of sessions started by someone else, and you are not allowed to change them, so it cannot be deleted with its files.';
    const refused = FilesApiError.fromBody(403, { error: sentence, code: 'forbidden', message: sentence, service: 'agents', required: 'write' });
    const failure = (error: unknown) => bucketErrorMessage(error, t, 'deleteBucket');

    it('says why, in the server’s sentence, when the files could not go because of other people’s sessions', () => {
      expect(failure(refused)).toBe(sentence);
      // The answer that has no code and only an `error` (the fallback of the same route) says it too.
      expect(failure(FilesApiError.fromBody(403, { error: sentence }))).toBe(sentence);
    });

    it('words the gates’ own refusal, which gives no reason of its own, as a missing permission', () => {
      const gate = 'Forbidden: files requires write permission';
      expect(failure(FilesApiError.fromBody(403, {}))).toBe('[errors.forbidden]');
      expect(failure(FilesApiError.fromBody(403, { error: 'Forbidden' }))).toBe('[errors.forbidden]');
      expect(failure(FilesApiError.fromBody(403, { error: gate, code: 'forbidden', message: gate, service: 'files', required: 'write' }))).toBe('[errors.forbidden]');
    });

    it('uses the delete dialog’s words for a storage location another bucket uses', () => {
      const shared = FilesApiError.fromBody(409, { error: 'x', code: 'storage_location_shared' });
      expect(failure(shared)).toBe('[errors.storageLocationSharedDelete]');
    });

    it('keeps the agents of a bucket in use, and the wording of everything else', () => {
      const reason = 'The bucket "docs" is where this agent keeps session files: Support.';
      const inUse = FilesApiError.fromBody(409, { error: reason, code: 'bucket_in_use', agents: [{ key: 'support', name: 'Support' }] });
      expect(failure(inUse)).toBe(reason);
      expect(failure(FilesApiError.fromBody(409, { error: 'x', code: 'bucket_deleting' }))).toBe('[errors.bucketDeleting]');
      expect(failure(FilesApiError.fromBody(503, { error: 'x', code: 'queue_unavailable' }))).toBe('[errors.queueUnavailable]');
      expect(failure(FilesApiError.fromBody(409, { error: 'x', code: 'bucket_not_empty' }))).toBe('[errors.bucketNotEmpty]');
      expect(failure(new Error('odd'))).toBe('[errors.generic]');
    });
  });

  it('knows a bucket that is gone', () => {
    expect(isBucketGone(FilesApiError.fromBody(404, { error: 'x' }))).toBe(true);
    expect(isBucketGone(FilesApiError.fromBody(409, { error: 'x', code: 'bucket_not_found' }))).toBe(true);
    expect(isBucketGone(FilesApiError.fromBody(500, { error: 'x' }))).toBe(false);
    expect(isBucketGone(null)).toBe(false);
  });
});

/* ── The API tab's samples ───────────────────────────────────────────────── */

describe('the API tab’s code samples', () => {
  const context = { origin: 'https://console.example.com/', bucketKey: 'support-docs' };
  const all = API_LANGUAGES.flatMap((language) => API_OPERATIONS.map((operation) => ({ language, operation, code: buildSnippet(operation, language, context) })));

  it('covers three languages and the six operations of a bucket’s files', () => {
    expect(API_LANGUAGES).toEqual(['curl', 'typescript', 'python']);
    expect(API_OPERATIONS).toEqual(['list', 'listFolder', 'upload', 'uploadToFolder', 'download', 'delete']);
    expect(all).toHaveLength(18);
  });

  it('uses the real host and this bucket’s key everywhere, and never prints a missing value', () => {
    for (const { language, operation, code } of all) {
      const label = `${language}/${operation}`;
      expect(code, label).toContain('console.example.com');
      expect(code, label).not.toContain('https://console.example.com//');
      expect(code, label).toContain('support-docs');
      // A value that was not there would print as one of these (`nextCursor ?? undefined` is real code, not one of them).
      expect(code, label).not.toMatch(/\/undefined\b|'undefined'|"undefined"|\[object|\bNaN\b/);
    }
  });

  it('calls the routes of the client API, not the dashboard’s', () => {
    for (const { language, code } of all) {
      expect(code).not.toContain('/api/files/');
      if (language === 'curl') expect(code).toContain('/api/client/v1/files/buckets/support-docs/objects');
    }
    expect(clientApiRoutes.objects('support-docs')).toBe('/api/client/v1/files/buckets/support-docs/objects');
    expect(buildSnippet('list', 'curl', context)).toContain(`https://console.example.com${clientApiRoutes.objects('support-docs')}?limit=50`);
    expect(buildSnippet('delete', 'curl', context)).toContain(`-X DELETE "https://console.example.com${clientApiRoutes.object('support-docs', SAMPLE_FILE_KEY)}"`);
  });

  it('sends the object key as ONE path segment: its slashes are encoded', () => {
    const encoded = encodeURIComponent(SAMPLE_FILE_KEY);
    expect(encoded).toContain('%2F');
    expect(buildSnippet('download', 'curl', context)).toContain(`${clientApiRoutes.download('support-docs', SAMPLE_FILE_KEY)}`);
    expect(buildSnippet('download', 'curl', context)).toContain(`${clientApiRoutes.download('support-docs', SAMPLE_FILE_KEY, 'markdown')}`);
    expect(clientApiRoutes.download('support-docs', SAMPLE_FILE_KEY, 'markdown')).toContain('?variant=markdown');
    // Python encodes it itself (safe=""), TypeScript hands it to the SDK as it is.
    expect(buildSnippet('download', 'python', context)).toContain('quote(');
    expect(buildSnippet('download', 'python', context)).toContain('safe=""');
    expect(buildSnippet('download', 'typescript', context)).toContain(`client.files.download('support-docs', '${SAMPLE_FILE_KEY}')`);
  });

  it('uploads a base64 data URL in a JSON body and asks for the Markdown copy', () => {
    const curl = buildSnippet('upload', 'curl', context);
    expect(curl).toContain('-X POST');
    expect(curl).toContain('data:application/pdf;base64,');
    expect(curl).toContain('convertToMarkdown: true');
    expect(curl).toContain('"Content-Type: application/json"');
    expect(buildSnippet('upload', 'typescript', context)).toContain('convertToMarkdown: true');
    expect(buildSnippet('upload', 'typescript', context)).toContain('data:application/pdf;base64,${bytes.toString(\'base64\')}');
    expect(buildSnippet('upload', 'python', context)).toContain('"convertToMarkdown": True');
    expect(buildSnippet('upload', 'python', context)).toContain('data:application/pdf;base64,{encoded}');
  });

  it('puts a file in a folder with a keyHint that ends in a slash, and only then', () => {
    expect(SAMPLE_FOLDER.endsWith('/')).toBe(true);
    for (const language of API_LANGUAGES) {
      expect(buildSnippet('upload', language, context), language).not.toContain('keyHint');
      expect(buildSnippet('uploadToFolder', language, context), language).toContain('keyHint');
      expect(buildSnippet('uploadToFolder', language, context), language).toContain(SAMPLE_FOLDER);
    }
  });

  it('lists a folder through the prefix parameter, which the SDK’s list helper does not have', () => {
    expect(buildSnippet('listFolder', 'curl', context)).toContain(`prefix=${SAMPLE_FOLDER}`);
    const typescript = buildSnippet('listFolder', 'typescript', context);
    expect(typescript).toContain("searchParams.set('prefix'");
    expect(typescript).not.toContain('client.files.list');
    expect(buildSnippet('listFolder', 'python', context)).toContain('"prefix"');
    expect(buildSnippet('list', 'typescript', context)).toContain("client.files.list('support-docs'");
  });

  it('keeps the token out of the page: a placeholder in the samples, the key from the environment', () => {
    expect(TOKEN_PLACEHOLDER).toBe('YOUR_API_TOKEN');
    expect(buildSnippet('list', 'curl', context)).toContain(`Authorization: Bearer ${TOKEN_PLACEHOLDER}`);
    expect(buildSnippet('list', 'python', context)).toContain(`Bearer ${TOKEN_PLACEHOLDER}`);
    expect(buildSnippet('list', 'typescript', context)).toContain('process.env.API_TOKEN');
    expect(buildSnippet('list', 'typescript', context)).toContain("baseURL: 'https://console.example.com'");
  });

  it('escapes a bucket key that has a quote or a space in it', () => {
    const odd = { origin: 'https://h.example', bucketKey: "it's docs" };
    expect(buildSnippet('list', 'typescript', odd)).toContain("client.files.list('it\\'s docs'");
    expect(buildSnippet('list', 'curl', odd)).toContain('/buckets/it\'s%20docs/objects');
  });

  it('shows a placeholder host until the page knows its own', () => {
    expect(apiBaseUrl('')).toBe(`${PLACEHOLDER_ORIGIN}/api/client/v1`);
    expect(apiBaseUrl('  ')).toBe(`${PLACEHOLDER_ORIGIN}/api/client/v1`);
    expect(apiBaseUrl('https://a.example///')).toBe('https://a.example/api/client/v1');
    expect(buildSnippet('list', 'curl', { origin: '', bucketKey: 'docs' })).toContain(PLACEHOLDER_ORIGIN);
  });

  it('names each operation by the request it makes', () => {
    expect(routeOf('list', 'docs')).toBe('GET /api/client/v1/files/buckets/docs/objects');
    expect(routeOf('listFolder', 'docs')).toBe('GET /api/client/v1/files/buckets/docs/objects');
    expect(routeOf('upload', 'docs')).toBe('POST /api/client/v1/files/buckets/docs/objects');
    expect(routeOf('uploadToFolder', 'docs')).toBe('POST /api/client/v1/files/buckets/docs/objects');
    expect(routeOf('download', 'docs')).toBe('GET /api/client/v1/files/buckets/docs/objects/{key}/download');
    expect(routeOf('delete', 'docs')).toBe('DELETE /api/client/v1/files/buckets/docs/objects/{key}');
  });

  it('shows the answers a caller reads the key from', () => {
    const upload = JSON.parse(uploadResponseExample('docs'));
    expect(upload.file).toMatchObject({ bucketKey: 'docs', key: SAMPLE_FILE_KEY, name: 'report.pdf' });
    // The key is generated: <slug>-<timestamp>-<8 hex>.<ext>, inside the folder it was uploaded to.
    expect(upload.file.key).toMatch(/\/[a-z0-9-]+-\d{13}-[0-9a-f]{8}\.pdf$/);
    const list = JSON.parse(listResponseExample());
    expect(list).toMatchObject({ count: 1, prefix: SAMPLE_FOLDER, nextCursor: null });
    expect(list.files[0].key).toBe(SAMPLE_FILE_KEY);
    expect(list.folders[0].startsWith(SAMPLE_FOLDER)).toBe(true);
  });

  /**
   * The key of a bucket made before keys were checked can be any text, and every sample is code that a person
   * copies and runs. Each sample is rendered with such keys and compared with the render for a plain key: the key may
   * change the text it stands for, never the shape of the program around it.
   */
  describe('a bucket key that holds quotes, braces, a backslash or a line break', () => {
    const MARK = 'KEYMARK';
    const AWKWARD_KEYS = [
      'say "hello"',
      'a"+b+"',
      'x{1 + 1}',
      'x{name}',
      'back\\slash',
      "it's",
      'two\nlines',
      'return\rcarriage',
      'line\u2028separator',
      'tab\tstop',
      'a b',
      '../up',
      'A/B',
      '100%',
      'back`tick${name}',
      'first\nsecond();//',
    ];
    const at = (bucketKey: string) => ({ origin: 'https://console.example.com', bucketKey });
    const count = (text: string, pattern: RegExp) => (text.match(pattern) ?? []).length;

    it('puts the key in the cURL and Python samples in its URL-encoded form only, where a plain key stands', () => {
      for (const language of ['curl', 'python'] as const) {
        for (const operation of API_OPERATIONS) {
          const plain = buildSnippet(operation, language, at(MARK));
          for (const key of AWKWARD_KEYS) {
            const label = `${language}/${operation} ${JSON.stringify(key)}`;
            expect(buildSnippet(operation, language, at(key)), label).toBe(plain.split(MARK).join(encodeURIComponent(key)));
          }
        }
      }
    });

    it('adds no line, quote, brace or backslash to the Python samples, which put the key inside an f-string', () => {
      for (const operation of API_OPERATIONS) {
        const plain = buildSnippet(operation, 'python', at(MARK)).split('\n');
        for (const key of AWKWARD_KEYS) {
          const label = `python/${operation} ${JSON.stringify(key)}`;
          const lines = buildSnippet(operation, 'python', at(key)).split('\n');
          expect(lines, label).toHaveLength(plain.length);
          lines.forEach((line, index) => {
            for (const pattern of [/"/g, /[{}]/g, /\\/g, /[\r\u2028\u2029]/g]) {
              expect(count(line, pattern), `${label}, line ${index + 1}, ${pattern}`).toBe(count(plain[index]!, pattern));
            }
          });
        }
      }
    });

    /** What the TypeScript compiler makes of a sample: its syntax errors, its node kinds and the text of its strings. */
    function shapeOf(code: string) {
      const options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext };
      const errors = (ts.transpileModule(code, { reportDiagnostics: true, compilerOptions: options }).diagnostics ?? []).map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
      );
      const kinds: number[] = [];
      const strings: string[] = [];
      const visit = (node: ts.Node) => {
        kinds.push(node.kind);
        if (ts.isStringLiteral(node)) strings.push(node.text);
        ts.forEachChild(node, visit);
      };
      visit(ts.createSourceFile('sample.ts', code, ts.ScriptTarget.ES2022, true));
      return { errors, kinds, strings };
    }

    it('keeps the key inside its string in the TypeScript samples: the same program, with the key as its text', () => {
      for (const operation of API_OPERATIONS) {
        const plain = shapeOf(buildSnippet(operation, 'typescript', at(MARK)));
        expect(plain.errors, `typescript/${operation}`).toEqual([]);
        for (const key of AWKWARD_KEYS) {
          const label = `typescript/${operation} ${JSON.stringify(key)}`;
          const shape = shapeOf(buildSnippet(operation, 'typescript', at(key)));
          expect(shape.errors, label).toEqual([]);
          expect(shape.kinds, label).toEqual(plain.kinds);
          // A string that is the key alone is the key; one that holds it in an address holds its URL-encoded form.
          expect(shape.strings, label).toEqual(plain.strings.map((text) => (text === MARK ? key : text.split(MARK).join(encodeURIComponent(key)))));
        }
      }
    });

    it('writes a line break of the key as an escape in the TypeScript literal, not as a break of the line', () => {
      const code = buildSnippet('list', 'typescript', at('two\nlines\u2028here'));
      expect(code).toContain("client.files.list('two\\nlines\\u2028here'");
      expect(code.split('\n').some((line) => line.startsWith('lines'))).toBe(false);
    });
  });
});

/* ── The wording ─────────────────────────────────────────────────────────── */

describe('the bucket page’s wording', () => {
  const flatten = (node: unknown, path = ''): Array<[string, string]> =>
    typeof node === 'string'
      ? [[path, node]]
      : node && typeof node === 'object'
        ? Object.entries(node).flatMap(([key, value]) => flatten(value, path ? `${path}.${key}` : key))
        : [];
  const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  const english = Object.fromEntries(flatten(en.files.bucket));
  const turkish = Object.fromEntries(flatten(tr.files.bucket));

  it('has the same keys and placeholders in English and Turkish, and the Turkish is not the English', () => {
    expect(Object.keys(turkish).sort()).toEqual(Object.keys(english).sort());
    for (const key of Object.keys(english)) {
      expect(turkish[key]!.trim(), key).not.toBe('');
      expect(turkish[key], key).not.toBe(english[key]);
      expect(placeholders(turkish[key]!), key).toEqual(placeholders(english[key]!));
    }
  });

  it('has no sentence that nobody asks for, and every sentence the components ask for', () => {
    const root = join(__dirname, '../../components/files/bucket');
    const used = new Set<string>();
    for (const file of readdirSync(root).filter((name) => name.endsWith('.tsx'))) {
      const source = readFileSync(join(root, file), 'utf8');
      const spaces = new Map<string, string>();
      for (const match of source.matchAll(/const\s+(\w+)\s*=\s*useTranslations\('([\w.]+)'\)/g)) spaces.set(match[1]!, match[2]!);
      for (const match of source.matchAll(/\b(\w+)\(\s*'([\w.]+)'/g)) {
        if (spaces.get(match[1]!) === 'files.bucket') used.add(match[2]!);
      }
    }
    // The two refusal titles belong to `en.ts` / `tr.ts` (the bucket list uses them too).
    const own = new Set([...Object.keys(english)].filter((key) => !key.startsWith('refusalTitle')));
    expect([...used].filter((key) => !key.startsWith('refusalTitle') && !(key in english))).toEqual([]);
    expect([...own].filter((key) => !used.has(key))).toEqual([]);
    expect(used.size).toBeGreaterThan(150);
  });
});

/* ── A narrow screen ─────────────────────────────────────────────────────── */

describe('the stylesheet’s guards for a narrow screen', () => {
  // jsdom lays nothing out, so these pin the rules that keep the page from scrolling sideways on a phone.
  const css = readFileSync(join(__dirname, '../../components/files/bucket/bucket.module.css'), 'utf8');
  const rule = (selector: string) => {
    const match = css.match(new RegExp(`(?:^|\\n)${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`));
    return match?.[1] ?? '';
  };

  it('stacks the label / value rows of the Settings cards under 640px', () => {
    // The stylesheet keeps more than one block for this width (the header has its own): look at all of them.
    const media = [...css.matchAll(/@media \(max-width: 640px\)\s*\{[\s\S]*?\n\}/g)].map((block) => block[0]).join('\n');
    expect(media).toMatch(/\.rows\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });

  it('lets the name cell shrink instead of pushing the grid wider', () => {
    for (const selector of ['.nameCell', '.nameStack', '.nameLine', '.nameButton']) {
      expect(rule(selector), selector).toMatch(/min-width:\s*0/);
    }
    expect(rule('.nameButton')).toMatch(/text-overflow:\s*ellipsis/);
  });

  it('scrolls code inside its own box and wraps long values', () => {
    expect(rule('.code')).toMatch(/overflow:\s*auto/);
    expect(rule('.code')).toMatch(/white-space:\s*pre/);
    expect(rule('.rowValue')).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule('.operationRoute')).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it('stacks the two-column cards under 860px', () => {
    expect(css).toMatch(/@media \(max-width: 860px\)\s*\{\s*\.twoCol\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });

  it('sets no fixed width wider than a phone', () => {
    const widths = [...css.matchAll(/(?<![-\w])width:\s*(\d+)px/g)].map((match) => Number(match[1]));
    expect(widths.filter((width) => width > 320)).toEqual([]);
  });
});
