/**
 * A platform-provided record refused by the model service answers 403 with code platform_record_read_only on the
 * dashboard routes (create, delete) of /api/models; the model view carries allProjects.
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
  listModelProviders: vi.fn(),
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

import { createModel, deleteModel, listModels, listModelProviders } from '@/lib/services/models/modelService';
import { PlatformRecordReadOnlyError } from '@/lib/services/providers/managedProviderErrors';
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

  it('lists a model with allProjects as a boolean, false by default', async () => {
    (listModels as ReturnType<typeof vi.fn>).mockResolvedValue([
      { _id: 'a', name: 'A', key: 'a', category: 'llm', settings: {} },
      { _id: 'b', name: 'B', key: 'b', category: 'llm', settings: {}, allProjects: true },
    ]);
    const res = await app.inject({ method: 'GET', url: '/api/models', headers: HEADERS });
    const body = parseJsonBody<{ models: Array<{ allProjects: boolean }> }>(res.body);
    expect(body.models.map((m) => m.allProjects)).toEqual([false, true]);
  });
});
