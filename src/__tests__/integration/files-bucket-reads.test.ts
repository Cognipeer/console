/**
 * What the Document Store's bucket screens read, over a real SQLite database and the real drivers' contracts
 * (services/files/fileReads.ts): in the bucket list each bucket's numbers and its provider's health, in the provider
 * list each provider's health and where it keeps files, and on a bucket's page the agents that keep session files
 * there and where its files physically are. The unit tests pin the decisions with mocks; this proves the pieces fit -
 * the stored records, the one grouped read for the numbers, the agent lookup (draft and published versions) and each
 * driver's own words for "where".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const hoisted = vi.hoisted(() => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/database', () => ({ getDatabase: hoisted.getDatabase }));

import type { IAgentConfig } from '@/lib/database';
import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import { providerRegistry } from '@/lib/providers';
import { FileServiceError } from '@/lib/services/files/errors';
import { getFileBucketDetail, listFileBucketItems, listFileProviderItems } from '@/lib/services/files/fileReads';

const DB_NAME = 'tenant_bucket_reads';
const PROJECT = 'proj-1';
const OTHER_PROJECT = 'proj-2';
const SECRET = 'ENC-SECRET-VALUE-THAT-MUST-NOT-LEAK';

let db: SQLiteProvider;
let tmpDir: string;
let tenantId: string;

const provider = (key: string, driver: string, settings: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) => db.createProvider({
  tenantId, projectId: PROJECT, key, type: 'file', driver, label: `Provider ${key}`, status: 'active',
  credentialsEnc: SECRET, settings, createdBy: 'u1', ...overrides,
} as never);
const bucket = (key: string, providerKey: string, overrides: Record<string, unknown> = {}) => db.createFileBucket({
  tenantId, projectId: PROJECT, key, name: `Bucket ${key}`, providerKey, status: 'active', createdBy: 'u1', ...overrides,
} as never);
const put = (bucketKey: string, key: string, size: number, overrides: Record<string, unknown> = {}) => db.createFileRecord({
  tenantId, projectId: PROJECT, providerKey: 's3-main', bucketKey, key, name: key.split('/').pop()!, size,
  contentType: 'text/plain', markdownStatus: 'skipped', createdBy: 'u1', ...overrides,
} as never);
const agent = (key: string, config: IAgentConfig, projectId = PROJECT) => db.createAgent({
  tenantId, projectId, key, name: `Agent ${key}`, config, status: 'active', createdBy: 'u1',
});
const publish = async (agentId: string, key: string, config: IAgentConfig, version: number) => {
  await db.createAgentVersion({
    tenantId, projectId: PROJECT, agentId, agentKey: key, version,
    snapshot: { name: key, config, status: 'active' }, publishedBy: 'u1',
  } as never);
  await db.updateAgent(agentId, { publishedVersion: version });
};
const attachmentsOn = (bucketKey: string, enabled = true): IAgentConfig => ({ modelKey: 'm', attachments: { enabled, bucketKey } });

beforeEach(async () => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'bucket-reads-'));
  db = new SQLiteProvider(tmpDir, 'test_main');
  await db.connect();
  hoisted.getDatabase.mockResolvedValue(db);
  const tenant = await db.createTenant({ companyName: 'Acme', slug: 'acme-bucket-reads', dbName: DB_NAME, licenseType: 'FREE', ownerId: 'owner-1' });
  tenantId = String(tenant._id);
  await db.switchToTenant(DB_NAME);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.disconnect();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── The bucket list ───────────────────────────────────────────────────────

describe('listFileBucketItems: the buckets of a project with their numbers and their provider\'s health', () => {
  /** Eight buckets on five kinds of provider state, with files in two of them. */
  const seed = async () => {
    const s3 = await provider('s3-main', 'aws-s3-files', { bucket: 'files', region: 'eu-west-1', prefix: 'console' });
    await db.updateProvider(String(s3._id), { lastTest: { ok: true, at: '2026-10-19T08:30:00.000Z', latencyMs: 90, message: 'Connected to the bucket.' } });
    await provider('disk', 'local-filesystem', { basePath: '/srv/data' }, { credentialsEnc: '' });
    const minio = await provider('minio', 's3-compatible-files', { bucket: 'media', endpoint: 'https://minio.example.com:9000' });
    await db.updateProvider(String(minio._id), { lastTest: { ok: false, at: '2026-10-18T07:00:00.000Z', latencyMs: 0, message: 'The secret access key is wrong.' } });
    await provider('off', 'aws-s3-files', { bucket: 'files' }, { status: 'disabled' });
    // Exists in the tenant but is given to another project only.
    await db.createProvider({ tenantId, projectId: OTHER_PROJECT, key: 'elsewhere', type: 'file', driver: 'aws-s3-files', label: 'Elsewhere', status: 'active', credentialsEnc: SECRET, settings: { bucket: 'x' }, createdBy: 'u1' });

    await bucket('docs', 's3-main', { prefix: 'invoices' });
    await bucket('scratch', 'disk');
    await bucket('media', 'minio');
    await bucket('archived', 's3-main', { status: 'disabled' });
    await bucket('on-off', 'off');
    await bucket('orphan', 'deleted-provider');
    await bucket('foreign', 'elsewhere');
    await bucket('emptying', 's3-main', { metadata: { deleting: true } });
    // Another project's bucket is not listed.
    await db.createFileBucket({ tenantId, projectId: OTHER_PROJECT, key: 'theirs', name: 'Theirs', providerKey: 's3-main', status: 'active', createdBy: 'u1' } as never);

    await put('docs', 'a.txt', 100);
    await put('docs', 'b.pdf', 200, { contentType: 'application/pdf', markdownStatus: 'succeeded', markdownKey: 'b.md', markdownSize: 50 });
    await put('docs', 'sessions/x.txt', 7, { purpose: 'conversation', conversationId: 'c1', agentKey: 'bot' });
    await put('media', 'clip.bin', 1000, { providerKey: 'minio' });
    // Not docs: the same bucket key under another provider, and another project's files.
    await put('docs', 'other-provider.txt', 5000, { providerKey: 'second-s3' });
    await put('docs', 'other-project.txt', 9000, { projectId: OTHER_PROJECT });
  };

  const listed = async () => {
    const items = await listFileBucketItems(DB_NAME, tenantId, PROJECT);
    return { items, by: Object.fromEntries(items.map((item) => [item.key, item])) };
  };

  it('lists every bucket of the project - and no other project\'s', async () => {
    await seed();
    const { items } = await listed();
    expect(items.map((item) => item.key).sort()).toEqual(['archived', 'docs', 'emptying', 'foreign', 'media', 'on-off', 'orphan', 'scratch']);
  });

  it('adds up each bucket: its files, and the bytes of the originals and their Markdown copies', async () => {
    await seed();
    const { by } = await listed();
    expect(by.docs!.stats).toEqual({ fileCount: 3, totalBytes: 100 + 200 + 50 + 7 });
    expect(by.media!.stats).toEqual({ fileCount: 1, totalBytes: 1000 });
  });

  it('shows zero, not nothing, for a bucket that holds no file', async () => {
    await seed();
    const { by } = await listed();
    for (const key of ['scratch', 'archived', 'on-off', 'orphan', 'foreign', 'emptying']) {
      expect(by[key]!.stats, key).toEqual({ fileCount: 0, totalBytes: 0 });
    }
  });

  it('reads all the numbers in ONE grouped query, never one per bucket, and lists no file', async () => {
    await seed();
    const stats = vi.spyOn(db, 'listFileBucketStats');
    const records = vi.spyOn(db, 'listFileRecords');
    const { items } = await listed();
    expect(items).toHaveLength(8);
    expect(stats).toHaveBeenCalledTimes(1);
    const [asked] = stats.mock.calls[0]!;
    expect(asked?.buckets).toHaveLength(8);
    expect(records).not.toHaveBeenCalled();
  });

  it('never calls a storage provider: health is what the last test said', async () => {
    await seed();
    const createRuntime = vi.spyOn(providerRegistry, 'createRuntime');
    await listed();
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it('reports each provider\'s health from its stored test and status', async () => {
    await seed();
    const { by } = await listed();
    expect(by.docs!.providerHealth).toEqual({ state: 'ok', testedAt: '2026-10-19T08:30:00.000Z', message: 'Connected to the bucket.' });
    expect(by.media!.providerHealth).toEqual({ state: 'failed', testedAt: '2026-10-18T07:00:00.000Z', message: 'The secret access key is wrong.' });
    expect(by.scratch!.providerHealth).toEqual({ state: 'builtin' });
    expect(by['on-off']!.providerHealth).toEqual({ state: 'inactive', message: 'The storage provider is switched off.' });
  });

  it('calls a bucket whose provider is gone, or never given to the project, inactive - and shows no provider for it', async () => {
    await seed();
    const { by } = await listed();
    for (const key of ['orphan', 'foreign']) {
      expect(by[key]!.providerHealth, key).toEqual({
        state: 'inactive', message: 'The storage provider no longer exists or is not available to this project.',
      });
      expect(by[key], key).not.toHaveProperty('provider');
    }
  });

  it('keeps a switched-off bucket in the list with its own status (its provider\'s health is separate)', async () => {
    await seed();
    const { by } = await listed();
    expect(by.archived).toMatchObject({ status: 'disabled', providerHealth: { state: 'ok' }, stats: { fileCount: 0 } });
  });

  it('marks a bucket the "delete with its files" job is working on - and only that one', async () => {
    await seed();
    const { items, by } = await listed();
    expect(by.emptying!.deleting).toBe(true);
    expect(items.filter((item) => 'deleting' in item).map((item) => item.key)).toEqual(['emptying']);
  });

  it('carries the bucket as the plain listing did (id, name, provider key, prefix) and its provider with the driver\'s capabilities', async () => {
    await seed();
    const { by } = await listed();
    expect(by.docs).toMatchObject({
      id: expect.any(String), key: 'docs', name: 'Bucket docs', providerKey: 's3-main', prefix: 'invoices', status: 'active',
      provider: { key: 's3-main', label: 'Provider s3-main', driver: 'aws-s3-files', hasCredentials: true },
    });
    expect(by.docs!.provider!.driverCapabilities).toBeDefined();
    expect(by.scratch!.provider!.driverCapabilities).toMatchObject({ builtin: true });
  });

  it('never carries a credential', async () => {
    await seed();
    const { items } = await listed();
    const text = JSON.stringify(items);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('credentialsEnc');
  });

  it('is empty for a project with no bucket yet', async () => {
    expect(await listFileBucketItems(DB_NAME, tenantId, PROJECT)).toEqual([]);
  });
});

// ── The provider list ─────────────────────────────────────────────────────

describe('listFileProviderItems: the providers of a project with their health and where they keep files', () => {
  const seed = async () => {
    const s3 = await provider('s3-main', 'aws-s3-files', { bucket: 'files', region: 'eu-west-1', prefix: 'console' });
    await db.updateProvider(String(s3._id), { lastTest: { ok: true, at: '2026-10-19T08:30:00.000Z', latencyMs: 90, message: 'Connected to the bucket.' } });
    await provider('disk', 'local-filesystem', { basePath: '/srv/data' }, { credentialsEnc: '' });
    await provider('grid', 'mongodb-gridfs-files', { bucketName: 'uploads' });
    await provider('azure', 'azure-blob-files', { container: 'files', accountName: 'acme', authMethod: 'accountKey' }, { status: 'disabled' });
    await db.createProvider({ tenantId, projectId: OTHER_PROJECT, key: 'elsewhere', type: 'file', driver: 'aws-s3-files', label: 'Elsewhere', status: 'active', credentialsEnc: SECRET, settings: { bucket: 'x' }, createdBy: 'u1' });
    // Not a file provider.
    await db.createProvider({ tenantId, projectId: PROJECT, key: 'vec', type: 'vector', driver: 'x', label: 'V', status: 'active', credentialsEnc: SECRET, settings: {}, createdBy: 'u1' });
  };

  it('lists the file providers of the project, each with its health and the base of its storage location', async () => {
    await seed();
    const providers = await listFileProviderItems(DB_NAME, tenantId, PROJECT);
    const view = Object.fromEntries(providers.map((item) => [item.key, [item.providerHealth?.state, item.storageLocationBase]]));
    expect(view).toEqual({
      's3-main': ['ok', `s3://files/console/${tenantId}/s3-main/`],
      disk: ['builtin', null],
      grid: ['untested', `MongoDB GridFS · uploads/${tenantId}/grid/`],
      azure: ['inactive', `https://acme.blob.core.windows.net/files/${tenantId}/azure/`],
    });
  });

  it('keeps what the plain listing had, and no credential', async () => {
    await seed();
    const providers = await listFileProviderItems(DB_NAME, tenantId, PROJECT);
    const s3 = providers.find((item) => item.key === 's3-main')!;
    expect(s3).toMatchObject({ driver: 'aws-s3-files', label: 'Provider s3-main', status: 'active', hasCredentials: true, settings: { bucket: 'files' } });
    expect(s3.driverCapabilities).toBeDefined();
    expect(JSON.stringify(providers)).not.toContain(SECRET);
  });

  it('narrows the list by the filters it is given', async () => {
    await seed();
    const providers = await listFileProviderItems(DB_NAME, tenantId, PROJECT, { status: 'active', driver: 'mongodb-gridfs-files' });
    expect(providers.map((item) => item.key)).toEqual(['grid']);
  });
});

// ── One bucket ────────────────────────────────────────────────────────────

describe('getFileBucketDetail: one bucket for its page', () => {
  it('is the list\'s row plus who uses the bucket and where its files are', async () => {
    const s3 = await provider('s3-main', 'aws-s3-files', { bucket: 'files', region: 'eu-west-1', prefix: 'console' });
    await db.updateProvider(String(s3._id), { lastTest: { ok: true, at: '2026-10-19T08:30:00.000Z', latencyMs: 90, message: 'Connected to the bucket.' } });
    await bucket('docs', 's3-main', { prefix: 'invoices' });
    await put('docs', 'a.txt', 100);
    await put('docs', 'b.pdf', 200, { markdownStatus: 'succeeded', markdownKey: 'b.md', markdownSize: 50 });

    const detail = await getFileBucketDetail(DB_NAME, tenantId, PROJECT, 'docs');
    expect(detail).toMatchObject({
      key: 'docs', name: 'Bucket docs', providerKey: 's3-main', status: 'active',
      stats: { fileCount: 2, totalBytes: 350 },
      providerHealth: { state: 'ok', testedAt: '2026-10-19T08:30:00.000Z' },
      provider: { key: 's3-main' },
      usedBy: [],
      storageLocation: `s3://files/console/${tenantId}/s3-main/invoices/`,
    });
    expect(JSON.stringify(detail)).not.toContain(SECRET);
  });

  it('answers a missing bucket - and another project\'s - with a typed 404', async () => {
    await provider('s3-main', 'aws-s3-files', { bucket: 'files' });
    await db.createFileBucket({ tenantId, projectId: OTHER_PROJECT, key: 'theirs', name: 'Theirs', providerKey: 's3-main', status: 'active', createdBy: 'u1' } as never);

    for (const key of ['nobody', 'theirs']) {
      const failure = await getFileBucketDetail(DB_NAME, tenantId, PROJECT, key).catch((error) => error);
      expect(failure, key).toBeInstanceOf(FileServiceError);
      expect(failure, key).toMatchObject({ code: 'bucket_not_found', status: 404 });
    }
  });

  it('still answers for a switched-off bucket whose provider is gone: it is read from the database alone', async () => {
    await bucket('old', 'deleted-provider', { status: 'disabled', prefix: 'old-stuff' });
    await put('old', 'a.txt', 10, { providerKey: 'deleted-provider' });
    const createRuntime = vi.spyOn(providerRegistry, 'createRuntime');

    const detail = await getFileBucketDetail(DB_NAME, tenantId, PROJECT, 'old');

    expect(createRuntime).not.toHaveBeenCalled();
    expect(detail).toMatchObject({
      key: 'old', status: 'disabled', stats: { fileCount: 1, totalBytes: 10 },
      providerHealth: { state: 'inactive' }, usedBy: [], storageLocation: null,
    });
    expect(detail).not.toHaveProperty('provider');
  });

  it('marks the bucket the delete-with-files job is working on', async () => {
    await provider('s3-main', 'aws-s3-files', { bucket: 'files' });
    await bucket('emptying', 's3-main', { metadata: { deleting: true } });
    expect((await getFileBucketDetail(DB_NAME, tenantId, PROJECT, 'emptying')).deleting).toBe(true);
  });

  describe('usedBy: the agents that keep session files in the bucket', () => {
    beforeEach(async () => {
      await provider('s3-main', 'aws-s3-files', { bucket: 'files' });
      await bucket('docs', 's3-main');
    });

    const usedBy = async (key = 'docs') => (await getFileBucketDetail(DB_NAME, tenantId, PROJECT, key)).usedBy;

    it('names the agents of the project whose Files settings point at the bucket - switched on or not - and no others', async () => {
      const a = await agent('a', attachmentsOn('docs'));
      const b = await agent('b', attachmentsOn('docs', false));
      await agent('c', attachmentsOn('elsewhere'));
      await agent('d', { modelKey: 'm' });
      await agent('e', attachmentsOn('docs'), OTHER_PROJECT);

      expect(await usedBy()).toEqual([
        { agentId: String(a._id), agentKey: 'a', name: 'Agent a' },
        { agentId: String(b._id), agentKey: 'b', name: 'Agent b' },
      ]);
    });

    it('is empty for a bucket nobody keeps session files in', async () => {
      await agent('a', attachmentsOn('elsewhere'));
      expect(await usedBy()).toEqual([]);
    });

    it('addresses an agent by the id its page is under, not by its key', async () => {
      const made = await agent('lookup', attachmentsOn('docs'));
      const [user] = await usedBy();
      expect(user!.agentId).toBe(String(made._id));
      expect(user!.agentId).not.toBe('lookup');
    });

    it('also names an agent whose draft moved on but whose PUBLISHED version still keeps its files there', async () => {
      const moved = await agent('moved', attachmentsOn('scratch'));
      await publish(String(moved._id), 'moved', attachmentsOn('docs'), 1);
      // Draft and published both on the bucket: named once.
      const both = await agent('both', attachmentsOn('docs'));
      await publish(String(both._id), 'both', attachmentsOn('docs'), 1);
      // Only an older, no longer published version named it.
      const left = await agent('left', attachmentsOn('scratch'));
      await db.createAgentVersion({ tenantId, projectId: PROJECT, agentId: String(left._id), agentKey: 'left', version: 1, snapshot: { name: 'left', config: attachmentsOn('docs'), status: 'active' }, publishedBy: 'u1' } as never);
      await publish(String(left._id), 'left', attachmentsOn('scratch'), 2);

      expect((await usedBy()).map((user) => user.agentKey)).toEqual(['both', 'moved']);
    });

    it('lists them by name, then key, whatever order they were made in', async () => {
      await db.createAgent({ tenantId, projectId: PROJECT, key: 'z-key', name: 'Alpha', config: attachmentsOn('docs'), status: 'active', createdBy: 'u1' });
      await db.createAgent({ tenantId, projectId: PROJECT, key: 'a-key', name: 'Beta', config: attachmentsOn('docs'), status: 'active', createdBy: 'u1' });
      await db.createAgent({ tenantId, projectId: PROJECT, key: 'm-key', name: 'Alpha', config: attachmentsOn('docs'), status: 'active', createdBy: 'u1' });
      expect((await usedBy()).map((user) => user.agentKey)).toEqual(['m-key', 'z-key', 'a-key']);
    });

    it('is the same answer the bucket_in_use check gives for a delete (one source)', async () => {
      await agent('a', attachmentsOn('docs'));
      await agent('b', attachmentsOn('docs'));
      const { findAgentsUsingBucket } = await import('@/lib/services/agents/sessionFilesBucket');
      const guard = await findAgentsUsingBucket(DB_NAME, PROJECT, 'docs');
      expect((await usedBy()).map((user) => user.agentKey)).toEqual(guard.map((use) => use.key));
    });
  });

  describe('storageLocation: where the bucket\'s files are, per driver', () => {
    const detailOf = async (driver: string, settings: Record<string, unknown>, bucketOverrides: Record<string, unknown> = {}) => {
      await provider('prov', driver, settings);
      await bucket('docs', 'prov', bucketOverrides);
      return getFileBucketDetail(DB_NAME, tenantId, PROJECT, 'docs');
    };

    it('S3: the bucket, the provider\'s base prefix, the tenant and provider, then the bucket\'s own prefix', async () => {
      const detail = await detailOf('aws-s3-files', { bucket: 'files', region: 'eu-west-1', prefix: 'console/prod' }, { prefix: 'invoices/2026' });
      expect(detail.storageLocation).toBe(`s3://files/console/prod/${tenantId}/prov/invoices/2026/`);
    });

    it('uses the bucket key as the prefix when the bucket has none, as the file service does', async () => {
      const detail = await detailOf('aws-s3-files', { bucket: 'files' });
      expect(detail.storageLocation).toBe(`s3://files/${tenantId}/prov/docs/`);
    });

    it('is the provider\'s own base for a bucket whose prefix is empty', async () => {
      const detail = await detailOf('aws-s3-files', { bucket: 'files' }, { prefix: '' });
      expect(detail.storageLocation).toBe(`s3://files/${tenantId}/prov/`);
    });

    it('S3-compatible: the path first, then the server that holds it', async () => {
      const detail = await detailOf('s3-compatible-files', { bucket: 'media', endpoint: 'https://minio.example.com:9000' }, { prefix: 'clips' });
      expect(detail.storageLocation).toBe(`s3://media/${tenantId}/prov/clips/ · minio.example.com:9000`);
    });

    it('Azure Blob: the account, the container, the tenant and provider, then the bucket\'s prefix', async () => {
      const detail = await detailOf('azure-blob-files', { container: 'files', accountName: 'acme', authMethod: 'accountKey' }, { prefix: 'reports' });
      expect(detail.storageLocation).toBe(`https://acme.blob.core.windows.net/files/${tenantId}/prov/reports/`);
    });

    it('MongoDB GridFS: the GridFS bucket, the tenant and provider, then the bucket\'s prefix', async () => {
      const detail = await detailOf('mongodb-gridfs-files', { bucketName: 'uploads' }, { prefix: 'reports' });
      expect(detail.storageLocation).toBe(`MongoDB GridFS · uploads/${tenantId}/prov/reports/`);
    });

    it('the server\'s own disk: not shown (it would be a server path)', async () => {
      const detail = await detailOf('local-filesystem', { basePath: '/srv/console-data', subdirectory: 'files' });
      expect(detail.storageLocation).toBeNull();
    });

    it('never carries a credential or a server path, whatever the provider holds', async () => {
      await provider('prov', 'aws-s3-files', { bucket: 'files', accessKeyId: 'AKIA-LEAK', secretAccessKey: 'shh-leak' });
      await bucket('docs', 'prov');
      const detail = await getFileBucketDetail(DB_NAME, tenantId, PROJECT, 'docs');
      expect(detail.storageLocation).not.toMatch(/AKIA|leak/);
    });
  });
});
