import type { FileMarkdownStatus, FileTypeFilter, IFileBucketRecord, IFileRecord } from '@/lib/database';
import type { ProviderCapabilityFlags } from '@/lib/providers';
import type { ProviderConfigView } from '@/lib/services/providers/providerService';

/**
 * How a bucket's storage provider is doing, from what is already known (no call is made to it):
 * `ok` / `failed` after the last "Test connection", `untested` before any, `builtin` for storage that needs no
 * test (the server's own disk), `inactive` when the provider is switched off, in error, or not usable by this project.
 */
export type ProviderHealthState = 'ok' | 'failed' | 'untested' | 'builtin' | 'inactive';

export interface ProviderHealth {
  state: ProviderHealthState;
  /** When the last test ran (ISO 8601); absent when none did. */
  testedAt?: string;
  /** What the last test said, or why the provider is `inactive`. */
  message?: string;
}

export interface FileProviderView extends ProviderConfigView {
  driverCapabilities?: ProviderCapabilityFlags;
  /** Set by the Document Store's provider listing (`GET /files/providers`). */
  providerHealth?: ProviderHealth;
  /**
   * Where this provider keeps files, up to and including `<providerKey>/`, so a form can preview
   * `${storageLocationBase}${bucketPrefix}/`. `null` when the location is not shown (the server's own disk).
   * Set by the Document Store's provider listing.
   */
  storageLocationBase?: string | null;
}

export interface FileBucketView extends Omit<IFileBucketRecord, '_id'> {
  id: string;
  provider?: FileProviderView;
}

export interface FileRecordView extends Omit<IFileRecord, '_id'> {
  id: string;
  /**
   * A session file (`purpose: 'conversation'`): the `_id` of the agent that owns
   * the session, for the Session link — `agentKey` alone cannot build the page's
   * URL. Set by the Document Store routes when they list or read a record; absent
   * when the agent no longer exists.
   */
  agentId?: string;
  /**
   * The uploader as a person's name (`uploadedBy` is a user id). Set by the Document Store
   * routes when they list or read a record; absent for a system actor or a removed account.
   */
  uploadedByName?: string;
  /** `createdBy` as a person's name, set the same way; absent for a system actor or a removed account. */
  createdByName?: string;
}

export type FileRecordListItem = FileRecordView;

/** A bucket's files added up (every record of the bucket, session files included). */
export interface BucketStats {
  fileCount: number;
  /** Σ(size + markdownSize): the original and its Markdown copy. */
  totalBytes: number;
}

/** One row of `GET /files/buckets`. */
export interface BucketListItem extends FileBucketView {
  stats: BucketStats;
  providerHealth: ProviderHealth;
  /** Present (true) while a "delete the bucket with its files" job is running. */
  deleting?: boolean;
  /** Why the last "delete the bucket with its files" run stopped before the bucket was gone; the delete can be tried again. */
  deleteError?: string;
}

/** An agent that keeps its session files in a bucket (its draft or its published version names it). */
export interface BucketUser {
  agentId: string;
  agentKey: string;
  name: string;
}

/** `GET /files/buckets/:bucketKey`. */
export interface BucketDetail extends BucketListItem {
  usedBy: BucketUser[];
  /** Where the bucket's files are, in words (no credentials, no server paths); `null` for the server's own disk. */
  storageLocation: string | null;
}

/** `GET /files/limits`. */
export interface FileLimits {
  /** The largest file one upload may carry: the smallest of the configured limit, the per-request quota and what fits the request body. */
  maxFileBytes: number;
  /** The largest upload request body the server reads. */
  maxRequestBytes: number;
  /** The content types an upload is limited to; `null` = any. */
  allowedMimeTypes: string[] | null;
  quota: {
    usedBytes: number;
    /** `null` = unlimited. */
    limitBytes: number | null;
    filesUsed: number;
    /** `null` = unlimited. */
    filesLimit: number | null;
  };
}

export interface ListFilesRequest {
  providerKey?: string;
  bucketKey: string;
  search?: string;
  /**
   * A folder path inside the bucket (`''` = its root). Without `search` the
   * listing is that folder only: its files and its sub-folders (`folders`), found
   * from the keys. With `search`, every match under the prefix, however deep.
   * Absent = the flat listing of the whole bucket.
   */
  prefix?: string;
  /** Only session files (`conversation`) or only the others (`other`). */
  purpose?: 'conversation' | 'other';
  /** Only files of this kind. A filter lists like a search: every match under `prefix`, however deep, no folders. */
  type?: FileTypeFilter;
  limit?: number;
  cursor?: string;
}

export interface ListFilesResponse {
  items: FileRecordListItem[];
  /** Sub-folders of `prefix` (full paths ending in `/`); only in the folder listing. */
  folders?: string[];
  /** The folder listed, normalised; only in the folder listing. */
  prefix?: string;
  nextCursor?: string;
}

export interface UploadFileRequest {
  providerKey?: string;
  bucketKey: string;
  fileName: string;
  contentType?: string;
  data: Buffer | string;
  metadata?: Record<string, unknown>;
  createdBy: string;
  convertToMarkdown?: boolean;
  /**
   * When the Markdown copy is made. `sync` (the default) converts before the call returns, so the copy can be read
   * right after. `queued` stores the file with `markdownStatus: 'pending'` and hands the conversion to a background
   * job; only the formats the job can read are converted, any other file is stored as `skipped`.
   */
  markdown?: 'sync' | 'queued';
  /** The object's key inside the bucket; ending with `/` it names a folder and the file gets a generated name inside it. */
  keyHint?: string;
  /** Session-file tags written onto the record (`IFileRecord.purpose` and friends). */
  recordExtras?: Partial<Pick<IFileRecord, 'purpose' | 'conversationId' | 'agentKey' | 'expiresAt' | 'uploadedBy' | 'origin'>>;
}

export interface UploadFileResponse {
  record: FileRecordView;
}

export interface DownloadFileOptions {
  variant?: 'original' | 'markdown';
}

export interface DownloadFileResult {
  fileName: string;
  contentType?: string;
  data: Buffer;
  size?: number;
  etag?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateFileConversionPayload {
  markdownStatus: FileMarkdownStatus;
  markdownKey?: string;
  markdownSize?: number;
  markdownContentType?: string;
  markdownError?: string;
  updatedBy?: string;
}

/** `POST /files/buckets/:bucketKey/objects/batch-delete`: what was deleted, and what could not be and why. */
export interface BatchDeleteResult {
  deleted: string[];
  failed: Array<{ key: string; error: string }>;
}

/** `POST /files/buckets/:bucketKey/import`: one page of the objects found under the bucket's folder. */
export interface ImportFromStorageResult {
  /** Objects looked at on this page. */
  scanned: number;
  /** Records created for them. */
  imported: number;
  /** Objects left alone: already a file of the bucket, a Markdown copy, a driver's own file, or not under the bucket's folder. */
  skipped: number;
  /** Continue from here for the next page; absent on the last one. */
  nextCursor?: string;
}
