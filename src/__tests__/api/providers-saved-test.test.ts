/**
 * "Test connection" of a SAVED provider (the edit form and the Files bucket page both use it):
 *
 *   POST /api/providers/:id/test                              no body: re-test what is stored, keep the outcome on the record
 *   POST /api/providers/:id/test  { credentials?, settings? }  test what an update with those values would store, keep nothing
 *
 * Run with the real permission gate, the real provider service (over a mocked database), the real connection test
 * and a registered test driver, so the merge of the stored and the typed values, the driver's own check of the
 * merged values and the scrubbing of secrets are exercised together.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ getDatabase: vi.fn() }));

vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));
vi.mock('@/lib/database', () => ({
  getDatabase: hoisted.getDatabase,
  // The gate reads the caller (and the engine its policies) through the tenant scope.
  runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(await hoisted.getDatabase()),
}));

import { providerRegistry } from '@/lib/providers';
import type { FileConnectionCheck } from '@/lib/providers';
import { ProviderSettingsError } from '@/lib/providers/errors';
import { getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';
import { encryptObject } from '@/lib/utils/crypto';
import { providersApiPlugin } from '@/server/api/plugins/providers';
import { createMockDb, type MockDb } from '../helpers/db.mock';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const STORED_CREDENTIALS = { accessKeyId: 'AKIA-STORED-0001', secretAccessKey: 'stored-secret-value-0001' };
const NEW_SECRET = 'typed-secret-value-0002';
const STORED_SETTINGS = { endpoint: 'https://93.184.216.34:9000', bucket: 'files', prefix: 'console' };

// ── a driver whose runtime records what it was built from ─────────────────────────────────────────────────────────
type Built = { credentials: Record<string, unknown>; settings: Record<string, unknown> };
const built: Built[] = [];
const closed = vi.fn();
const validateSettings = vi.fn();
let nextCheck: (context: Built) => FileConnectionCheck;

const GOOD_STEPS: FileConnectionCheck['steps'] = [
  { step: 'list', ok: true },
  { step: 'write', ok: true },
  { step: 'read', ok: true },
  { step: 'delete', ok: true },
];

providerRegistry.register({
  id: 'test-saved-files',
  version: '1.0.0',
  domains: ['file'],
  display: { label: 'Test files (saved provider)' },
  form: { sections: [] },
  validateSettings,
  createRuntime: (context: Built) => {
    built.push({ credentials: { ...context.credentials }, settings: { ...context.settings } });
    return {
      close: closed,
      checkConnection: async () => nextCheck(context),
    };
  },
} as never);

// ── the world: tenant, callers, stored provider ───────────────────────────────────────────────────────────────────
const USERS: Record<string, Record<string, unknown>> = {
  owner: { _id: 'u-owner', tenantId: 'tenant-1', role: 'owner', email: 'owner@acme.test', name: 'Owner' },
  admin: { _id: 'u-admin', tenantId: 'tenant-1', role: 'admin', email: 'admin@acme.test', name: 'Admin' },
  plain: { _id: 'u-plain', tenantId: 'tenant-1', role: 'user', email: 'plain@acme.test', name: 'Plain' },
  // an admin whose own grant for Providers is read-only: the role check of the handler would let them in, the gate must not
  narrowed: {
    _id: 'u-narrow', tenantId: 'tenant-1', role: 'admin', email: 'narrow@acme.test', name: 'Narrow',
    servicePermissions: { providers: 'read' },
  },
};

const headersOf = (who: keyof typeof USERS) => ({
  'x-license-type': 'FREE',
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': 'tenant-1',
  'x-tenant-slug': 'acme',
  'x-user-id': String(USERS[who]!._id),
  'x-user-role': String(USERS[who]!.role),
});

const storedRecord = (overrides: Record<string, unknown> = {}) => ({
  _id: 'prov-1',
  tenantId: 'tenant-1',
  key: 'minio-main',
  type: 'file',
  driver: 'test-saved-files',
  label: 'MinIO',
  status: 'active',
  credentialsEnc: encryptObject(STORED_CREDENTIALS),
  settings: { ...STORED_SETTINGS },
  lastTest: null,
  ...overrides,
});

let db: MockDb;
let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

const original = getConfigSource();
function deployment(mode: 'saas' | 'onprem') {
  setConfigSource({ get: (k: string) => (k === 'DEPLOYMENT_MODE' ? mode : process.env[k]) } as ConfigSource);
}

beforeEach(async () => {
  built.length = 0;
  closed.mockReset();
  validateSettings.mockReset();
  // The driver's own check, on whatever it is handed: the merged values.
  validateSettings.mockImplementation(({ credentials, settings }: Built) => {
    if (!settings.bucket) throw new ProviderSettingsError('bucket', 'Bucket is required.');
    if (!credentials.secretAccessKey) throw new ProviderSettingsError('secretAccessKey', 'Secret access key is required.');
  });
  nextCheck = () => ({ ok: true, message: 'Connected. Listed, wrote, read and deleted a test object.', steps: GOOD_STEPS });
  deployment('saas');

  db = createMockDb();
  hoisted.getDatabase.mockResolvedValue(db);
  db.findUserById.mockImplementation((async (id: string) =>
    Object.values(USERS).find((user) => user._id === id) ?? null) as never);
  db.findProviderById.mockResolvedValue(storedRecord() as never);
  db.updateProvider.mockImplementation((async (_id: string, updates: Record<string, unknown>) => ({ ...storedRecord(), ...updates })) as never);

  // The production JSON parser: the body stays the raw string and an empty one reaches the handler.
  app = await createFastifyApiTestApp(providersApiPlugin, { rawJsonBody: true });
});

afterEach(async () => {
  await app.close();
  setConfigSource(original);
});

/** `body: undefined` sends no body at all (the Files bucket page's "Test now"). */
const test = (who: keyof typeof USERS, body?: unknown, id = 'prov-1') =>
  app.inject({
    method: 'POST',
    url: `/api/providers/${id}/test`,
    headers: body === undefined ? headersOf(who) : { ...headersOf(who), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { payload: typeof body === 'string' ? body : JSON.stringify(body) }),
  });

const lastTestWritten = () =>
  db.updateProvider.mock.calls.map(([, updates]) => (updates as { lastTest?: unknown }).lastTest).filter(Boolean);

describe('POST /api/providers/:id/test without a body (re-test the stored connection)', () => {
  it('tests what is stored, answers the steps and keeps the outcome on the record', async () => {
    const res = await test('owner');
    expect(res.statusCode).toBe(200);
    const body = parseJsonBody<{ ok: boolean; latencyMs: number; message: string; details: { steps: unknown[] } }>(res.body);
    expect(body).toMatchObject({ ok: true, message: 'Connected. Listed, wrote, read and deleted a test object.' });
    expect(body.latencyMs).toBeGreaterThanOrEqual(0);
    expect(body.details.steps).toEqual(GOOD_STEPS);

    expect(built).toEqual([{ credentials: STORED_CREDENTIALS, settings: STORED_SETTINGS }]);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(lastTestWritten()).toEqual([
      { ok: true, at: expect.any(Date), latencyMs: expect.any(Number), message: 'Connected. Listed, wrote, read and deleted a test object.' },
    ]);
  });

  it('is the same with an empty JSON object, an empty JSON body, and credentials that are all blank', async () => {
    for (const body of ['{}', '', { credentials: {} }, { credentials: { secretAccessKey: '', accessKeyId: null } }]) {
      db.updateProvider.mockClear();
      built.length = 0;
      const res = await app.inject({
        method: 'POST',
        url: '/api/providers/prov-1/test',
        headers: { ...headersOf('owner'), 'content-type': 'application/json' },
        payload: typeof body === 'string' ? body : JSON.stringify(body),
      });
      expect(res.statusCode, JSON.stringify(body)).toBe(200);
      expect(built, JSON.stringify(body)).toEqual([{ credentials: STORED_CREDENTIALS, settings: STORED_SETTINGS }]);
      expect(lastTestWritten(), JSON.stringify(body)).toHaveLength(1);
    }
  });

  it('keeps a failed outcome too, with the steps that ran', async () => {
    nextCheck = () => ({
      ok: false,
      message: 'Could list the bucket but not write to it.',
      steps: [{ step: 'list', ok: true }, { step: 'write', ok: false, message: 'Access denied' }],
    });
    const res = await test('admin');
    expect(res.statusCode).toBe(200);
    expect(parseJsonBody<{ ok: boolean; details: { steps: unknown[] } }>(res.body)).toMatchObject({
      ok: false,
      details: { steps: [{ step: 'list', ok: true }, { step: 'write', ok: false, message: 'Access denied' }] },
    });
    expect(lastTestWritten()).toEqual([expect.objectContaining({ ok: false })]);
  });
});

describe('POST /api/providers/:id/test with the form\'s unsaved values', () => {
  it('a blank secret keeps the stored one, the typed settings replace the stored ones, and nothing is kept on the record', async () => {
    const res = await test('owner', {
      credentials: { accessKeyId: '', secretAccessKey: '' },
      settings: { endpoint: 'https://93.184.216.35:9000', bucket: 'other-bucket' },
    });
    expect(res.statusCode).toBe(200);
    expect(built).toEqual([{
      credentials: STORED_CREDENTIALS,
      // replaced wholesale, as an update does: the stored prefix is gone with the rest of the old settings
      settings: { endpoint: 'https://93.184.216.35:9000', bucket: 'other-bucket' },
    }]);
    expect(db.updateProvider).not.toHaveBeenCalled();
  });

  it('a typed secret wins over the stored one for that field only', async () => {
    const res = await test('owner', { credentials: { secretAccessKey: NEW_SECRET }, settings: STORED_SETTINGS });
    expect(res.statusCode).toBe(200);
    expect(built).toEqual([{
      credentials: { accessKeyId: STORED_CREDENTIALS.accessKeyId, secretAccessKey: NEW_SECRET },
      settings: STORED_SETTINGS,
    }]);
    expect(db.updateProvider).not.toHaveBeenCalled();
  });

  it('credentials alone leave the stored settings in place', async () => {
    const res = await test('owner', { credentials: { secretAccessKey: NEW_SECRET } });
    expect(res.statusCode).toBe(200);
    expect(built[0]!.settings).toEqual(STORED_SETTINGS);
    expect(built[0]!.credentials.secretAccessKey).toBe(NEW_SECRET);
    expect(db.updateProvider).not.toHaveBeenCalled();
  });

  it('settings alone test the stored credentials against them, and keep nothing', async () => {
    const res = await test('owner', { settings: { ...STORED_SETTINGS, bucket: 'renamed' } });
    expect(res.statusCode).toBe(200);
    expect(built).toEqual([{ credentials: STORED_CREDENTIALS, settings: { ...STORED_SETTINGS, bucket: 'renamed' } }]);
    expect(db.updateProvider).not.toHaveBeenCalled();
  });

  it('the driver checks the MERGED values, before anything is dialled', async () => {
    await test('owner', { credentials: { accessKeyId: 'AKIA-TYPED-0003' }, settings: { ...STORED_SETTINGS, bucket: 'renamed' } });
    expect(validateSettings).toHaveBeenCalledTimes(1);
    expect(validateSettings).toHaveBeenCalledWith({
      credentials: { accessKeyId: 'AKIA-TYPED-0003', secretAccessKey: STORED_CREDENTIALS.secretAccessKey },
      settings: { ...STORED_SETTINGS, bucket: 'renamed' },
      isOnPrem: false,
      tenantId: 'tenant-1',
    });
  });

  it('refuses a setting the driver cannot work with as a 400 naming the field, without building a runtime', async () => {
    const res = await test('owner', { settings: { endpoint: STORED_SETTINGS.endpoint } });
    expect(res.statusCode).toBe(400);
    expect(parseJsonBody(res.body)).toEqual({ error: 'Bucket is required.', code: 'provider_settings_invalid', field: 'bucket' });
    expect(built).toHaveLength(0);
    expect(db.updateProvider).not.toHaveBeenCalled();
  });

  it('refuses an endpoint the outbound guard does not allow (SaaS) as a 400 naming the field', async () => {
    const res = await test('owner', { settings: { endpoint: 'http://10.1.2.3:9000', bucket: 'files' } });
    expect(res.statusCode).toBe(400);
    expect(parseJsonBody(res.body)).toMatchObject({ code: 'provider_endpoint_not_allowed', field: 'endpoint' });
    expect(built).toHaveLength(0);
  });

  it('a stored connection that cannot be opened can still be tried with re-entered credentials; without them it is a 409', async () => {
    db.findProviderById.mockResolvedValue(storedRecord({ credentialsEnc: 'not-a-sealed-blob' }) as never);

    const none = await test('owner');
    expect(none.statusCode).toBe(409);
    expect(built).toHaveLength(0);

    const retyped = await test('owner', { credentials: { accessKeyId: 'AKIA-TYPED-0003', secretAccessKey: NEW_SECRET } });
    expect(retyped.statusCode).toBe(200);
    expect(built).toEqual([{
      credentials: { accessKeyId: 'AKIA-TYPED-0003', secretAccessKey: NEW_SECRET },
      settings: STORED_SETTINGS,
    }]);
    expect(db.updateProvider).not.toHaveBeenCalled();
  });

  it('refuses a body that is not an object, and credentials or settings that are not objects (400)', async () => {
    for (const bad of ['[1]', '"text"', '{"credentials":"x"}', '{"settings":[1]}', '{"credentials":[1]}', '{"settings":3}', '{not json']) {
      const res = await test('owner', bad);
      expect(res.statusCode, bad).toBe(400);
    }
    expect(built).toHaveLength(0);
    expect(db.updateProvider).not.toHaveBeenCalled();
  });
});

describe('secrets never leave', () => {
  it('a message that quotes a secret is scrubbed - the stored one and the typed one - and the answer carries no credential', async () => {
    nextCheck = (context) => ({
      ok: false,
      message: `Signature mismatch for ${String(context.credentials.secretAccessKey)} (${String(context.credentials.accessKeyId)})`,
      steps: [{ step: 'list', ok: false, message: `rejected ${String(context.credentials.secretAccessKey)}` }],
    });

    for (const body of [undefined, { credentials: { secretAccessKey: NEW_SECRET }, settings: STORED_SETTINGS }]) {
      const res = await test('owner', body);
      expect(res.statusCode).toBe(200);
      for (const secret of [STORED_CREDENTIALS.secretAccessKey, STORED_CREDENTIALS.accessKeyId, NEW_SECRET]) {
        expect(res.body).not.toContain(secret);
      }
      expect(parseJsonBody<{ message: string }>(res.body).message).toContain('***');
    }
  });

  it('the refusal of a setting does not echo the typed credentials either', async () => {
    const res = await test('owner', { credentials: { secretAccessKey: NEW_SECRET }, settings: {} });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain(NEW_SECRET);
    expect(res.body).not.toContain(STORED_CREDENTIALS.secretAccessKey);
  });
});

describe('who may test a saved provider (same gate as updating it)', () => {
  it('owners and admins may, with and without values', async () => {
    for (const who of ['owner', 'admin'] as const) {
      expect((await test(who)).statusCode, who).toBe(200);
      expect((await test(who, { settings: STORED_SETTINGS })).statusCode, who).toBe(200);
    }
  });

  it('a plain member is refused by the gate before the handler runs - nothing is built, decrypted or written', async () => {
    for (const body of [undefined, { settings: STORED_SETTINGS }, { credentials: { secretAccessKey: NEW_SECRET } }]) {
      const res = await test('plain', body);
      expect(res.statusCode).toBe(403);
      expect(res.body).not.toContain(STORED_CREDENTIALS.secretAccessKey);
    }
    expect(built).toHaveLength(0);
    expect(db.findProviderById).not.toHaveBeenCalled();
    expect(db.updateProvider).not.toHaveBeenCalled();
  });

  it('an admin whose own grant for Providers is read-only is refused too, for the re-test and for values alike', async () => {
    for (const body of [undefined, { settings: STORED_SETTINGS }]) {
      expect((await test('narrowed', body)).statusCode).toBe(403);
    }
    expect(built).toHaveLength(0);
    expect(db.updateProvider).not.toHaveBeenCalled();
  });

  it('the same caller is refused updating the provider, so the two stay level', async () => {
    for (const who of ['plain', 'narrowed'] as const) {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/providers/prov-1?scope=tenant',
        headers: { ...headersOf(who), 'content-type': 'application/json' },
        payload: JSON.stringify({ label: 'renamed' }),
      });
      expect(res.statusCode, who).toBe(403);
    }
  });

  it('a provider of another workspace, or none, is a 404 and nothing is decrypted', async () => {
    db.findProviderById.mockResolvedValueOnce(storedRecord({ tenantId: 'someone-else' }) as never);
    expect((await test('owner', { settings: STORED_SETTINGS })).statusCode).toBe(404);
    db.findProviderById.mockResolvedValueOnce(null);
    expect((await test('owner', undefined, 'nope')).statusCode).toBe(404);
    expect(built).toHaveLength(0);
  });
});
