/**
 * Creating a file provider with `POST /client/v1/files/providers` needs only the files permission, so what a provider
 * may point at on the server's disk is decided by the provider service, not by the permission: the REAL route, the
 * REAL file service and the REAL provider service, over a stand-in database.
 *
 *  - the provider key is a folder name on the disk drivers, so one that goes up (`..`) or holds a separator is refused;
 *  - the base directory of the local disk driver is a directory of the server: refused on a shared deployment, and on a
 *    self-hosted one unless the person the call acts for is an owner or an admin (a request body cannot ask for it);
 *  - a relative subdirectory is open to everyone, as long as it stays inside the base directory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  auth: {
    token: 'tok',
    tokenRecord: { _id: 'tok-1', userId: 'user-1' },
    tenant: { licenseType: 'STARTER' },
    tenantId: 'tenant-1',
    tenantDbName: 'tenant_acme',
    projectId: 'proj-1',
    user: { _id: 'user-1', role: 'user' } as { _id: string; role: string } | null,
  },
  db: {
    switchToTenant: vi.fn(),
    findProviderByKey: vi.fn(),
    createProvider: vi.fn(),
  },
}));

vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));
vi.mock('@/server/api/fastify-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/api/fastify-utils')>();
  return {
    ...actual,
    // The token gate is covered by the rbac / route-declaration tests; the handler is under test here.
    withClientApiRequestContext: (handler: (...args: unknown[]) => unknown) =>
      (request: unknown, reply: unknown) => handler(request, reply, hoisted.auth),
    getApiTokenContextForRequest: async () => hoisted.auth,
  };
});
vi.mock('@/lib/database', () => ({
  getDatabase: async () => hoisted.db,
  runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(hoisted.db),
}));
vi.mock('@/lib/quota/quotaGuard', () => ({
  checkPerRequestLimits: vi.fn(async () => ({ allowed: true, effectiveLimits: {} })),
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  checkResourceQuota: vi.fn(async () => ({ allowed: true })),
}));
// Readable stand-ins for the sealed blob.
vi.mock('@/lib/utils/crypto', () => ({
  encryptObject: vi.fn((value: unknown) => `enc:${JSON.stringify(value)}`),
  decryptObject: vi.fn((blob: string) => JSON.parse(blob.slice(4))),
}));

import { getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';
import { clientFilesApiPlugin } from '@/server/api/plugins/client-files';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const original = getConfigSource();
function deployment(mode: 'saas' | 'onprem') {
  setConfigSource({ get: (key: string) => (key === 'DEPLOYMENT_MODE' ? mode : process.env[key]) } as ConfigSource);
}

let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

beforeEach(async () => {
  vi.clearAllMocks();
  deployment('saas');
  hoisted.auth.user = { _id: 'user-1', role: 'user' };
  hoisted.db.findProviderByKey.mockResolvedValue(null);
  hoisted.db.createProvider.mockImplementation(async (input: Record<string, unknown>) => ({ _id: 'prov-1', ...input }));
  app = await createFastifyApiTestApp(clientFilesApiPlugin);
});

afterEach(async () => {
  await app.close();
  setConfigSource(original);
});

const asRole = (role: string | null) => { hoisted.auth.user = role === null ? null : { _id: 'user-1', role }; };
function create(overrides: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: '/api/client/v1/files/providers',
    payload: {
      key: 'disk-2',
      driver: 'local-filesystem',
      label: 'Disk',
      credentials: {},
      settings: {},
      ...overrides,
    } as never,
  });
}
const json = (res: { body: string }) => parseJsonBody<Record<string, unknown>>(res.body);

function expectRefused(res: { statusCode: number; body: string }, field: string, message?: string | RegExp) {
  expect(res.statusCode, res.body).toBe(400);
  expect(json(res)).toMatchObject({ code: 'provider_settings_invalid', field });
  if (message) expect(String(json(res).error)).toMatch(message);
  expect(hoisted.db.createProvider).not.toHaveBeenCalled();
}

describe('the base directory of a local disk provider', () => {
  it.each(['owner', 'admin'])('is accepted from %s of a self-hosted deployment', async (role) => {
    deployment('onprem');
    asRole(role);

    const res = await create({ settings: { basePath: '/srv/console-files' } });

    expect(res.statusCode, res.body).toBe(201);
    expect(hoisted.db.createProvider).toHaveBeenCalledWith(expect.objectContaining({
      key: 'disk-2',
      driver: 'local-filesystem',
      settings: { basePath: '/srv/console-files' },
    }));
    // what the caller was allowed to do is not part of the provider
    expect(JSON.stringify(hoisted.db.createProvider.mock.calls[0])).not.toContain('allowHostPaths');
  });

  it.each(['user', 'member', 'viewer', undefined])('is refused from a caller whose role is %s, on a self-hosted deployment too', async (role) => {
    deployment('onprem');
    asRole(role as string);

    expectRefused(await create({ settings: { basePath: '/srv/console-files' } }), 'basePath', /^Only an owner or an admin can choose the base directory/);
  });

  it('is refused from a token whose owner is unknown', async () => {
    deployment('onprem');
    asRole(null);

    expectRefused(await create({ settings: { basePath: '/srv/console-files' } }), 'basePath');
  });

  it.each(['owner', 'admin', 'user'])('is refused on a shared deployment, from %s as from anyone', async (role) => {
    asRole(role);

    expectRefused(await create({ settings: { basePath: '/srv/console-files' } }), 'basePath', /^A base directory can only be chosen on a self-hosted deployment/);
  });

  it('cannot be allowed by the request: a body that says so changes nothing', async () => {
    deployment('onprem');
    asRole('user');

    expectRefused(await create({ allowHostPaths: true, settings: { basePath: '/srv/console-files' } }), 'basePath');
    expectRefused(await create({ settings: { basePath: '/srv/console-files', allowHostPaths: true } }), 'basePath');
  });

  it('is not needed for the built-in data directory: a blank one is accepted from anyone, anywhere', async () => {
    for (const mode of ['saas', 'onprem'] as const) {
      deployment(mode);
      for (const settings of [{}, { basePath: '' }, { basePath: '  ' }]) {
        hoisted.db.createProvider.mockClear();
        const res = await create({ key: `disk-${mode}`, settings });
        expect(res.statusCode, res.body).toBe(201);
      }
    }
  });
});

describe('the subdirectory of a local disk provider', () => {
  it('is accepted from anyone when it stays inside the base directory', async () => {
    const res = await create({ settings: { subdirectory: 'archive/2026' } });

    expect(res.statusCode, res.body).toBe(201);
    expect(hoisted.db.createProvider).toHaveBeenCalledWith(expect.objectContaining({ settings: { subdirectory: 'archive/2026' } }));
  });

  it.each(['..', '../other', 'a/../../other', '/etc', 'C:\\data'])('is refused when it is %j', async (subdirectory) => {
    asRole('owner');
    deployment('onprem');

    expectRefused(await create({ settings: { subdirectory } }), 'subdirectory');
  });
});

describe('the key of a provider', () => {
  it.each(['..', '.', '../tenant-2/local', 'a/b', 'a\\b'])('is refused when it is %j: it is a folder name', async (key) => {
    asRole('owner');
    deployment('onprem');

    expectRefused(await create({ key, settings: { basePath: '/srv/console-files' } }), 'key', /^The provider key is used as a folder name/);
  });

  it('is refused for every driver, not only for the disk one', async () => {
    const res = await create({
      key: '../minio',
      driver: 's3-compatible-files',
      credentials: { accessKeyId: 'AKIATEST', secretAccessKey: 'secret-secret-secret' },
      settings: { endpoint: 'https://93.184.216.34:9000', bucket: 'files' },
    });

    expectRefused(res, 'key');
  });

  it.each(['minio-main', 'My Provider', 'a.b'])('takes %j', async (key) => {
    const res = await create({ key });

    expect(res.statusCode, res.body).toBe(201);
  });
});
