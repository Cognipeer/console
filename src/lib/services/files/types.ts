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
  limit?: number;
  cursor?: string;
}

export interface ListFilesResponse {
  items: FileRecordListItem[];
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
  keyHint?: string;
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
