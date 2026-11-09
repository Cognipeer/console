/**
 * A platform-provided record refused by the model service answers 403 with code platform_record_read_only on the
 * dashboard routes (create, delete) of /api/models; the model view carries platform. Inactive platform
 * models are left out unless asked for (then marked unavailable); platform providers are listed on request.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/database', () => {
  const getDatabase = vi.fn();
  return {
    getDatabase,
    runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(await getDatabase()),
  };
});
vi.mock('@/lib/services/models/modelService', () => ({
  listModels: vi.fn(),
  createModel: vi.fn(),
  deleteModel: vi.fn(),
  updateModel: vi.fn(),
  getModelById: vi.fn(),
  addPlatformModelsToProject: vi.fn(),
  removePlatformModelFromProject: vi.fn(),
  listModelProviders: vi.fn(),
  listPlatformModelProviders: vi.fn(),
}));
vi.mock('@/lib/quota', () => ({ checkResourceQuota: vi.fn() }));
vi.mock('@/lib/services/projects/projectContext', () => {
  class ProjectContextError extends Error {
    status: number;
    constructor(msg: string, status: number) {
      super(msg);
      this.status = status;
    }
  }
  return { resolveProjectContext: vi.fn(), ProjectContextError };
});

import {
  addPlatformModelsToProject,
  createModel,
  deleteModel,
  getModelById,
  listModels,
  listModelProviders,
  listPlatformModelProviders,
  removePlatformModelFromProject,
  updateModel,
} from '@/lib/services/models/modelService';
import { PlatformModelSelectionError, PlatformRecordReadOnlyError } from '@/lib/services/providers/managedProviderErrors';
import { checkResourceQuota } from '@/lib/quota';
import { resolveProjectContext } from '@/lib/services/projects/projectContext';
import { modelsApiPlugin } from '@/server/api/plugins/models';
import { getDatabase } from '@/lib/database';
import { createMockDb } from '../helpers/db.mock';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const HEADERS = {
  'content-type': 'application/json',
  'x-license-type': 'STARTER',
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': 'tenant-1',
  'x-tenant-slug': 'acme',
  'x-user-id': 'user-1',
  'x-user-role': 'owner',
};

describe('/api/models and platform records', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    (resolveProjectContext as ReturnType<typeof vi.fn>).mockResolvedValue({
      projectId: 'proj-1',
      project: { _id: 'proj-1', name: 'Default' },
      user: { _id: 'user-1', role: 'owner', projectIds: ['proj-1'] },
    });
    (checkResourceQuota as ReturnType<typeof vi.fn>).mockResolvedValue({ allowed: true });
    (listModelProviders as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (listModels as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const rbacDb = createMockDb();
    rbacDb.findUserById.mockResolvedValue({ _id: 'user-1', role: 'owner', tenantId: 'tenant-1' } as never);
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(rbacDb);
    app = await createFastifyApiTestApp(modelsApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  it('answers 403 with the platform code on delete', async () => {
    (deleteModel as ReturnType<typeof vi.fn>).mockRejectedValue(new PlatformRecordReadOnlyError());
    const res = await app.inject({ method: 'DELETE', url: '/api/models/model-1', headers: { ...HEADERS, 'content-type': undefined as never } });
    expect(res.statusCode).toBe(403);
    expect(parseJsonBody<{ code: string }>(res.body).code).toBe('platform_record_read_only');
  });

  it('deleting a platform model removes it from the active project and never deletes the record', async () => {
    (getModelById as ReturnType<typeof vi.fn>).mockResolvedValue({ _id: 'pm-1', key: 'plat-a', platform: true });
    const res = await app.inject({ method: 'DELETE', url: '/api/models/pm-1', headers: { ...HEADERS, 'content-type': undefined as never } });
    expect(res.statusCode).toBe(200);
    expect(parseJsonBody<{ removed: boolean }>(res.body).removed).toBe(true);
    expect(removePlatformModelFromProject).toHaveBeenCalledWith('tenant_acme', 'tenant-1', 'proj-1', 'plat-a', 'user-1');
    expect(deleteModel).not.toHaveBeenCalled();
  });

  it('keeps answering 403 when a platform model is changed', async () => {
    (updateModel as ReturnType<typeof vi.fn>).mockRejectedValue(new PlatformRecordReadOnlyError());
    const res = await app.inject({ method: 'PUT', url: '/api/models/pm-1', headers: HEADERS, payload: JSON.stringify({ name: 'X' }) });
    expect(res.statusCode).toBe(403);
    expect(parseJsonBody<{ code: string }>(res.body).code).toBe('platform_record_read_only');
  });

  it('adds platform models to the active project by key', async () => {
    (addPlatformModelsToProject as ReturnType<typeof vi.fn>).mockResolvedValue(['a', 'b']);
    const res = await app.inject({ method: 'POST', url: '/api/models/platform/add', headers: HEADERS, payload: JSON.stringify({ keys: ['a', 'b'] }) });
    expect(res.statusCode).toBe(200);
    expect(parseJsonBody<{ added: string[] }>(res.body).added).toEqual(['a', 'b']);
    expect(addPlatformModelsToProject).toHaveBeenCalledWith('tenant_acme', 'tenant-1', 'proj-1', ['a', 'b'], 'user-1');
  });

  it('refuses an add without keys (400) and answers the typed refusals of the service', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/models/platform/add', headers: HEADERS, payload: JSON.stringify({ keys: [] }) });
    expect(bad.statusCode).toBe(400);
    (addPlatformModelsToProject as ReturnType<typeof vi.fn>).mockRejectedValue(
      new PlatformModelSelectionError('provider_not_in_project', 'Make the provider available in this project first.', 409, 'a'),
    );
    const res = await app.inject({ method: 'POST', url: '/api/models/platform/add', headers: HEADERS, payload: JSON.stringify({ keys: ['a'] }) });
    expect(res.statusCode).toBe(409);
    expect(parseJsonBody<{ code: string }>(res.body).code).toBe('provider_not_in_project');
  });

  it('answers 403 when a model is added to a platform provider', async () => {
    (createModel as ReturnType<typeof vi.fn>).mockRejectedValue(
      new PlatformRecordReadOnlyError('Models cannot be added to a platform provider.'),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/models',
      headers: HEADERS,
      payload: JSON.stringify({ name: 'M', providerKey: 'platform', category: 'llm', modelId: 'x', pricing: { inputTokenPer1M: 1, outputTokenPer1M: 1 }, settings: {} }),
    });
    expect(res.statusCode).toBe(403);
    expect(parseJsonBody<{ error: string }>(res.body).error).toBe('Models cannot be added to a platform provider.');
  });

  it('lists a model with platform as a boolean, false by default', async () => {
    (listModels as ReturnType<typeof vi.fn>).mockResolvedValue([
      { _id: 'a', name: 'A', key: 'a', category: 'llm', settings: {} },
      { _id: 'b', name: 'B', key: 'b', category: 'llm', settings: {}, platform: true },
    ]);
    const res = await app.inject({ method: 'GET', url: '/api/models', headers: HEADERS });
    const body = parseJsonBody<{ models: Array<{ platform: boolean }> }>(res.body);
    expect(body.models.map((m) => m.platform)).toEqual([false, true]);
  });

  it('leaves out inactive platform models unless includeUnavailable, then marks them unavailable', async () => {
    (listModels as ReturnType<typeof vi.fn>).mockResolvedValue([
      { _id: 'a', name: 'A', key: 'a', category: 'llm', settings: {}, platform: true },
      { _id: 'b', name: 'B', key: 'b', category: 'llm', settings: {}, platform: true, metadata: { inactive: true } },
      { _id: 'c', name: 'C', key: 'c', category: 'llm', settings: {}, metadata: { inactive: true } },
    ]);
    const plain = await app.inject({ method: 'GET', url: '/api/models', headers: HEADERS });
    expect(parseJsonBody<{ models: Array<{ key: string }> }>(plain.body).models.map((m) => m.key)).toEqual(['a', 'c']);
    const all = await app.inject({ method: 'GET', url: '/api/models?includeUnavailable=true', headers: HEADERS });
    const models = parseJsonBody<{ models: Array<{ key: string; unavailable?: boolean }> }>(all.body).models;
    expect(models.map((m) => [m.key, m.unavailable])).toEqual([['a', undefined], ['b', true], ['c', undefined]]);
  });

  it('returns platformProviders with the assigned flag on includeProviders + includePlatform only', async () => {
    const assigned = { _id: 'pp1', tenantId: 'tenant-1', key: 'plat-a', type: 'model', driver: 'openai', label: 'A', status: 'active', platform: true, projectIds: ['proj-1'], settings: { secret: 1 }, description: 'internal' };
    const other = { ...assigned, _id: 'pp2', key: 'plat-b', label: 'B', projectIds: [] };
    (listModelProviders as ReturnType<typeof vi.fn>).mockResolvedValue([assigned]);
    (listPlatformModelProviders as ReturnType<typeof vi.fn>).mockResolvedValue([assigned, other]);

    const withPlatform = await app.inject({ method: 'GET', url: '/api/models?includeProviders=true&includePlatform=true', headers: HEADERS });
    const body = parseJsonBody<{ providers: Array<{ key: string }>; platformProviders: Array<Record<string, unknown>> }>(withPlatform.body);
    expect(body.providers.map((p) => p.key)).toEqual(['plat-a']);
    expect(body.platformProviders.map((p) => [p.key, p.assigned])).toEqual([['plat-a', true], ['plat-b', false]]);
    for (const p of body.platformProviders) {
      expect(p).toMatchObject({ platform: true, settings: {} });
      expect(p).not.toHaveProperty('description');
    }

    const without = await app.inject({ method: 'GET', url: '/api/models?includeProviders=true', headers: HEADERS });
    expect(parseJsonBody<Record<string, unknown>>(without.body)).not.toHaveProperty('platformProviders');
    const noProviders = await app.inject({ method: 'GET', url: '/api/models?includePlatform=true', headers: HEADERS });
    expect(parseJsonBody<Record<string, unknown>>(noProviders.body)).not.toHaveProperty('platformProviders');
  });
});
