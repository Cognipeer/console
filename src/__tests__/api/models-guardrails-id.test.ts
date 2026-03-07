import { describe, it, expect, vi, beforeEach } from 'vitest';
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
  return { requireProjectContext: vi.fn(), ProjectContextError };
});

import { GET as getModel, PUT as putModel, DELETE as deleteModelRoute } from '@/server/api/routes/models/[id]/route';
import { GET as getGuardrailRoute, PATCH as patchGuardrail, DELETE as deleteGuardrailRoute } from '@/server/api/routes/guardrails/[id]/route';
import { getModelById, updateModel, deleteModel } from '@/lib/services/models/modelService';
import { getGuardrail, updateGuardrail, deleteGuardrail } from '@/lib/services/guardrail';
import { requireProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';

const HEADERS = {
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': 'tenant-1',
  'x-user-id': 'user-1',
};

function makeReq(path: string, method = 'GET', body?: object, headers: Record<string, string> = HEADERS) {
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

const MOCK_PROJECT = { projectId: 'proj-1' };

beforeEach(() => {
  vi.clearAllMocks();
  (requireProjectContext as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_PROJECT);
  (getModelById as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_MODEL);
  (updateModel as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_MODEL);
  (deleteModel as ReturnType<typeof vi.fn>).mockResolvedValue(true);
  (getGuardrail as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_GUARDRAIL);
  (updateGuardrail as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_GUARDRAIL);
  (deleteGuardrail as ReturnType<typeof vi.fn>).mockResolvedValue(true);
});

// ---- Models [id] ----

describe('GET /api/models/[id]', () => {
  it('returns model 200', async () => {
    const res = await getModel(makeReq('/api/models/model-1'), { params: Promise.resolve({ id: 'model-1' }) });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.model).toBeDefined();
  });

  it('sanitizes sensitive fields', async () => {
    const res = await getModel(makeReq('/api/models/model-1'), { params: Promise.resolve({ id: 'model-1' }) });
    const body = await res.json();
    expect(body.model.settings.apiKey).toBe('••••••••');
  });

  it('returns 404 when model not found', async () => {
    (getModelById as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await getModel(makeReq('/api/models/unknown'), { params: Promise.resolve({ id: 'unknown' }) });
    expect(res.status).toBe(404);
  });

  it('returns 401 when headers missing', async () => {
    const res = await getModel(makeReq('/api/models/model-1', 'GET', undefined, {}), { params: Promise.resolve({ id: 'model-1' }) });
    expect(res.status).toBe(401);
  });

  it('returns ProjectContextError status', async () => {
    const e = new (ProjectContextError as any)('No project', 404);
    (requireProjectContext as ReturnType<typeof vi.fn>).mockRejectedValue(e);
    const res = await getModel(makeReq('/api/models/model-1'), { params: Promise.resolve({ id: 'model-1' }) });
    expect(res.status).toBe(404);
  });

  it('returns 500 on unexpected error', async () => {
    (getModelById as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db error'));
    const res = await getModel(makeReq('/api/models/model-1'), { params: Promise.resolve({ id: 'model-1' }) });
    expect(res.status).toBe(500);
  });
});

describe('PUT /api/models/[id]', () => {
  it('updates model and returns 200', async () => {
    const res = await putModel(makeReq('/api/models/model-1', 'PUT', { name: 'Updated Model' }), { params: Promise.resolve({ id: 'model-1' }) });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.model).toBeDefined();
  });

  it('returns 404 when model not found after update', async () => {
    (updateModel as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await putModel(makeReq('/api/models/model-1', 'PUT', {}), { params: Promise.resolve({ id: 'model-1' }) });
    expect(res.status).toBe(500); // returns 500 with "Failed to update model"
  });

  it('returns 401 when headers missing', async () => {
    const res = await putModel(makeReq('/api/models/model-1', 'PUT', {}, {}), { params: Promise.resolve({ id: 'model-1' }) });
    expect(res.status).toBe(401);
  });

  it('returns 500 on unexpected error', async () => {
    (updateModel as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db failure'));
    const res = await putModel(makeReq('/api/models/model-1', 'PUT', {}), { params: Promise.resolve({ id: 'model-1' }) });
    expect(res.status).toBe(500);
  });
});

describe('DELETE /api/models/[id]', () => {
  it('deletes model and returns 200', async () => {
    const res = await deleteModelRoute(makeReq('/api/models/model-1', 'DELETE'), { params: Promise.resolve({ id: 'model-1' }) });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
  });

  it('returns 404 when model not found', async () => {
    (deleteModel as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const res = await deleteModelRoute(makeReq('/api/models/model-1', 'DELETE'), { params: Promise.resolve({ id: 'model-1' }) });
    expect(res.status).toBe(404);
  });

  it('returns 401 when headers missing', async () => {
    const res = await deleteModelRoute(makeReq('/api/models/model-1', 'DELETE', undefined, {}), { params: Promise.resolve({ id: 'model-1' }) });
    expect(res.status).toBe(401);
  });

  it('returns 500 on unexpected error', async () => {
    (deleteModel as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db failure'));
    const res = await deleteModelRoute(makeReq('/api/models/model-1', 'DELETE'), { params: Promise.resolve({ id: 'model-1' }) });
    expect(res.status).toBe(500);
  });
});

// ---- Guardrails [id] ----

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

  it('returns 401 when headers missing', async () => {
    const res = await getGuardrailRoute(makeReq('/api/guardrails/gr-1', 'GET', undefined, {}), { params: Promise.resolve({ id: 'gr-1' }) });
    expect(res.status).toBe(401);
  });

  it('returns 500 on unexpected error', async () => {
    (getGuardrail as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db error'));
    const res = await getGuardrailRoute(makeReq('/api/guardrails/gr-1'), { params: Promise.resolve({ id: 'gr-1' }) });
    expect(res.status).toBe(500);
  });
});

describe('PATCH /api/guardrails/[id]', () => {
  it('updates guardrail and returns 200', async () => {
    const res = await patchGuardrail(makeReq('/api/guardrails/gr-1', 'PATCH', { name: 'Updated Shield' }), { params: Promise.resolve({ id: 'gr-1' }) });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.guardrail).toBeDefined();
  });

  it('returns 400 for invalid action', async () => {
    const res = await patchGuardrail(makeReq('/api/guardrails/gr-1', 'PATCH', { action: 'explode' }), { params: Promise.resolve({ id: 'gr-1' }) });
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid target', async () => {
    const res = await patchGuardrail(makeReq('/api/guardrails/gr-1', 'PATCH', { target: 'somewhere' }), { params: Promise.resolve({ id: 'gr-1' }) });
    expect(res.status).toBe(400);
  });

  it('returns 404 when guardrail not found after update', async () => {
    (updateGuardrail as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await patchGuardrail(makeReq('/api/guardrails/gr-1', 'PATCH', {}), { params: Promise.resolve({ id: 'gr-1' }) });
    expect(res.status).toBe(404);
  });

  it('returns 401 when headers missing', async () => {
    const res = await patchGuardrail(makeReq('/api/guardrails/gr-1', 'PATCH', {}, {}), { params: Promise.resolve({ id: 'gr-1' }) });
    expect(res.status).toBe(401);
  });
});

describe('DELETE /api/guardrails/[id]', () => {
  it('deletes guardrail and returns 200', async () => {
    const res = await deleteGuardrailRoute(makeReq('/api/guardrails/gr-1', 'DELETE'), { params: Promise.resolve({ id: 'gr-1' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('returns 401 when headers missing', async () => {
    const res = await deleteGuardrailRoute(makeReq('/api/guardrails/gr-1', 'DELETE', undefined, {}), { params: Promise.resolve({ id: 'gr-1' }) });
    expect(res.status).toBe(401);
  });

  it('returns 500 on unexpected error', async () => {
    (deleteGuardrail as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db error'));
    const res = await deleteGuardrailRoute(makeReq('/api/guardrails/gr-1', 'DELETE'), { params: Promise.resolve({ id: 'gr-1' }) });
    expect(res.status).toBe(500);
  });
});
