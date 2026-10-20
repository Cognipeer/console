/**
 * Unit tests - what the Document Store's screens read about buckets and providers (services/files/fileReads.ts):
 * a provider's health and where it keeps files, a bucket's numbers, who uses a bucket, and where its files are.
 *
 * The drivers' own contracts answer "where", so the real ones are used here (the registry hands them out by id).
 * Nothing here calls a storage provider: all of it is read from the database.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  contracts: {} as Record<string, unknown>,
  getProviderConfigByKey: vi.fn(),
  listProviderConfigs: vi.fn(),
  findAgentsUsingBucket: vi.fn(),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/core/logger', () => ({ createLogger: () => mocks.log }));
vi.mock('@/lib/providers', () => ({
  providerRegistry: {
    listDescriptors: vi.fn().mockReturnValue([]),
    getContract: (driver: string) => {
      const contract = mocks.contracts[driver];
      if (!contract) throw new Error(`Provider contract "${driver}" is not registered.`);
      return contract;
    },
  },
}));
vi.mock('@/lib/services/providers/providerService', () => ({
  createProviderConfig: vi.fn(),
  getProviderConfigByKey: mocks.getProviderConfigByKey,
  listProviderConfigs: mocks.listProviderConfigs,
  loadProviderRuntimeData: vi.fn(),
}));
vi.mock('@/lib/services/agents/sessionFilesBucket', () => ({ findAgentsUsingBucket: mocks.findAgentsUsingBucket }));
vi.mock('@cognipeer/to-markdown', () => ({ convertToMarkdown: vi.fn() }));

import { getDatabase, type IFileBucketRecord } from '@/lib/database';
import { AwsS3FileProviderContract } from '@/lib/providers/contracts/awsS3Files.contract';
import { AzureBlobFileProviderContract } from '@/lib/providers/contracts/azureBlobFiles.contract';
import { LocalFileProviderContract } from '@/lib/providers/contracts/localFile.contract';
import { MongoGridFsFileProviderContract } from '@/lib/providers/contracts/mongoGridFsFiles.contract';
import { S3CompatibleFileProviderContract } from '@/lib/providers/contracts/s3Compatible.contract';
import {
  describeBucketLocation,
  describeProviderHealth,
  getFileBucketDetail,
  listFileBucketItems,
  listFileProviderItems,
  storageLocationBaseOf,
} from '@/lib/services/files/fileReads';
import { createMockDb } from '../helpers/db.mock';

mocks.contracts['local-filesystem'] = LocalFileProviderContract;
mocks.contracts['mongodb-gridfs-files'] = MongoGridFsFileProviderContract;
mocks.contracts['aws-s3-files'] = AwsS3FileProviderContract;
mocks.contracts['s3-compatible-files'] = S3CompatibleFileProviderContract;
mocks.contracts['azure-blob-files'] = AzureBlobFileProviderContract;

const TENANT_DB = 'tenant_acme';
const TENANT = 'tenant-1';
const PROJECT = 'proj-1';

const providerOf = (over: Record<string, unknown> = {}) => ({
  id: 'prov-1', key: 's3-main', type: 'file', driver: 'aws-s3-files', label: 'S3', status: 'active',
  settings: { bucket: 'files', region: 'eu-west-1' }, hasCredentials: true, tenantId: TENANT, createdBy: 'u1', ...over,
});
const bucketOf = (over: Record<string, unknown> = {}) => ({
  _id: 'b1', tenantId: TENANT, projectId: PROJECT, key: 'docs', name: 'Docs', providerKey: 's3-main', status: 'active', prefix: 'docs', createdBy: 'u1', ...over,
}) as unknown as IFileBucketRecord;

// ── Provider health ───────────────────────────────────────────────────────

describe('describeProviderHealth', () => {
  const tested = (ok: boolean | null, extra: Record<string, unknown> = {}) => ({
    status: 'active' as const,
    driverCapabilities: { upload: true } as never,
    lastTest: { ok, at: '2026-10-19T08:30:00.000Z', latencyMs: 120, message: 'Connected to the bucket.', ...extra },
  });

  it('is inactive when the bucket\'s provider no longer exists or was never given to the project', () => {
    expect(describeProviderHealth(undefined)).toEqual({
      state: 'inactive',
      message: 'The storage provider no longer exists or is not available to this project.',
    });
  });

  it('is inactive when the provider is switched off or in error, whatever its last test said', () => {
    expect(describeProviderHealth({ ...tested(true), status: 'disabled' })).toEqual({ state: 'inactive', message: 'The storage provider is switched off.' });
    expect(describeProviderHealth({ ...tested(true), status: 'errored' })).toEqual({ state: 'inactive', message: 'The storage provider is in an error state.' });
  });

  it('is builtin for storage that needs no test (the server\'s own disk), tested or not', () => {
    expect(describeProviderHealth({ status: 'active', driverCapabilities: { builtin: true } as never })).toEqual({ state: 'builtin' });
    expect(describeProviderHealth({ ...tested(false), driverCapabilities: { builtin: true } as never })).toEqual({ state: 'builtin' });
  });

  it('is untested before any test, and when the driver has none to run', () => {
    expect(describeProviderHealth({ status: 'active', driverCapabilities: {} as never })).toEqual({ state: 'untested' });
    expect(describeProviderHealth({ status: 'active' })).toEqual({ state: 'untested' });
    expect(describeProviderHealth({ ...tested(null) })).toEqual({ state: 'untested', testedAt: '2026-10-19T08:30:00.000Z' });
  });

  it('is ok after a test that passed, with when it ran and what it said', () => {
    expect(describeProviderHealth(tested(true))).toEqual({ state: 'ok', testedAt: '2026-10-19T08:30:00.000Z', message: 'Connected to the bucket.' });
  });

  it('is failed after a test that did not pass', () => {
    expect(describeProviderHealth(tested(false, { message: 'The secret access key is wrong.' }))).toEqual({
      state: 'failed', testedAt: '2026-10-19T08:30:00.000Z', message: 'The secret access key is wrong.',
    });
  });

  it('reads the time of a test whether it is a Date or text, and leaves out one it cannot read', () => {
    expect(describeProviderHealth(tested(true, { at: new Date('2026-01-02T03:04:05.000Z') })).testedAt).toBe('2026-01-02T03:04:05.000Z');
    expect(describeProviderHealth(tested(true, { at: 'yesterday-ish' }))).not.toHaveProperty('testedAt');
  });

  it('keeps a long message to 500 characters and leaves out an empty one', () => {
    expect(describeProviderHealth(tested(false, { message: 'x'.repeat(900) })).message).toHaveLength(500);
    expect(describeProviderHealth(tested(true, { message: '' }))).not.toHaveProperty('message');
  });
});

// ── Where the files are ───────────────────────────────────────────────────

describe('storageLocationBaseOf: where a provider keeps files, per driver', () => {
  const base = (driver: string, settings: Record<string, unknown>, key = 'prov') => storageLocationBaseOf({ driver, key, settings } as never, 'tenant-1');

  it('is not shown for the server\'s own disk (a server path)', () => {
    expect(base('local-filesystem', { basePath: '/srv/console-data', subdirectory: 'files' })).toBeNull();
    expect(base('local-filesystem', {})).toBeNull();
  });

  it('names the GridFS bucket and the tenant and provider prefix', () => {
    expect(base('mongodb-gridfs-files', { database: 'console_files', bucketName: 'uploads' })).toBe('MongoDB GridFS · uploads/tenant-1/prov/');
    expect(base('mongodb-gridfs-files', {})).toMatch(/^MongoDB GridFS · .+\/tenant-1\/prov\/$/);
  });

  it('names the S3 bucket, the base prefix and the tenant and provider', () => {
    expect(base('aws-s3-files', { bucket: 'files', region: 'eu-west-1' })).toBe('s3://files/tenant-1/prov/');
    expect(base('aws-s3-files', { bucket: 'files', prefix: 'console/prod' })).toBe('s3://files/console/prod/tenant-1/prov/');
  });

  it('keeps the server of a custom endpoint out of the path a bucket prefix is added to', () => {
    // The S3 drivers write "<path> · <host>" so two servers with one bucket name can be told apart; the base is the path.
    expect(base('s3-compatible-files', { bucket: 'files', endpoint: 'https://minio.example.com:9000' })).toBe('s3://files/tenant-1/prov/');
    expect(base('aws-s3-files', { bucket: 'files', prefix: 'console', endpoint: 'https://minio.example.com' })).toBe('s3://files/console/tenant-1/prov/');
  });

  it('names the Azure account, container and the tenant and provider prefix', () => {
    expect(base('azure-blob-files', { container: 'files', accountName: 'acme', authMethod: 'accountKey' })).toBe('https://acme.blob.core.windows.net/files/tenant-1/prov/');
  });

  it('is not shown when the settings do not say (no bucket, no container)', () => {
    expect(base('aws-s3-files', {})).toBeNull();
    expect(base('azure-blob-files', {})).toBeNull();
  });

  it('always ends with a slash, so a bucket prefix can be appended', () => {
    for (const [driver, settings] of [
      ['mongodb-gridfs-files', {}],
      ['aws-s3-files', { bucket: 'files' }],
      ['azure-blob-files', { container: 'files' }],
    ] as const) {
      expect(base(driver, settings)?.endsWith('/'), driver).toBe(true);
    }
  });

  it('never contains a credential, however the provider is set up', () => {
    const settings = { bucket: 'files', accessKeyId: 'AKIA-LEAK', secretAccessKey: 'shh-leak', connectionString: 'AccountKey=leak', sasToken: 'sig=leak' };
    for (const driver of ['aws-s3-files', 's3-compatible-files', 'azure-blob-files', 'mongodb-gridfs-files']) {
      expect(base(driver, { ...settings, container: 'files' }) ?? '', driver).not.toMatch(/leak|AKIA/);
    }
  });

  it('is not shown, and does not fail, for a driver whose contract is missing', () => {
    expect(base('retired-driver', {})).toBeNull();
    expect(mocks.log.warn).toHaveBeenCalledWith('Could not describe the storage location of a file provider', expect.objectContaining({ driver: 'retired-driver' }));
  });

  it('does not fail on a contract that throws', () => {
    mocks.contracts['broken-driver'] = { describeStorageLocation: () => { throw new Error('boom'); } };
    expect(base('broken-driver', {})).toBeNull();
    delete mocks.contracts['broken-driver'];
  });

  it('adds the slash a contract left out', () => {
    mocks.contracts['bare-driver'] = { describeStorageLocation: () => 'bare://store' };
    expect(base('bare-driver', {})).toBe('bare://store/');
    delete mocks.contracts['bare-driver'];
  });

  it('does not take the middle dot of the GridFS location for a server name', () => {
    expect(base('mongodb-gridfs-files', { bucketName: 'uploads' })).toBe('MongoDB GridFS · uploads/tenant-1/prov/');
  });

  it('is not shown for a driver that does not describe its location', () => {
    mocks.contracts['silent-driver'] = {};
    expect(base('silent-driver', {})).toBeNull();
    delete mocks.contracts['silent-driver'];
  });
});

describe('describeBucketLocation: where one bucket\'s files are', () => {
  it('adds the bucket\'s own prefix to the provider\'s base', () => {
    expect(describeBucketLocation('s3://files/tenant-1/prov/', { key: 'docs', prefix: 'invoices/2026' })).toBe('s3://files/tenant-1/prov/invoices/2026/');
  });

  it('uses the bucket key as the prefix when the bucket has none (as the file service does)', () => {
    expect(describeBucketLocation('s3://files/tenant-1/prov/', { key: 'docs' })).toBe('s3://files/tenant-1/prov/docs/');
    expect(describeBucketLocation('s3://files/tenant-1/prov/', { key: 'docs', prefix: null })).toBe('s3://files/tenant-1/prov/docs/');
  });

  it('is the provider\'s base itself for a bucket whose prefix is empty', () => {
    expect(describeBucketLocation('s3://files/tenant-1/prov/', { key: 'docs', prefix: '' })).toBe('s3://files/tenant-1/prov/');
    expect(describeBucketLocation('s3://files/tenant-1/prov/', { key: 'docs', prefix: '/' })).toBe('s3://files/tenant-1/prov/');
  });

  it('tolerates slashes around the prefix', () => {
    expect(describeBucketLocation('s3://files/t/p/', { key: 'docs', prefix: '/a/b/' })).toBe('s3://files/t/p/a/b/');
  });

  it('is not shown when the provider\'s location is not', () => {
    expect(describeBucketLocation(null, { key: 'docs', prefix: 'x' })).toBeNull();
  });
});

// ── The provider list ─────────────────────────────────────────────────────

describe('listFileProviderItems', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('adds health and the location base to each provider', async () => {
    mocks.listProviderConfigs.mockResolvedValue([
      providerOf({ lastTest: { ok: true, at: '2026-10-19T08:30:00.000Z', latencyMs: 80, message: 'ok' } }),
      providerOf({ id: 'prov-2', key: 'disk', driver: 'local-filesystem', settings: { basePath: '/srv/data' } }),
      providerOf({ id: 'prov-3', key: 'grid', driver: 'mongodb-gridfs-files', settings: { bucketName: 'uploads' }, status: 'disabled' }),
    ]);
    const providers = await listFileProviderItems(TENANT_DB, TENANT, PROJECT, { driver: 'x' });

    expect(mocks.listProviderConfigs).toHaveBeenCalledWith(TENANT_DB, TENANT, { driver: 'x', type: 'file', projectId: PROJECT });
    expect(providers.map((provider) => [provider.key, provider.providerHealth?.state, provider.storageLocationBase])).toEqual([
      ['s3-main', 'ok', 's3://files/tenant-1/s3-main/'],
      ['disk', 'builtin', null],
      ['grid', 'inactive', 'MongoDB GridFS · uploads/tenant-1/grid/'],
    ]);
  });

  it('keeps what the plain provider list had (the driver\'s capabilities among it)', async () => {
    mocks.listProviderConfigs.mockResolvedValue([providerOf()]);
    mocks.contracts['aws-s3-files'] = { ...(AwsS3FileProviderContract as object), capabilities: { upload: true, download: true } };
    const [provider] = await listFileProviderItems(TENANT_DB, TENANT, PROJECT);
    mocks.contracts['aws-s3-files'] = AwsS3FileProviderContract;
    expect(provider).toMatchObject({ key: 's3-main', label: 'S3', driver: 'aws-s3-files', hasCredentials: true, driverCapabilities: { upload: true, download: true } });
  });
});

// ── The bucket list and a bucket's page ───────────────────────────────────

describe('listFileBucketItems', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    mocks.listProviderConfigs.mockResolvedValue([
      providerOf({ lastTest: { ok: false, at: '2026-10-19T08:30:00.000Z', latencyMs: 80, message: 'The secret access key is wrong.' } }),
      providerOf({ id: 'prov-2', key: 'disk', driver: 'local-filesystem', settings: {} }),
    ]);
    db.listFileBuckets.mockResolvedValue([
      bucketOf(),
      bucketOf({ _id: 'b2', key: 'scratch', name: 'Scratch', providerKey: 'disk', status: 'disabled', prefix: undefined }),
      bucketOf({ _id: 'b3', key: 'orphan', name: 'Orphan', providerKey: 'deleted-provider' }),
      bucketOf({ _id: 'b4', key: 'going', name: 'Going', metadata: { deleting: true } }),
    ]);
    db.listFileBucketStats.mockResolvedValue([
      { providerKey: 's3-main', bucketKey: 'docs', fileCount: 12, totalBytes: 3400 },
      { providerKey: 'disk', bucketKey: 'scratch', fileCount: 1, totalBytes: 5 },
    ]);
  });

  it('reads every number in ONE grouped read, for the project\'s buckets only', async () => {
    await listFileBucketItems(TENANT_DB, TENANT, PROJECT);
    expect(db.listFileBucketStats).toHaveBeenCalledTimes(1);
    expect(db.listFileBucketStats).toHaveBeenCalledWith({
      projectId: PROJECT,
      buckets: [
        { providerKey: 's3-main', bucketKey: 'docs' },
        { providerKey: 'disk', bucketKey: 'scratch' },
        { providerKey: 'deleted-provider', bucketKey: 'orphan' },
        { providerKey: 's3-main', bucketKey: 'going' },
      ],
    });
    expect(db.listFileBuckets).toHaveBeenCalledWith(TENANT, PROJECT);
  });

  it('puts each bucket\'s numbers on it, and zeros on a bucket with no files', async () => {
    const items = await listFileBucketItems(TENANT_DB, TENANT, PROJECT);
    expect(Object.fromEntries(items.map((item) => [item.key, item.stats]))).toEqual({
      docs: { fileCount: 12, totalBytes: 3400 },
      scratch: { fileCount: 1, totalBytes: 5 },
      orphan: { fileCount: 0, totalBytes: 0 },
      going: { fileCount: 0, totalBytes: 0 },
    });
  });

  it('does not mix up buckets of two providers that share a key', async () => {
    db.listFileBuckets.mockResolvedValue([bucketOf({ key: 'docs', providerKey: 's3-main' }), bucketOf({ _id: 'b9', key: 'docs', providerKey: 'disk' })]);
    db.listFileBucketStats.mockResolvedValue([{ providerKey: 'disk', bucketKey: 'docs', fileCount: 4, totalBytes: 40 }]);
    const items = await listFileBucketItems(TENANT_DB, TENANT, PROJECT);
    expect(items.map((item) => [item.providerKey, item.stats.fileCount])).toEqual([['s3-main', 0], ['disk', 4]]);
  });

  it('tells how each bucket\'s provider is doing', async () => {
    const items = await listFileBucketItems(TENANT_DB, TENANT, PROJECT);
    const health = Object.fromEntries(items.map((item) => [item.key, item.providerHealth.state]));
    expect(health).toEqual({ docs: 'failed', scratch: 'builtin', orphan: 'inactive', going: 'failed' });
    expect(items[0]!.providerHealth.message).toBe('The secret access key is wrong.');
  });

  it('attaches the provider where there is one, and says a bucket is being deleted', async () => {
    const items = await listFileBucketItems(TENANT_DB, TENANT, PROJECT);
    expect(items[0]).toMatchObject({ id: 'b1', key: 'docs', status: 'active', provider: { key: 's3-main' } });
    expect(items[2]).not.toHaveProperty('provider');
    expect(items.map((item) => item.deleting)).toEqual([undefined, undefined, undefined, true]);
    expect(items[0]).not.toHaveProperty('deleting');
    expect(items[0]).not.toHaveProperty('_id');
  });

  it('never calls a storage provider (the list opens while one is down)', async () => {
    await expect(listFileBucketItems(TENANT_DB, TENANT, PROJECT)).resolves.toHaveLength(4);
    // The only collaborators are the database and the provider list; no runtime is built.
    expect(mocks.getProviderConfigByKey).not.toHaveBeenCalled();
  });

  it('lists a project with no buckets without asking for any numbers', async () => {
    db.listFileBuckets.mockResolvedValue([]);
    expect(await listFileBucketItems(TENANT_DB, TENANT, PROJECT)).toEqual([]);
  });
});

describe('getFileBucketDetail', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.findFileBucketByKey.mockResolvedValue(bucketOf({ prefix: 'invoices' }));
    db.listFileBucketStats.mockResolvedValue([{ providerKey: 's3-main', bucketKey: 'docs', fileCount: 7, totalBytes: 700 }]);
    mocks.getProviderConfigByKey.mockResolvedValue(providerOf({ lastTest: { ok: true, at: '2026-10-19T08:30:00.000Z', latencyMs: 80, message: 'ok' } }));
    mocks.findAgentsUsingBucket.mockResolvedValue([]);
  });

  it('is the list\'s row plus who uses the bucket and where its files are', async () => {
    mocks.findAgentsUsingBucket.mockResolvedValue([
      { key: 'support', name: 'Support bot' },
      { key: 'sales', name: 'Sales bot', publishedOnly: true },
    ]);
    db.findAgentByKey.mockImplementation((async (key: string) => ({ _id: `id-of-${key}`, key })) as never);

    const detail = await getFileBucketDetail(TENANT_DB, TENANT, PROJECT, 'docs');
    expect(detail).toMatchObject({
      id: 'b1', key: 'docs', status: 'active',
      stats: { fileCount: 7, totalBytes: 700 },
      providerHealth: { state: 'ok', testedAt: '2026-10-19T08:30:00.000Z' },
      provider: { key: 's3-main' },
      usedBy: [
        { agentId: 'id-of-support', agentKey: 'support', name: 'Support bot' },
        { agentId: 'id-of-sales', agentKey: 'sales', name: 'Sales bot' },
      ],
      storageLocation: 's3://files/tenant-1/s3-main/invoices/',
    });
    expect(mocks.findAgentsUsingBucket).toHaveBeenCalledWith(TENANT_DB, PROJECT, 'docs');
    expect(db.findAgentByKey).toHaveBeenCalledWith('support', PROJECT);
    expect(db.listFileBucketStats).toHaveBeenCalledWith({ projectId: PROJECT, buckets: [{ providerKey: 's3-main', bucketKey: 'docs' }] });
  });

  it('names the server of a custom S3 endpoint after the bucket\'s path, not inside it', async () => {
    mocks.getProviderConfigByKey.mockResolvedValue(providerOf({ driver: 's3-compatible-files', settings: { bucket: 'files', endpoint: 'https://minio.example.com:9000' } }));
    const detail = await getFileBucketDetail(TENANT_DB, TENANT, PROJECT, 'docs');
    expect(detail.storageLocation).toBe('s3://files/tenant-1/s3-main/invoices/ · minio.example.com:9000');
  });

  it('lists nobody when no agent keeps session files in the bucket', async () => {
    expect((await getFileBucketDetail(TENANT_DB, TENANT, PROJECT, 'docs')).usedBy).toEqual([]);
  });

  it('leaves out an agent that was deleted between the two reads (it has no page to link to)', async () => {
    mocks.findAgentsUsingBucket.mockResolvedValue([{ key: 'gone', name: 'Gone' }, { key: 'support', name: 'Support bot' }]);
    db.findAgentByKey.mockImplementation((async (key: string) => (key === 'gone' ? null : { _id: 'a1', key })) as never);
    expect((await getFileBucketDetail(TENANT_DB, TENANT, PROJECT, 'docs')).usedBy).toEqual([{ agentId: 'a1', agentKey: 'support', name: 'Support bot' }]);
  });

  it('has zero numbers for a bucket with no files', async () => {
    db.listFileBucketStats.mockResolvedValue([]);
    expect((await getFileBucketDetail(TENANT_DB, TENANT, PROJECT, 'docs')).stats).toEqual({ fileCount: 0, totalBytes: 0 });
  });

  it('describes a switched-off bucket like any other', async () => {
    db.findFileBucketByKey.mockResolvedValue(bucketOf({ status: 'disabled' }));
    expect(await getFileBucketDetail(TENANT_DB, TENANT, PROJECT, 'docs')).toMatchObject({ status: 'disabled', storageLocation: expect.any(String) });
  });

  it('has no location and an inactive provider when the bucket\'s provider is gone', async () => {
    mocks.getProviderConfigByKey.mockResolvedValue(null);
    const detail = await getFileBucketDetail(TENANT_DB, TENANT, PROJECT, 'docs');
    expect(detail.storageLocation).toBeNull();
    expect(detail.providerHealth.state).toBe('inactive');
    expect(detail).not.toHaveProperty('provider');
  });

  it('has no location for the server\'s own disk', async () => {
    db.findFileBucketByKey.mockResolvedValue(bucketOf({ providerKey: 'disk' }));
    mocks.getProviderConfigByKey.mockResolvedValue(providerOf({ key: 'disk', driver: 'local-filesystem', settings: { basePath: '/srv/data' } }));
    const detail = await getFileBucketDetail(TENANT_DB, TENANT, PROJECT, 'docs');
    expect(detail.storageLocation).toBeNull();
    expect(detail.providerHealth).toEqual({ state: 'builtin' });
  });

  it('uses the bucket key as the prefix when the bucket has none', async () => {
    db.findFileBucketByKey.mockResolvedValue(bucketOf({ prefix: undefined }));
    expect((await getFileBucketDetail(TENANT_DB, TENANT, PROJECT, 'docs')).storageLocation).toBe('s3://files/tenant-1/s3-main/docs/');
  });

  it('is a 404 bucket_not_found for a bucket that does not exist', async () => {
    db.findFileBucketByKey.mockResolvedValue(null);
    await expect(getFileBucketDetail(TENANT_DB, TENANT, PROJECT, 'gone')).rejects.toMatchObject({ code: 'bucket_not_found', status: 404 });
  });
});
