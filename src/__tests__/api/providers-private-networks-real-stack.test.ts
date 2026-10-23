/**
 * Saving a provider on SaaS through the REAL providers plugin, the REAL permission gate and the REAL provider service
 * over a real SQLite database with two organizations. Organization A has opened 10.50.0.0/16 (`PROVIDER_PRIVATE_NETWORKS`),
 * organization B has not:
 *
 *  - POST /api/providers?scope=tenant answers 201 for A and stores the provider; the same body from B is answered 400
 *    `provider_endpoint_not_allowed` with a reason that names no address, and nothing is stored;
 *  - the three file stores (S3-compatible, Azure Blob connection string, MongoDB GridFS) and an inference provider are
 *    held to the same rule, and so is a name that answers with an address of the network;
 *  - POST /api/providers/test (nothing is saved or dialled for a refusal) gives B the same 400.
 *
 * DNS is answered by a mock; nothing is sent to any address.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ getDatabase: vi.fn() }));

// The code under test reads the database through these two functions only.
vi.mock('@/lib/database', () => ({
  getDatabase: hoisted.getDatabase,
  runWithTenantScope: async (tenantDbName: string, fn: (db: any) => unknown) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const db = await hoisted.getDatabase();
    return db.runWithTenant(tenantDbName, () => fn(db));
  },
}));
vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));

const dns = vi.hoisted(() => ({ answers: new Map<string, string[]>() }));
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (host: string) => {
    const addresses = dns.answers.get(host);
    if (!addresses) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  }),
  resolveSrv: vi.fn(async (name: string) => {
    throw Object.assign(new Error(`querySrv ENODATA ${name}`), { code: 'ENODATA' });
  }),
}));

import { drainPendingTasks } from '@/lib/core/asyncTask';
import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import { configureIamEngine, resetIamEngineForTests } from '@/lib/iam/engine';
import { resetEnforceStatsForTests } from '@/lib/iam/enforce';
import { resetPrincipalCacheForTests } from '@/lib/iam/principalCache';
import { resetProjectNarrowingCachesForTests } from '@/lib/iam/projectNarrowing';
import { resetResourceAuthzThrottleForTests } from '@/lib/iam/resourceAuthz';
import { resetResourceAuthzStatsForTests } from '@/lib/iam/resourceAuthzStats';
import { providersApiPlugin } from '@/server/api/plugins/providers';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';
import { restoreDeployment, SAAS, useDeployment } from '../helpers/providerNetworks';

const NEUTRAL = 'private network addresses are reachable only through networks the operator has opened for this organization';
const KEY = Buffer.alloc(64, 3).toString('base64');

interface Org {
  id: string;
  slug: string;
  dbName: string;
  ownerId: string;
  email: string;
}

let dir: string;
let db: SQLiteProvider;
let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
let orgA: Org;
let orgB: Org;

async function createOrg(slug: string): Promise<Org> {
  const dbName = `tenant_${slug}`;
  const tenant = await db.createTenant({ companyName: `Org ${slug}`, slug, dbName, licenseType: 'FREE', ownerId: `owner-${slug}` });
  const id = String(tenant._id);
  await db.switchToTenant(dbName);
  const owner = await db.createUser({ tenantId: id, email: `owner@${slug}.io`, name: `Owner ${slug}`, password: '$2b$10$x', role: 'owner', licenseId: 'FREE', features: [] });
  return { id, slug, dbName, ownerId: String(owner._id), email: `owner@${slug}.io` };
}

beforeEach(async () => {
  vi.clearAllMocks();
  dns.answers.clear();
  dir = mkdtempSync(path.join(tmpdir(), 'providers-private-networks-'));
  db = new SQLiteProvider(dir, 'test_main');
  await db.connect();
  hoisted.getDatabase.mockResolvedValue(db);
  resetPrincipalCacheForTests();
  resetIamEngineForTests();
  resetProjectNarrowingCachesForTests();
  resetEnforceStatsForTests();
  resetResourceAuthzThrottleForTests();
  resetResourceAuthzStatsForTests();
  configureIamEngine({ validateRequests: true, versionCheckMs: 5_000 });

  orgA = await createOrg('org-a');
  orgB = await createOrg('org-b');
  useDeployment({ ...SAAS, PROVIDER_PRIVATE_NETWORKS: `${orgA.id}=10.50.0.0/16` });

  app = await createFastifyApiTestApp(providersApiPlugin);
  await app.ready();
});

afterEach(async () => {
  restoreDeployment();
  await app.close();
  await drainPendingTasks();
  await db.disconnect();
  rmSync(dir, { recursive: true, force: true });
});

function send(org: Org, url: string, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: `/api${url}`,
    headers: {
      'content-type': 'application/json',
      'x-tenant-db-name': org.dbName,
      'x-tenant-id': org.id,
      'x-tenant-slug': org.slug,
      'x-user-email': org.email,
      'x-user-id': org.ownerId,
      'x-user-role': 'owner',
      'x-license-type': 'FREE',
    },
    payload: JSON.stringify(payload),
  });
}
const create = (org: Org, payload: Record<string, unknown>) => send(org, '/providers?scope=tenant', payload);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (res: { body: string }): any => parseJsonBody(res.body);

async function stored(org: Org, key: string) {
  await db.switchToTenant(org.dbName);
  return db.findProviderByKey(org.id, key);
}

const s3 = (key: string, endpoint: string) => ({
  key,
  type: 'file',
  driver: 's3-compatible-files',
  label: 'Company MinIO',
  credentials: { accessKeyId: 'AKIATEST', secretAccessKey: 'secret-secret-secret' },
  settings: { endpoint, bucket: 'files-bkt' },
});

function expectRefused(res: { statusCode: number; body: string }, field: string): void {
  expect(res.statusCode, res.body).toBe(400);
  expect(json(res)).toStrictEqual({
    error: `Provider endpoint "${field}" is not allowed: ${NEUTRAL}`,
    code: 'provider_endpoint_not_allowed',
    field,
  });
  // the answer names no address, URL, credential or key
  for (const forbidden of ['10.50', 'AKIATEST', 'secret-secret', 'http', 'minio', KEY, 'appuser', 'hunter2']) {
    expect(res.body, forbidden).not.toContain(forbidden);
  }
}

describe('POST /api/providers?scope=tenant on SaaS', () => {
  it('stores an S3-compatible provider on an address of the organization\'s network, and refuses the same body from another organization', async () => {
    const accepted = await create(orgA, s3('minio-main', 'http://10.50.1.5:9000'));
    expect(accepted.statusCode, accepted.body).toBe(201);
    expect(json(accepted).provider).toMatchObject({ key: 'minio-main', type: 'file', driver: 's3-compatible-files', status: 'active' });
    expect(accepted.body).not.toContain('secret-secret');
    expect(await stored(orgA, 'minio-main')).toMatchObject({ tenantId: orgA.id, key: 'minio-main', settings: { endpoint: 'http://10.50.1.5:9000' } });

    const refused = await create(orgB, s3('minio-main', 'http://10.50.1.5:9000'));
    expectRefused(refused, 'endpoint');
    expect(await stored(orgB, 'minio-main')).toBeNull();
  });

  it('refuses an address outside the organization\'s network even for the organization that has one', async () => {
    expectRefused(await create(orgA, s3('minio-other', 'http://10.99.0.7:9000')), 'endpoint');
    expectRefused(await create(orgA, s3('minio-loopback', 'http://127.0.0.1:9000')), 'endpoint');
    expectRefused(await create(orgA, s3('minio-metadata', 'http://169.254.169.254')), 'endpoint');
    expect(await stored(orgA, 'minio-other')).toBeNull();
  });

  it('decides a name by the addresses it answers with, for each organization on its own', async () => {
    dns.answers.set('minio.corp.example', ['10.50.1.5']);
    dns.answers.set('mixed.corp.example', ['10.50.1.5', '10.99.0.7']);

    expect((await create(orgA, s3('by-name', 'http://minio.corp.example:9000'))).statusCode).toBe(201);
    expectRefused(await create(orgB, s3('by-name', 'http://minio.corp.example:9000')), 'endpoint');
    // organization B's refusal does not change what A is told about the same name
    expect((await create(orgA, s3('by-name-again', 'http://minio.corp.example:9000'))).statusCode).toBe(201);
    expectRefused(await create(orgA, s3('mixed', 'http://mixed.corp.example:9000')), 'endpoint');

    // and the other way round: a name B was refused first is still A's to use
    dns.answers.set('minio-b-first.corp.example', ['10.50.1.5']);
    expectRefused(await create(orgB, s3('b-first', 'http://minio-b-first.corp.example:9000')), 'endpoint');
    expect((await create(orgA, s3('a-second', 'http://minio-b-first.corp.example:9000'))).statusCode).toBe(201);
  });

  it('keeps refusing the addresses no network can open, even for an organization whose range covers every address', async () => {
    useDeployment({ ...SAAS, PROVIDER_PRIVATE_NETWORKS: `${orgA.id}=0.0.0.0/0,::/0` });
    for (const [index, endpoint] of ['http://169.254.169.254', 'http://127.0.0.1:9000', 'http://168.63.129.16', 'http://[::1]:9000', 'http://[fd00:ec2::254]'].entries()) {
      expectRefused(await create(orgA, s3(`never-${index}`, endpoint)), 'endpoint');
    }
    expect((await create(orgA, s3('anywhere-else', 'http://10.99.0.7:9000'))).statusCode).toBe(201);
    expectRefused(await create(orgB, s3('b-anywhere-else', 'http://10.99.0.7:9000')), 'endpoint');
  });

  it('a public address is accepted for every organization, as it was', async () => {
    for (const org of [orgA, orgB]) {
      const res = await create(org, s3('public-store', 'http://93.184.216.34:9000'));
      expect(res.statusCode, res.body).toBe(201);
    }
  });

  it('holds an Azure Blob connection string to the same rule', async () => {
    const azure = (key: string) => ({
      key,
      type: 'file',
      driver: 'azure-blob-files',
      label: 'Company Azurite',
      credentials: { connectionString: `AccountName=acctname1;AccountKey=${KEY};BlobEndpoint=https://10.50.1.5/acctname1` },
      settings: { authMethod: 'connectionString', container: 'files' },
    });
    const accepted = await create(orgA, azure('azure-main'));
    expect(accepted.statusCode, accepted.body).toBe(201);
    expect(accepted.body).not.toContain(KEY);
    expectRefused(await create(orgB, azure('azure-main')), 'connectionString');
    expect(await stored(orgB, 'azure-main')).toBeNull();
  });

  it('holds a MongoDB GridFS connection URI to the same rule', async () => {
    const gridfs = (key: string) => ({
      key,
      type: 'file',
      driver: 'mongodb-gridfs-files',
      label: 'Company MongoDB',
      credentials: { uri: 'mongodb://appuser:hunter2@10.50.1.5:27017/files' },
      settings: {},
    });
    const accepted = await create(orgA, gridfs('gridfs-main'));
    expect(accepted.statusCode, accepted.body).toBe(201);
    expect(accepted.body).not.toContain('hunter2');
    expectRefused(await create(orgB, gridfs('gridfs-main')), 'uri');
    expect(await stored(orgB, 'gridfs-main')).toBeNull();
  });

  it('holds an inference provider\'s base URL to the same rule', async () => {
    const model = (key: string) => ({
      key,
      type: 'model',
      driver: 'openai-compatible',
      label: 'Company vLLM',
      credentials: { apiKey: 'sk-test-key' },
      settings: { baseUrl: 'http://10.50.1.5:8000/v1' },
    });
    const accepted = await create(orgA, model('vllm-main'));
    expect(accepted.statusCode, accepted.body).toBe(201);
    expectRefused(await create(orgB, model('vllm-main')), 'baseUrl');
  });

  it('is the old behaviour for everyone when no network is configured', async () => {
    useDeployment(SAAS);
    expectRefused(await create(orgA, s3('minio-main', 'http://10.50.1.5:9000')), 'endpoint');
    expectRefused(await create(orgB, s3('minio-main', 'http://10.50.1.5:9000')), 'endpoint');
    expect((await create(orgA, s3('public-store', 'http://93.184.216.34:9000'))).statusCode).toBe(201);
  });

  it('a network opened for every organization (*) is open to organization B as well', async () => {
    useDeployment({ ...SAAS, PROVIDER_PRIVATE_NETWORKS: `${orgA.id}=10.50.0.0/16;*=100.64.10.0/24` });
    expect((await create(orgB, s3('wildcard-store', 'http://100.64.10.9:9000'))).statusCode).toBe(201);
    expectRefused(await create(orgB, s3('minio-main', 'http://10.50.1.5:9000')), 'endpoint');
  });
});

describe('POST /api/providers/test on SaaS', () => {
  it('refuses organization B the same way, before anything is dialled', async () => {
    const res = await send(orgB, '/providers/test', s3('minio-main', 'http://10.50.1.5:9000'));
    expectRefused(res, 'endpoint');
    expect(await stored(orgB, 'minio-main')).toBeNull();
  });
});
