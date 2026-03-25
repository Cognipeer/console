import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/models/modelService', () => ({
  listModelProviders: vi.fn(),
  createModelProvider: vi.fn(),
}));

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

import { listModelProviders, createModelProvider } from '@/lib/services/models/modelService';
import { resolveProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';
import { modelsApiPlugin } from '@/server/api/plugins/models';
import {
  createFastifyApiTestApp,
  parseJsonBody,
} from '../helpers/fastify-api';

const mockContext = {
  projectId: 'project-1',
  project: { _id: 'project-1', name: 'Default' },
  user: { _id: 'user-1', role: 'owner', projectIds: ['project-1'] },
};

const mockProvider = {
  _id: 'prov-1',
  key: 'openai-1',
  label: 'OpenAI Main',
  driver: 'openai',
  status: 'active',
};

const HEADERS = {
  'content-type': 'application/json',
  'x-license-type': 'FREE',
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': 'tenant-1',
  'x-tenant-slug': 'acme',
  'x-user-id': 'user-1',
  'x-user-role': 'owner',
};

describe('/api/models/providers', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    (resolveProjectContext as ReturnType<typeof vi.fn>).mockResolvedValue(mockContext);
    app = await createFastifyApiTestApp(modelsApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns providers list', async () => {
    (listModelProviders as ReturnType<typeof vi.fn>).mockResolvedValue([mockProvider]);
    const res = await app.inject({ method: 'GET', url: '/api/models/providers', headers: HEADERS });
    expect(res.statusCode).toBe(200);
    const body = parseJsonBody<{ providers: Array<{ key: string }> }>(res.body);
    expect(body.providers[0].key).toBe('openai-1');
  });

  it('passes status and driver filters', async () => {
    (listModelProviders as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    await app.inject({
      method: 'GET',
      url: '/api/models/providers?status=active&driver=openai',
      headers: HEADERS,
    });
    expect(listModelProviders).toHaveBeenCalledWith(
      'tenant_acme',
      'tenant-1',
      'project-1',
      expect.objectContaining({ status: 'active', driver: 'openai' }),
    );
  });

  it('returns 401 when headers missing', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/models/providers' });
    expect(res.statusCode).toBe(401);
  });

  it('returns ProjectContextError status', async () => {
    const ProjectError = ProjectContextError as unknown as new (message: string, status: number) => Error;
    (resolveProjectContext as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ProjectError('No project', 400),
    );
    const res = await app.inject({ method: 'GET', url: '/api/models/providers', headers: HEADERS });
    expect(res.statusCode).toBe(400);
  });

  it('creates a provider and returns 201', async () => {
    (createModelProvider as ReturnType<typeof vi.fn>).mockResolvedValue(mockProvider);
    const res = await app.inject({
      method: 'POST',
      url: '/api/models/providers',
      headers: HEADERS,
      payload: JSON.stringify({
        key: 'openai-1',
        label: 'OpenAI Main',
        driver: 'openai',
        credentials: {},
      }),
    });
    expect(res.statusCode).toBe(201);
    const body = parseJsonBody<{ provider: { key: string } }>(res.body);
    expect(body.provider.key).toBe('openai-1');
  });

  it('returns 400 when required fields missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/models/providers',
      headers: HEADERS,
      payload: JSON.stringify({ key: 'openai-1' }),
    });
    expect(res.statusCode).toBe(400);
  });
});
