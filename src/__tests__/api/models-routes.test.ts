import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

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
  return { requireProjectContext: vi.fn(), ProjectContextError };
});

import { GET, POST } from '@/server/api/routes/models/route';
import { listModels, createModel, listModelProviders } from '@/lib/services/models/modelService';
import { checkResourceQuota } from '@/lib/quota';
import { requireProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';

const HEADERS = {
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': 'tenant-1',
  'x-user-id': 'user-1',
  'x-user-role': 'owner',
  'x-license-type': 'STARTER',
};

function makeReq(path: string, method = 'GET', body?: object, headers: Record<string, string> = HEADERS) {
  const url = `http://localhost${path}`;
  return new NextRequest(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

const MOCK_PROJECT_CONTEXT = { projectId: 'proj-1', project: { _id: 'proj-1', name: 'Default' } };
const MOCK_MODEL = {
  _id: 'model-1',
  name: 'GPT-4',
  providerKey: 'openai-prov',
  category: 'llm',
  modelId: 'gpt-4',
  pricing: { input: 0.01, output: 0.03 },
  settings: { temperature: 0.7, apiKey: 'sk-secret' },
};

beforeEach(() => {
  vi.clearAllMocks();
  (requireProjectContext as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_PROJECT_CONTEXT);
  (listModels as ReturnType<typeof vi.fn>).mockResolvedValue([MOCK_MODEL]);
  (createModel as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_MODEL);
  (checkResourceQuota as ReturnType<typeof vi.fn>).mockResolvedValue({ allowed: true });
  (listModelProviders as ReturnType<typeof vi.fn>).mockResolvedValue([]);
});

describe('GET /api/models', () => {
  it('returns models list 200', async () => {
    const req = makeReq('/api/models');
    const res = await GET(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.models).toHaveLength(1);
  });

  it('sanitizes sensitive settings fields', async () => {
    const req = makeReq('/api/models');
    const res = await GET(req);
    const body = await res.json();
    expect(body.models[0].settings.apiKey).toBe('••••••••');
    expect(body.models[0].settings.temperature).toBe(0.7);
  });

  it('returns 401 when x-tenant-db-name is missing', async () => {
    const req = makeReq('/api/models', 'GET', undefined, {
      'x-tenant-id': 'tenant-1',
      'x-user-id': 'user-1',
    });
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('returns 401 when x-tenant-id is missing', async () => {
    const req = makeReq('/api/models', 'GET', undefined, {
      'x-tenant-db-name': 'tenant_acme',
      'x-user-id': 'user-1',
    });
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('passes category filter to listModels', async () => {
    const req = makeReq('/api/models?category=embedding');
    await GET(req);
    expect(listModels).toHaveBeenCalledWith('tenant_acme', 'proj-1', expect.objectContaining({ category: 'embedding' }));
  });

  it('passes providerKey filter to listModels', async () => {
    const req = makeReq('/api/models?providerKey=openai-prov');
    await GET(req);
    expect(listModels).toHaveBeenCalledWith('tenant_acme', 'proj-1', expect.objectContaining({ providerKey: 'openai-prov' }));
  });

  it('includes providers when includeProviders=true', async () => {
    (listModelProviders as ReturnType<typeof vi.fn>).mockResolvedValue([{ key: 'p1' }]);
    const req = makeReq('/api/models?includeProviders=true');
    const res = await GET(req);
    const body = await res.json();
    expect(body.providers).toHaveLength(1);
  });

  it('returns ProjectContextError status', async () => {
    const e = new (ProjectContextError as any)('No project', 404);
    (requireProjectContext as ReturnType<typeof vi.fn>).mockRejectedValue(e);
    const req = makeReq('/api/models');
    const res = await GET(req);
    expect(res.status).toBe(404);
  });

  it('returns 500 on unexpected error', async () => {
    (listModels as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db error'));
    const req = makeReq('/api/models');
    const res = await GET(req);
    expect(res.status).toBe(500);
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
    const req = makeReq('/api/models', 'POST', VALID_BODY);
    const res = await POST(req);
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.model).toBeDefined();
  });

  it('returns 401 when headers missing', async () => {
    const req = makeReq('/api/models', 'POST', VALID_BODY, {});
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('returns 401 when license header missing', async () => {
    const req = makeReq('/api/models', 'POST', VALID_BODY, {
      'x-tenant-db-name': 'tenant_acme',
      'x-tenant-id': 'tenant-1',
      'x-user-id': 'user-1',
      'x-user-role': 'owner',
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('returns 400 when name is missing', async () => {
    const { name: _omit, ...rest } = VALID_BODY;
    const req = makeReq('/api/models', 'POST', rest);
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('name');
  });

  it('returns 400 when providerKey is missing', async () => {
    const { providerKey: _omit, ...rest } = VALID_BODY;
    const req = makeReq('/api/models', 'POST', rest);
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 when category is missing', async () => {
    const { category: _omit, ...rest } = VALID_BODY;
    const req = makeReq('/api/models', 'POST', rest);
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 429 when quota exceeded', async () => {
    (checkResourceQuota as ReturnType<typeof vi.fn>).mockResolvedValue({ allowed: false, reason: 'Model quota exceeded' });
    const req = makeReq('/api/models', 'POST', VALID_BODY);
    const res = await POST(req);
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toContain('Model quota exceeded');
  });

  it('returns 429 with default message when quota reason absent', async () => {
    (checkResourceQuota as ReturnType<typeof vi.fn>).mockResolvedValue({ allowed: false });
    const req = makeReq('/api/models', 'POST', VALID_BODY);
    const res = await POST(req);
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toContain('quota');
  });

  it('passes correct args to createModel', async () => {
    const req = makeReq('/api/models', 'POST', { ...VALID_BODY, description: 'My model' });
    await POST(req);
    expect(createModel).toHaveBeenCalledWith(
      'tenant_acme',
      'tenant-1',
      'proj-1',
      'user-1',
      expect.objectContaining({ name: 'GPT-4', description: 'My model' }),
    );
  });

  it('sanitizes sensitive fields in returned model', async () => {
    const req = makeReq('/api/models', 'POST', VALID_BODY);
    const res = await POST(req);
    const body = await res.json();
    expect(body.model.settings.apiKey).toBe('••••••••');
  });

  it('returns ProjectContextError status on POST', async () => {
    const e = new (ProjectContextError as any)('Forbidden', 403);
    (requireProjectContext as ReturnType<typeof vi.fn>).mockRejectedValue(e);
    const req = makeReq('/api/models', 'POST', VALID_BODY);
    const res = await POST(req);
    expect(res.status).toBe(403);
  });

  it('returns 500 on unexpected error', async () => {
    (createModel as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db error'));
    const req = makeReq('/api/models', 'POST', VALID_BODY);
    const res = await POST(req);
    expect(res.status).toBe(500);
  });
});
