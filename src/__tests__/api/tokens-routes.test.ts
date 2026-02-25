import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockDb = vi.hoisted(() => ({
  listProjectApiTokens: vi.fn(),
  createApiToken: vi.fn(),
}));

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn().mockResolvedValue(mockDb),
}));

vi.mock('@/lib/quota/quotaGuard', () => ({
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

import { GET, POST } from '@/app/api/tokens/route';
import { checkResourceQuota } from '@/lib/quota/quotaGuard';
import { requireProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';

const HEADERS = {
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': 'tenant-1',
  'x-user-id': 'user-1',
  'x-user-role': 'owner',
  'x-license-type': 'STARTER',
};

function makeReq(path: string, method = 'GET', body?: object, headers: Record<string, string> = HEADERS) {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

const MOCK_PROJECT = { projectId: 'proj-1' };

const MOCK_TOKENS = [
  { _id: 'tok-1', label: 'My Token', userId: 'user-1', lastUsed: null },
  { _id: 'tok-2', label: 'Other Token', userId: 'user-2', lastUsed: null },
];

beforeEach(() => {
  vi.clearAllMocks();
  (requireProjectContext as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_PROJECT);
  mockDb.listProjectApiTokens.mockResolvedValue(MOCK_TOKENS);
  mockDb.createApiToken.mockResolvedValue({ _id: 'tok-new', label: 'My API Key' });
  (checkResourceQuota as ReturnType<typeof vi.fn>).mockResolvedValue({ allowed: true });
});

describe('GET /api/tokens', () => {
  it('returns tokens list 200', async () => {
    const req = makeReq('/api/tokens');
    const res = await GET(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.tokens).toHaveLength(2);
  });

  it('returns 401 when headers missing', async () => {
    const req = makeReq('/api/tokens', 'GET', undefined, {});
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('returns 403 for disallowed roles', async () => {
    const req = makeReq('/api/tokens', 'GET', undefined, {
      ...HEADERS,
      'x-user-role': 'viewer',
    });
    const res = await GET(req);
    expect(res.status).toBe(403);
  });

  it('allows user role to list tokens', async () => {
    const req = makeReq('/api/tokens', 'GET', undefined, {
      ...HEADERS,
      'x-user-role': 'user',
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
  });

  it('allows project_admin role', async () => {
    const req = makeReq('/api/tokens', 'GET', undefined, {
      ...HEADERS,
      'x-user-role': 'project_admin',
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
  });

  it('returns ProjectContextError status', async () => {
    const e = new (ProjectContextError as any)('No project', 404);
    (requireProjectContext as ReturnType<typeof vi.fn>).mockRejectedValue(e);
    const req = makeReq('/api/tokens');
    const res = await GET(req);
    expect(res.status).toBe(404);
  });

  it('returns 500 on unexpected error', async () => {
    mockDb.listProjectApiTokens.mockRejectedValue(new Error('db failure'));
    const req = makeReq('/api/tokens');
    const res = await GET(req);
    expect(res.status).toBe(500);
  });

  it('passes tenantId and projectId to listProjectApiTokens', async () => {
    const req = makeReq('/api/tokens');
    await GET(req);
    expect(mockDb.listProjectApiTokens).toHaveBeenCalledWith('tenant-1', 'proj-1');
  });
});

describe('POST /api/tokens', () => {
  it('creates token and returns 201 with cpeer_ prefix', async () => {
    const req = makeReq('/api/tokens', 'POST', { label: 'My API Key' });
    const res = await POST(req);
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.token).toMatch(/^cpeer_/);
    expect(body.label).toBe('My API Key');
  });

  it('returns 401 when headers missing', async () => {
    const req = makeReq('/api/tokens', 'POST', { label: 'My Key' }, {});
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('returns 401 when license type missing', async () => {
    const { 'x-license-type': _omit, ...restHeaders } = HEADERS;
    const req = makeReq('/api/tokens', 'POST', { label: 'My Key' }, restHeaders);
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('returns 403 for disallowed roles', async () => {
    const req = makeReq('/api/tokens', 'POST', { label: 'My Key' }, {
      ...HEADERS,
      'x-user-role': 'viewer',
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });

  it('returns ProjectContextError status', async () => {
    const e = new (ProjectContextError as any)('No project', 404);
    (requireProjectContext as ReturnType<typeof vi.fn>).mockRejectedValue(e);
    const req = makeReq('/api/tokens', 'POST', { label: 'My Key' });
    const res = await POST(req);
    expect(res.status).toBe(404);
  });

  it('returns 400 when label is too short', async () => {
    const req = makeReq('/api/tokens', 'POST', { label: 'ab' });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 when label is missing', async () => {
    const req = makeReq('/api/tokens', 'POST', {});
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 429 when quota exceeded', async () => {
    (checkResourceQuota as ReturnType<typeof vi.fn>).mockResolvedValue({ allowed: false, reason: 'API token quota exceeded' });
    const req = makeReq('/api/tokens', 'POST', { label: 'My Key' });
    const res = await POST(req);
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toContain('quota');
  });

  it('passes correct args to createApiToken', async () => {
    const req = makeReq('/api/tokens', 'POST', { label: 'Production Key' });
    await POST(req);
    expect(mockDb.createApiToken).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      label: 'Production Key',
    }));
  });

  it('returns 500 on unexpected error', async () => {
    mockDb.createApiToken.mockRejectedValue(new Error('db failure'));
    const req = makeReq('/api/tokens', 'POST', { label: 'My Key' });
    const res = await POST(req);
    expect(res.status).toBe(500);
  });
});
