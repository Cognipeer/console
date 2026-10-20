/**
 * The Azure Blob Storage file runtime: the five file operations, the "Test connection" check and the network
 * rules around them.
 *
 * Layout: `<settings.prefix>/<tenantId>/<providerKey>/<key>` inside one container, the same isolation the S3
 * drivers use. Every call runs under its own deadline and fails as an `AzureBlobError` (status, Azure's code
 * and a `retryable` verdict, never the SDK's request, which holds a SAS signature).
 *
 * Network rules (the same ones the model providers follow, see `providerEndpointGuard`):
 *  - the endpoint is vetted when the runtime is built, and again when a socket connects (the agent's lookup),
 *  - a CA certificate or "skip TLS verification" is applied through the same agent,
 *  - without any of those the SDK keeps its own agent, which honours HTTP(S)_PROXY.
 */

import { randomUUID } from 'node:crypto';
import type { AnonymousCredential, ContainerClient, StorageSharedKeyCredential } from '@azure/storage-blob';
import { getConfig } from '@/lib/core/config';
import type { DownloadFileOptions, FileConnectionCheck, FileObjectHandle, FileProviderRuntime, ListFilesOptions, ListFilesResult, UploadFileInput } from '@/lib/providers/domains/file';
import { ProviderSettingsError } from '@/lib/providers/errors';
import type { ProviderContext } from '@/lib/providers/types';
import { privateNetworkBlockApplies, safeFetch } from '@/lib/security/outboundFetch';
import { createStorageAgents, type StorageAgents } from '@/lib/security/storageTransport';
import { assertProviderUrlAllowed, endpointGuardOptions } from '@/lib/services/providers/providerEndpointGuard';
import { resolveDownloadCeiling } from '../downloadCeiling';
import {
  resolveAzureBlobConfig,
  secretValues,
  type AzureBlobCredentials,
  type AzureBlobSettings,
} from './blobConfig';
import { createClientSecretCredential, ENTRA_TIMEOUT_MS, type TokenCredential } from './blobEntra';
import {
  AzureBlobError,
  describeAzureError,
  describeFailure,
  isAzureBlobError,
  isContainerMissing,
  isHopelessFailure,
  isInterruptedRead,
  redactSecrets,
} from './blobErrors';
import {
  asciiHeaderValue,
  assertBlobNameLimits,
  buildBasePrefix,
  generateKey,
  quoteEtag,
  sanitizeBlobKey,
  sanitizeListPrefix,
  sha256Hex,
} from './blobKeys';
import { decodeBlobMetadata, encodeBlobMetadata, isDirectoryMarker } from './blobMetadata';
import { buildPipeline, loadAzureBlobSdk } from './blobTransport';

/** A page may legitimately come back empty with a continuation token (service partition boundary). */
const MAX_EMPTY_PAGES = 8;
const MAX_PAGE_SIZE = 5000;
const LIST_TIMEOUT_MS = 30_000;
/** How many times a download whose connection dropped asks for the rest of the object. */
const DOWNLOAD_RETRIES = 2;
/** The last attempt to remove the test object after the check's own time limit has passed. */
const CLEANUP_TIMEOUT_MS = 5_000;
const MIB = 1024 * 1024;
/** Where "Test connection" writes: inside the provider's own prefix, and recognisable to anyone who looks. */
export const CONNECTION_TEST_PREFIX = '.cognipeer-connection-test/';
/** A name no ASCII-only metadata channel carries unharmed: the test proves the codec end to end. */
const CONNECTION_TEST_NAME = 'Bağlantı testi 接続テスト.txt';

export interface AzureBlobRuntime extends FileProviderRuntime {
  close(): void;
  checkConnection(options?: { signal?: AbortSignal; write?: boolean }): Promise<FileConnectionCheck>;
}

/** One operation's budget: just inside the caller's per-attempt timeout so a stalled socket is closed, not abandoned. */
function operationTimeoutMs(): number {
  const budget = getConfig().gateway.requestTimeoutMs;
  return budget > 0 ? Math.max(5_000, budget - 2_000) : 600_000;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.floor(value), min), max);
}

function tooLarge(ceiling: number): AzureBlobError {
  return new AzureBlobError(
    `This file is larger than the ${Math.floor(ceiling / MIB)} MB this server loads into memory at once.`,
    { code: 'ObjectTooLarge', retryable: false },
  );
}

/** What a download has read so far: it outlives one response, because a body that was cut off is continued, not restarted. */
interface BodySink {
  chunks: Buffer[];
  total: number;
}

/** Adds the body to `sink`, stopping (and closing the stream) once the whole passes `ceiling`. */
async function readBody(stream: NodeJS.ReadableStream | undefined, ceiling: number, sink: BodySink): Promise<void> {
  if (!stream) return;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (sink.total + buffer.length > ceiling) {
      (stream as { destroy?: () => void }).destroy?.();
      throw tooLarge(ceiling);
    }
    sink.total += buffer.length;
    sink.chunks.push(buffer);
  }
}

/**
 * The text of an error a person will read: our own sentences (scrubbed again, since a service or a token server may
 * have echoed a credential into one), anything else scrubbed and cut to one line.
 */
function failureText(error: unknown, secrets: readonly string[]): string {
  if (isAzureBlobError(error) || error instanceof ProviderSettingsError) return redactSecrets(error.message, secrets);
  const line = error instanceof Error ? error.message.split(/\r?\n/, 1)[0] : '';
  return redactSecrets(line, secrets).slice(0, 300) || 'The connection check failed.';
}

export async function createAzureBlobRuntime(
  context: ProviderContext<AzureBlobCredentials, AzureBlobSettings>,
): Promise<AzureBlobRuntime> {
  const { tenantId, providerKey, credentials, settings, logger } = context;
  // Plain http and skipped verification are the provider's own choice on every deployment; the network policy applies
  // either way, and Microsoft Entra sign-in still needs https (`resolveAzureBlobConfig`).
  const config = resolveAzureBlobConfig(credentials, settings, { allowHttp: true });
  const guard = endpointGuardOptions(tenantId);
  // Rows stored before the endpoint policy, and a name that now answers differently, are not covered by the
  // save-time check: the policy is applied again here, before any socket exists. A refusal is a `ProviderEndpointError`
  // for the setting the endpoint was read from, as it is when the provider is saved (a name that does not resolve is
  // one that is `retryable`).
  await assertProviderUrlAllowed(config.endpointField, config.endpoint.serviceUrl, { tenantId });
  if (config.auth.method === 'entra') await assertProviderUrlAllowed('authorityHost', config.auth.authority, { tenantId });

  const basePrefix = buildBasePrefix([config.prefix, tenantId, providerKey]);
  const { endpoint, container: containerName } = config;
  const failureContext = {
    account: endpoint.accountName ?? endpoint.host,
    container: containerName,
    host: endpoint.host,
    authMethod: config.authMethod,
    apiVersion: config.apiVersion,
    // a SAS that expires while the runtime is cached is refused by the service; the sentence can say so
    ...(config.auth.method === 'sas' ? { sas: { expiresAt: config.auth.sas.expiresAt, startsAt: config.auth.sas.startsAt } } : {}),
  };
  const secrets = secretValues(credentials, config);

  // The agent is installed only where it has a job: refusing private addresses at connect time, trusting a
  // private CA, or skipping verification. Elsewhere the SDK keeps its default agent (and with it HTTP(S)_PROXY,
  // which an injected agent ignores).
  const guarded = privateNetworkBlockApplies(endpoint.host, guard);
  const needsAgent = guarded || Boolean(config.caCertificate) || config.allowInsecureTls;
  const agents: StorageAgents | undefined = needsAgent
    ? createStorageAgents({
      guard,
      guardHost: endpoint.host,
      caCertificate: config.caCertificate,
      allowInsecureTls: config.allowInsecureTls,
      maxSockets: 32,
    })
    : undefined;

  let container: ContainerClient;
  try {
    const sdk = await loadAzureBlobSdk();
    let containerUrl = `${endpoint.serviceUrl}/${containerName}`;
    let credential: StorageSharedKeyCredential | AnonymousCredential | TokenCredential;
    switch (config.auth.method) {
      case 'accountKey':
        credential = new sdk.StorageSharedKeyCredential(endpoint.accountName as string, config.auth.accountKey);
        break;
      case 'sas':
        credential = new sdk.AnonymousCredential();
        containerUrl += `?${config.auth.sas.token}`;
        break;
      case 'entra':
        credential = createClientSecretCredential({
          authorityHost: config.auth.authority,
          tenantId: config.auth.tenantId,
          clientId: config.auth.clientId,
          clientSecret: config.auth.clientSecret,
          // Refuses private targets under the same rules as the endpoint and never follows redirects (`safeFetch` also pins
          // DNS to the vetted addresses). A provider with a CA certificate (or skipped verification) trusts it for its token
          // server too: the agents hold the trust they were built with. The credential's own deadline (`init.signal`) covers
          // the answer body too, so it stays linked after the headers.
          fetchImpl: (url, init) => safeFetch(url, init, {
            ...endpointGuardOptions(tenantId),
            timeoutMs: ENTRA_TIMEOUT_MS,
            followRedirects: false,
            keepAbortLinked: true,
            ...(agents?.tls ? { tls: agents.tls } : {}),
          }),
        });
        break;
    }
    const agent = agents ? (endpoint.protocol === 'https:' ? agents.httpsAgent : agents.httpAgent) : undefined;
    container = new sdk.ContainerClient(containerUrl, buildPipeline(sdk, credential, { apiVersion: config.apiVersion, agent }));
  } catch (error) {
    agents?.destroy();
    throw error;
  }

  function toStorageName(rawKey?: string): { relativeKey: string; blobName: string } {
    const relativeKey = sanitizeBlobKey(rawKey ?? generateKey());
    return { relativeKey, blobName: assertBlobNameLimits(`${basePrefix}${relativeKey}`) };
  }

  /** The error with the credentials in play taken out of its text; the same error when there were none. */
  function scrubbed(error: AzureBlobError): AzureBlobError {
    const message = redactSecrets(error.message, secrets);
    return message === error.message
      ? error
      : new AzureBlobError(message, { statusCode: error.statusCode, code: error.code, requestId: error.requestId, retryable: error.retryable });
  }

  function toAzureBlobError(error: unknown, operation: string, clocks?: { deadline: AbortSignal; caller?: AbortSignal }): Error {
    if (isAzureBlobError(error)) return scrubbed(error);
    if (error instanceof ProviderSettingsError) return error;
    const info = describeAzureError(error);
    // An abort that neither the deadline nor the caller raised came from the connection (the SDK reports a body cut off
    // mid-stream as one), and "did not answer in time" would be the wrong thing to tell.
    const interrupted = info.aborted && clocks !== undefined && !clocks.deadline.aborted && clocks.caller?.aborted !== true;
    return new AzureBlobError(redactSecrets(describeFailure(info, { ...failureContext, operation, interrupted }), secrets), {
      statusCode: info.status,
      code: info.code ?? info.systemCode,
      requestId: info.requestId,
      retryable: !isHopelessFailure(info),
    });
  }

  /** Runs one SDK call under its own deadline (and the caller's signal) and turns every failure into an `AzureBlobError`. */
  async function call<T>(
    operation: string,
    run: (signal: AbortSignal) => Promise<T>,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    const deadline = AbortSignal.timeout(options.timeoutMs ?? operationTimeoutMs());
    try {
      return await run(options.signal ? AbortSignal.any([deadline, options.signal]) : deadline);
    } catch (error) {
      // Creating the container runs on a clock of its own (shared by the callers that wait for it): not judged against ours.
      throw toAzureBlobError(error, operation, operation === 'create the container' ? undefined : { deadline, caller: options.signal });
    }
  }

  /**
   * Concurrent first uploads share one creation request, which runs on its own deadline so that one caller
   * giving up does not fail the others. Only the request in flight is shared: a container deleted later is
   * created again by the next upload, and across pods `createIfNotExists` is idempotent.
   */
  let creating: Promise<void> | undefined;
  function createContainerOnce(): Promise<void> {
    creating ??= container
      .createIfNotExists({ abortSignal: AbortSignal.timeout(Math.min(LIST_TIMEOUT_MS, operationTimeoutMs())) })
      .then(() => undefined)
      .finally(() => {
        creating = undefined;
      });
    return creating;
  }

  /**
   * A 404 that means "no such file": the service says so with the code `BlobNotFound`. A missing container counts
   * too when this provider creates it on first write (then the store is simply empty); otherwise it is a
   * configuration error and keeps its own message. A 404 without one of those codes - `ResourceNotFound` (an
   * account-level miss), or an answer that is not Azure's at all (a gateway, a proxy page, another storage
   * protocol's error) - says the endpoint is wrong, not that the file is absent, and surfaces as the failure it is.
   */
  function isMissingFile(error: unknown): boolean {
    return isAzureBlobError(error)
      && error.statusCode === 404
      && (error.code === 'BlobNotFound' || (error.code === 'ContainerNotFound' && config.createContainer));
  }

  function toHandle(blobName: string, item: {
    size?: number;
    contentType?: string;
    etag?: string;
    lastModified?: Date;
    metadata?: Record<string, string>;
  }): FileObjectHandle {
    const relativeKey = blobName.slice(basePrefix.length);
    const decoded = decodeBlobMetadata(item.metadata);
    return {
      key: relativeKey,
      name: decoded.name ?? relativeKey.split('/').pop() ?? relativeKey,
      size: item.size ?? 0,
      contentType: item.contentType,
      checksum: decoded.checksum,
      etag: quoteEtag(item.etag),
      lastModified: item.lastModified,
      metadata: decoded.custom,
    };
  }

  /* ---------------------------------------------------------------- */
  /*  Operations (the public methods and the check share these)       */
  /* ---------------------------------------------------------------- */

  async function upload(input: UploadFileInput, signal?: AbortSignal) {
    const { relativeKey, blobName } = toStorageName(input.key ?? generateKey(input.name));
    const body = Buffer.isBuffer(input.data) ? input.data : Buffer.from(input.data);
    const checksum = sha256Hex(body);
    const encoded = encodeBlobMetadata({ checksum, name: input.name, custom: input.metadata });
    if (encoded.droppedCustom) {
      logger?.warn?.('Azure blob metadata not stored on the blob', { key: blobName, reason: encoded.droppedCustom });
    }
    const contentType = asciiHeaderValue(input.contentType);
    const blob = container.getBlockBlobClient(blobName);
    const send = (deadline: AbortSignal) => blob.uploadData(body, {
      abortSignal: deadline,
      metadata: encoded.metadata,
      ...(contentType ? { blobHTTPHeaders: { blobContentType: contentType } } : {}),
    });

    const response = await call('upload', async (deadline) => {
      try {
        return await send(deadline);
      } catch (error) {
        if (config.createContainer && isContainerMissing(describeAzureError(error))) {
          await call('create the container', () => createContainerOnce(), { signal: deadline, timeoutMs: Math.min(LIST_TIMEOUT_MS, operationTimeoutMs()) });
          return send(deadline);
        }
        throw error;
      }
    }, { signal });

    logger?.info?.('Uploaded Azure blob', { key: blobName, size: body.length });
    return {
      handle: {
        key: relativeKey,
        name: input.name ?? relativeKey.split('/').pop() ?? relativeKey,
        size: body.length,
        contentType,
        checksum,
        etag: quoteEtag(response.etag),
        lastModified: response.lastModified,
        metadata: input.metadata,
      } satisfies FileObjectHandle,
    };
  }

  async function download(key: string, signal?: AbortSignal, options?: DownloadFileOptions) {
    const { relativeKey, blobName } = toStorageName(key);
    try {
      return await call('download', async (deadline) => {
        const blob = container.getBlobClient(blobName);
        // The SDK would continue a body that was cut off by itself, but it does not when the connection drops (it ends the
        // stream with an AbortError, which it cannot tell from a cancelled request), so its retry is off and the
        // continuation below does that job.
        const first = await blob.download(0, undefined, { abortSignal: deadline, maxRetryRequests: 0 });
        const ceiling = resolveDownloadCeiling(options);
        const size = first.contentLength;
        if (size !== undefined && size > ceiling) {
          (first.readableStreamBody as { destroy?: () => void } | undefined)?.destroy?.();
          throw tooLarge(ceiling);
        }
        const body: BodySink = { chunks: [], total: 0 };
        let response = first;
        for (let resumes = 0; ; resumes += 1) {
          try {
            await readBody(response.readableStreamBody, ceiling, body);
            break;
          } catch (error) {
            // Only a connection that went away is continued. The deadline (the caller's signal included) and every other
            // failure end the download.
            if (!isInterruptedRead(error) || deadline.aborted) throw error;
            // Every byte arrived and only the close of the connection was reported: nothing is missing.
            if (size !== undefined && body.total === size) break;
            // The rest is asked for under the version the download started with, so it needs a size and a version to ask under.
            if (size === undefined || first.etag === undefined || body.total > size || resumes >= DOWNLOAD_RETRIES) throw error;
            try {
              response = await blob.download(body.total, size - body.total, {
                abortSignal: deadline,
                maxRetryRequests: 0,
                conditions: { ifMatch: first.etag },
              });
            } catch (resumeError) {
              if (describeAzureError(resumeError).status === 412) {
                throw new AzureBlobError('The file changed while it was being downloaded; try again.', { code: 'BlobChangedDuringDownload', retryable: true });
              }
              throw resumeError;
            }
          }
        }
        const data = Buffer.concat(body.chunks, body.total);
        if (size !== undefined && data.length !== size) {
          throw new Error(`Incomplete download: got ${data.length} of ${size} bytes`);
        }
        return {
          data,
          size: size ?? data.length,
          contentType: first.contentType,
          metadata: decodeBlobMetadata(first.metadata).custom,
          etag: quoteEtag(first.etag),
        };
      }, { signal });
    } catch (error) {
      // "not found" in the text: the client download route maps it to 404, like the other drivers.
      if (isMissingFile(error)) {
        const { code, requestId } = error as AzureBlobError;
        throw new AzureBlobError(`File not found: ${relativeKey}`, { statusCode: 404, code, requestId });
      }
      throw error;
    }
  }

  async function remove(key: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<void> {
    const { blobName } = toStorageName(key);
    try {
      await call('delete', (deadline) => container.getBlobClient(blobName).deleteIfExists({
        abortSignal: deadline,
        deleteSnapshots: 'include',
      }), options);
    } catch (error) {
      // Nothing to delete in a container that is not there yet (it is created by the first upload).
      if (!(isMissingFile(error) && (error as AzureBlobError).code === 'ContainerNotFound')) throw error;
    }
    logger?.info?.('Deleted Azure blob', { key: blobName });
  }

  /** One page of blob items; `undefined` when the listing had none to give. */
  async function listPage(page: { prefix: string; cursor?: string; maxPageSize: number; includeMetadata: boolean; signal: AbortSignal }) {
    const pages = container
      .listBlobsFlat({ prefix: page.prefix, includeMetadata: page.includeMetadata, abortSignal: page.signal })
      .byPage({ continuationToken: page.cursor, maxPageSize: page.maxPageSize });
    const next = await pages.next();
    return next.done ? undefined : next.value;
  }

  async function list(options?: ListFilesOptions): Promise<ListFilesResult> {
    const prefix = `${basePrefix}${sanitizeListPrefix(options?.prefix)}`;
    const maxPageSize = clamp(options?.limit ?? 50, 1, MAX_PAGE_SIZE);

    try {
      return await call('list', async (deadline) => {
        let cursor = options?.cursor || undefined;
        for (let attempt = 0; attempt < MAX_EMPTY_PAGES; attempt += 1) {
          const page = await listPage({ prefix, cursor, maxPageSize, includeMetadata: true, signal: deadline });
          if (!page) return { items: [] };

          cursor = page.continuationToken || undefined;
          const items = page.segment.blobItems
            .filter((item) => !isDirectoryMarker(item.metadata, item.properties.contentLength))
            .map((item) => toHandle(item.name, {
              size: item.properties.contentLength,
              contentType: item.properties.contentType,
              etag: item.properties.etag,
              lastModified: item.properties.lastModified,
              metadata: item.metadata,
            }));
          if (items.length > 0 || !cursor) return { items, nextCursor: cursor };
        }
        return { items: [], nextCursor: cursor };
      }, { timeoutMs: Math.min(LIST_TIMEOUT_MS, operationTimeoutMs()) });
    } catch (error) {
      // The container is created by the first upload, so until then there is nothing to list.
      if (isMissingFile(error)) return { items: [] };
      throw error;
    }
  }

  async function head(key: string, signal?: AbortSignal): Promise<FileObjectHandle | null> {
    const { blobName } = toStorageName(key);
    try {
      return await call('read properties', async (deadline) => {
        const props = await container.getBlobClient(blobName).getProperties({ abortSignal: deadline });
        return toHandle(blobName, {
          size: props.contentLength,
          contentType: props.contentType,
          etag: props.etag,
          lastModified: props.lastModified,
          metadata: props.metadata,
        });
      }, { timeoutMs: Math.min(LIST_TIMEOUT_MS, operationTimeoutMs()), signal });
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Test connection                                                 */
  /* ---------------------------------------------------------------- */

  /** A list denied for lack of the permission is a gap in the credential, not a broken connection: writing may still work. */
  function isListPermissionGap(error: unknown): boolean {
    return isAzureBlobError(error) && error.statusCode === 403 && error.code === 'AuthorizationPermissionMismatch';
  }

  async function checkConnection(options?: { signal?: AbortSignal; write?: boolean }): Promise<FileConnectionCheck> {
    const signal = options?.signal;
    const write = options?.write ?? true;
    const steps: NonNullable<FileConnectionCheck['steps']> = [];
    const testKey = `${CONNECTION_TEST_PREFIX}${randomUUID()}.txt`;
    let wrote = false;
    let deleted = false;
    let containerMissing = false;

    /** Runs one step; a failure becomes the step's message instead of an exception. */
    async function step(name: 'list' | 'write' | 'read' | 'delete', run: () => Promise<string | void>): Promise<{ ok: boolean; error?: unknown }> {
      try {
        const message = await run();
        steps.push({ step: name, ok: true, ...(message ? { message } : {}) });
        return { ok: true };
      } catch (error) {
        // A delete that the time limit cut short is cleaned up afterwards; any other failure leaves the test file.
        const stays = name === 'delete' && signal?.aborted !== true ? ` The test file "${testKey}" stays in the container.` : '';
        steps.push({ step: name, ok: false, message: `${failureText(error, secrets)}${stays}` });
        return { ok: false, error };
      }
    }

    try {
      if (signal?.aborted) return { ok: false, message: 'The connection test was cancelled.', steps };

      const listed = await step('list', async () => {
        try {
          await call('list', (deadline) => listPage({ prefix: basePrefix, maxPageSize: 1, includeMetadata: false, signal: deadline }), {
            timeoutMs: Math.min(LIST_TIMEOUT_MS, operationTimeoutMs()),
            signal,
          });
        } catch (error) {
          if (isMissingFile(error)) {
            containerMissing = true;
            return 'The container is created on the first upload.';
          }
          if (isListPermissionGap(error)) {
            throw new AzureBlobError(`${(error as Error).message} Uploads, downloads and deletes do not need it; importing existing files does.`, {
              statusCode: 403,
              code: 'AuthorizationPermissionMismatch',
              retryable: false,
            });
          }
          throw error;
        }
      });

      // Writing is tried after a list that failed only for want of the list permission: the answer to "does it
      // work" is in the steps either way. Any other list failure (rejected key, network, missing container) would
      // repeat on the next request, so the check stops there.
      if (write && (listed.ok || isListPermissionGap(listed.error)) && !signal?.aborted) {
        const payload = Buffer.from(`cognipeer connection test ${testKey}`, 'utf8');
        const metadata = { purpose: 'connection-test', note: 'ğüşiöç 日本語' };

        const written = await step('write', async () => {
          await upload({ key: testKey, name: CONNECTION_TEST_NAME, contentType: 'text/plain', data: payload, metadata }, signal);
          wrote = true;
        });

        if (written.ok) {
          await step('read', async () => {
            const downloaded = await download(testKey, signal);
            if (!downloaded.data.equals(payload)) {
              throw new AzureBlobError('The test object came back with different content than was written.', { retryable: false });
            }
            const found = await head(testKey, signal);
            if (found?.name !== CONNECTION_TEST_NAME) {
              throw new AzureBlobError('The file name of the test object did not survive the round trip.', { retryable: false });
            }
            if (JSON.stringify(downloaded.metadata) !== JSON.stringify(metadata)) {
              throw new AzureBlobError('The custom metadata of the test object did not survive the round trip.', { retryable: false });
            }
          });
          await step('delete', async () => {
            await remove(testKey, { signal });
            deleted = true;
          });
        }
      }
    } catch (error) {
      return { ok: false, message: failureText(error, secrets), steps };
    } finally {
      // The time limit ran out between writing and deleting: one short attempt to leave nothing behind.
      if (wrote && !deleted && signal?.aborted) {
        await remove(testKey, { timeoutMs: CLEANUP_TIMEOUT_MS }).catch(() => undefined);
      }
    }

    const failed = steps.filter((entry) => !entry.ok);
    // Only the removal of the test file failed: the connection works, so the check passes, and the step and the message
    // say what is missing and which file stays (the same as for the other file providers). A delete that the time
    // limit cut short is not that.
    const onlyDelete = failed.length === 1 && failed[0].step === 'delete' && signal?.aborted !== true;
    if (failed.length === 0 || onlyDelete) {
      const message = containerMissing && !write
        ? `Connected to storage account "${failureContext.account}"; the container "${containerName}" is created on the first upload.`
        : `Connected to container "${containerName}"${write ? '' : ' (listing only)'}.`;
      return { ok: true, message: onlyDelete ? `${message} Removing the test file failed.${failed[0].message ? ` ${failed[0].message}` : ''}` : message, steps };
    }
    const first = failed[0];
    const writeSide = steps.filter((entry) => entry.step !== 'list');
    const rest = first.step === 'list' && writeSide.length === 3 && writeSide.every((entry) => entry.ok)
      ? ' Writing, reading and deleting still work.'
      : '';
    return { ok: false, message: `${first.message ?? 'The connection check failed.'}${rest}`, steps };
  }

  const runtime: AzureBlobRuntime = {
    uploadFile: (input) => upload(input),
    downloadFile: (key, options) => download(key, undefined, options),
    deleteFile: (key) => remove(key),
    listFiles: (options) => list(options),
    getFileMetadata: (key) => head(key),
    checkConnection,
    /** Called by the runtime pool when the entry is evicted, and by "Test connection" once its probe is done. */
    close() {
      agents?.destroy();
    },
  };

  return runtime;
}
