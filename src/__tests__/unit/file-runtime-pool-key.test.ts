/**
 * Unit tests — the pooled file runtime follows the provider's settings
 *
 * The file service pooled a runtime under a hash of the provider's credentials
 * only, so editing the bucket, endpoint or auth method of a provider kept using
 * the old runtime until its cache entry expired. The key now covers driver,
 * credentials and settings, ignores key order, and the runtime it replaces is
 * released.
 */

import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadProviderRuntimeData: vi.fn(),
  createRuntime: vi.fn(),
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
    getContract: vi.fn().mockReturnValue({ id: 'aws-s3-files', capabilities: { upload: true, download: true } }),
    createRuntime: mocks.createRuntime,
  },
}));
vi.mock('@cognipeer/to-markdown', () => ({ convertToMarkdown: vi.fn() }));
vi.mock('@/lib/core/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

import { getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';
import { hashCredentials, hashRuntimeConfig, runtimePool } from '@/lib/core/runtimePool';
import { getDatabase } from '@/lib/database';
import { downloadFile, FILE_RUNTIME_POOL_PREFIX } from '@/lib/services/files/fileService';
import { createMockDb } from '../helpers/db.mock';

interface FakeRuntime {
  id: number;
  driver: string;
  settings: Record<string, unknown>;
  close: ReturnType<typeof vi.fn>;
  downloadFile: ReturnType<typeof vi.fn>;
}

interface StoredProvider {
  driver: string;
  settings: Record<string, unknown>;
  credentials: Record<string, unknown>;
}

const ORIGINAL_SOURCE = getConfigSource();
const PROJECT = 'p1';

/** The provider each tenant currently has stored under the key `store`. */
const stored = new Map<string, StoredProvider>();
let created: FakeRuntime[] = [];

function setProvider(tenantId: string, provider: Partial<StoredProvider> = {}) {
  stored.set(tenantId, {
    driver: 'aws-s3-files',
    settings: { bucket: 'docs', region: 'eu-west-1' },
    credentials: { accessKeyId: 'AKIA-TEST', secretAccessKey: 'secret-1' },
    ...provider,
  });
}

/**
 * One service call that builds (or reuses) the tenant's file runtime. A download does; listing and reading a
 * file's metadata do not (they read the database, so they work while the provider is down).
 */
async function touch(tenantId: string) {
  await downloadFile('tenant_db', tenantId, PROJECT, 'docs', 'a.txt');
}

/** Let the pool's queued close() calls run. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  stored.clear();
  created = [];
  // Close an evicted runtime at once instead of after the production grace period.
  const source: ConfigSource = {
    name: 'test',
    get: (key) => (key === 'PROVIDER_RUNTIME_DISPOSE_GRACE_SECONDS' ? '0' : process.env[key]),
  };
  setConfigSource(source);

  mocks.loadProviderRuntimeData.mockReset();
  mocks.loadProviderRuntimeData.mockImplementation(async (_tenantDb: string, ref: { tenantId: string; key: string }) => {
    const provider = stored.get(ref.tenantId);
    if (!provider) throw new Error(`no provider for ${ref.tenantId}`);
    return {
      record: { key: ref.key, type: 'file', status: 'active', driver: provider.driver, settings: provider.settings, metadata: {} },
      credentials: provider.credentials,
    };
  });
  mocks.createRuntime.mockReset();
  mocks.createRuntime.mockImplementation(async (driver: string, context: { settings: Record<string, unknown> }) => {
    const runtime: FakeRuntime = {
      id: created.length + 1,
      driver,
      settings: context.settings,
      close: vi.fn(),
      downloadFile: vi.fn(async () => ({ data: Buffer.from('x'), size: 1 })),
    };
    created.push(runtime);
    return runtime;
  });

  const db = createMockDb();
  (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  db.findFileBucketByKey.mockImplementation((async (tenantId: string) => ({
    _id: 'b1', tenantId, projectId: PROJECT, key: 'docs', name: 'Docs', providerKey: 'store', status: 'active', createdBy: 'u1',
  })) as never);
  db.findFileRecordByKey.mockResolvedValue({
    _id: 'f1', tenantId: 't1', projectId: PROJECT, providerKey: 'store', bucketKey: 'docs', key: 'a.txt', name: 'a.txt', size: 1, markdownStatus: 'skipped', createdBy: 'u1',
  } as never);
});

afterEach(async () => {
  runtimePool.invalidateByPrefix(FILE_RUNTIME_POOL_PREFIX);
  runtimePool.invalidateByPrefix('file:');
  await flush();
  setConfigSource(ORIGINAL_SOURCE);
});

describe('the pooled file runtime', () => {
  it('is reused while neither the credentials nor the settings change', async () => {
    setProvider('t1');
    await touch('t1');
    await touch('t1');
    await touch('t1');

    expect(mocks.createRuntime).toHaveBeenCalledTimes(1);
    expect(created[0].close).not.toHaveBeenCalled();
  });

  it('is rebuilt when a setting is edited, with the edited settings, and the old one is released', async () => {
    setProvider('t1', { settings: { bucket: 'docs', endpoint: 'https://old.example.com' } });
    await touch('t1');

    setProvider('t1', { settings: { bucket: 'docs', endpoint: 'https://new.example.com' } });
    await touch('t1');
    await touch('t1');
    await flush();

    expect(mocks.createRuntime).toHaveBeenCalledTimes(2);
    expect(created[1].settings).toEqual({ bucket: 'docs', endpoint: 'https://new.example.com' });
    expect(created[0].close).toHaveBeenCalledTimes(1);
    expect(created[1].close).not.toHaveBeenCalled();
  });

  it('is rebuilt when a setting is added or removed', async () => {
    setProvider('t1', { settings: { bucket: 'docs' } });
    await touch('t1');
    setProvider('t1', { settings: { bucket: 'docs', createBucketIfMissing: true } });
    await touch('t1');
    setProvider('t1', { settings: { bucket: 'docs' } });
    await touch('t1');

    expect(mocks.createRuntime).toHaveBeenCalledTimes(3);
  });

  it('is not rebuilt when the same settings arrive in a different key order', async () => {
    setProvider('t1', {
      settings: { bucket: 'docs', region: 'eu-west-1', tls: { caCertificate: 'pem', allowInsecureTls: false } },
      credentials: { accessKeyId: 'AKIA-TEST', secretAccessKey: 'secret-1' },
    });
    await touch('t1');

    setProvider('t1', {
      settings: { tls: { allowInsecureTls: false, caCertificate: 'pem' }, region: 'eu-west-1', bucket: 'docs' },
      credentials: { secretAccessKey: 'secret-1', accessKeyId: 'AKIA-TEST' },
    });
    await touch('t1');
    await flush();

    expect(mocks.createRuntime).toHaveBeenCalledTimes(1);
    expect(created[0].close).not.toHaveBeenCalled();
  });

  it('is rebuilt when the credentials change, as before', async () => {
    setProvider('t1');
    await touch('t1');
    setProvider('t1', { credentials: { accessKeyId: 'AKIA-TEST', secretAccessKey: 'secret-2' } });
    await touch('t1');
    await flush();

    expect(mocks.createRuntime).toHaveBeenCalledTimes(2);
    expect(created[0].close).toHaveBeenCalledTimes(1);
  });

  it('is rebuilt when the driver behind the same provider key changes', async () => {
    setProvider('t1', { driver: 'aws-s3-files', settings: { bucket: 'docs' }, credentials: {} });
    await touch('t1');
    setProvider('t1', { driver: 'local-files', settings: { bucket: 'docs' }, credentials: {} });
    await touch('t1');

    expect(mocks.createRuntime).toHaveBeenCalledTimes(2);
    expect(created.map((runtime) => runtime.driver)).toEqual(['aws-s3-files', 'local-files']);
  });

  it('is kept per tenant: the same provider key in two tenants is two runtimes, and editing one leaves the other', async () => {
    setProvider('t1');
    setProvider('t2');
    await touch('t1');
    await touch('t2');
    expect(mocks.createRuntime).toHaveBeenCalledTimes(2);

    setProvider('t1', { settings: { bucket: 'other' } });
    await touch('t1');
    await touch('t2');
    await flush();

    expect(mocks.createRuntime).toHaveBeenCalledTimes(3);
    const [first, second] = created;
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).not.toHaveBeenCalled();
  });

  describe('when requests arrive together', () => {
    /** Holds every runtime that is being built until the test lets go, so the requests really overlap. */
    function holdBuilds() {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const build = mocks.createRuntime.getMockImplementation()!;
      mocks.createRuntime.mockImplementation(async (driver: string, context: { settings: Record<string, unknown> }) => {
        await gate;
        return build(driver, context);
      });
      return release;
    }

    it('builds one runtime for the first requests of a provider, and every request uses it', async () => {
      setProvider('t1');
      const release = holdBuilds();

      const requests = [touch('t1'), touch('t1'), touch('t1'), touch('t1')];
      await flush();
      release();
      await Promise.all(requests);
      await flush();

      expect(mocks.createRuntime).toHaveBeenCalledTimes(1);
      expect(created).toHaveLength(1);
      expect(created[0].close).not.toHaveBeenCalled();

      // The one runtime is the pooled one.
      await touch('t1');
      expect(mocks.createRuntime).toHaveBeenCalledTimes(1);
    });

    it('builds one runtime for the requests that follow a settings edit, and releases the one it replaces', async () => {
      setProvider('t1', { settings: { bucket: 'docs', endpoint: 'https://old.example.com' } });
      await touch('t1');

      setProvider('t1', { settings: { bucket: 'docs', endpoint: 'https://new.example.com' } });
      const release = holdBuilds();
      const requests = [touch('t1'), touch('t1'), touch('t1')];
      await flush();
      release();
      await Promise.all(requests);
      await flush();

      expect(mocks.createRuntime).toHaveBeenCalledTimes(2);
      expect(created[1].settings).toEqual({ bucket: 'docs', endpoint: 'https://new.example.com' });
      expect(created[0].close).toHaveBeenCalledTimes(1);
      expect(created[1].close).not.toHaveBeenCalled();
    });

    it('does not share a build between tenants that use the same provider key', async () => {
      setProvider('t1');
      setProvider('t2');
      const release = holdBuilds();

      const requests = [touch('t1'), touch('t2'), touch('t1'), touch('t2')];
      await flush();
      release();
      await Promise.all(requests);

      expect(mocks.createRuntime).toHaveBeenCalledTimes(2);
    });
  });
});

describe('the pool the file service keeps its runtimes in', () => {
  /** Another caller's runtime of the same provider: the sandbox volumes pool theirs under `file:<tenant>:<key>`, hashed their own way. */
  function foreignRuntime() {
    return { close: vi.fn(), tag: 'foreign' };
  }

  it('is its own: a runtime another caller pooled under file:<tenant>:<key> is neither evicted nor closed by a file call', async () => {
    setProvider('t1');
    const foreign = foreignRuntime();
    await runtimePool.getOrCreate('file:t1:store', 'a-hash-of-the-credentials-only', async () => foreign);

    await touch('t1');
    await touch('t1');
    await flush();

    expect(mocks.createRuntime).toHaveBeenCalledTimes(1);
    expect(foreign.close).not.toHaveBeenCalled();
    // Still the pooled one: asking again with its hash builds nothing.
    const factory = vi.fn(async () => foreignRuntime());
    expect(await runtimePool.getOrCreate('file:t1:store', 'a-hash-of-the-credentials-only', factory)).toBe(foreign);
    expect(factory).not.toHaveBeenCalled();
  });

  it('does not lose its own runtime to that caller either: the two alternate without rebuilding each other', async () => {
    setProvider('t1');
    const foreign = foreignRuntime();

    for (let round = 0; round < 3; round += 1) {
      await runtimePool.getOrCreate('file:t1:store', 'a-hash-of-the-credentials-only', async () => foreign);
      await touch('t1');
    }
    await flush();

    expect(mocks.createRuntime).toHaveBeenCalledTimes(1);
    expect(created[0].close).not.toHaveBeenCalled();
    expect(foreign.close).not.toHaveBeenCalled();
  });

  it('keeps its runtimes under file-runtime:<tenant>:<key>, which is what FILE_RUNTIME_POOL_PREFIX names', async () => {
    setProvider('t1');
    await touch('t1');
    const adopted = vi.fn(async () => ({ close: vi.fn(), tag: 'rebuilt' }));

    // With the hash the file service used, the entry is the one it made: nothing is rebuilt.
    const settings = { bucket: 'docs', region: 'eu-west-1' };
    const credentials = { accessKeyId: 'AKIA-TEST', secretAccessKey: 'secret-1' };
    const pooled = await runtimePool.getOrCreate(
      `${FILE_RUNTIME_POOL_PREFIX}t1:store`,
      hashRuntimeConfig({ driver: 'aws-s3-files', credentials, settings }),
      adopted,
    );

    expect(FILE_RUNTIME_POOL_PREFIX).toBe('file-runtime:');
    expect(pooled).toBe(created[0]);
    expect(adopted).not.toHaveBeenCalled();
  });
});

describe('hashRuntimeConfig', () => {
  const base = {
    driver: 'aws-s3-files',
    credentials: { accessKeyId: 'AKIA-TEST', secretAccessKey: 'secret-1' },
    settings: { bucket: 'docs', endpoint: 'https://s3.example.com', tags: [{ k: 'a', v: '1' }, { k: 'b', v: '2' }] },
  };

  it('is a short hex digest', () => {
    expect(hashRuntimeConfig(base)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is the same for the same config', () => {
    expect(hashRuntimeConfig(structuredClone(base))).toBe(hashRuntimeConfig(base));
  });

  it('changes with the driver, a credential or a setting', () => {
    const hash = hashRuntimeConfig(base);
    const variants = [
      { ...base, driver: 'azure-blob-files' },
      { ...base, credentials: { ...base.credentials, secretAccessKey: 'secret-2' } },
      { ...base, settings: { ...base.settings, bucket: 'other' } },
      { ...base, settings: { ...base.settings, endpoint: 'https://s3.example.org' } },
      { ...base, settings: { ...base.settings, extra: true } },
      { ...base, settings: { bucket: 'docs', tags: base.settings.tags } },
      { ...base, settings: { ...base.settings, tags: [{ k: 'b', v: '2' }, { k: 'a', v: '1' }] } },
    ];
    for (const variant of variants) {
      expect(hashRuntimeConfig(variant)).not.toBe(hash);
    }
  });

  it('does not depend on key order, at any depth', () => {
    const reordered = {
      settings: { tags: [{ v: '1', k: 'a' }, { v: '2', k: 'b' }], endpoint: 'https://s3.example.com', bucket: 'docs' },
      credentials: { secretAccessKey: 'secret-1', accessKeyId: 'AKIA-TEST' },
      driver: 'aws-s3-files',
    };
    expect(hashRuntimeConfig(reordered)).toBe(hashRuntimeConfig(base));
  });

  it('keeps the old credentials hash as it was for the model and vector pools', () => {
    const credentials = { secretAccessKey: 'secret-1', accessKeyId: 'AKIA-TEST' };
    expect(hashCredentials(credentials)).toBe(createHash('sha256').update(JSON.stringify(credentials)).digest('hex').slice(0, 16));
  });
});
