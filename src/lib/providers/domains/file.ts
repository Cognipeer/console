export type FileUploadData = Buffer;

export interface FileObjectHandle {
  key: string;
  name: string;
  size: number;
  contentType?: string;
  checksum?: string;
  etag?: string;
  lastModified?: Date;
  metadata?: Record<string, unknown>;
  markdownKey?: string;
  markdownAvailable?: boolean;
  markdownSize?: number;
  markdownContentType?: string;
}

export interface UploadFileInput {
  key?: string;
  name: string;
  contentType?: string;
  data: FileUploadData;
  metadata?: Record<string, unknown>;
}

export interface UploadFileResult {
  handle: FileObjectHandle;
}

export interface FileDownloadResult {
  data: Buffer;
  contentType?: string;
  size?: number;
  metadata?: Record<string, unknown>;
  etag?: string;
}

export interface ListFilesOptions {
  prefix?: string;
  cursor?: string;
  limit?: number;
}

export interface ListFilesResult {
  items: FileObjectHandle[];
  nextCursor?: string;
}

export interface FileProviderRuntime {
  uploadFile(input: UploadFileInput): Promise<UploadFileResult>;
  downloadFile(key: string): Promise<FileDownloadResult>;
  deleteFile(key: string): Promise<void>;
  listFiles(options?: ListFilesOptions): Promise<ListFilesResult>;
  getFileMetadata(key: string): Promise<FileObjectHandle | null>;
}
