import type { FileMarkdownStatus, IFileBucketRecord, IFileRecord } from '@/lib/database';
import type { ProviderCapabilityFlags } from '@/lib/providers';
import type { ProviderConfigView } from '@/lib/services/providers/providerService';

export interface FileProviderView extends ProviderConfigView {
  driverCapabilities?: ProviderCapabilityFlags;
}

export interface FileBucketView extends Omit<IFileBucketRecord, '_id'> {
  id: string;
  provider?: FileProviderView;
}

export interface FileRecordView extends Omit<IFileRecord, '_id'> {
  id: string;
}

export type FileRecordListItem = FileRecordView;

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
  /** The object's key inside the bucket; ending with `/` it names a folder and the file gets a generated name inside it. */
  keyHint?: string;
  /** Session-file tags written onto the record (`IFileRecord.purpose` and friends). */
  recordExtras?: Partial<Pick<IFileRecord, 'purpose' | 'conversationId' | 'agentKey' | 'expiresAt' | 'uploadedBy'>>;
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
