/**
 * Platform-provided records (`platform`) through the tenant-facing services: read-only everywhere a tenant could
 * change them, never set from a payload, operator credentials for managed records, key uniqueness, route mapping.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  db: {
    switchToTenant: vi.fn(),
    findProviderById: vi.fn(),
    findProviderByKey: vi.fn(),
    listModels: vi.fn(),
    listProviders: vi.fn(),
    updateProvider: vi.fn(),
    deleteProvider: vi.fn(),
    createProvider: vi.fn(),
    findModelById: vi.fn(),
    findModelByKey: vi.fn(),
    updateModel: vi.fn(),
    deleteModel: vi.fn(),
    createModel: vi.fn(),
  },
}));

vi.mock('@/lib/database', () => ({ getDatabase: async () => hoisted.db }));
vi.mock('@/lib/utils/crypto', () => ({
  encryptObject: vi.fn((value: unknown) => `enc:${JSON.stringify(value)}`),
  decryptObject: vi.fn((blob: string) => JSON.parse(blob.slice(4))),
}));
const cacheDel = vi.hoisted(() => vi.fn());
vi.mock('@/lib/core/cache', () => ({ getCache: async () => ({ del: cacheDel, get: vi.fn(), set: vi.fn() }) }));
vi.mock('@/lib/services/providers/providerEndpointGuard', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  assertProviderEndpointsAllowed: vi.fn(),
}));
vi.mock('@/lib/services/providers/providerSettingsValidation', () => ({
  settingsValidatorOf: vi.fn(),
  validateProviderSettings: vi.fn(),
}));

import {
  registerManagedCreditsHost,
  resetManagedCreditsHostForTests,
  type ManagedCreditsHost,
} from '@/enterprise/managed-credits';
import {
  createProviderConfig,
  deleteProviderConfig,
  loadProviderRuntimeData,
  recordProviderTest,
  resolveProviderTestTarget,
  updateProviderConfig,
  listProviderConfigs,
  redactPlatformProvider,
} from '@/lib/services/providers/providerService';
import { ManagedProviderError, PlatformModelSelectionError, PlatformRecordReadOnlyError } from '@/lib/services/providers/managedProviderErrors';
import {
  addPlatformModelsToProject,
  createModel,
  deleteModel,
  removePlatformModelFromProject,
  updateModel,
} from '@/lib/services/models/modelService';
import { sendProviderConfigError } from '@/server/api/providerConfigErrors';

const provider = (overrides: Record<string, unknown> = {}) => ({
  _id: 'prov-1',
  tenantId: 'tenant-1',
  key: 'own',
  type: 'model',
  driver: 'openai',
  label: 'Own',
  status: 'active',
  credentialsEnc: `enc:${JSON.stringify({ apiKey: 'tenant-secret' })}`,
  settings: {},
  ...overrides,
});
const wideProvider = (overrides: Record<string, unknown> = {}) =>
  provider({ _id: 'prov-wide', key: 'platform', label: 'Platform', platform: true, settings: { managed: true }, ...overrides });
const model = (overrides: Record<string, unknown> = {}) => ({
  _id: 'model-1', tenantId: 'tenant-1', projectId: 'p1', name: 'M', key: 'm', providerKey: 'own',
  providerDriver: 'openai', category: 'llm', modelId: 'x', pricing: {}, settings: {}, ...overrides,
});

const host = (extra: Partial<ManagedCreditsHost> = {}): ManagedCreditsHost => ({
  isManagedProvider: (ref) => ref.settings?.managed === true,
  reserve: vi.fn(),
  ...extra,
});

const modelInput = {
  name: 'M', providerKey: 'own', category: 'llm', modelId: 'x', pricing: { inputTokenPer1M: 1, outputTokenPer1M: 1 },
};

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.db.findProviderById.mockReset().mockResolvedValue(provider());
  hoisted.db.findProviderByKey.mockReset().mockResolvedValue(provider());
  hoisted.db.createProvider.mockReset().mockImplementation(async (p: object) => ({ ...p, _id: 'new' }));
  hoisted.db.createModel.mockReset().mockImplementation(async (m: object) => ({ ...m, _id: 'new-model', key: (m as { key: string }).key }));
  hoisted.db.findModelByKey.mockReset().mockResolvedValue(null);
  hoisted.db.findModelById.mockReset().mockResolvedValue(model());
  hoisted.db.updateModel.mockReset().mockImplementation(async (_id: string, d: object) => ({ ...model(), ...d }));
});
afterEach(() => resetManagedCreditsHostForTests());

describe('provider mutations on a platform record', () => {
  beforeEach(() => hoisted.db.findProviderById.mockResolvedValue(wideProvider({ settings: {} })));

  it('refuses update, delete and test writes, with no host registered', async () => {
    for (const payload of [
      { label: 'x' }, { projectIds: ['p1'] }, { status: 'disabled' as const },
      { credentials: { apiKey: 'k' } }, { settings: { a: 1 } },
    ]) {
      await expect(updateProviderConfig('db', 'prov-wide', payload)).rejects.toBeInstanceOf(PlatformRecordReadOnlyError);
    }
    await expect(deleteProviderConfig('db', 'prov-wide')).rejects.toBeInstanceOf(PlatformRecordReadOnlyError);
    await expect(
      resolveProviderTestTarget('db', { id: 'prov-wide', tenantId: 'tenant-1' }, { credentials: { apiKey: 'typed' } }),
    ).rejects.toBeInstanceOf(PlatformRecordReadOnlyError);
    await expect(
      resolveProviderTestTarget('db', { id: 'prov-wide', tenantId: 'tenant-1' }, {}),
    ).rejects.toBeInstanceOf(PlatformRecordReadOnlyError);
    await expect(recordProviderTest('db', 'prov-wide', { ok: true } as never)).rejects.toBeInstanceOf(PlatformRecordReadOnlyError);
    expect(hoisted.db.updateProvider).not.toHaveBeenCalled();
    expect(hoisted.db.deleteProvider).not.toHaveBeenCalled();
  });

  it('still updates and deletes an ordinary record', async () => {
    hoisted.db.findProviderById.mockResolvedValue(provider());
    hoisted.db.updateProvider.mockResolvedValue(provider({ label: 'y' }));
    hoisted.db.deleteProvider.mockResolvedValue(true);
    await expect(updateProviderConfig('db', 'prov-1', { label: 'y' })).resolves.toMatchObject({ label: 'y', platform: false });
    await expect(deleteProviderConfig('db', 'prov-1')).resolves.toBe(true);
  });

  it('maps to 403 with error and code for dashboard and client routes alike', () => {
    const send = vi.fn();
    const reply = { code: vi.fn(() => ({ send })) };
    expect(sendProviderConfigError(reply as never, new PlatformRecordReadOnlyError())).toBe(true);
    expect(reply.code).toHaveBeenLastCalledWith(403);
    expect(send).toHaveBeenLastCalledWith({
      error: 'This item is provided by the platform and cannot be changed.',
      code: 'platform_record_read_only',
    });
  });
});

describe('assignment of a platform provider', () => {
  const platformProvider = (projectIds: string[]) => wideProvider({ settings: {}, projectIds });

  beforeEach(() => {
    hoisted.db.findProviderById.mockResolvedValue(platformProvider(['p1']));
    hoisted.db.updateProvider.mockImplementation(async (_id: string, d: object) => ({ ...platformProvider(['p1']), ...d }));
    hoisted.db.listModels.mockResolvedValue([
      { key: 'pm-1', platform: true }, { key: 'pm-2', platform: true }, { key: 'own-model' },
    ]);
  });

  it('tenant scope: an assignment-only change is allowed (updatedBy and allowHostPaths aside)', async () => {
    const view = await updateProviderConfig(
      'db', 'prov-wide',
      { projectIds: ['p1', 'p2'], updatedBy: 'u1', allowHostPaths: true },
      { allowPlatformAssignment: true },
    );
    expect(hoisted.db.updateProvider).toHaveBeenCalledWith('prov-wide', { projectIds: ['p1', 'p2'], updatedBy: 'u1' });
    expect(view).toMatchObject({ platform: true, projectIds: ['p1', 'p2'] });
  });

  it('project scope (no allowance) is refused', async () => {
    await expect(updateProviderConfig('db', 'prov-wide', { projectIds: ['p2'] }, { projectId: 'p1' }))
      .rejects.toBeInstanceOf(PlatformRecordReadOnlyError);
    expect(hoisted.db.updateProvider).not.toHaveBeenCalled();
  });

  it('refuses the assignment when the payload carries any other field, or no assignment', async () => {
    for (const payload of [
      { projectIds: ['p2'], label: 'x' }, { projectIds: ['p2'], status: 'disabled' as const },
      { projectIds: ['p2'], settings: {} }, { projectIds: ['p2'], credentials: { apiKey: 'k' } },
      { projectIds: ['p2'], metadata: {} }, { projectIds: ['p2'], description: 'd' },
      { projectIds: ['p2'], capabilitiesOverride: [] }, { label: 'x' }, {},
    ]) {
      await expect(updateProviderConfig('db', 'prov-wide', payload, { allowPlatformAssignment: true }))
        .rejects.toBeInstanceOf(PlatformRecordReadOnlyError);
    }
    expect(hoisted.db.updateProvider).not.toHaveBeenCalled();
  });

  it('skips the managed check for the allowed case only', async () => {
    registerManagedCreditsHost(host());
    hoisted.db.findProviderById.mockResolvedValue(wideProvider({ projectIds: ['p1'] }));
    await expect(updateProviderConfig('db', 'prov-wide', { projectIds: ['p2'] }, { allowPlatformAssignment: true }))
      .resolves.toBeTruthy();
    // An ordinary managed record is still refused.
    hoisted.db.findProviderById.mockResolvedValue(provider({ settings: { managed: true } }));
    await expect(updateProviderConfig('db', 'prov-1', { projectIds: ['p2'] }, { allowPlatformAssignment: true }))
      .rejects.toThrow();
  });

  it('invalidates the model caches of its platform models for old and new projects and the tenant-wide entry', async () => {
    cacheDel.mockClear();
    await updateProviderConfig('db', 'prov-wide', { projectIds: ['p2'] }, { allowPlatformAssignment: true });
    const deleted = cacheDel.mock.calls.map((c) => c[0] as string);
    expect(hoisted.db.listModels).toHaveBeenCalledWith({ providerKey: 'platform' });
    for (const project of ['p1', 'p2', '']) {
      for (const key of ['pm-1', 'pm-2']) {
        expect(deleted).toContain(`model-meta:db:${project}:${key}`);
      }
    }
    expect(deleted.some((k) => k.endsWith(':own-model'))).toBe(false);
    expect(deleted.some((k) => k.includes(':p3:'))).toBe(false);
  });

  it('does not touch the caches when an ordinary provider is updated', async () => {
    cacheDel.mockClear();
    hoisted.db.findProviderById.mockResolvedValue(provider());
    hoisted.db.updateProvider.mockResolvedValue(provider({ projectIds: ['p2'] }));
    await updateProviderConfig('db', 'prov-1', { projectIds: ['p2'] });
    expect(cacheDel).not.toHaveBeenCalled();
  });
});

describe('platform is never taken from a tenant payload', () => {
  it('createProviderConfig ignores it', async () => {
    hoisted.db.findProviderByKey.mockResolvedValue(null);
    const view = await createProviderConfig('db', 'tenant-1', {
      key: 'mine', type: 'model', driver: 'openai', label: 'x', credentials: { apiKey: 'k' }, createdBy: 'u',
      platform: true,
    } as never);
    expect(hoisted.db.createProvider.mock.calls[0][0]).not.toHaveProperty('platform');
    expect(view.platform).toBe(false);
  });

  it('updateProviderConfig ignores it', async () => {
    hoisted.db.updateProvider.mockResolvedValue(provider());
    await updateProviderConfig('db', 'prov-1', { label: 'x', platform: true } as never);
    expect(hoisted.db.updateProvider.mock.calls[0][1]).not.toHaveProperty('platform');
  });

  it('createModel and updateModel ignore it', async () => {
    hoisted.db.findProviderByKey.mockResolvedValue(provider());
    await createModel('db', 'tenant-1', 'p1', 'u1', { ...modelInput, platform: true } as never);
    expect(hoisted.db.createModel.mock.calls[0][0]).not.toHaveProperty('platform');
    await updateModel('db', 'p1', 'model-1', { name: 'n', platform: true } as never);
    expect(hoisted.db.updateModel.mock.calls[0][1]).not.toHaveProperty('platform');
  });
});

describe('model mutations on a platform model', () => {
  beforeEach(() => hoisted.db.findModelById.mockResolvedValue(model({ platform: true, projectId: 'other' })));

  it('refuses update (including replicas and settings) and delete', async () => {
    await expect(updateModel('db', 'p1', 'model-1', { name: 'x' })).rejects.toBeInstanceOf(PlatformRecordReadOnlyError);
    await expect(updateModel('db', 'p1', 'model-1', { replicas: [] } as never)).rejects.toBeInstanceOf(PlatformRecordReadOnlyError);
    await expect(updateModel('db', 'p1', 'model-1', { settings: { a: 1 } })).rejects.toBeInstanceOf(PlatformRecordReadOnlyError);
    await expect(deleteModel('db', 'p1', 'model-1')).rejects.toBeInstanceOf(PlatformRecordReadOnlyError);
    expect(hoisted.db.updateModel).not.toHaveBeenCalled();
    expect(hoisted.db.deleteModel).not.toHaveBeenCalled();
  });

  it('a missing model is still null or false', async () => {
    hoisted.db.findModelById.mockResolvedValue(null);
    await expect(updateModel('db', 'p1', 'nope', { name: 'x' })).resolves.toBeNull();
    await expect(deleteModel('db', 'p1', 'nope')).resolves.toBe(false);
  });

  it('refuses re-pointing an own model to a platform provider', async () => {
    hoisted.db.findModelById.mockResolvedValue(model());
    hoisted.db.findProviderByKey.mockResolvedValue(wideProvider());
    await expect(updateModel('db', 'p1', 'model-1', { providerKey: 'platform' })).rejects.toBeInstanceOf(PlatformRecordReadOnlyError);
  });
});

describe('createModel on a platform provider', () => {
  it('refuses a platform provider', async () => {
    hoisted.db.findProviderByKey.mockResolvedValue(wideProvider({ settings: {} }));
    await expect(createModel('db', 'tenant-1', 'p1', 'u1', { ...modelInput, providerKey: 'platform' } as never))
      .rejects.toThrow('Models cannot be added to a platform provider.');
    expect(hoisted.db.createModel).not.toHaveBeenCalled();
  });

  it('refuses a provider the managed host recognises, even when not platform', async () => {
    registerManagedCreditsHost(host());
    hoisted.db.findProviderByKey.mockResolvedValue(provider({ key: 'platform', settings: { managed: true } }));
    await expect(createModel('db', 'tenant-1', 'p1', 'u1', { ...modelInput, providerKey: 'platform' } as never))
      .rejects.toBeInstanceOf(PlatformRecordReadOnlyError);
  });

  it('suffixes the key of a platform model instead of a duplicate-key error', async () => {
    hoisted.db.findProviderByKey.mockResolvedValue(provider());
    hoisted.db.findModelByKey.mockImplementation(async (key: string) => (key === 'shared' ? model({ key: 'shared', platform: true }) : null));
    const created = await createModel('db', 'tenant-1', 'p1', 'u1', { ...modelInput, name: 'Shared' } as never);
    expect(created.key).toBe('shared-2');
    expect(hoisted.db.findModelByKey).toHaveBeenCalledWith('shared', 'p1');
  });
});

describe('the platform model key prefix is reserved', () => {
  it('refuses creating a tenant model under it, by key or by a name it derives the key from', async () => {
    await expect(createModel('db', 'tenant-1', 'p1', 'u1', { ...modelInput, key: 'cognipeer.gpt-x' } as never)).rejects.toThrow(/reserved/);
    await expect(createModel('db', 'tenant-1', 'p1', 'u1', { ...modelInput, name: 'Cognipeer.GPT' } as never)).rejects.toThrow(/reserved/);
    expect(hoisted.db.createModel).not.toHaveBeenCalled();
  });

  it('refuses renaming a tenant model into it, and keeps other dotted keys', async () => {
    await expect(updateModel('db', 'p1', 'model-1', { key: 'cognipeer.gpt-x' } as never)).rejects.toThrow(/reserved/);
    expect(hoisted.db.updateModel).not.toHaveBeenCalled();
    const created = await createModel('db', 'tenant-1', 'p1', 'u1', { ...modelInput, key: 'gpt-5.1' } as never);
    expect(created.key).toBe('gpt-5.1');
  });
});

describe('operator connections for managed records', () => {
  const managed = () => provider({ key: 'platform', settings: { managed: true }, credentialsEnc: 'not-decryptable' });
  const load = (withConnectionId = true) =>
    loadProviderRuntimeData(
      'db',
      { key: 'platform', tenantId: 'tenant-1' },
      { allowManaged: true, ...(withConnectionId ? { managedConnectionId: 'conn-a' } : {}) },
    );
  const connection = { driver: 'driver-a', settings: { region: 'r1' }, credentials: { apiKey: 'operator' } };

  it('uses the host connection and never decrypts the stored blob', async () => {
    const { decryptObject } = await import('@/lib/utils/crypto');
    hoisted.db.findProviderByKey.mockResolvedValue(managed());
    const resolveConnection = vi.fn(() => connection);
    registerManagedCreditsHost(host({ resolveConnection }));
    const loaded = await load();
    expect(loaded.credentials).toEqual({ apiKey: 'operator' });
    expect(loaded.managedConnection).toEqual({ id: 'conn-a', driver: 'driver-a', settings: { region: 'r1' } });
    // No secret travels in the connection descriptor.
    expect(JSON.stringify(loaded.managedConnection)).not.toContain('operator');
    expect(resolveConnection).toHaveBeenCalledWith(expect.objectContaining({ key: 'platform' }), 'conn-a');
    expect(decryptObject).not.toHaveBeenCalled();
  });

  it('refuses a managed record with no connection id, without asking the host', async () => {
    hoisted.db.findProviderByKey.mockResolvedValue(managed());
    const resolveConnection = vi.fn(() => connection);
    registerManagedCreditsHost(host({ resolveConnection }));
    await expect(load(false)).rejects.toBeInstanceOf(ManagedProviderError);
    expect(resolveConnection).not.toHaveBeenCalled();
  });

  it('refuses with a generic message when the connection is null, missing, malformed or the host throws', async () => {
    hoisted.db.findProviderByKey.mockResolvedValue(managed());
    for (const h of [
      host({ resolveConnection: () => null }),
      host(),
      host({ resolveConnection: () => { throw new Error('SEARCH_API_KEY missing'); } }),
      host({ resolveConnection: () => ({ driver: '', settings: {}, credentials: {} }) }),
      host({ resolveConnection: () => ({ driver: 'driver-a', settings: {}, credentials: 'oops' as never }) }),
      host({ resolveConnection: () => ({ driver: 'driver-a', settings: [] as never, credentials: {} }) }),
    ]) {
      registerManagedCreditsHost(h);
      const error = await load().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ManagedProviderError);
      expect((error as Error).message).toBe('This provider is not available right now.');
    }
  });

  it('leaves a non-managed record and a no-host deployment unchanged', async () => {
    registerManagedCreditsHost(host({ resolveConnection: () => connection }));
    hoisted.db.findProviderByKey.mockResolvedValue(provider());
    const own = await load();
    expect(own.credentials).toEqual({ apiKey: 'tenant-secret' });
    expect(own.managedConnection).toBeUndefined();
    resetManagedCreditsHostForTests();
    hoisted.db.findProviderByKey.mockResolvedValue(provider({ key: 'platform', settings: { managed: true } }));
    expect((await load()).credentials).toEqual({ apiKey: 'tenant-secret' });
  });
});

describe('listProviderConfigs view', () => {
  it('carries platform with a default of false', async () => {
    hoisted.db.listProviders.mockResolvedValue([provider(), wideProvider()]);
    const views = await listProviderConfigs('db', 'tenant-1', { projectId: 'p1' });
    expect(views.map((v) => v.platform)).toEqual([false, true]);
  });
});

describe('replicas cannot route a tenant model onto a platform provider', () => {
  it('refuses a replica naming a platform provider, accepts an ordinary one', async () => {
    hoisted.db.findProviderByKey.mockImplementation(async (_t: string, key: string) =>
      key === 'platform' ? wideProvider({ settings: {} }) : provider({ key }));
    await expect(
      updateModel('db', 'p1', 'model-1', { replicas: [{ providerKey: 'platform' }] } as never),
    ).rejects.toBeInstanceOf(PlatformRecordReadOnlyError);
    expect(hoisted.db.updateModel).not.toHaveBeenCalled();
    await expect(
      updateModel('db', 'p1', 'model-1', { replicas: [{ providerKey: 'second' }] } as never),
    ).resolves.toBeTruthy();
  });

  it('refuses a replica naming a managed provider with no platform flag', async () => {
    registerManagedCreditsHost(host());
    hoisted.db.findProviderByKey.mockResolvedValue(provider({ key: 'm', settings: { managed: true } }));
    await expect(
      updateModel('db', 'p1', 'model-1', { replicas: [{ providerKey: 'm' }] } as never),
    ).rejects.toBeInstanceOf(PlatformRecordReadOnlyError);
  });
});

describe('redactPlatformProvider', () => {
  it('keeps identity fields of a platform view and passes an ordinary view through', () => {
    const wide = { ...wideProvider({ projectIds: ['p1'] }), hasCredentials: true, description: 'd', metadata: { a: 1 } } as never;
    const out = redactPlatformProvider(wide) as unknown as Record<string, unknown>;
    expect(out).toMatchObject({ key: 'platform', platform: true, projectIds: ['p1'], settings: {} });
    expect(out).not.toHaveProperty('metadata');
    expect(out).not.toHaveProperty('description');
    const plain = { ...provider(), platform: false, hasCredentials: true } as never;
    expect(redactPlatformProvider(plain)).toBe(plain);
  });
});

describe('adding platform models to a project, one by one', () => {
  const platformModel = (key: string, overrides: Record<string, unknown> = {}) => model({
    _id: `id-${key}`, key, projectId: undefined, platform: true, providerKey: 'platform', projectIds: [], ...overrides,
  });
  const assigned = (projectIds: string[]) => wideProvider({ projectIds });

  beforeEach(() => {
    cacheDel.mockReset();
    hoisted.db.listModels.mockReset().mockResolvedValue([
      platformModel('a'),
      platformModel('b', { projectIds: ['p1'] }),
      platformModel('off', { metadata: { inactive: true } }),
      model({ key: 'own-m', providerKey: 'own' }),
    ]);
    hoisted.db.findProviderByKey.mockReset().mockResolvedValue(assigned(['p1']));
  });

  it('adds the project to the model, keeps the other projects, and drops the project caches of those keys', async () => {
    await expect(addPlatformModelsToProject('db', 'tenant-1', 'p1', ['a', 'b'], 'u1')).resolves.toEqual(['a', 'b']);
    // `b` already has p1: idempotent, written once for `a` only.
    expect(hoisted.db.updateModel).toHaveBeenCalledTimes(1);
    expect(hoisted.db.updateModel).toHaveBeenCalledWith('id-a', { projectIds: ['p1'] });
    expect(cacheDel).toHaveBeenCalledWith('model-meta:db:p1:a');
    expect(cacheDel).toHaveBeenCalledWith('model-meta:db:p1:b');
  });

  it('keeps the projects the model was added to elsewhere', async () => {
    hoisted.db.listModels.mockResolvedValue([platformModel('a', { projectIds: ['p9'] })]);
    await addPlatformModelsToProject('db', 'tenant-1', 'p1', ['a']);
    expect(hoisted.db.updateModel).toHaveBeenCalledWith('id-a', { projectIds: ['p9', 'p1'] });
  });

  it('refuses a model whose provider is not assigned to the project (409), writing nothing', async () => {
    hoisted.db.findProviderByKey.mockResolvedValue(assigned(['p2']));
    const error = await addPlatformModelsToProject('db', 'tenant-1', 'p1', ['a']).catch((e) => e);
    expect(error).toBeInstanceOf(PlatformModelSelectionError);
    expect(error).toMatchObject({ status: 409, code: 'provider_not_in_project', message: 'Make the provider available in this project first.' });
    expect(hoisted.db.updateModel).not.toHaveBeenCalled();
  });

  it('refuses an unavailable model (409) and an unknown or non-platform key (404), writing nothing, even if another key is fine', async () => {
    await expect(addPlatformModelsToProject('db', 'tenant-1', 'p1', ['a', 'off'])).rejects.toMatchObject({ status: 409, code: 'model_unavailable' });
    await expect(addPlatformModelsToProject('db', 'tenant-1', 'p1', ['a', 'own-m'])).rejects.toMatchObject({ status: 404, code: 'platform_model_not_found' });
    await expect(addPlatformModelsToProject('db', 'tenant-1', 'p1', ['nope'])).rejects.toMatchObject({ status: 404 });
    expect(hoisted.db.updateModel).not.toHaveBeenCalled();
  });

  it('does not take another tenant\'s platform model', async () => {
    hoisted.db.listModels.mockResolvedValue([platformModel('a', { tenantId: 'tenant-2' })]);
    await expect(addPlatformModelsToProject('db', 'tenant-1', 'p1', ['a'])).rejects.toMatchObject({ status: 404 });
  });

  it('removes the project from the model, never deletes the record, and is idempotent', async () => {
    await removePlatformModelFromProject('db', 'tenant-1', 'p1', 'b', 'u1');
    expect(hoisted.db.updateModel).toHaveBeenCalledWith('id-b', { projectIds: [] });
    expect(hoisted.db.deleteModel).not.toHaveBeenCalled();
    expect(cacheDel).toHaveBeenCalledWith('model-meta:db:p1:b');
    hoisted.db.updateModel.mockClear();
    await removePlatformModelFromProject('db', 'tenant-1', 'p1', 'a');
    expect(hoisted.db.updateModel).not.toHaveBeenCalled();
    await expect(removePlatformModelFromProject('db', 'tenant-1', 'p1', 'own-m')).rejects.toMatchObject({ status: 404 });
  });
});
