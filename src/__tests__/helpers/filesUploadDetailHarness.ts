/**
 * Shared pieces of the upload screen and file drawer UI tests: a query client, records and buckets to show, the
 * wait helpers and a scripted `XMLHttpRequest` (the upload sends its body through one, to report progress).
 * jsdom only; import this from a test file that starts with `// @vitest-environment jsdom`.
 */

import { QueryClient } from '@tanstack/react-query';
import type { FileBucketView, FileRecordView } from '@/lib/services/files';
import type { FilesLimits } from '@/components/files/filesApi';
import { wait } from './iamCenterUi';

/** A query client that does not retry and answers an error at once. */
export function newQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0, gcTime: 0 } } });
}

/** Waits (really) until `check` holds. */
export async function until(check: () => boolean, label: string, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await wait(10);
  }
}

export function bucketView(over: Record<string, unknown> = {}): FileBucketView {
  return {
    id: 'bucket-1',
    tenantId: 't1',
    providerKey: 'minio',
    key: 'docs',
    name: 'Marketing assets',
    status: 'active',
    ...over,
  } as unknown as FileBucketView;
}

const HOUR = 3_600_000;

export function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

export function fileRecord(over: Record<string, unknown> = {}): FileRecordView {
  return {
    id: 'file-1',
    tenantId: 't1',
    providerKey: 'minio',
    bucketKey: 'docs',
    key: 'reports/2026/q3-report-1760000000000-a1b2c3d4.pdf',
    name: 'Q3 report.pdf',
    size: 4_812_345,
    contentType: 'application/pdf',
    checksum: '9f2c'.padEnd(60, '0') + 'e71a',
    markdownStatus: 'skipped',
    createdBy: 'user-1',
    createdByName: 'Ada Lovelace',
    createdAt: isoAgo(2 * HOUR),
    updatedAt: isoAgo(2 * HOUR),
    ...over,
  } as unknown as FileRecordView;
}

export function limitsPayload(over: Partial<FilesLimits> = {}): FilesLimits {
  return {
    maxFileBytes: 1_000_000,
    maxRequestBytes: 2_000_000,
    allowedMimeTypes: null,
    quota: { usedBytes: 0, limitBytes: null, filesUsed: 0, filesLimit: null },
    ...over,
  };
}

/** A browser `File` of the given size without allocating it. */
export function makeFile(name: string, options: { size?: number; type?: string; lastModified?: number } = {}): File {
  const file = new File(['x'], name, { type: options.type ?? 'text/plain', lastModified: options.lastModified ?? 1 });
  if (options.size !== undefined) Object.defineProperty(file, 'size', { value: options.size });
  return file;
}

/* ── A scripted XMLHttpRequest ──────────────────────────────────────────── */

/**
 * Stands in for `XMLHttpRequest` (`vi.stubGlobal('XMLHttpRequest', FakeXhr)`): records what was sent and lets a
 * test report progress and answer, or abort, each upload by hand.
 */
export class FakeXhr {
  static instances: FakeXhr[] = [];

  static reset(): void {
    FakeXhr.instances = [];
  }

  method = '';
  url = '';
  headers: Record<string, string> = {};
  responseType = '';
  /** The parsed JSON body that was sent. */
  body: Record<string, unknown> | undefined;
  status = 0;
  statusText = '';
  responseText = '';
  aborted = false;
  upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor() {
    FakeXhr.instances.push(this);
  }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  send(body: string): void {
    this.body = JSON.parse(body) as Record<string, unknown>;
  }

  abort(): void {
    this.aborted = true;
    this.onabort?.();
  }

  progress(loaded: number, total: number): void {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total });
  }

  respond(status: number, json: unknown): void {
    this.status = status;
    this.responseText = JSON.stringify(json);
    this.onload?.();
  }
}
