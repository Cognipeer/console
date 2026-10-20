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

/** What a caller may ask of one `downloadFile` call. */
export interface DownloadFileOptions {
  /**
   * The most bytes this call reads into memory. A larger object is refused with the driver's "too large" error
   * (`object_too_large`; Azure Blob Storage spells it `ObjectTooLarge`) before it is read to the end. Left out, the
   * server-wide ceiling applies (`maxStorageDownloadBytes`: twice the upload limit, at least 100 MiB), which suits
   * the objects the Files service wrote itself. A caller that reads objects the upload limit never applied to (the
   * files of a sandbox volume) states the bound it can hold. Only a positive number counts, and no bound goes
   * beyond what one Buffer can hold.
   */
  maxBytes?: number;
}

export interface ListFilesOptions {
  /**
   * Narrows the listing to the keys under this prefix. The drivers do NOT mean the same thing by it, so a caller that
   * needs the files of one folder lists with the folder's name and keeps the keys that start with `<folder>/` itself
   * (the import from storage does):
   *  - S3-compatible and MongoDB GridFS: the prefix is text, read as a key, so its trailing slash is dropped - `dir/`
   *    and `dir` both list `dir/a.txt`, and also `dir-other/b.txt` and `dirx.txt`;
   *  - Azure Blob Storage: the prefix is text and a trailing slash is kept - `dir/` lists the folder only, `dir` every
   *    key that starts with those letters;
   *  - local disk: the prefix names a folder - its files at any depth, and nothing for a name that is not a folder
   *    (`dirx.txt` is not in the listing of `dir`, and `di` lists nothing).
   * A blank prefix is the whole provider in every driver.
   */
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
  /**
   * The steps that ran, in order; a step after a failed one did not run and is left out. The exception is a
   * list that failed only because listing is not permitted (a container SAS without the list permission): write,
   * read and delete are still tried, so the result says which of them work.
   */
  steps?: Array<{ step: 'list' | 'write' | 'read' | 'delete'; ok: boolean; message?: string }>;
}

export interface FileProviderRuntime {
  uploadFile(input: UploadFileInput): Promise<UploadFileResult>;
  downloadFile(key: string, options?: DownloadFileOptions): Promise<FileDownloadResult>;
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
