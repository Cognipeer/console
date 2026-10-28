'use client';

/**
 * React Query hooks of the Document Store screens.
 *
 * - Every key starts `['files', <project>, ...]` (`filesKeys`). The browser cannot read the active project (its
 *   cookie is httpOnly), so `<project>` is a marker that changes whenever the app announces a project switch
 *   (`ACTIVE_PROJECT_CHANGED_EVENT`): queries of the project that was left are never shown for the new one.
 * - Mutations invalidate what they change: the bucket list (its stats), the bucket (its detail), its objects.
 * - A record converting to Markdown and a bucket being deleted are polled until they settle.
 *
 * The fetchers, types and routes are in `filesApi.ts`.
 */

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
  type QueryKey,
  type UseInfiniteQueryResult,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { ACTIVE_PROJECT_CHANGED_EVENT } from '@/components/layout/useEffectivePermissions';
import type { OcrSettings } from '@/lib/services/extraction/types';
import type { FileBucketView, FileRecordView } from '@/lib/services/files';
import {
  archiveFileName,
  archiveObjects,
  batchDeleteObjects,
  convertObject,
  createBucket,
  deleteBucket,
  deleteObject,
  downloadObject,
  fetchObjectText,
  getBucket,
  getFilesLimits,
  getObject,
  importFromStorage,
  isFilesApiError,
  listBuckets,
  listFileProviders,
  listObjects,
  testFileProvider,
  updateBucket,
  uploadObject,
  type BatchDeleteResult,
  type BucketDetail,
  type BucketListItem,
  type CreateBucketInput,
  type DeleteBucketOptions,
  type DeleteBucketResult,
  type FileProviderListItem,
  type ProviderTestResult,
  type FilesApiError,
  type FileLimits,
  type ImportInput,
  type ImportFromStorageResult,
  type ObjectsPage,
  type ObjectsQuery,
  type ObjectVariant,
  type UpdateBucketInput,
  type UploadObjectInput,
  type UploadObjectOptions,
  type UploadObjectResult,
} from './filesApi';
import { markdownFileName } from './shared/fileKind';
import { saveBlob } from './shared/saveBlob';

/* ── The active project ──────────────────────────────────────────────────── */

let projectGeneration = 0;
const projectListeners = new Set<() => void>();

function announceProjectChange(): void {
  projectGeneration += 1;
  projectListeners.forEach((listener) => listener());
}

// Registered when the module loads (browser only), so a switch made while no Files screen is mounted still
// retires what an earlier visit cached.
if (typeof window !== 'undefined') {
  window.addEventListener(ACTIVE_PROJECT_CHANGED_EVENT, announceProjectChange);
}

function subscribeToProject(listener: () => void): () => void {
  projectListeners.add(listener);
  return () => {
    projectListeners.delete(listener);
  };
}

/** The marker of the project the app is in right now (changes when the app announces a project switch). */
export function getFilesProjectScope(): string {
  return `project:${projectGeneration}`;
}

/**
 * The `<project>` part of every Files query key. Components use it through the hooks below; reach for it directly
 * only to build a key by hand. Queries of an earlier project that nothing observes any more are dropped.
 */
export function useFilesProject(): string {
  const queryClient = useQueryClient();
  const project = useSyncExternalStore(subscribeToProject, getFilesProjectScope, () => 'project:0');

  useEffect(() => {
    queryClient.removeQueries({
      queryKey: filesKeys.all,
      type: 'inactive',
      predicate: (query) => query.queryKey[1] !== project,
    });
  }, [project, queryClient]);

  return project;
}

/* ── Keys ────────────────────────────────────────────────────────────────── */

/** The parameters of an objects listing as they enter its key: `cursor` is the page param, not part of the key. */
export type ObjectsListQuery = Omit<ObjectsQuery, 'cursor'>;

/** Drops empty parameters so the same listing always has the same key. */
export function normalizeObjectsQuery(query: ObjectsQuery = {}): ObjectsListQuery {
  const out: ObjectsListQuery = {};
  if (query.prefix !== undefined) out.prefix = query.prefix;
  const search = query.search?.trim();
  if (search) out.search = search;
  if (query.type) out.type = query.type;
  if (query.purpose) out.purpose = query.purpose;
  if (query.limit !== undefined) out.limit = query.limit;
  return out;
}

/**
 * Query keys. `project` is the marker `useFilesProject()` returns. A key is a prefix of the keys below it, so
 * invalidating `objectsOf(project, bucket)` reaches every listing of that bucket.
 */
export const filesKeys = {
  all: ['files'] as const,
  project: (project: string) => ['files', project] as const,
  buckets: (project: string) => ['files', project, 'buckets'] as const,
  /** Every bucket detail of the project. */
  bucketDetails: (project: string) => ['files', project, 'bucket'] as const,
  bucket: (project: string, bucketKey: string) => ['files', project, 'bucket', bucketKey] as const,
  /** Every listing of a bucket (any folder, search, type). */
  objectsOf: (project: string, bucketKey: string) => ['files', project, 'objects', bucketKey] as const,
  objects: (project: string, bucketKey: string, query: ObjectsListQuery) =>
    ['files', project, 'objects', bucketKey, query] as const,
  object: (project: string, bucketKey: string, key: string) => ['files', project, 'object', bucketKey, key] as const,
  /** Every record and text of one bucket. */
  objectRecordsOf: (project: string, bucketKey: string) => ['files', project, 'object', bucketKey] as const,
  textsOf: (project: string, bucketKey: string) => ['files', project, 'text', bucketKey] as const,
  text: (project: string, bucketKey: string, key: string, variant: ObjectVariant) =>
    ['files', project, 'text', bucketKey, key, variant] as const,
  providers: (project: string) => ['files', project, 'providers'] as const,
  /** The limits of the project, or (with `bucketKey`) the ones that apply to uploads into that bucket. */
  limits: (project: string, bucketKey?: string): readonly ['files', string, 'limits'] | readonly ['files', string, 'limits', string] =>
    bucketKey ? ['files', project, 'limits', bucketKey] : ['files', project, 'limits'],
};

/* ── Polling ─────────────────────────────────────────────────────────────── */

/** Stop polling a conversion that is still pending after this long (the job is lost; a refresh is up to the person). */
export const MARKDOWN_POLL_MAX_MS = 5 * 60_000;
/** A delete-with-files job on a big bucket can take a while. */
export const DELETE_POLL_MAX_MS = 30 * 60_000;

/**
 * How long to wait before asking again, given how long it has been pending: quick at first, slower as it drags
 * on, `false` (stop) after `maxMs`.
 */
export function pollDelayMs(elapsedMs: number, maxMs: number): number | false {
  if (elapsedMs >= maxMs) return false;
  if (elapsedMs < 30_000) return 2_000;
  if (elapsedMs < 120_000) return 4_000;
  return 10_000;
}

/** A file whose Markdown conversion is queued or running. */
export function hasPendingMarkdown(records: ReadonlyArray<{ markdownStatus?: string | null }> | null | undefined): boolean {
  return Boolean(records?.some((record) => record.markdownStatus === 'pending'));
}

/** A bucket a delete-with-files job is removing. */
export function isBucketDeleting(bucket: { deleting?: boolean } | null | undefined): boolean {
  return bucket?.deleting === true;
}

/**
 * Names one run of a background job: the item, and (when the server says) when the run was last asked for, so asking
 * again ("Convert again", "Delete again") restarts the poll clock instead of finding it already out of time.
 */
function runName(item: { key: string; updatedAt?: unknown }): string {
  return item.updatedAt ? `${item.key}@${String(item.updatedAt)}` : item.key;
}

/** Names the files that are converting (`null` = none): the poll clock restarts when this changes. */
export function pendingMarkdownSignature(
  records: ReadonlyArray<{ key: string; markdownStatus?: string | null; updatedAt?: unknown }> | null | undefined,
): string | null {
  const runs = (records ?? []).filter((record) => record.markdownStatus === 'pending').map(runName);
  return runs.length > 0 ? runs.sort().join('\n') : null;
}

/** Names the buckets that are being deleted (`null` = none). */
export function deletingBucketsSignature(
  buckets: ReadonlyArray<{ key: string; deleting?: boolean; updatedAt?: unknown }> | null | undefined,
): string | null {
  const runs = (buckets ?? []).filter(isBucketDeleting).map(runName);
  return runs.length > 0 ? runs.sort().join('\n') : null;
}

/** A refusal (403, 404, 409...) will not change by asking again. */
function isClientError(error: unknown): boolean {
  return isFilesApiError(error) && error.status >= 400 && error.status < 500;
}

/**
 * `refetchInterval` helper. `poll(query.state, unsettledOf)` returns the delay before the next poll, or `false`
 * when there is nothing to wait for: `unsettledOf(data)` names what is still unsettled (`null` when nothing is).
 * The clock starts when something becomes unsettled, restarts when the set that is unsettled changes (a second
 * conversion started), and ends at `maxMs`, so a job that was lost does not keep the page polling forever. A
 * refusal ends it at once: the file or the bucket is gone, or no longer visible.
 */
function usePollWhile(maxMs: number) {
  const clock = useRef<{ signature: string; startedAt: number } | null>(null);
  return useCallback(
    <T>(state: { data: T | undefined; error: unknown }, unsettledOf: (data: T | undefined) => string | null): number | false => {
      const unsettled = isClientError(state.error) ? null : unsettledOf(state.data);
      if (unsettled === null) {
        clock.current = null;
        return false;
      }
      if (clock.current?.signature !== unsettled) clock.current = { signature: unsettled, startedAt: Date.now() };
      return pollDelayMs(Date.now() - clock.current.startedAt, maxMs);
    },
    [maxMs],
  );
}

/** Client errors (403, 404, 409...) will not change on a retry; a lost connection or a 5xx gets one more try. */
export function retryUnlessClientError(failureCount: number, error: unknown): boolean {
  if (isClientError(error)) return false;
  return failureCount < 1;
}

/* ── Invalidation ────────────────────────────────────────────────────────── */

/** Where the file's key sits in the keys of `filesKeys.object` and `filesKeys.text`: `['files', project, kind, bucket, key, ...]`. */
const FILE_KEY_INDEX = 4;

/** After the bucket list changed (a bucket was created, deleted, renamed...). */
export function invalidateBuckets(queryClient: QueryClient, project: string): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: filesKeys.buckets(project) });
}

/** After the bucket itself changed (name, description, status, a delete started): its detail and the list. */
export async function invalidateBucketMeta(queryClient: QueryClient, project: string, bucketKey: string): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: filesKeys.bucket(project, bucketKey) }),
    invalidateBuckets(queryClient, project),
  ]);
}

/**
 * After files were added, removed, imported or converted: the bucket's listings, records and texts, its detail
 * and the bucket list (both carry the stats), and the limits (the quota in use). `removedKeys` are files that were
 * just deleted: their own records and texts are not asked for again (see `forgetObjects`).
 */
export async function invalidateBucketContent(
  queryClient: QueryClient,
  project: string,
  bucketKey: string,
  options: { removedKeys?: readonly string[] } = {},
): Promise<void> {
  const removed = new Set(options.removedKeys ?? []);
  const keepsFile = (query: { queryKey: QueryKey }) => !removed.has(String(query.queryKey[FILE_KEY_INDEX]));
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: filesKeys.objectsOf(project, bucketKey) }),
    queryClient.invalidateQueries({ queryKey: filesKeys.objectRecordsOf(project, bucketKey), predicate: keepsFile }),
    queryClient.invalidateQueries({ queryKey: filesKeys.textsOf(project, bucketKey), predicate: keepsFile }),
    queryClient.invalidateQueries({ queryKey: filesKeys.limits(project) }),
    invalidateBucketMeta(queryClient, project, bucketKey),
  ]);
}

/** After one file's record changed (its conversion restarted): the record, its texts and the listings that show it. */
export async function invalidateObject(queryClient: QueryClient, project: string, bucketKey: string, key: string): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: filesKeys.object(project, bucketKey, key) }),
    queryClient.invalidateQueries({ queryKey: [...filesKeys.textsOf(project, bucketKey), key] }),
    queryClient.invalidateQueries({ queryKey: filesKeys.objectsOf(project, bucketKey) }),
  ]);
}

/** After a provider was tested (the outcome is kept on its record): everything that shows a provider's health. */
export async function invalidateProviderHealth(queryClient: QueryClient, project: string): Promise<void> {
  await Promise.all([
    invalidateBuckets(queryClient, project),
    queryClient.invalidateQueries({ queryKey: filesKeys.bucketDetails(project) }),
    queryClient.invalidateQueries({ queryKey: filesKeys.providers(project) }),
  ]);
}

/**
 * Drops a query nobody is looking at, and settles one that is still on screen (a page or a drawer that has not
 * closed yet): its request is cancelled and it is marked stale WITHOUT a refetch, so it does not ask the server for
 * something that is gone.
 */
function retireQueries(queryClient: QueryClient, queryKey: QueryKey): void {
  void queryClient.cancelQueries({ queryKey });
  queryClient.removeQueries({ queryKey, type: 'inactive' });
  void queryClient.invalidateQueries({ queryKey, refetchType: 'none' });
}

/** After a bucket is gone: forget everything cached about it. */
export function forgetBucket(queryClient: QueryClient, project: string, bucketKey: string): void {
  retireQueries(queryClient, filesKeys.bucket(project, bucketKey));
  retireQueries(queryClient, filesKeys.objectsOf(project, bucketKey));
  retireQueries(queryClient, filesKeys.objectRecordsOf(project, bucketKey));
  retireQueries(queryClient, filesKeys.textsOf(project, bucketKey));
}

/** After files were deleted: forget their records and texts. */
export function forgetObjects(queryClient: QueryClient, project: string, bucketKey: string, keys: readonly string[]): void {
  for (const key of keys) {
    retireQueries(queryClient, filesKeys.object(project, bucketKey, key));
    retireQueries(queryClient, [...filesKeys.textsOf(project, bucketKey), key]);
  }
}

/**
 * The invalidations above bound to the active project, for code that changes data without one of the mutation hooks
 * (the upload screen sends files one by one and invalidates once at the end).
 */
export function useFilesInvalidation() {
  const queryClient = useQueryClient();
  const project = useFilesProject();
  return useMemo(
    () => ({
      buckets: () => invalidateBuckets(queryClient, project),
      bucketMeta: (bucketKey: string) => invalidateBucketMeta(queryClient, project, bucketKey),
      bucketContent: (bucketKey: string, options?: { removedKeys?: readonly string[] }) =>
        invalidateBucketContent(queryClient, project, bucketKey, options),
      object: (bucketKey: string, key: string) => invalidateObject(queryClient, project, bucketKey, key),
      providerHealth: () => invalidateProviderHealth(queryClient, project),
      forgetBucket: (bucketKey: string) => forgetBucket(queryClient, project, bucketKey),
      forgetObjects: (bucketKey: string, keys: readonly string[]) => forgetObjects(queryClient, project, bucketKey, keys),
    }),
    [queryClient, project],
  );
}

/* ── Reads ───────────────────────────────────────────────────────────────── */

/** The buckets of the active project with their stats and provider health. Polled while a bucket is being deleted. */
export function useBuckets(): UseQueryResult<BucketListItem[], FilesApiError> {
  const project = useFilesProject();
  const poll = usePollWhile(DELETE_POLL_MAX_MS);
  return useQuery<BucketListItem[], FilesApiError>({
    queryKey: filesKeys.buckets(project),
    queryFn: ({ signal }) => listBuckets({ signal }),
    refetchOnMount: 'always',
    retry: retryUnlessClientError,
    refetchInterval: (query) => poll(query.state, deletingBucketsSignature),
  });
}

/** One bucket with who uses it and where it stores. 404 when it does not exist. Polled while it is being deleted. */
export function useBucket(bucketKey: string | null | undefined): UseQueryResult<BucketDetail, FilesApiError> {
  const project = useFilesProject();
  const poll = usePollWhile(DELETE_POLL_MAX_MS);
  return useQuery<BucketDetail, FilesApiError>({
    queryKey: filesKeys.bucket(project, bucketKey ?? ''),
    enabled: Boolean(bucketKey),
    queryFn: ({ signal }) => getBucket(bucketKey as string, { signal }),
    refetchOnMount: 'always',
    retry: retryUnlessClientError,
    refetchInterval: (query) => poll(query.state, (bucket) => deletingBucketsSignature(bucket ? [bucket] : [])),
  });
}

export type ObjectsInfiniteResult = UseInfiniteQueryResult<InfiniteData<ObjectsPage, string | undefined>, FilesApiError>;

/**
 * The files of a bucket, a page at a time (`fetchNextPage` is "Load more"). `query` picks the folder, search, type
 * and purpose; a change of any of them is another listing with its own cache entry. Polled while a visible file
 * is converting to Markdown (a poll, like a refresh, re-reads every page loaded so far).
 */
export function useObjects(
  bucketKey: string | null | undefined,
  query: ObjectsQuery = {},
  options: { enabled?: boolean } = {},
): ObjectsInfiniteResult {
  const project = useFilesProject();
  const poll = usePollWhile(MARKDOWN_POLL_MAX_MS);
  const params = normalizeObjectsQuery(query);
  return useInfiniteQuery<
    ObjectsPage,
    FilesApiError,
    InfiniteData<ObjectsPage, string | undefined>,
    ReturnType<typeof filesKeys.objects>,
    string | undefined
  >({
    queryKey: filesKeys.objects(project, bucketKey ?? '', params),
    enabled: Boolean(bucketKey) && options.enabled !== false,
    initialPageParam: undefined,
    queryFn: ({ pageParam, signal }) => listObjects(bucketKey as string, { ...params, cursor: pageParam }, { signal }),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    refetchOnMount: 'always',
    retry: retryUnlessClientError,
    refetchInterval: (infinite) => poll(infinite.state, (data) => pendingMarkdownSignature(data?.pages.flatMap((page) => page.items))),
  });
}

/** The loaded pages as one list of files (each key once) and one list of folders (in the order they were named). */
export function flattenObjectPages(pages: ReadonlyArray<ObjectsPage> | null | undefined): {
  items: FileRecordView[];
  folders: string[];
} {
  const items: FileRecordView[] = [];
  const seenKeys = new Set<string>();
  const folders = new Set<string>();
  for (const page of pages ?? []) {
    for (const item of page.items) {
      if (seenKeys.has(item.key)) continue;
      seenKeys.add(item.key);
      items.push(item);
    }
    for (const folder of page.folders) folders.add(folder);
  }
  return { items, folders: [...folders] };
}

/**
 * One file's record, for the file drawer. `placeholder` (the row the drawer was opened from) is shown while the
 * fresh record loads. Polled while the record's Markdown conversion is pending.
 */
export function useObject(
  bucketKey: string | null | undefined,
  key: string | null | undefined,
  options: { placeholder?: FileRecordView } = {},
): UseQueryResult<FileRecordView, FilesApiError> {
  const project = useFilesProject();
  const poll = usePollWhile(MARKDOWN_POLL_MAX_MS);
  return useQuery<FileRecordView, FilesApiError>({
    queryKey: filesKeys.object(project, bucketKey ?? '', key ?? ''),
    enabled: Boolean(bucketKey && key),
    queryFn: ({ signal }) => getObject(bucketKey as string, key as string, { signal }),
    placeholderData: options.placeholder,
    refetchOnMount: 'always',
    retry: retryUnlessClientError,
    refetchInterval: (query) => poll(query.state, (record) => pendingMarkdownSignature(record ? [record] : [])),
  });
}

/**
 * The text of a file or of its Markdown copy (text types only; 415 `preview_unsupported` otherwise). Pass
 * `enabled: false` until there is something to read (a conversion that has not succeeded yet has no copy).
 */
export function useObjectText(
  bucketKey: string | null | undefined,
  key: string | null | undefined,
  variant: ObjectVariant,
  options: { enabled?: boolean } = {},
): UseQueryResult<string, FilesApiError> {
  const project = useFilesProject();
  return useQuery<string, FilesApiError>({
    queryKey: filesKeys.text(project, bucketKey ?? '', key ?? '', variant),
    enabled: Boolean(bucketKey && key) && options.enabled !== false,
    queryFn: ({ signal }) => fetchObjectText(bucketKey as string, key as string, { variant, signal }),
    retry: retryUnlessClientError,
  });
}

/** The file providers of the active project with their health and where they keep files. */
export function useFileProviders(options: { enabled?: boolean } = {}): UseQueryResult<FileProviderListItem[], FilesApiError> {
  const project = useFilesProject();
  return useQuery<FileProviderListItem[], FilesApiError>({
    queryKey: filesKeys.providers(project),
    enabled: options.enabled !== false,
    queryFn: ({ signal }) => listFileProviders({ signal }),
    refetchOnMount: 'always',
    retry: retryUnlessClientError,
  });
}

/** What one upload may weigh and be, and the project's storage quota. Pass `bucketKey` for an upload into that bucket. */
export function useFilesLimits(options: { bucketKey?: string; enabled?: boolean } = {}): UseQueryResult<FileLimits, FilesApiError> {
  const project = useFilesProject();
  return useQuery<FileLimits, FilesApiError>({
    queryKey: filesKeys.limits(project, options.bucketKey),
    enabled: options.enabled !== false,
    queryFn: ({ signal }) => getFilesLimits({ signal, bucketKey: options.bucketKey }),
    refetchOnMount: 'always',
    retry: retryUnlessClientError,
  });
}

/* ── Writes ──────────────────────────────────────────────────────────────── */

export function useCreateBucket(): UseMutationResult<FileBucketView, FilesApiError, CreateBucketInput> {
  const queryClient = useQueryClient();
  const project = useFilesProject();
  return useMutation<FileBucketView, FilesApiError, CreateBucketInput>({
    mutationFn: (input) => createBucket(input),
    onSuccess: () => invalidateBuckets(queryClient, project),
  });
}

export function useUpdateBucket(): UseMutationResult<
  FileBucketView,
  FilesApiError,
  { bucketKey: string; patch: UpdateBucketInput }
> {
  const queryClient = useQueryClient();
  const project = useFilesProject();
  return useMutation<FileBucketView, FilesApiError, { bucketKey: string; patch: UpdateBucketInput }>({
    mutationFn: ({ bucketKey, patch }) => updateBucket(bucketKey, patch),
    onSuccess: (_bucket, { bucketKey }) => invalidateBucketMeta(queryClient, project, bucketKey),
  });
}

/**
 * `deleted`: the bucket is gone (its cache is forgotten). `deleting`: a job is removing the files first; the list
 * and the bucket report it and are polled until it is gone. `force` deletes only the bucket, leaving its files in the
 * storage provider - also when the bucket is `deleting`, the way out of a run that was lost and cannot be asked for
 * again; `deleteFiles` asked for a bucket that is already `deleting` queues the job anew.
 */
export function useDeleteBucket(): UseMutationResult<
  DeleteBucketResult,
  FilesApiError,
  { bucketKey: string } & DeleteBucketOptions
> {
  const queryClient = useQueryClient();
  const project = useFilesProject();
  return useMutation<DeleteBucketResult, FilesApiError, { bucketKey: string } & DeleteBucketOptions>({
    mutationFn: ({ bucketKey, deleteFiles, force }) => deleteBucket(bucketKey, { deleteFiles, force }),
    onSuccess: async (result, { bucketKey }) => {
      if (result.status === 'deleted') {
        forgetBucket(queryClient, project, bucketKey);
        await invalidateBuckets(queryClient, project);
        return;
      }
      await invalidateBucketMeta(queryClient, project, bucketKey);
    },
    // A refusal can leave the bucket changed: a queue that was not there leaves a note on it (`deleteError`), a run
    // that began meanwhile marks it deleting, an agent that chose it since blocks the delete. Read it again.
    onError: (_error, { bucketKey }) => invalidateBucketMeta(queryClient, project, bucketKey),
  });
}

/** One upload. To send several files, call `uploadFile` yourself and `useFilesInvalidation().bucketContent` once at the end. */
export function useUploadObject(): UseMutationResult<
  UploadObjectResult,
  FilesApiError,
  { bucketKey: string; input: UploadObjectInput; options?: UploadObjectOptions }
> {
  const queryClient = useQueryClient();
  const project = useFilesProject();
  return useMutation<UploadObjectResult, FilesApiError, { bucketKey: string; input: UploadObjectInput; options?: UploadObjectOptions }>({
    mutationFn: ({ bucketKey, input, options }) => uploadObject(bucketKey, input, options),
    onSuccess: (_result, { bucketKey }) => invalidateBucketContent(queryClient, project, bucketKey),
  });
}

export function useDeleteObject(): UseMutationResult<void, FilesApiError, { bucketKey: string; key: string }> {
  const queryClient = useQueryClient();
  const project = useFilesProject();
  return useMutation<void, FilesApiError, { bucketKey: string; key: string }>({
    mutationFn: ({ bucketKey, key }) => deleteObject(bucketKey, key),
    onSuccess: (_result, { bucketKey, key }) => {
      forgetObjects(queryClient, project, bucketKey, [key]);
      return invalidateBucketContent(queryClient, project, bucketKey, { removedKeys: [key] });
    },
  });
}

/** Deletes up to 100 files; the ones that were refused are in `failed`. */
export function useBatchDeleteObjects(): UseMutationResult<
  BatchDeleteResult,
  FilesApiError,
  { bucketKey: string; keys: string[] }
> {
  const queryClient = useQueryClient();
  const project = useFilesProject();
  return useMutation<BatchDeleteResult, FilesApiError, { bucketKey: string; keys: string[] }>({
    mutationFn: ({ bucketKey, keys }) => batchDeleteObjects(bucketKey, keys),
    onSuccess: (result, { bucketKey }) => {
      forgetObjects(queryClient, project, bucketKey, result.deleted);
      return invalidateBucketContent(queryClient, project, bucketKey, { removedKeys: result.deleted });
    },
  });
}

/** `ocr` replaces the file's own OCR settings for this run (null = the plain conversion); left out, the file keeps its own. */
export interface ConvertObjectVariables {
  bucketKey: string;
  key: string;
  ocr?: OcrSettings | null;
}

/** (Re)starts a Markdown conversion; the record comes back `pending` and the screens poll it from there. */
export function useConvertObject(): UseMutationResult<FileRecordView, FilesApiError, ConvertObjectVariables> {
  const queryClient = useQueryClient();
  const project = useFilesProject();
  return useMutation<FileRecordView, FilesApiError, ConvertObjectVariables>({
    mutationFn: ({ bucketKey, key, ocr }) => convertObject(bucketKey, key, ocr !== undefined ? { ocr } : {}),
    onSuccess: (record, { bucketKey, key }) => {
      queryClient.setQueryData(filesKeys.object(project, bucketKey, key), record);
      return invalidateObject(queryClient, project, bucketKey, key);
    },
  });
}

/** "Import from storage": one scan step; call again with `nextCursor` until it is absent. */
export function useImportFromStorage(): UseMutationResult<
  ImportFromStorageResult,
  FilesApiError,
  { bucketKey: string; input?: ImportInput }
> {
  const queryClient = useQueryClient();
  const project = useFilesProject();
  return useMutation<ImportFromStorageResult, FilesApiError, { bucketKey: string; input?: ImportInput }>({
    mutationFn: ({ bucketKey, input }) => importFromStorage(bucketKey, input),
    onSuccess: (result, { bucketKey }) => (result.imported > 0 ? invalidateBucketContent(queryClient, project, bucketKey) : undefined),
  });
}

/** Saves a file, or its Markdown copy, to disk. */
export function useDownloadObject(): UseMutationResult<
  void,
  FilesApiError,
  { bucketKey: string; key: string; fileName: string; variant?: ObjectVariant }
> {
  return useMutation<void, FilesApiError, { bucketKey: string; key: string; fileName: string; variant?: ObjectVariant }>({
    mutationFn: async ({ bucketKey, key, fileName, variant }) => {
      const downloaded = await downloadObject(bucketKey, key, { variant });
      saveBlob(downloaded.blob, downloaded.fileName ?? (variant === 'markdown' ? markdownFileName(fileName) : fileName));
    },
  });
}

/** Saves up to 50 files as one zip. 413 `archive_too_large` over 200 MB. */
export function useArchiveObjects(): UseMutationResult<void, FilesApiError, { bucketKey: string; keys: string[] }> {
  return useMutation<void, FilesApiError, { bucketKey: string; keys: string[] }>({
    mutationFn: async ({ bucketKey, keys }) => {
      saveBlob(await archiveObjects(bucketKey, keys), archiveFileName(bucketKey));
    },
  });
}

/**
 * Tests a saved provider by its RECORD id (`provider._id`) and refreshes everything that shows its health.
 * A caller without provider access gets a 403 (`filesErrorMessage(error, t, 'providerTest')` words it).
 */
export function useTestFileProvider(): UseMutationResult<ProviderTestResult, FilesApiError, string> {
  const queryClient = useQueryClient();
  const project = useFilesProject();
  return useMutation<ProviderTestResult, FilesApiError, string>({
    mutationFn: (providerRecordId) => testFileProvider(providerRecordId),
    onSuccess: () => invalidateProviderHealth(queryClient, project),
  });
}
