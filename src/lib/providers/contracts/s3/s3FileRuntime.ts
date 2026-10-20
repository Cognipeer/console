import { createHash, randomUUID } from 'node:crypto';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type ListObjectsV2CommandOutput,
  type _Object,
} from '@aws-sdk/client-s3';
import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';
import { ProviderSettingsError } from '@/lib/providers/errors';
import {
  assertPublicUrl,
  OutboundDnsError,
  type OutboundGuardOptions,
} from '@/lib/security/outboundFetch';
import { createStorageAgents, type StorageAgents } from '@/lib/security/storageTransport';
import { endpointGuardOptions, toProviderEndpointError } from '@/lib/services/providers/providerEndpointGuard';
import type { ProviderContext } from '../../types';
import type {
  FileConnectionCheck,
  FileDownloadResult,
  FileObjectHandle,
  FileProviderRuntime,
  ListFilesOptions,
  UploadFileInput,
  UploadFileResult,
} from '../../domains/file';
import { maxStorageDownloadBytes } from '../storageLimits';
import {
  buildS3Metadata,
  decodeS3Metadata,
  generateKey,
  normalizeS3Endpoint,
  resolveS3Bucket,
  resolveS3Region,
  S3_CONNECTION_TEST_PREFIX,
  s3BasePrefix,
  sanitizeKey,
  settingText,
  type S3CompatibleSettings,
  type S3Credentials,
} from './s3Helpers';
import { describeS3Error, isS3OperationError, S3OperationError, type S3ErrorContext, type S3Operation } from './s3Errors';

/**
 * The runtime both S3 drivers share: `aws-s3-files` (Amazon S3, or any endpoint set the old way) and
 * `s3-compatible-files` (an endpoint is required). One implementation means every fix reaches the providers that
 * already exist.
 *
 * With a custom endpoint the client is configured for the stores that sit behind one (MinIO, Ceph RGW, SeaweedFS,
 * Garage, R2, ...): flexible checksums only where the API requires them, no `Expect: 100-continue`, connections made
 * through agents that follow the deployment's network policy and the provider's own CA certificate, bounded
 * timeouts. Amazon S3 itself keeps the SDK's defaults.
 */

/** Longest wait for a connection to open, and for a socket that has gone quiet while a request is on it. */
export const S3_CONNECT_TIMEOUT_MS = 10_000;
export const S3_SOCKET_TIMEOUT_MS = 120_000;
/** The resilience layer retries on top of this, so the SDK itself tries once more at most. */
export const S3_MAX_ATTEMPTS = 2;
/** Longest wait for the object "Test connection" wrote to be removed, once the test itself is over. */
export const S3_PROBE_CLEANUP_MS = 3_000;

const moduleLogger = createLogger('s3-file-runtime');

type RuntimeLogger = NonNullable<ProviderContext['logger']>;

export interface S3FileRuntime extends FileProviderRuntime {
  checkConnection(options?: { signal?: AbortSignal; write?: boolean }): Promise<FileConnectionCheck>;
  close(): void;
}

export interface S3ClientBundle {
  client: S3Client;
  /** The connections of a custom endpoint; `undefined` for Amazon S3, which uses the SDK's own handler. */
  agents?: StorageAgents;
  endpoint?: string;
  region: string;
  bucket: string;
  /** The values that must never show up in a message. */
  secrets: string[];
}

function requiredCredential(value: unknown, label: string, field: string): string {
  const text = settingText(value);
  if (!text) throw new ProviderSettingsError(field, `${label} is required.`);
  return text;
}

/** The policy refuses this endpoint (a private target on SaaS); a resolver outage stays the retryable error it is. */
async function assertEndpointAllowed(endpoint: string, guard: OutboundGuardOptions | undefined): Promise<void> {
  try {
    await assertPublicUrl(endpoint, guard);
  } catch (error) {
    if (error instanceof OutboundDnsError) throw error;
    throw toProviderEndpointError('endpoint', error);
  }
}

/**
 * Builds the S3 client of a provider's settings. Reads them leniently (a stored row keeps working: values trimmed,
 * defaults filled in); the strict checks that refuse a setting belong to the save path (`validateS3Settings`).
 *
 * Throws `ProviderSettingsError` for a setting that cannot work (no bucket, no keys, a CA bundle that does not parse,
 * skipped TLS verification outside a self-hosted deployment) and `ProviderEndpointError` for an endpoint the
 * deployment's network policy refuses, before any socket is opened. A private endpoint passes only inside a network
 * the operator has opened for `options.tenantId` (none is opened without it).
 */
export async function createS3Client(
  credentials: S3Credentials,
  settings: S3CompatibleSettings,
  options: { requireEndpoint: boolean; tenantId?: string },
): Promise<S3ClientBundle> {
  const endpointText = settingText(settings.endpoint);
  const endpoint = endpointText ? normalizeS3Endpoint(endpointText) : undefined;
  if (!endpoint && options.requireEndpoint) {
    throw new ProviderSettingsError('endpoint', 'Endpoint URL is required (for example https://minio.internal:9000).');
  }
  const region = resolveS3Region(settings.region, Boolean(endpoint));
  const bucket = resolveS3Bucket(settings.bucket);
  const accessKeyId = requiredCredential(credentials.accessKeyId, 'Access key ID', 'accessKeyId');
  const secretAccessKey = requiredCredential(credentials.secretAccessKey, 'Secret access key', 'secretAccessKey');
  const sessionToken = settingText(credentials.sessionToken);
  const sdkCredentials = { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
  const secrets = [accessKeyId, secretAccessKey, ...(sessionToken ? [sessionToken] : [])];
  // Most S3-compatible stores need path-style addressing, so a custom endpoint turns it on unless it is switched off.
  const forcePathStyle = settings.usePathStyleEndpoint ?? Boolean(endpoint);

  if (!endpoint) {
    // Amazon S3 itself: the SDK's defaults (checksums, connection handling) stay as they are.
    return { client: new S3Client({ region, credentials: sdkCredentials, forcePathStyle }), region, bucket, secrets };
  }

  const guard = endpointGuardOptions(options.tenantId);
  await assertEndpointAllowed(endpoint, guard);
  const agents = createStorageAgents({
    guard,
    guardHost: new URL(endpoint).hostname,
    caCertificate: settings.caCertificate,
    allowInsecureTls: settings.allowInsecureTls,
    isOnPrem: getConfig().deployment.isOnPrem,
  });
  try {
    const client = new S3Client({
      region,
      endpoint,
      credentials: sdkCredentials,
      forcePathStyle,
      // Flexible checksums (the CRC32 header or trailer the SDK adds by default) only where the API requires them:
      // stores that predate them answer 501 or fail the signature check.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      // A body of 2 MiB and more is announced with "Expect: 100-continue" by default. Stores and proxies that do not
      // implement it answer 417 or leave such uploads waiting, so the header is not sent at all.
      expectContinueHeader: false,
      maxAttempts: S3_MAX_ATTEMPTS,
      // Agent instances, not agent options: with options the SDK builds a throwaway https agent for a request that
      // carries `Expect: 100-continue`, which drops the CA and the verification setting for it.
      requestHandler: {
        httpAgent: agents.httpAgent,
        httpsAgent: agents.httpsAgent,
        connectionTimeout: S3_CONNECT_TIMEOUT_MS,
        socketTimeout: S3_SOCKET_TIMEOUT_MS,
      },
    });
    return { client, agents, endpoint, region, bucket, secrets };
  } catch (error) {
    agents.destroy();
    throw error;
  }
}

/** The bytes of a GetObject body; refuses (and stops reading) once `limit` is passed. */
async function readBody(body: unknown, limit: number, tooLarge: () => S3OperationError): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const fixed = Buffer.isBuffer(body) ? body : typeof body === 'string' ? Buffer.from(body) : body instanceof Uint8Array ? Buffer.from(body) : undefined;
  if (fixed) {
    if (fixed.length > limit) throw tooLarge();
    return fixed;
  }

  const stream = body as Partial<AsyncIterable<Uint8Array | string>> & {
    destroy?: () => void;
    transformToByteArray?: () => Promise<Uint8Array>;
    arrayBuffer?: () => Promise<ArrayBuffer>;
  };
  if (typeof stream[Symbol.asyncIterator] === 'function') {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of stream as AsyncIterable<Uint8Array | string>) {
      const piece = typeof chunk === 'string'
        ? Buffer.from(chunk)
        : Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      total += piece.length;
      if (total > limit) {
        stream.destroy?.();
        throw tooLarge();
      }
      chunks.push(piece);
    }
    return Buffer.concat(chunks, total);
  }
  // Bodies that cannot be read piece by piece are read whole (and checked afterwards).
  const whole = typeof stream.transformToByteArray === 'function'
    ? Buffer.from(await stream.transformToByteArray())
    : typeof stream.arrayBuffer === 'function'
      ? Buffer.from(await stream.arrayBuffer())
      : undefined;
  if (!whole) throw new Error('The storage returned a response body this driver cannot read.');
  if (whole.length > limit) throw tooLarge();
  return whole;
}

function toHandle(
  key: string,
  object: Pick<_Object, 'Key' | 'Size' | 'LastModified' | 'ETag'>,
): FileObjectHandle {
  return {
    key,
    name: key.split('/').pop() ?? key,
    size: object.Size ?? 0,
    etag: object.ETag ?? undefined,
    lastModified: object.LastModified ?? undefined,
  };
}

function isListing(listing: ListObjectsV2CommandOutput): boolean {
  // A page that answers 200 without any listing field is not an S3 server (a web console, a proxy).
  return listing.Name !== undefined || listing.KeyCount !== undefined || listing.IsTruncated !== undefined;
}

export interface S3FileRuntimeArgs {
  tenantId: string;
  providerKey: string;
  credentials: S3Credentials;
  settings: S3CompatibleSettings;
  logger?: RuntimeLogger;
  /** S3-compatible storage needs an endpoint; Amazon S3 builds its own from the region. */
  requireEndpoint: boolean;
  /** S3-compatible storage with "Create bucket if missing" on: the first upload creates a bucket the store reports missing. */
  createBucketIfMissing?: boolean;
}

export async function createS3FileRuntime(args: S3FileRuntimeArgs): Promise<S3FileRuntime> {
  const { client, agents, endpoint, bucket, secrets } = await createS3Client(args.credentials, args.settings, {
    requireEndpoint: args.requireEndpoint,
    tenantId: args.tenantId,
  });
  const log: Pick<RuntimeLogger, 'info' | 'warn'> = args.logger ?? moduleLogger;
  const createBucketOnUpload = args.createBucketIfMissing === true;
  const basePrefix = s3BasePrefix(args.settings.prefix, args.tenantId, args.providerKey);

  const errorContext = (operation: S3Operation): S3ErrorContext => ({
    endpoint,
    bucket,
    operation,
    createBucket: args.requireEndpoint ? (createBucketOnUpload ? 'on' : 'off') : undefined,
    secrets,
  });

  function toStorageKey(relativeKey?: string) {
    const sanitized = sanitizeKey(relativeKey ?? generateKey());
    return { relativeKey: sanitized, storageKey: `${basePrefix}${sanitized}` };
  }

  /** Every SDK call goes through here: what comes out says what to change and carries `statusCode` / `retryable`. */
  async function call<T>(operation: S3Operation, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    try {
      return await run();
    } catch (error) {
      // The caller gave up (the time limit of "Test connection"): that is not a storage failure to explain.
      if (signal?.aborted || isS3OperationError(error)) throw error;
      throw new S3OperationError(describeS3Error(error, errorContext(operation)), error);
    }
  }

  async function createBucket(signal?: AbortSignal): Promise<void> {
    await call('create-bucket', async () => {
      try {
        await client.send(new CreateBucketCommand({ Bucket: bucket }), { abortSignal: signal });
        log.info('Created S3 bucket', { bucket });
      } catch (error) {
        // Another replica created it first: the bucket is there, which is all this wanted.
        if ((error as Error | undefined)?.name === 'BucketAlreadyOwnedByYou') return;
        throw error;
      }
    }, signal);
  }

  async function putObject(input: UploadFileInput, signal?: AbortSignal): Promise<UploadFileResult> {
    const { relativeKey, storageKey } = toStorageKey(input.key ?? generateKey(input.name));
    const body = Buffer.isBuffer(input.data) ? input.data : Buffer.from(input.data);
    const checksum = createHash('sha256').update(body).digest('hex');
    // Amazon S3 itself (no endpoint) has no proxy in the path, so a key keeps its `_` and `.`, as it always did.
    const { metadata, dropped } = buildS3Metadata([
      ['checksum', checksum],
      ['originalName', input.name],
      ...Object.entries(input.metadata ?? {}),
    ], { keepPunctuation: !endpoint });
    if (dropped.length > 0) {
      log.warn('S3 object metadata that does not fit was left out', { key: storageKey, dropped });
    }

    const send = () => client.send(
      new PutObjectCommand({ Bucket: bucket, Key: storageKey, Body: body, ContentType: input.contentType, Metadata: metadata }),
      { abortSignal: signal },
    );
    const response = await call('put', async () => {
      try {
        return await send();
      } catch (error) {
        // Never on a 403: credentials without rights to the bucket may simply lack the right to make it.
        if (!createBucketOnUpload || (error as Error | undefined)?.name !== 'NoSuchBucket') throw error;
        await createBucket(signal);
        return send();
      }
    }, signal);

    log.info('Uploaded S3 object', { key: storageKey, size: body.length });

    return {
      handle: {
        key: relativeKey,
        name: input.name ?? relativeKey.split('/').pop() ?? relativeKey,
        size: body.length,
        contentType: input.contentType,
        checksum,
        etag: response.ETag ?? undefined,
        // what the caller gave, not the header-safe form that was sent
        metadata: input.metadata,
      },
    };
  }

  async function getObject(key: string, signal?: AbortSignal): Promise<FileDownloadResult> {
    const { storageKey } = toStorageKey(key);
    const limit = maxStorageDownloadBytes();
    const tooLarge = () => new S3OperationError({
      code: 'object_too_large',
      message: `The object is larger than the ${Math.round(limit / (1024 * 1024))} MB this server reads into memory at once.`,
      retryable: false,
    });
    return call('get', async () => {
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: storageKey }), { abortSignal: signal });
      if (typeof response.ContentLength === 'number' && response.ContentLength > limit) {
        (response.Body as { destroy?: () => void } | undefined)?.destroy?.();
        throw tooLarge();
      }
      const data = await readBody(response.Body, limit, tooLarge);
      return {
        data,
        size: response.ContentLength ?? data.length,
        contentType: response.ContentType ?? undefined,
        metadata: decodeS3Metadata(response.Metadata),
        etag: response.ETag ?? undefined,
      };
    }, signal);
  }

  async function removeObject(key: string, signal?: AbortSignal): Promise<void> {
    const { storageKey } = toStorageKey(key);
    await call('delete', () => client.send(new DeleteObjectCommand({ Bucket: bucket, Key: storageKey }), { abortSignal: signal }), signal);
    log.info('Deleted S3 object', { key: storageKey });
  }

  /** The first page of the provider's own prefix: one request that proves the bucket, the keys and the endpoint. */
  function listOnePage(signal?: AbortSignal) {
    return call('list', () => client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: basePrefix, MaxKeys: 1 }),
      { abortSignal: signal },
    ), signal);
  }

  /** What a failed step looks like to the person who pressed "Test connection". */
  function reasonOf(error: unknown, signal?: AbortSignal): string {
    if (signal?.aborted) return 'The test was stopped before it finished (time limit).';
    if (error instanceof Error && (isS3OperationError(error) || error instanceof ProviderSettingsError)) return error.message;
    return describeS3Error(error, errorContext('list')).message;
  }

  /**
   * Removes the object "Test connection" wrote. It runs on a signal of its own: the caller's may be spent (its time
   * limit ended the test while the object was already stored), and the object is wanted gone whatever became of the
   * test. Never throws.
   */
  async function removeProbe(probeKey: string): Promise<{ ok: true } | { ok: false; message: string; timedOut: boolean }> {
    const limit = AbortSignal.timeout(S3_PROBE_CLEANUP_MS);
    try {
      await removeObject(probeKey, limit);
      return { ok: true };
    } catch (error) {
      if (limit.aborted) return { ok: false, message: 'the delete did not finish in time', timedOut: true };
      return { ok: false, message: reasonOf(error), timedOut: false };
    }
  }

  async function checkConnection(options: { signal?: AbortSignal; write?: boolean } = {}): Promise<FileConnectionCheck> {
    const { signal } = options;
    const write = options.write !== false;
    const steps: NonNullable<FileConnectionCheck['steps']> = [];
    const outcome = (ok: boolean, message: string): FileConnectionCheck => ({ ok, message, steps });
    const fail = (step: 'list' | 'write' | 'read', error: unknown, lead = ''): FileConnectionCheck => {
      const reason = reasonOf(error, signal);
      steps.push({ step, ok: false, message: reason });
      // "Writing failed: the test was stopped" would blame the store for the caller's time limit
      return outcome(false, signal?.aborted ? reason : `${lead}${reason}`);
    };

    try {
      if (signal?.aborted) return outcome(false, reasonOf(undefined, signal));

      let created = false;
      let listing: ListObjectsV2CommandOutput;
      try {
        listing = await listOnePage(signal);
      } catch (error) {
        if (!(createBucketOnUpload && isS3OperationError(error) && error.code === 'bucket_missing')) return fail('list', error);
        try {
          await createBucket(signal);
          created = true;
          listing = await listOnePage(signal);
        } catch (inner) {
          return fail('list', inner);
        }
      }
      if (!isListing(listing)) {
        return fail('list', new S3OperationError({
          code: 'not_s3',
          message: `${endpoint ? new URL(endpoint).host : 'The endpoint'} answered HTTP 200 but not with an S3 bucket listing. Check the endpoint URL and port: a web console or a proxy page can answer 200 to every request.`,
          statusCode: 200,
          retryable: false,
        }));
      }
      steps.push({ step: 'list', ok: true });

      let deleteFailure: { message: string; timedOut: boolean } | undefined;
      if (write) {
        const probeKey = `${S3_CONNECTION_TEST_PREFIX}${randomUUID()}.txt`;
        const data = Buffer.from('cognipeer connection test');
        let writeFailure: FileConnectionCheck | undefined;
        let readFailure: unknown;
        try {
          try {
            // A non-ASCII name on purpose: it sends the metadata encoding over the real wire.
            await putObject({ key: probeKey, name: 'bağlantı-testi.txt', contentType: 'text/plain', data, metadata: { purpose: 'connection-test' } }, signal);
            steps.push({ step: 'write', ok: true });
          } catch (error) {
            writeFailure = fail('write', error, 'Listing works, but writing a test object failed: ');
          }

          if (!writeFailure) {
            try {
              const back = await getObject(probeKey, signal);
              if (!back.data.equals(data)) {
                throw new S3OperationError({ code: 'integrity', message: 'The object read back differs from the object written.', retryable: false });
              }
              steps.push({ step: 'read', ok: true });
            } catch (error) {
              readFailure = error;
              steps.push({ step: 'read', ok: false, message: reasonOf(error, signal) });
            }
          }
        } finally {
          // The put was attempted, so the object may exist: a failed read leaves it, so does a time limit that ended the
          // test first, and so can a write the store answered with an error after it had stored the object.
          const removal = await removeProbe(probeKey);
          if (!writeFailure) {
            if (removal.ok) {
              steps.push({ step: 'delete', ok: true });
            } else {
              deleteFailure = { message: removal.message, timedOut: removal.timedOut };
              steps.push({ step: 'delete', ok: false, message: removal.message });
            }
          }
        }

        if (writeFailure) return writeFailure;
        if (readFailure !== undefined) {
          const reason = reasonOf(readFailure, signal);
          return outcome(false, signal?.aborted ? reason : `Writing works, but reading the test object back failed: ${reason}`);
        }
      }

      const passed = steps.filter((step) => step.ok).map((step) => step.step);
      const done = `Connected to bucket "${bucket}" (${[...(created ? ['bucket created'] : []), ...passed].join(', ')}).`;
      if (!deleteFailure) return outcome(true, done);
      // A delete that ran out of time says nothing about the permission to delete.
      return outcome(
        true,
        deleteFailure.timedOut
          ? `${done} Removing the test object did not finish in time; it may be left under "${S3_CONNECTION_TEST_PREFIX}".`
          : `${done} Removing the test object failed (${deleteFailure.message}); it was left under "${S3_CONNECTION_TEST_PREFIX}". Deleting files needs the DeleteObject permission.`,
      );
    } catch (error) {
      // Every step above answers for itself; this is the net under them, because a connection test never throws.
      return outcome(false, reasonOf(error, signal));
    }
  }

  const runtime: S3FileRuntime = {
    uploadFile: (input) => putObject(input),
    downloadFile: (key) => getObject(key),
    deleteFile: (key) => removeObject(key),

    async listFiles(options?: ListFilesOptions) {
      const sanitizedPrefix = options?.prefix && options.prefix.trim().length > 0 ? sanitizeKey(options.prefix) : undefined;
      const listPrefix = sanitizedPrefix ? `${basePrefix}${sanitizedPrefix}` : basePrefix;

      const response = await call('list', () => client.send(new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: listPrefix,
        ContinuationToken: options?.cursor,
        MaxKeys: options?.limit ?? 50,
      })));

      const contents: _Object[] = response.Contents ?? [];
      return {
        items: contents.map((object) => toHandle((object.Key ?? '').slice(basePrefix.length), object)),
        nextCursor: response.NextContinuationToken ?? undefined,
      };
    },

    async getFileMetadata(key) {
      const { relativeKey, storageKey } = toStorageKey(key);
      try {
        const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: storageKey }));
        return {
          key: relativeKey,
          name: relativeKey.split('/').pop() ?? relativeKey,
          size: Number(head.ContentLength ?? 0),
          contentType: head.ContentType ?? undefined,
          etag: head.ETag ?? undefined,
          metadata: decodeS3Metadata(head.Metadata),
          lastModified: head.LastModified ?? undefined,
        } satisfies FileObjectHandle;
      } catch (error) {
        const name = (error as Error | undefined)?.name;
        if (name === 'NotFound' || name === 'NoSuchKey') return null;
        throw new S3OperationError(describeS3Error(error, errorContext('head')), error);
      }
    },

    checkConnection,

    close() {
      client.destroy();
      agents?.destroy();
    },
  };

  return runtime;
}
