import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/models/modelService', () => ({
  getModelById: vi.fn(),
  updateModel: vi.fn(),
  deleteModel: vi.fn(),
}));

vi.mock('@/lib/services/guardrail', () => ({
  getGuardrail: vi.fn(),
  updateGuardrail: vi.fn(),
  deleteGuardrail: vi.fn(),
  createGuardrail: vi.fn(),
  listGuardrails: vi.fn(),
  PII_CATEGORIES: [],
  MODERATION_CATEGORIES: [],
  PROMPT_SHIELD_ISSUES: [],
  buildDefaultPresetPolicy: vi.fn(() => ({})),
}));

vi.mock('@/lib/services/projects/projectContext', () => {
  class ProjectContextError extends Error {
    status: number;
    constructor(msg: string, status: number) {
      super(msg);
      this.status = status;
    }
  }
  return {
    requireProjectContext: vi.fn(),
    resolveProjectContext: vi.fn(),
    ProjectContextError,
  };
});

import { GET as getGuardrailRoute, PATCH as patchGuardrail, DELETE as deleteGuardrailRoute } from '@/server/api/routes/guardrails/[id]/route';
import { getModelById, updateModel, deleteModel } from '@/lib/services/models/modelService';
import { getGuardrail, updateGuardrail, deleteGuardrail } from '@/lib/services/guardrail';
import { requireProjectContext, resolveProjectContext } from '@/lib/services/projects/projectContext';
import { modelsApiPlugin } from '@/server/api/plugins/models';
import {
  createFastifyApiTestApp,
  parseJsonBody,
} from '../helpers/fastify-api';

const HEADERS = {
  'x-license-type': 'FREE',
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': 'tenant-1',
  'x-tenant-slug': 'acme',
  'x-user-id': 'user-1',
  'x-user-role': 'owner',
};

function makeReq(path: string, method = 'GET', body?: object, headers: Record<string, string> = {
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': 'tenant-1',
  'x-user-id': 'user-1',
}) {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

const MOCK_MODEL = {
  _id: 'model-1', name: 'GPT-4', providerKey: 'openai',
  category: 'llm', modelId: 'gpt-4',
  settings: { temperature: 0.7, apiKey: 'sk-secret' },
};

const MOCK_GUARDRAIL = {
  _id: 'gr-1', name: 'PII Shield', type: 'preset',
  action: 'block', target: 'input', enabled: true,
};

const MOCK_PROJECT = {
  projectId: 'proj-1',
  project: { _id: 'proj-1' },
  user: { _id: 'user-1', role: 'owner', projectIds: ['proj-1'] },
};

describe('models and guardrails detail routes', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    (requireProjectContext as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_PROJECT);
    (resolveProjectContext as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_PROJECT);
    (getModelById as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_MODEL);
    (updateModel as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_MODEL);
    (deleteModel as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (getGuardrail as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_GUARDRAIL);
    (updateGuardrail as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_GUARDRAIL);
    (deleteGuardrail as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    app = await createFastifyApiTestApp(modelsApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  describe('GET /api/models/:id', () => {
    it('returns model 200', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/models/model-1', headers: HEADERS });
      expect(res.statusCode).toBe(200);
      const body = parseJsonBody<{ model: { settings: { apiKey: string } } }>(res.body);
      expect(body.model.settings.apiKey).toBe('••••••••');
    });

    it('returns 404 when model not found', async () => {
      (getModelById as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const res = await app.inject({ method: 'GET', url: '/api/models/unknown', headers: HEADERS });
      expect(res.statusCode).toBe(404);
    });

    it('returns 401 when headers missing', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/models/model-1' });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('PUT /api/models/:id', () => {
    it('updates model and returns 200', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/models/model-1',
        headers: {
          ...HEADERS,
          'content-type': 'application/json',
        },
        payload: JSON.stringify({ name: 'Updated Model' }),
      });
      expect(res.statusCode).toBe(200);
    });

    it('returns 500 when update fails', async () => {
      (updateModel as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const res = await app.inject({
        method: 'PUT',
        url: '/api/models/model-1',
        headers: {
          ...HEADERS,
          'content-type': 'application/json',
        },
        payload: JSON.stringify({}),
      });
      expect(res.statusCode).toBe(500);
    });
  });

  describe('DELETE /api/models/:id', () => {
    it('deletes model and returns 200', async () => {
      const res = await app.inject({ method: 'DELETE', url: '/api/models/model-1', headers: HEADERS });
      expect(res.statusCode).toBe(200);
      const body = parseJsonBody<{ success: boolean }>(res.body);
      expect(body.success).toBe(true);
    });

    it('returns 404 when model not found', async () => {
      (deleteModel as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      const res = await app.inject({ method: 'DELETE', url: '/api/models/model-1', headers: HEADERS });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /api/guardrails/[id]', () => {
    it('returns guardrail 200', async () => {
      const res = await getGuardrailRoute(makeReq('/api/guardrails/gr-1'), { params: Promise.resolve({ id: 'gr-1' }) });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.guardrail).toBeDefined();
    });

    it('returns 404 when guardrail not found', async () => {
      (getGuardrail as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const res = await getGuardrailRoute(makeReq('/api/guardrails/unknown'), { params: Promise.resolve({ id: 'unknown' }) });
      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /api/guardrails/[id]', () => {
    it('updates guardrail and returns 200', async () => {
      const res = await patchGuardrail(makeReq('/api/guardrails/gr-1', 'PATCH', { name: 'Updated Shield' }), { params: Promise.resolve({ id: 'gr-1' }) });
      expect(res.status).toBe(200);
    });
  });

  describe('DELETE /api/guardrails/[id]', () => {
    it('deletes guardrail and returns 200', async () => {
      const res = await deleteGuardrailRoute(makeReq('/api/guardrails/gr-1', 'DELETE'), { params: Promise.resolve({ id: 'gr-1' }) });
      expect(res.status).toBe(200);
    });
  });
});
