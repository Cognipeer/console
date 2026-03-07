import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/models/modelService', () => ({
  listModels: vi.fn(),
  createModel: vi.fn(),
  listModelProviders: vi.fn(),
}));

vi.mock('@/lib/quota', () => ({
  checkResourceQuota: vi.fn(),
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

import { listModels, createModel, listModelProviders } from '@/lib/services/models/modelService';
import { checkResourceQuota } from '@/lib/quota';
import { resolveProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';
import { modelsApiPlugin } from '@/server/api/plugins/models';
import {
  createFastifyApiTestApp,
  parseJsonBody,
} from '../helpers/fastify-api';

const HEADERS = {
  'content-type': 'application/json',
  'x-license-type': 'STARTER',
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': 'tenant-1',
  'x-tenant-slug': 'acme',
  'x-user-id': 'user-1',
  'x-user-role': 'owner',
};

const MOCK_PROJECT_CONTEXT = {
  projectId: 'proj-1',
  project: { _id: 'proj-1', name: 'Default' },
  user: { _id: 'user-1', role: 'owner', projectIds: ['proj-1'] },
};
const MOCK_MODEL = {
  _id: 'model-1',
  name: 'GPT-4',
  providerKey: 'openai-prov',
  category: 'llm',
  modelId: 'gpt-4',
  pricing: { input: 0.01, output: 0.03 },
  settings: { temperature: 0.7, apiKey: 'sk-secret' },
};

describe('/api/models', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    (resolveProjectContext as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_PROJECT_CONTEXT);
    (listModels as ReturnType<typeof vi.fn>).mockResolvedValue([MOCK_MODEL]);
    (createModel as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_MODEL);
    (checkResourceQuota as ReturnType<typeof vi.fn>).mockResolvedValue({ allowed: true });
    (listModelProviders as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    app = await createFastifyApiTestApp(modelsApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  function injectGet(path: string, headers: Record<string, string> = HEADERS) {
    return app.inject({ method: 'GET', url: path, headers });
  }

  function injectPost(
    body: object,
    headers: Record<string, string> = HEADERS,
  ) {
    return app.inject({
      method: 'POST',
      url: '/api/models',
      headers,
      payload: JSON.stringify(body),
    });
  }

  describe('GET /api/models', () => {
    it('returns models list 200', async () => {
      const res = await injectGet('/api/models');
      const body = parseJsonBody<{ models: Array<{ settings: { apiKey: string } }> }>(res.body);
      expect(res.statusCode).toBe(200);
      expect(body.models).toHaveLength(1);
      expect(body.models[0].settings.apiKey).toBe('••••••••');
    });

    it('passes category filter to listModels', async () => {
      await injectGet('/api/models?category=embedding');
      expect(listModels).toHaveBeenCalledWith(
        'tenant_acme',
        'proj-1',
        expect.objectContaining({ category: 'embedding' }),
      );
    });

    it('includes providers when includeProviders=true', async () => {
      (listModelProviders as ReturnType<typeof vi.fn>).mockResolvedValue([{ key: 'p1' }]);
      const res = await injectGet('/api/models?includeProviders=true');
      const body = parseJsonBody<{ providers: Array<{ key: string }> }>(res.body);
      expect(body.providers).toHaveLength(1);
    });

    it('returns 401 when required headers missing', async () => {
      const res = await injectGet('/api/models', {
        'content-type': 'application/json',
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns ProjectContextError status', async () => {
      const ProjectError = ProjectContextError as unknown as new (message: string, status: number) => Error;
      const error = new ProjectError('No project', 404);
      (resolveProjectContext as ReturnType<typeof vi.fn>).mockRejectedValue(error);
      const res = await injectGet('/api/models');
      expect(res.statusCode).toBe(404);
    });

    it('returns 500 on unexpected error', async () => {
      (listModels as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db error'));
      const res = await injectGet('/api/models');
      expect(res.statusCode).toBe(500);
    });
  });

  describe('POST /api/models', () => {
    const VALID_BODY = {
      name: 'GPT-4',
      providerKey: 'openai-prov',
      category: 'llm',
      modelId: 'gpt-4',
      pricing: { input: 0.01, output: 0.03 },
      settings: { temperature: 0.7 },
    };

    it('creates model and returns 201', async () => {
      const res = await injectPost(VALID_BODY);
      const body = parseJsonBody<{ model: { settings: { apiKey: string } } }>(res.body);
      expect(res.statusCode).toBe(201);
      expect(body.model).toBeDefined();
      expect(body.model.settings.apiKey).toBe('••••••••');
    });

    it('returns 401 when headers missing', async () => {
      const res = await injectPost(VALID_BODY, {
        'content-type': 'application/json',
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 400 when a required field is missing', async () => {
      const rest = { ...VALID_BODY, name: undefined };
      const res = await injectPost(rest);
      expect(res.statusCode).toBe(400);
      const body = parseJsonBody<{ error: string }>(res.body);
      expect(body.error).toContain('name');
    });

    it('returns 429 when quota exceeded', async () => {
      (checkResourceQuota as ReturnType<typeof vi.fn>).mockResolvedValue({
        allowed: false,
        reason: 'Model quota exceeded',
      });
      const res = await injectPost(VALID_BODY);
      expect(res.statusCode).toBe(429);
    });

    it('passes correct args to createModel', async () => {
      await injectPost({ ...VALID_BODY, description: 'My model' });
      expect(createModel).toHaveBeenCalledWith(
        'tenant_acme',
        'tenant-1',
        'proj-1',
        'user-1',
        expect.objectContaining({ name: 'GPT-4', description: 'My model' }),
      );
    });

    it('returns ProjectContextError status on POST', async () => {
      const ProjectError = ProjectContextError as unknown as new (message: string, status: number) => Error;
      const error = new ProjectError('Forbidden', 403);
      (resolveProjectContext as ReturnType<typeof vi.fn>).mockRejectedValue(error);
      const res = await injectPost(VALID_BODY);
      expect(res.statusCode).toBe(403);
    });

    it('returns 500 on unexpected error', async () => {
      (createModel as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db error'));
      const res = await injectPost(VALID_BODY);
      expect(res.statusCode).toBe(500);
    });
  });
});
