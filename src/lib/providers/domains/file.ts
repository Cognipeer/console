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

/** What a file provider's "Test connection" learned, step by step. */
export interface FileConnectionCheck {
  ok: boolean;
  message: string;
  /** The steps that ran, in order; a step after a failed one did not run and is left out. */
  steps?: Array<{ step: 'list' | 'write' | 'read' | 'delete'; ok: boolean; message?: string }>;
}

export interface FileProviderRuntime {
  uploadFile(input: UploadFileInput): Promise<UploadFileResult>;
  downloadFile(key: string): Promise<FileDownloadResult>;
  deleteFile(key: string): Promise<void>;
  listFiles(options?: ListFilesOptions): Promise<ListFilesResult>;
  getFileMetadata(key: string): Promise<FileObjectHandle | null>;
  /**
   * The driver's own end-to-end check, used by "Test connection" in place of a bare `listFiles`: list, and, when
   * `write` is true (the default), write, read back and delete a small object under a reserved prefix. It must stop
   * when `signal` aborts (the test's time limit), and it creates the bucket or container only through the normal
   * upload path of a provider that is set to create a missing one. A driver without one is tested with
   * `listFiles({ limit: 1 })`.
   */
  checkConnection?(options?: { signal?: AbortSignal; write?: boolean }): Promise<FileConnectionCheck>;
  /**
   * Release any connections this runtime owns (a keep-alive client or agent). Called by "Test connection" once its
   * probe is done and by the runtime pool when an evicted runtime's grace period has elapsed. Stateless drivers can
   * leave it out.
   */
  close?(): Promise<void> | void;
}
