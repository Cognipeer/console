/**
 * Unit tests — how file I/O is guarded by the circuit breaker
 *
 *  - The breaker key carries the tenant: a provider key is only unique inside its
 *    tenant, so each tenant's provider has a circuit of its own.
 *  - Only an outage counts against the breaker (`isTransientStorageError`): a
 *    rejected key, a missing bucket or a refused setting is the caller's to fix.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadProviderRuntimeData: vi.fn(),
  createRuntime: vi.fn(),
  convert: vi.fn(),
}));

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/services/providers/providerService', () => ({
  createProviderConfig: vi.fn(),
  getProviderConfigByKey: vi.fn(),
  listProviderConfigs: vi.fn(),
  loadProviderRuntimeData: mocks.loadProviderRuntimeData,
}));
vi.mock('@/lib/providers', () => ({
  providerRegistry: {
    listDescriptors: vi.fn().mockReturnValue([]),
    getContract: vi.fn().mockReturnValue({ id: 'memory-files', capabilities: { upload: true, download: true } }),
    createRuntime: mocks.createRuntime,
  },
}));
vi.mock('@cognipeer/to-markdown', () => ({ convertToMarkdown: mocks.convert }));
vi.mock('@/lib/core/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

import {
  CircuitOpenError,
  getAllCircuitStates,
  getCircuitState,
  RequestTimeoutError,
  resetAllCircuits,
} from '@/lib/core/resilience';
import { getConfigSource, setConfigSource } from '@/lib/core/config';
import { runtimePool } from '@/lib/core/runtimePool';
import { getDatabase } from '@/lib/database';
import { ProviderSettingsError } from '@/lib/providers/errors';
import { OutboundDnsError, OutboundNetworkError } from '@/lib/security/outboundFetch';
import {
  deleteFile,
  downloadFile,
  FILE_RUNTIME_POOL_PREFIX,
  isTransientStorageError,
  replaceFileContent,
  uploadFile,
} from '@/lib/services/files/fileService';
import { ProviderEndpointError } from '@/lib/services/providers/providerEndpointGuard';
import { createMockDb } from '../helpers/db.mock';

const ORIGINAL_SOURCE = getConfigSource();
const PROJECT = 'p1';
const THRESHOLD = 3;

interface FakeRuntime {
  uploadFile: ReturnType<typeof vi.fn>;
  downloadFile: ReturnType<typeof vi.fn>;
  deleteFile: ReturnType<typeof vi.fn>;
  getFileMetadata: ReturnType<typeof vi.fn>;
}

/** One runtime per tenant, so a test can make one tenant's storage fail and leave the other's healthy. */
let runtimes: Record<string, FakeRuntime>;
let db: ReturnType<typeof createMockDb>;

function makeRuntime(): FakeRuntime {
  return {
    uploadFile: vi.fn(async (input: { key: string; name: string; data: Buffer }) => ({
      handle: { key: input.key, name: input.name, size: input.data.length },
    })),
    downloadFile: vi.fn(async () => ({ data: Buffer.from('abc'), contentType: 'text/plain', size: 3 })),
    deleteFile: vi.fn(async () => undefined),
    // The text copy is not written over an object that is already there: nothing is.
    getFileMetadata: vi.fn(async () => null),
  };
}

function gatewayConfig(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    GATEWAY_RETRY_ENABLED: 'false',
    GATEWAY_CIRCUIT_BREAKER_ENABLED: 'true',
    GATEWAY_CIRCUIT_BREAKER_THRESHOLD: String(THRESHOLD),
    GATEWAY_CIRCUIT_BREAKER_RESET_MS: '60000',
    PROVIDER_RUNTIME_DISPOSE_GRACE_SECONDS: '0',
    ...overrides,
  };
  setConfigSource({ name: 'test', get: (key) => values[key] ?? process.env[key] });
}

const upload = (tenantId: string, extra: Record<string, unknown> = {}) =>
  uploadFile('tenant_db', tenantId, PROJECT, {
    bucketKey: 'docs', fileName: 'a.txt', contentType: 'text/plain', data: Buffer.from('abc'), createdBy: 'u1', convertToMarkdown: false, ...extra,
  });
const download = (tenantId: string) => downloadFile('tenant_db', tenantId, PROJECT, 'docs', 'a.txt');
const remove = (tenantId: string) => deleteFile('tenant_db', tenantId, PROJECT, 'docs', 'a.txt', 'u1');
const replace = (tenantId: string) =>
  replaceFileContent('tenant_db', tenantId, PROJECT, 'docs', 'a.txt', { data: Buffer.from('abcd'), updatedBy: 'u1', convertToMarkdown: false });

const outage = () => Object.assign(new Error('Service unavailable'), { status: 503 });
const refusal = () => Object.assign(new Error('Access denied'), { statusCode: 403, retryable: false });

beforeEach(() => {
  resetAllCircuits();
  gatewayConfig();
  runtimes = { t1: makeRuntime(), t2: makeRuntime() };

  mocks.loadProviderRuntimeData.mockReset();
  mocks.loadProviderRuntimeData.mockImplementation(async (_tenantDb: string, ref: { key: string }) => ({
    record: { key: ref.key, type: 'file', status: 'active', driver: 'memory-files', settings: {}, metadata: {} },
    credentials: {},
  }));
  mocks.createRuntime.mockReset();
  mocks.createRuntime.mockImplementation(async (_driver: string, context: { tenantId: string }) => runtimes[context.tenantId]);
  mocks.convert.mockReset();
  mocks.convert.mockResolvedValue({ markdown: '# a' });

  db = createMockDb();
  (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  db.findFileBucketByKey.mockImplementation((async (tenantId: string) => ({
    _id: 'b1', tenantId, projectId: PROJECT, key: 'docs', name: 'Docs', providerKey: 'store', status: 'active', createdBy: 'u1',
  })) as never);
  db.findFileRecordByKey.mockImplementation((async () => ({
    _id: 'f1', tenantId: 'tenant', providerKey: 'store', bucketKey: 'docs', key: 'a.txt', name: 'a.txt', size: 3, markdownStatus: 'skipped', createdBy: 'u1',
  })) as never);
  db.createFileRecord.mockImplementation((async (input: Record<string, unknown>) => ({ _id: 'f1', ...input })) as never);
  db.updateFileRecord.mockImplementation((async (id: string, patch: Record<string, unknown>) => ({ _id: id, ...patch })) as never);
  db.listFileRecordsByKeys.mockResolvedValue([] as never);
});

afterEach(() => {
  runtimePool.invalidateByPrefix(FILE_RUNTIME_POOL_PREFIX);
  resetAllCircuits();
  setConfigSource(ORIGINAL_SOURCE);
});

const circuitKeys = () => [...getAllCircuitStates().keys()].sort();

describe('the breaker key of a file operation', () => {
  it('upload: file-upload:<tenantId>:<providerKey>', async () => {
    runtimes.t1.uploadFile.mockRejectedValue(outage());
    await expect(upload('t1')).rejects.toMatchObject({ status: 503 });

    expect(circuitKeys()).toEqual(['file-upload:t1:store']);
    expect(getCircuitState('file-upload:t1:store')).toMatchObject({ failures: 1 });
  });

  it('download: file-download:<tenantId>:<providerKey>', async () => {
    runtimes.t1.downloadFile.mockRejectedValue(outage());
    await expect(download('t1')).rejects.toMatchObject({ status: 503 });

    expect(circuitKeys()).toEqual(['file-download:t1:store']);
  });

  it('delete: file-delete:<tenantId>:<providerKey>', async () => {
    runtimes.t1.deleteFile.mockRejectedValue(outage());
    await expect(remove('t1')).rejects.toMatchObject({ status: 503 });

    expect(circuitKeys()).toEqual(['file-delete:t1:store']);
  });

  it('rewriting a file\'s content is an upload', async () => {
    runtimes.t1.uploadFile.mockRejectedValue(outage());
    await expect(replace('t1')).rejects.toMatchObject({ status: 503 });

    expect(circuitKeys()).toEqual(['file-upload:t1:store']);
  });

  it('the text copy written after an upload is guarded by the same upload circuit', async () => {
    runtimes.t1.uploadFile
      .mockResolvedValueOnce({ handle: { key: 'docs/a.txt', name: 'a.txt', size: 3 } })
      .mockRejectedValueOnce(outage());

    await upload('t1', { convertToMarkdown: true });

    // The original is stored; the failed text copy is recorded, and counted on this tenant's upload circuit only.
    expect(db.updateFileRecord).toHaveBeenCalledWith('f1', expect.objectContaining({ markdownStatus: 'failed' }));
    expect(circuitKeys()).toEqual(['file-upload:t1:store']);
    expect(getCircuitState('file-upload:t1:store')).toMatchObject({ failures: 1 });
  });

  it('never uses a key without the tenant', async () => {
    runtimes.t1.uploadFile.mockRejectedValue(outage());
    runtimes.t1.downloadFile.mockRejectedValue(outage());
    runtimes.t1.deleteFile.mockRejectedValue(outage());
    await expect(upload('t1')).rejects.toBeDefined();
    await expect(download('t1')).rejects.toBeDefined();
    await expect(remove('t1')).rejects.toBeDefined();

    expect(getCircuitState('file-upload:store')).toBeUndefined();
    expect(getCircuitState('file-download:store')).toBeUndefined();
    expect(getCircuitState('file-delete:store')).toBeUndefined();
    expect(circuitKeys()).toEqual(['file-delete:t1:store', 'file-download:t1:store', 'file-upload:t1:store']);
  });
});

describe('two tenants with the same provider key', () => {
  it('keep separate breakers: an outage of one tenant\'s storage leaves the other tenant\'s circuit closed', async () => {
    runtimes.t1.uploadFile.mockRejectedValue(outage());

    for (let i = 0; i < THRESHOLD; i += 1) {
      await expect(upload('t1')).rejects.toMatchObject({ status: 503 });
    }
    expect(getCircuitState('file-upload:t1:store')?.state).toBe('open');
    await expect(upload('t1')).rejects.toBeInstanceOf(CircuitOpenError);
    expect(runtimes.t1.uploadFile).toHaveBeenCalledTimes(THRESHOLD);

    // Same provider key, healthy storage, other tenant: served as usual.
    const { record } = await upload('t2');
    expect(record.key).toMatch(/^a-\d+-[0-9a-f]{8}\.txt$/);
    expect(runtimes.t2.uploadFile).toHaveBeenCalledTimes(1);
    expect(getCircuitState('file-upload:t2:store')).toMatchObject({ state: 'closed', failures: 0 });
  });

  it('keep their own failure counts', async () => {
    runtimes.t1.downloadFile.mockRejectedValue(outage());
    runtimes.t2.downloadFile.mockRejectedValue(outage());

    await expect(download('t1')).rejects.toBeDefined();
    await expect(download('t1')).rejects.toBeDefined();
    await expect(download('t2')).rejects.toBeDefined();

    expect(getCircuitState('file-download:t1:store')).toMatchObject({ failures: 2 });
    expect(getCircuitState('file-download:t2:store')).toMatchObject({ failures: 1 });
  });
});

describe('what counts against the file breaker', () => {
  it('a refusal (403) never opens it: the next call still reaches the storage', async () => {
    runtimes.t1.uploadFile.mockRejectedValue(refusal());

    for (let i = 0; i < THRESHOLD * 2; i += 1) {
      await expect(upload('t1')).rejects.toMatchObject({ statusCode: 403 });
    }

    expect(getCircuitState('file-upload:t1:store')).toMatchObject({ state: 'closed', failures: 0 });
    expect(runtimes.t1.uploadFile).toHaveBeenCalledTimes(THRESHOLD * 2);
  });

  it('a missing object in the AWS SDK shape ($metadata.httpStatusCode 404) does not count either', async () => {
    runtimes.t1.downloadFile.mockRejectedValue(Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } }));

    for (let i = 0; i < THRESHOLD * 2; i += 1) {
      await expect(download('t1')).rejects.toMatchObject({ name: 'NoSuchKey' });
    }

    expect(getCircuitState('file-download:t1:store')).toMatchObject({ state: 'closed', failures: 0 });
  });

  it('a setting the endpoint policy refuses does not count', async () => {
    runtimes.t1.uploadFile.mockRejectedValue(new ProviderEndpointError('endpoint', 'private addresses are not allowed'));

    for (let i = 0; i < THRESHOLD * 2; i += 1) {
      await expect(upload('t1')).rejects.toMatchObject({ name: 'ProviderEndpointError' });
    }

    expect(getCircuitState('file-upload:t1:store')).toMatchObject({ state: 'closed', failures: 0 });
  });

  it('a header Node refuses to write (a non-Latin-1 file name in object metadata) never opens it: the next valid upload still goes through', async () => {
    gatewayConfig({ GATEWAY_RETRY_ENABLED: 'true', GATEWAY_RETRY_MAX_ATTEMPTS: '3', GATEWAY_RETRY_INITIAL_DELAY_MS: '1' });
    const headerError = (code: string) =>
      Object.assign(new TypeError('Invalid character in header content ["x-amz-meta-originalname"]'), { code });

    for (const code of ['ERR_INVALID_CHAR', 'ERR_INVALID_HTTP_TOKEN']) {
      runtimes.t1.uploadFile.mockReset();
      runtimes.t1.uploadFile.mockRejectedValue(headerError(code));
      for (let i = 0; i < THRESHOLD * 2; i += 1) {
        await expect(upload('t1')).rejects.toMatchObject({ code });
      }
      // Every call reached the storage client once (nothing retried) and the circuit never moved.
      expect(runtimes.t1.uploadFile).toHaveBeenCalledTimes(THRESHOLD * 2);
      expect(getCircuitState('file-upload:t1:store')).toMatchObject({ state: 'closed', failures: 0 });
    }

    // A tenant's next upload with an ordinary name is served: the bad ones did not cut it off.
    runtimes.t1.uploadFile.mockReset();
    runtimes.t1.uploadFile.mockImplementation(async (input: { key: string; name: string; data: Buffer }) => ({
      handle: { key: input.key, name: input.name, size: input.data.length },
    }));
    await expect(upload('t1')).resolves.toMatchObject({ record: { name: 'a.txt' } });
  });

  it('a key the store does not hold (ENOENT, ENOTDIR, a 404-coded not-found) is not retried and never opens the download circuit', async () => {
    gatewayConfig({ GATEWAY_RETRY_ENABLED: 'true', GATEWAY_RETRY_MAX_ATTEMPTS: '3', GATEWAY_RETRY_INITIAL_DELAY_MS: '1' });
    const missing = [
      Object.assign(new Error("ENOENT: no such file or directory, open '/data/files/t1/store/a.txt'"), { code: 'ENOENT' }),
      Object.assign(new Error("ENOTDIR: not a directory, open '/data/files/t1/store/a.txt/b'"), { code: 'ENOTDIR' }),
      Object.assign(new Error('File not found: a.txt'), { statusCode: 404 }),
    ];

    for (const error of missing) {
      runtimes.t1.downloadFile.mockReset();
      runtimes.t1.downloadFile.mockRejectedValue(error);
      for (let i = 0; i < THRESHOLD * 2; i += 1) {
        await expect(download('t1')).rejects.toBe(error);
      }
      expect(runtimes.t1.downloadFile).toHaveBeenCalledTimes(THRESHOLD * 2);
      expect(getCircuitState('file-download:t1:store')).toMatchObject({ state: 'closed', failures: 0 });
    }
  });

  it('outages do: after the threshold the circuit is open and the storage is left alone', async () => {
    runtimes.t1.deleteFile.mockRejectedValue(outage());

    for (let i = 0; i < THRESHOLD; i += 1) {
      await expect(remove('t1')).rejects.toMatchObject({ status: 503 });
    }
    await expect(remove('t1')).rejects.toBeInstanceOf(CircuitOpenError);

    expect(runtimes.t1.deleteFile).toHaveBeenCalledTimes(THRESHOLD);
    expect(getCircuitState('file-delete:t1:store')?.state).toBe('open');
  });

  it('an unclassified error counts, as before', async () => {
    runtimes.t1.downloadFile.mockRejectedValue(new Error('socket hang up'));
    for (let i = 0; i < THRESHOLD; i += 1) {
      await expect(download('t1')).rejects.toThrow('socket hang up');
    }

    expect(getCircuitState('file-download:t1:store')?.state).toBe('open');
  });

  it('a refusal is not retried and an outage is', async () => {
    gatewayConfig({ GATEWAY_RETRY_ENABLED: 'true', GATEWAY_RETRY_MAX_ATTEMPTS: '3', GATEWAY_RETRY_INITIAL_DELAY_MS: '1' });

    runtimes.t1.downloadFile.mockRejectedValue(refusal());
    await expect(download('t1')).rejects.toMatchObject({ statusCode: 403 });
    expect(runtimes.t1.downloadFile).toHaveBeenCalledTimes(1);

    runtimes.t2.downloadFile.mockRejectedValue(outage());
    await expect(download('t2')).rejects.toMatchObject({ status: 503 });
    expect(runtimes.t2.downloadFile).toHaveBeenCalledTimes(3);
    // The retried outage is one failure on the books, not three.
    expect(getCircuitState('file-download:t2:store')).toMatchObject({ failures: 1 });
  });
});

describe('isTransientStorageError', () => {
  const withProps = (message: string, props: Record<string, unknown>) => Object.assign(new Error(message), props);
  const carriers = (status: number) => [
    withProps('failed', { status }),
    withProps('failed', { statusCode: status }),
    withProps('failed', { $metadata: { httpStatusCode: status } }),
  ];

  it.each([408, 429, 500, 502, 503, 504])('HTTP %i is an outage, however the SDK reports it', (status) => {
    for (const error of carriers(status)) expect(isTransientStorageError(error)).toBe(true);
  });

  it.each([400, 401, 403, 404, 405, 409, 410, 412, 413, 416, 422])('HTTP %i is the caller\'s to fix', (status) => {
    for (const error of carriers(status)) expect(isTransientStorageError(error)).toBe(false);
  });

  it('network failures, timeouts and unclassified errors are outages', () => {
    expect(isTransientStorageError(new Error('socket hang up'))).toBe(true);
    expect(isTransientStorageError(withProps('refused', { code: 'ECONNREFUSED' }))).toBe(true);
    expect(isTransientStorageError(withProps('reset', { code: 'ECONNRESET' }))).toBe(true);
    expect(isTransientStorageError(new RequestTimeoutError('file-upload:t1:store', 1000))).toBe(true);
    expect(isTransientStorageError(withProps('redirected', { status: 301 }))).toBe(true);
  });

  it('a value that is not an error object is treated as unclassified', () => {
    for (const value of [undefined, null, 'boom', 42, {}]) expect(isTransientStorageError(value)).toBe(true);
  });

  it('an error that declares retryable decides, over its status', () => {
    expect(isTransientStorageError(withProps('classified', { retryable: false }))).toBe(false);
    expect(isTransientStorageError(withProps('classified', { retryable: false, status: 503 }))).toBe(false);
    expect(isTransientStorageError(withProps('classified', { retryable: true }))).toBe(true);
    expect(isTransientStorageError(withProps('classified', { retryable: true, status: 403 }))).toBe(true);
    expect(isTransientStorageError(withProps('classified', { retryable: 'no', status: 403 }))).toBe(false);
  });

  it('a refused setting or endpoint is never an outage', () => {
    expect(isTransientStorageError(new ProviderSettingsError('caCertificate', 'The certificate bundle is not valid.'))).toBe(false);
    expect(isTransientStorageError(new ProviderEndpointError('endpoint', 'private addresses are not allowed'))).toBe(false);
    expect(isTransientStorageError(new OutboundNetworkError('Outbound request to a private network address is blocked'))).toBe(false);
  });

  it('a resolver that is down is an outage, unlike an address the policy refused', () => {
    expect(isTransientStorageError(new OutboundDnsError('Could not resolve the host'))).toBe(true);
    expect(isTransientStorageError(new OutboundNetworkError('Refusing outbound request to private/loopback host: storage.internal'))).toBe(false);
  });

  it('the refusals say so themselves: the error classes declare retryable, nothing matches on their names', () => {
    expect(new ProviderSettingsError('endpoint', 'x')).toMatchObject({ retryable: false });
    expect(new ProviderEndpointError('endpoint', 'x')).toMatchObject({ retryable: false });
    expect(new OutboundNetworkError('x')).toMatchObject({ retryable: false });
    expect(new OutboundDnsError('x')).toMatchObject({ retryable: true });
    // A look-alike without the declaration is just an unclassified error.
    expect(isTransientStorageError(withProps('outbound refused', { name: 'OutboundNetworkError' }))).toBe(true);
  });

  it.each(['ERR_INVALID_CHAR', 'ERR_INVALID_HTTP_TOKEN'])('%s (Node refusing to write a header) is the request\'s fault, not an outage', (code) => {
    expect(isTransientStorageError(Object.assign(new TypeError('Invalid character in header content ["x-amz-meta-name"]'), { code }))).toBe(false);
  });

  it.each(['ENOENT', 'ENOTDIR', 'EISDIR'])('%s (a path that is not there, or is a directory) is the request\'s fault, not an outage', (code) => {
    expect(isTransientStorageError(withProps(`${code}: no such file or directory, open '/data/a.txt'`, { code }))).toBe(false);
  });

  it('other file-system and network codes are still outages', () => {
    for (const code of ['EMFILE', 'EIO', 'ENOSPC', 'EAGAIN', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'ERR_INVALID_URL']) {
      expect(isTransientStorageError(withProps('failed', { code })), code).toBe(true);
    }
  });

  it('a not-found that carries the 404 its store would have is not an outage', () => {
    expect(isTransientStorageError(withProps('File not found: a.txt', { statusCode: 404 }))).toBe(false);
  });

  it('follows the retry rules: what withResilience gives up on at once is no outage either', () => {
    for (const message of ['Unauthorized', 'Access Forbidden', 'Invalid API key provided', 'upload rejected, status: 413']) {
      expect(isTransientStorageError(new Error(message)), message).toBe(false);
    }
    expect(isTransientStorageError(new Error('request failed with status 503'))).toBe(true);
  });
});
