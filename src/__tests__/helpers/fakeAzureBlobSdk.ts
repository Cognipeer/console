/**
 * An in-memory stand-in for the parts of @azure/storage-blob the Azure file provider uses.
 *
 * It is as strict as the service about what it is sent (metadata names and values, blob name length), and it
 * throws the error shapes the real SDK throws, so a regression in the metadata codec or in the error mapping
 * fails here and not in a customer's account. It never opens a socket.
 */
import { Readable } from 'node:stream';

export interface FakeBlob {
  data: Buffer;
  contentType?: string;
  metadata: Record<string, string>;
  etag: string;
  lastModified: Date;
}

interface FakePipeline {
  factories: unknown[];
  credential: unknown;
  options: Record<string, unknown>;
}

export interface FakeState {
  /** Container URL (without query) to its blobs. */
  containers: Map<string, Map<string, FakeBlob>>;
  /** Every client constructed: its URL and the pipeline it was given, for assertions. */
  clients: Array<{ url: string; pipeline: FakePipeline }>;
  /** The kind of every SDK call, in order. */
  calls: string[];
  /** The abort signal each kind of call was last given. */
  signals: Map<string, AbortSignal | undefined>;
  /** The blob name of every upload, in order. */
  written: string[];
  /** The options of every listing page that was asked for. */
  lists: Array<{ prefix?: string; maxPageSize?: number; includeMetadata?: boolean }>;
  /** Makes the next call of that kind throw this. */
  failNext: Map<string, unknown>;
  /** Runs when a call of that kind starts (a test can abort a signal from here). */
  onCall: Map<string, () => void>;
  /** Milliseconds every call stalls (it still honours the abort signal). */
  delayMs: number;
  /** Pages returned empty (with a continuation token) before the real results. */
  emptyListPages: number;
  /** Makes downloads announce this Content-Length (`null` = none) and send these chunks instead of the blob. */
  download?: { contentLength?: number | null; chunks?: () => Iterable<Buffer> };
  /** Every download call: the range and the condition it asked for, and the SDK retry count it was given. */
  downloads: Array<{ offset: number; count?: number; ifMatch?: string; maxRetryRequests?: number }>;
  /**
   * Makes the next `times` downloads send only `afterBytes` bytes and then fail with `error` (an AbortError unless
   * given: that is what the real SDK's body stream ends with when the connection drops). `onCut` runs just before
   * the failure, for a test that changes the world at that moment (abort a signal, replace the blob).
   */
  cutDownload?: { afterBytes: number; times: number; error?: unknown; onCut?: () => void };
  etagSeq: number;
}

export const state: FakeState = {
  containers: new Map(),
  clients: [],
  calls: [],
  signals: new Map(),
  written: [],
  lists: [],
  failNext: new Map(),
  onCall: new Map(),
  delayMs: 0,
  emptyListPages: 0,
  downloads: [],
  etagSeq: 0,
};

export function resetFake(): void {
  state.containers.clear();
  state.clients.length = 0;
  state.calls.length = 0;
  state.signals.clear();
  state.written.length = 0;
  state.lists.length = 0;
  state.failNext.clear();
  state.onCall.clear();
  state.delayMs = 0;
  state.emptyListPages = 0;
  state.download = undefined;
  state.downloads.length = 0;
  state.cutDownload = undefined;
}

/** The error shape of a failed service call: `statusCode`, `details.errorCode`, and the body's message when there is one. */
export function restError(statusCode: number, errorCode: string, message = ''): Error {
  return Object.assign(new Error(message), { name: 'RestError', statusCode, code: message ? errorCode : undefined, details: { errorCode } });
}

const HEADER_TOKEN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_VALUE = /^[\x20-\x7e]*$/;

function assertServiceAcceptsMetadata(metadata: Record<string, string> | undefined): void {
  if (!metadata) return;
  const seen = new Set<string>();
  let total = 0;
  for (const [key, value] of Object.entries(metadata)) {
    if (!HEADER_TOKEN.test(key)) throw restError(400, 'InvalidMetadata', 'The metadata specified is invalid. It has characters that are not permitted.');
    if (!HEADER_VALUE.test(value)) throw new TypeError(`Invalid character in header content ["x-ms-meta-${key}"]`);
    if (seen.has(key.toLowerCase())) throw restError(400, 'Md5Mismatch', 'duplicate metadata name');
    seen.add(key.toLowerCase());
    total += key.length + value.length;
  }
  if (total > 8 * 1024) throw restError(400, 'MetadataTooLarge', 'The metadata specified is too large.');
}

function abortError(): Error {
  return Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
}

/** The first `afterBytes` of `data`, then the failure: a body that breaks off. */
async function* cutOff(data: Buffer, afterBytes: number, error: unknown, onCut?: () => void): AsyncGenerator<Buffer> {
  yield data.subarray(0, afterBytes);
  onCut?.();
  throw error;
}

async function gate(kind: string, abortSignal?: AbortSignal): Promise<void> {
  state.calls.push(kind);
  state.signals.set(kind, abortSignal);
  state.onCall.get(kind)?.();
  if (abortSignal?.aborted) throw abortError();
  const failure = state.failNext.get(kind);
  if (failure) {
    state.failNext.delete(kind);
    throw failure;
  }
  if (state.delayMs > 0) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, state.delayMs);
      abortSignal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(abortError());
      }, { once: true });
    });
  }
}

function containerKey(url: string): string {
  return url.split('?')[0];
}

class FakeContainerClient {
  readonly url: string;

  constructor(url: string, pipeline: FakePipeline) {
    this.url = url;
    state.clients.push({ url, pipeline });
  }

  private blobs(): Map<string, FakeBlob> {
    const found = state.containers.get(containerKey(this.url));
    if (!found) throw restError(404, 'ContainerNotFound', 'The specified container does not exist.');
    return found;
  }

  async createIfNotExists(options: { abortSignal?: AbortSignal } = {}): Promise<{ succeeded: boolean }> {
    await gate('createContainer', options.abortSignal);
    const key = containerKey(this.url);
    if (state.containers.has(key)) return { succeeded: false };
    state.containers.set(key, new Map());
    return { succeeded: true };
  }

  getBlockBlobClient(name: string) {
    const blobs = (): Map<string, FakeBlob> => this.blobs();
    return {
      async uploadData(data: Buffer, options: { metadata?: Record<string, string>; blobHTTPHeaders?: { blobContentType?: string }; abortSignal?: AbortSignal } = {}) {
        await gate('upload', options.abortSignal);
        if (name.length > 1024) throw restError(400, 'InvalidResourceName', 'The specified resource name length is not within the permissible limits.');
        assertServiceAcceptsMetadata(options.metadata);
        const contentType = options.blobHTTPHeaders?.blobContentType;
        if (contentType !== undefined && !HEADER_VALUE.test(contentType)) {
          throw new TypeError('Invalid character in header content ["x-ms-blob-content-type"]');
        }
        const store = blobs();
        state.etagSeq += 1;
        const blob: FakeBlob = {
          data: Buffer.from(data),
          contentType: contentType ?? 'application/octet-stream',
          metadata: { ...(options.metadata ?? {}) },
          etag: `"0x8D${String(state.etagSeq).padStart(10, '0')}"`,
          lastModified: new Date(),
        };
        store.set(name, blob);
        state.written.push(name);
        return { etag: blob.etag, lastModified: blob.lastModified };
      },
    };
  }

  getBlobClient(name: string) {
    const blobs = (): Map<string, FakeBlob> => this.blobs();
    return {
      async download(
        offset: number,
        count: number | undefined,
        options: { abortSignal?: AbortSignal; maxRetryRequests?: number; conditions?: { ifMatch?: string } } = {},
      ) {
        await gate('download', options.abortSignal);
        state.downloads.push({ offset, count, ifMatch: options.conditions?.ifMatch, maxRetryRequests: options.maxRetryRequests });
        const blob = blobs().get(name);
        if (!blob) throw restError(404, 'BlobNotFound', 'The specified blob does not exist.');
        if (options.conditions?.ifMatch && options.conditions.ifMatch !== blob.etag) {
          throw restError(412, 'ConditionNotMet', 'The condition specified using HTTP conditional header(s) is not met.');
        }
        const override = state.download;
        const data = blob.data.subarray(offset, count === undefined ? undefined : offset + count);
        const cut = state.cutDownload;
        let body: Iterable<Buffer> | AsyncIterable<Buffer> = override?.chunks ? override.chunks() : [data];
        if (cut && cut.times > 0) {
          cut.times -= 1;
          body = cutOff(data, cut.afterBytes, cut.error ?? abortError(), cut.onCut);
        }
        return {
          readableStreamBody: Readable.from(body),
          contentLength: override && 'contentLength' in override ? override.contentLength ?? undefined : data.length,
          contentType: blob.contentType,
          etag: blob.etag,
          metadata: { ...blob.metadata },
          lastModified: blob.lastModified,
        };
      },
      async getProperties(options: { abortSignal?: AbortSignal } = {}) {
        await gate('head', options.abortSignal);
        const blob = blobs().get(name);
        // HEAD answers carry no body: empty message, no `code`, only details.errorCode
        if (!blob) throw restError(404, 'BlobNotFound');
        return { contentLength: blob.data.length, contentType: blob.contentType, etag: blob.etag, lastModified: blob.lastModified, metadata: { ...blob.metadata } };
      },
      async deleteIfExists(options: { abortSignal?: AbortSignal; deleteSnapshots?: string } = {}) {
        await gate('delete', options.abortSignal);
        return { succeeded: blobs().delete(name) };
      },
    };
  }

  listBlobsFlat(options: { prefix?: string; includeMetadata?: boolean; abortSignal?: AbortSignal } = {}) {
    const blobs = (): Map<string, FakeBlob> => this.blobs();
    return {
      byPage(page: { continuationToken?: string; maxPageSize?: number } = {}) {
        return (async function* () {
          await gate('list', options.abortSignal);
          state.lists.push({ prefix: options.prefix, maxPageSize: page.maxPageSize, includeMetadata: options.includeMetadata });
          const names = [...blobs().keys()].filter((n) => n.startsWith(options.prefix ?? '')).sort();
          if (state.emptyListPages > 0 && !page.continuationToken?.startsWith('real:')) {
            state.emptyListPages -= 1;
            yield { continuationToken: `empty-${state.emptyListPages}`, segment: { blobItems: [] } };
            return;
          }
          const start = page.continuationToken?.startsWith('real:') ? names.indexOf(page.continuationToken.slice(5)) + 1 : 0;
          const slice = names.slice(start, start + (page.maxPageSize ?? 5000));
          const all = blobs();
          yield {
            continuationToken: start + slice.length < names.length ? `real:${slice[slice.length - 1]}` : '',
            segment: {
              blobItems: slice.map((name) => {
                const b = all.get(name)!;
                return {
                  name,
                  metadata: options.includeMetadata ? { ...b.metadata } : undefined,
                  // list responses carry an unquoted ETag
                  properties: { contentLength: b.data.length, contentType: b.contentType, etag: b.etag.replace(/"/g, ''), lastModified: b.lastModified },
                };
              }),
            },
          };
        })();
      },
    };
  }
}

class FakeStorageSharedKeyCredential {
  constructor(readonly accountName: string, readonly accountKey: string) {}
}

class FakeAnonymousCredential {}

export const fakeSdkModule = {
  ContainerClient: FakeContainerClient,
  StorageSharedKeyCredential: FakeStorageSharedKeyCredential,
  AnonymousCredential: FakeAnonymousCredential,
  newPipeline(credential: unknown, options: Record<string, unknown> = {}): FakePipeline {
    return { factories: [], credential, options };
  },
};
