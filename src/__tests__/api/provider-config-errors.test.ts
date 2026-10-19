/**
 * A provider configuration the console refuses - an endpoint the outbound guard does not allow
 * (`ProviderEndpointError`), a setting the driver cannot work with (`ProviderSettingsError`) - is the caller's to
 * fix: EVERY route that creates, updates or tests a provider answers it with 400 `{ error, code, field }`
 * (`sendProviderConfigError`), the dashboard and the client API alike: the generic provider routes and the
 * model, vector and file ones.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  session: { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', userId: 'user-1', userRole: 'owner' } as Record<string, string>,
  auth: {
    token: 'tok',
    tokenRecord: { _id: 'tok-1', userId: 'user-1' },
    tenant: { licenseType: 'STARTER' },
    tenantId: 'tenant-1',
    tenantDbName: 'tenant_acme',
    projectId: 'proj-1',
    user: { _id: 'user-1', role: 'owner' },
  },
  createProviderConfig: vi.fn(),
  updateProviderConfig: vi.fn(),
  getProviderConfigById: vi.fn(),
  loadProviderRuntimeData: vi.fn(),
  recordProviderTest: vi.fn(),
  resolveTenantProjectIds: vi.fn(),
  testProviderConnection: vi.fn(),
  createFileProvider: vi.fn(),
  createModelProvider: vi.fn(),
  createVectorProvider: vi.fn(),
  providersLog: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));
vi.mock('@/lib/core/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/core/logger')>();
  return {
    ...actual,
    // Only the dashboard providers API's logger is watched; every other scope logs as it always did.
    createLogger: (scope: string) => (scope === 'api:providers' ? hoisted.providersLog : actual.createLogger(scope)),
  };
});
vi.mock('@/server/api/fastify-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/api/fastify-utils')>();
  return {
    ...actual,
    // The permission gate is covered by the rbac / route-declaration tests; the handlers are under test here.
    withApiRequestContext: (handler: unknown) => handler,
    withClientApiRequestContext: (handler: (...args: unknown[]) => unknown) =>
      (request: unknown, reply: unknown) => handler(request, reply, hoisted.auth),
    getApiTokenContextForRequest: async () => hoisted.auth,
    requireSessionContext: () => hoisted.session,
    requireProjectContextForRequest: vi.fn(async () => ({ projectId: 'proj-ctx', session: hoisted.session })),
    sendProjectContextError: () => null,
  };
});
vi.mock('@/lib/services/providers/providerService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/providers/providerService')>();
  return {
    ...actual,
    createProviderConfig: hoisted.createProviderConfig,
    updateProviderConfig: hoisted.updateProviderConfig,
    getProviderConfigById: hoisted.getProviderConfigById,
    loadProviderRuntimeData: hoisted.loadProviderRuntimeData,
    recordProviderTest: hoisted.recordProviderTest,
    resolveTenantProjectIds: hoisted.resolveTenantProjectIds,
    listProviderConfigs: vi.fn(),
    deleteProviderConfig: vi.fn(),
  };
});
vi.mock('@/lib/services/providers/providerConnectionTest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/providers/providerConnectionTest')>();
  return { ...actual, testProviderConnection: hoisted.testProviderConnection };
});
vi.mock('@/lib/services/providers/providerUsage', () => ({ getProviderUsage: vi.fn() }));
vi.mock('@/lib/services/files', () => ({
  composeUploadKeyHint: vi.fn(() => ({})),
  createFileBucket: vi.fn(),
  createFileProvider: hoisted.createFileProvider,
  deleteFile: vi.fn(),
  deleteFileBucket: vi.fn(),
  downloadFile: vi.fn(),
  getFileBucket: vi.fn(),
  getFileRecord: vi.fn(),
  listFileBuckets: vi.fn(),
  listFileProviders: vi.fn(),
  listFiles: vi.fn(),
  updateFileBucket: vi.fn(),
  uploadFile: vi.fn(),
}));
vi.mock('@/lib/services/models/modelService', () => ({
  createDynamicModel: vi.fn(),
  createModel: vi.fn(),
  createModelProvider: hoisted.createModelProvider,
  deleteModel: vi.fn(),
  getModelById: vi.fn(),
  getModelUsageBreakdown: vi.fn(),
  getUsageAggregate: vi.fn(),
  listModelProviders: vi.fn(),
  listModels: vi.fn(),
  listUsageLogs: vi.fn(),
  updateModel: vi.fn(),
}));
vi.mock('@/lib/services/vector', () => ({
  createVectorProvider: hoisted.createVectorProvider,
  listVectorProviders: vi.fn(),
  VectorAttachRequiresDetailsError: class extends Error {},
  VectorAttachNotFoundError: class extends Error {},
}));

import type { FastifyReply } from 'fastify';
import type { FastifyPluginAsync } from 'fastify';
import { ProviderSettingsError } from '@/lib/providers/errors';
import { ProviderEndpointError } from '@/lib/services/providers/providerEndpointGuard';
import { sendProviderConfigError } from '@/server/api/providerConfigErrors';
import { clientFilesApiPlugin } from '@/server/api/plugins/client-files';
import { clientModelsApiPlugin } from '@/server/api/plugins/client-models';
import { clientProvidersApiPlugin } from '@/server/api/plugins/client-providers';
import { clientVectorApiPlugin } from '@/server/api/plugins/client-vector';
import { filesApiPlugin } from '@/server/api/plugins/files';
import { modelsApiPlugin } from '@/server/api/plugins/models';
import { providersApiPlugin } from '@/server/api/plugins/providers';
import { vectorApiPlugin } from '@/server/api/plugins/vector';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

type Refusal = { name: string; make: () => Error; expected: { code: string; field: string } };

/** The two refusals every route has to map, and what the caller must be told. */
const REFUSALS: Refusal[] = [
  {
    name: 'a setting the driver cannot work with',
    make: () => new ProviderSettingsError('endpoint', 'Endpoint must start with http:// or https://.'),
    expected: { code: 'provider_settings_invalid', field: 'endpoint' },
  },
  {
    name: 'an endpoint the outbound guard refuses',
    make: () => new ProviderEndpointError('endpoint', 'private network targets are not allowed'),
    expected: { code: 'provider_endpoint_not_allowed', field: 'endpoint' },
  },
];

const FILE_BODY = {
  key: 'minio-main',
  type: 'file',
  driver: 'aws-s3-files',
  label: 'MinIO',
  credentials: { accessKeyId: 'AKIA-TEST-1', secretAccessKey: 'secret-value-123' },
  settings: { region: 'us-east-1', endpoint: 'minio.internal:9000', bucket: 'files' },
};

async function appOf(plugin: FastifyPluginAsync) {
  return createFastifyApiTestApp(async (instance) => {
    await instance.register(plugin);
  });
}

const inject = (app: Awaited<ReturnType<typeof appOf>>, method: 'POST' | 'PATCH', url: string, payload: unknown = FILE_BODY) =>
  app.inject({ method, url, payload: payload as never });

function expectRefusal(res: { statusCode: number; body: string }, refusal: Refusal, error: Error) {
  expect(res.statusCode).toBe(400);
  expect(parseJsonBody(res.body)).toEqual({ error: error.message, ...refusal.expected });
}

beforeEach(() => {
  vi.clearAllMocks();
  // A rejection queued for a call that never happens must not reach the next test.
  for (const fn of [
    hoisted.createProviderConfig, hoisted.updateProviderConfig, hoisted.getProviderConfigById, hoisted.loadProviderRuntimeData,
    hoisted.recordProviderTest, hoisted.resolveTenantProjectIds, hoisted.testProviderConnection, hoisted.createFileProvider,
    hoisted.createModelProvider, hoisted.createVectorProvider,
  ]) {
    fn.mockReset();
  }
  hoisted.session.userRole = 'owner';
  // Assigned to the project of the dashboard session (proj-ctx) and to the project of the API token (proj-1).
  hoisted.getProviderConfigById.mockResolvedValue({
    _id: 'prov-1', tenantId: 'tenant-1', key: 'minio-main', projectIds: ['proj-ctx', 'proj-1'],
  });
  hoisted.resolveTenantProjectIds.mockImplementation(async (_db: string, _tenant: string, ids: string[]) => ({ projectIds: ids, unknown: [] }));
  hoisted.loadProviderRuntimeData.mockResolvedValue({
    record: { _id: 'prov-1', tenantId: 'tenant-1', key: 'minio-main', type: 'file', driver: 'aws-s3-files', settings: FILE_BODY.settings },
    credentials: FILE_BODY.credentials,
  });
});

describe('sendProviderConfigError', () => {
  const replyStub = () => {
    const reply = { code: vi.fn(), send: vi.fn() };
    reply.code.mockReturnValue(reply);
    return reply;
  };

  it.each(REFUSALS)('answers 400 { error, code, field } for $name, and says so', (refusal) => {
    const reply = replyStub();
    const error = refusal.make();
    expect(sendProviderConfigError(reply as unknown as FastifyReply, error)).toBe(true);
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({ error: error.message, ...refusal.expected });
  });

  it('leaves every other error to the route (nothing is sent)', () => {
    for (const other of [new Error('boom'), new TypeError('bad'), 'text', null, undefined, { code: 'provider_settings_invalid' }]) {
      const reply = replyStub();
      expect(sendProviderConfigError(reply as unknown as FastifyReply, other)).toBe(false);
      expect(reply.code).not.toHaveBeenCalled();
      expect(reply.send).not.toHaveBeenCalled();
    }
  });
});

describe('dashboard providers API (plugins/providers.ts)', () => {
  let app: Awaited<ReturnType<typeof appOf>>;
  beforeEach(async () => { app = await appOf(providersApiPlugin); });
  afterEach(async () => { await app.close(); });

  describe.each(REFUSALS)('$name', (refusal) => {
    it('creates nothing: POST /providers (tenant scope and project scope) is a 400', async () => {
      for (const url of ['/api/providers?scope=tenant', '/api/providers']) {
        const error = refusal.make();
        hoisted.createProviderConfig.mockRejectedValueOnce(error);
        expectRefusal(await inject(app, 'POST', url), refusal, error);
      }
    });

    it('changes nothing: PATCH /providers/:id (tenant scope and project scope) is a 400', async () => {
      for (const url of ['/api/providers/prov-1?scope=tenant', '/api/providers/prov-1']) {
        const error = refusal.make();
        hoisted.updateProviderConfig.mockRejectedValueOnce(error);
        expectRefusal(await inject(app, 'PATCH', url, { settings: { endpoint: 'x' } }), refusal, error);
      }
    });

    it('POST /providers/test (unsaved provider) is a 400, not a failed connection', async () => {
      const error = refusal.make();
      hoisted.testProviderConnection.mockRejectedValueOnce(error);
      const res = await inject(app, 'POST', '/api/providers/test', FILE_BODY);
      expectRefusal(res, refusal, error);
    });

    it('POST /providers/:id/test (stored provider) is a 400 and keeps no outcome', async () => {
      const error = refusal.make();
      hoisted.testProviderConnection.mockRejectedValueOnce(error);
      const res = await inject(app, 'POST', '/api/providers/prov-1/test', {});
      expectRefusal(res, refusal, error);
      expect(hoisted.recordProviderTest).not.toHaveBeenCalled();
    });
  });

  it('a message that happens to say "required" is not turned into a bare 400 (code and field stay)', async () => {
    const error = new ProviderSettingsError('accessKeyId', 'Access key ID is required.');
    hoisted.createProviderConfig.mockRejectedValueOnce(error);
    const res = await inject(app, 'POST', '/api/providers?scope=tenant');
    expect(parseJsonBody(res.body)).toEqual({ error: 'Access key ID is required.', code: 'provider_settings_invalid', field: 'accessKeyId' });
  });

  it('logs a refusal by name, code and field, not by its words (they can quote what was typed into a field)', async () => {
    hoisted.providersLog.error.mockClear();
    for (const error of [
      new ProviderEndpointError('endpoint', 'Invalid URL: https://AKIAEXAMPLE:SUPERSECRETKEY@host'),
      new ProviderSettingsError('accessKeyId', 'Bad value SUPERSECRETKEY'),
    ]) {
      hoisted.updateProviderConfig.mockRejectedValueOnce(error);
      expect((await inject(app, 'PATCH', '/api/providers/prov-1?scope=tenant', { settings: { endpoint: 'x' } })).statusCode).toBe(400);
    }

    expect(hoisted.providersLog.error).toHaveBeenCalledTimes(2);
    expect(hoisted.providersLog.error.mock.calls.map(([, fields]) => fields)).toEqual([
      { name: 'ProviderEndpointError', code: 'provider_endpoint_not_allowed', field: 'endpoint' },
      { name: 'ProviderSettingsError', code: 'provider_settings_invalid', field: 'accessKeyId' },
    ]);
    expect(JSON.stringify(hoisted.providersLog.error.mock.calls)).not.toContain('SUPERSECRETKEY');
  });

  it('still logs the message of any other failure', async () => {
    hoisted.providersLog.error.mockClear();
    hoisted.updateProviderConfig.mockRejectedValueOnce(new Error('database is down'));
    expect((await inject(app, 'PATCH', '/api/providers/prov-1?scope=tenant', { label: 'x' })).statusCode).toBe(500);
    expect(hoisted.providersLog.error).toHaveBeenCalledWith('Provider request failed', { error: 'database is down', name: 'Error' });
  });

  it('other failures keep their own answers (duplicate key 409, anything else on update 500)', async () => {
    hoisted.createProviderConfig.mockRejectedValueOnce(new Error('Provider with key "minio-main" already exists.'));
    expect((await inject(app, 'POST', '/api/providers?scope=tenant')).statusCode).toBe(409);
    hoisted.updateProviderConfig.mockRejectedValueOnce(new Error('database is down'));
    expect((await inject(app, 'PATCH', '/api/providers/prov-1?scope=tenant', { label: 'x' })).statusCode).toBe(500);
  });
});

describe('client providers API (plugins/client-providers.ts)', () => {
  let app: Awaited<ReturnType<typeof appOf>>;
  beforeEach(async () => { app = await appOf(clientProvidersApiPlugin); });
  afterEach(async () => { await app.close(); });

  describe.each(REFUSALS)('$name', (refusal) => {
    it('POST /client/v1/providers is a 400 (it used to be a 500)', async () => {
      const error = refusal.make();
      hoisted.createProviderConfig.mockRejectedValueOnce(error);
      expectRefusal(await inject(app, 'POST', '/api/client/v1/providers'), refusal, error);
      hoisted.createProviderConfig.mockRejectedValueOnce(error);
      expectRefusal(await inject(app, 'POST', '/api/client/v1/providers?scope=tenant'), refusal, error);
    });

    it('PATCH /client/v1/providers/:id is a 400', async () => {
      const error = refusal.make();
      hoisted.updateProviderConfig.mockRejectedValueOnce(error);
      const res = await inject(app, 'PATCH', '/api/client/v1/providers/prov-1', { settings: { endpoint: 'x' } });
      expectRefusal(res, refusal, error);
    });
  });

  it('a message that happens to say "required" keeps its code and field', async () => {
    hoisted.createProviderConfig.mockRejectedValueOnce(new ProviderSettingsError('bucket', 'Bucket name is required.'));
    const res = await inject(app, 'POST', '/api/client/v1/providers');
    expect(parseJsonBody(res.body)).toMatchObject({ code: 'provider_settings_invalid', field: 'bucket' });
  });

  it('other failures keep their own answers (duplicate key 409, anything else 500)', async () => {
    hoisted.createProviderConfig.mockRejectedValueOnce(new Error('Provider with key "minio-main" already exists.'));
    expect((await inject(app, 'POST', '/api/client/v1/providers')).statusCode).toBe(409);
    hoisted.updateProviderConfig.mockRejectedValueOnce(new Error('database is down'));
    expect((await inject(app, 'PATCH', '/api/client/v1/providers/prov-1', { label: 'x' })).statusCode).toBe(500);
  });
});

describe('Files providers (dashboard and client API)', () => {
  describe.each(REFUSALS)('$name', (refusal) => {
    it('POST /files/providers is a 400 (it used to be a 500)', async () => {
      const app = await appOf(filesApiPlugin);
      try {
        const error = refusal.make();
        hoisted.createFileProvider.mockRejectedValueOnce(error);
        expectRefusal(await inject(app, 'POST', '/api/files/providers'), refusal, error);
      } finally {
        await app.close();
      }
    });

    it('POST /client/v1/files/providers is a 400 (it used to be a 500)', async () => {
      const app = await appOf(clientFilesApiPlugin);
      try {
        const error = refusal.make();
        hoisted.createFileProvider.mockRejectedValueOnce(error);
        expectRefusal(await inject(app, 'POST', '/api/client/v1/files/providers'), refusal, error);
      } finally {
        await app.close();
      }
    });
  });

  it('a provider that is saved answers 201, and other failures stay a 500', async () => {
    for (const [plugin, url] of [
      [filesApiPlugin, '/api/files/providers'],
      [clientFilesApiPlugin, '/api/client/v1/files/providers'],
    ] as const) {
      const app = await appOf(plugin);
      try {
        hoisted.createFileProvider.mockResolvedValueOnce({ _id: 'prov-1', key: 'minio-main' });
        const created = await inject(app, 'POST', url);
        expect(created.statusCode, url).toBe(201);
        hoisted.createFileProvider.mockRejectedValueOnce(new Error('database is down'));
        const failed = await inject(app, 'POST', url);
        expect(failed.statusCode, url).toBe(500);
        expect(parseJsonBody<{ error: string }>(failed.body).error).toBe('database is down');
      } finally {
        await app.close();
      }
    }
  });
});

describe('model providers (plugins/models.ts)', () => {
  let app: Awaited<ReturnType<typeof appOf>>;
  const MODEL_BODY = { key: 'openai-eu', driver: 'openai-compatible', label: 'EU', credentials: { apiKey: 'sk-test-12345' } };
  beforeEach(async () => { app = await appOf(modelsApiPlugin); });
  afterEach(async () => { await app.close(); });

  it.each(REFUSALS)('POST /models/providers answers 400 { error, code, field } for $name', async (refusal) => {
    const error = refusal.make();
    hoisted.createModelProvider.mockRejectedValueOnce(error);
    expectRefusal(await inject(app, 'POST', '/api/models/providers', MODEL_BODY), refusal, error);
  });

  it('a duplicate key stays a 409', async () => {
    hoisted.createModelProvider.mockRejectedValueOnce(new Error('Provider with key "openai-eu" already exists.'));
    expect((await inject(app, 'POST', '/api/models/providers', MODEL_BODY)).statusCode).toBe(409);
  });
});

describe('client model providers (plugins/client-models.ts)', () => {
  let app: Awaited<ReturnType<typeof appOf>>;
  const MODEL_BODY = { key: 'openai-eu', driver: 'openai-compatible', label: 'EU', credentials: { apiKey: 'sk-test-12345' } };
  beforeEach(async () => { app = await appOf(clientModelsApiPlugin); });
  afterEach(async () => { await app.close(); });

  it.each(REFUSALS)('POST /client/v1/models/providers answers 400 { error, code, field } for $name (it used to be a 500)', async (refusal) => {
    const error = refusal.make();
    hoisted.createModelProvider.mockRejectedValueOnce(error);
    expectRefusal(await inject(app, 'POST', '/api/client/v1/models/providers', MODEL_BODY), refusal, error);
  });

  it('a provider that is saved answers 201, a duplicate key stays a 409 and anything else a 500', async () => {
    hoisted.createModelProvider.mockResolvedValueOnce({ _id: 'prov-1', key: 'openai-eu' });
    expect((await inject(app, 'POST', '/api/client/v1/models/providers', MODEL_BODY)).statusCode).toBe(201);
    hoisted.createModelProvider.mockRejectedValueOnce(new Error('Provider with key "openai-eu" already exists.'));
    expect((await inject(app, 'POST', '/api/client/v1/models/providers', MODEL_BODY)).statusCode).toBe(409);
    hoisted.createModelProvider.mockRejectedValueOnce(new Error('database is down'));
    expect((await inject(app, 'POST', '/api/client/v1/models/providers', MODEL_BODY)).statusCode).toBe(500);
  });
});

describe('vector providers (dashboard plugins/vector.ts and client plugins/client-vector.ts)', () => {
  const VECTOR_BODY = { key: 'es-main', driver: 'elasticsearch', label: 'Search', credentials: { apiKey: 'es-key-12345' } };
  const routes = [
    ['POST /vector/providers', vectorApiPlugin, '/api/vector/providers'],
    ['POST /client/v1/vector/providers', clientVectorApiPlugin, '/api/client/v1/vector/providers'],
  ] as const;

  describe.each(REFUSALS)('$name', (refusal) => {
    it.each(routes)('%s answers 400 { error, code, field } (it used to be a 500)', async (_name, plugin, url) => {
      const app = await appOf(plugin);
      try {
        const error = refusal.make();
        hoisted.createVectorProvider.mockRejectedValueOnce(error);
        expectRefusal(await inject(app, 'POST', url, VECTOR_BODY), refusal, error);
      } finally {
        await app.close();
      }
    });
  });

  it.each(routes)('%s: a provider that is saved answers 201, and other failures stay a 500', async (_name, plugin, url) => {
    const app = await appOf(plugin);
    try {
      hoisted.createVectorProvider.mockResolvedValueOnce({ _id: 'prov-1', key: 'es-main' });
      expect((await inject(app, 'POST', url, VECTOR_BODY)).statusCode).toBe(201);
      hoisted.createVectorProvider.mockRejectedValueOnce(new Error('database is down'));
      const failed = await inject(app, 'POST', url, VECTOR_BODY);
      expect(failed.statusCode).toBe(500);
      expect(parseJsonBody<{ error: string }>(failed.body).error).toBe('database is down');
    } finally {
      await app.close();
    }
  });
});
