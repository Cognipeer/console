import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/providers/providerService', () => ({
  getProviderConfigById: vi.fn(),
  updateProviderConfig: vi.fn(),
  deleteProviderConfig: vi.fn(),
}));

vi.mock('@/lib/services/projects/projectContext', () => ({
  requireProjectContext: vi.fn(),
  ProjectContextError: class ProjectContextError extends Error {
    status: number;
    constructor(message: string, status = 400) {
      super(message);
      this.status = status;
    }
  },
}));

import { GET, PATCH, DELETE } from '@/server/api/routes/providers/[id]/route';
import { getProviderConfigById, updateProviderConfig, deleteProviderConfig } from '@/lib/services/providers/providerService';
import { requireProjectContext } from '@/lib/services/projects/projectContext';

const mockGetProviderConfigById = vi.mocked(getProviderConfigById);
const mockUpdateProviderConfig = vi.mocked(updateProviderConfig);
const mockDeleteProviderConfig = vi.mocked(deleteProviderConfig);
const mockRequireProjectContext = vi.mocked(requireProjectContext);

const ADMIN_HEADERS = {
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': 'tenant-1',
  'x-user-id': 'user-1',
  'x-user-role': 'admin',
};

const mockProvider = {
  _id: 'pv-1',
  key: 'my-openai',
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  projectIds: ['proj-1'],
  label: 'My OpenAI',
  status: 'active',
};

const idParams = { params: Promise.resolve({ id: 'pv-1' }) };

function makeReq(method: string, path: string, headers?: Record<string, string>, body?: Record<string, unknown>) {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(headers || ADMIN_HEADERS) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// ─── GET ─────────────────────────────────────────────────────────────────────

describe('GET /api/providers/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockGetProviderConfigById.mockResolvedValue(mockProvider as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireProjectContext.mockResolvedValue({ projectId: 'proj-1' } as any);
  });

  it('returns provider config for admin', async () => {
    const res = await GET(makeReq('GET', '/api/providers/pv-1'), idParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.provider).toBeDefined();
  });

  it('returns 401 when headers are missing', async () => {
    const res = await GET(makeReq('GET', '/api/providers/pv-1', {}), idParams);
    expect(res.status).toBe(401);
  });

  it('returns 404 when provider not found', async () => {
    mockGetProviderConfigById.mockResolvedValueOnce(null);
    const res = await GET(makeReq('GET', '/api/providers/pv-1'), idParams);
    expect(res.status).toBe(404);
  });
});

// ─── PATCH ───────────────────────────────────────────────────────────────────

describe('PATCH /api/providers/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockGetProviderConfigById.mockResolvedValue(mockProvider as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockUpdateProviderConfig.mockResolvedValue({ ...mockProvider, label: 'Updated' } as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireProjectContext.mockResolvedValue({ projectId: 'proj-1' } as any);
  });

  it('updates provider label', async () => {
    const res = await PATCH(
      makeReq('PATCH', '/api/providers/pv-1', ADMIN_HEADERS, { label: 'Updated' }),
      idParams,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.provider).toBeDefined();
  });

  it('returns 401 when headers are missing', async () => {
    const res = await PATCH(
      makeReq('PATCH', '/api/providers/pv-1', {}, { label: 'x' }),
      idParams,
    );
    expect(res.status).toBe(401);
  });

  it('returns 404 when provider not found', async () => {
    mockGetProviderConfigById.mockResolvedValueOnce(null);
    const res = await PATCH(
      makeReq('PATCH', '/api/providers/pv-1', ADMIN_HEADERS, { label: 'x' }),
      idParams,
    );
    expect(res.status).toBe(404);
  });
});

// ─── DELETE (tenant scope) ────────────────────────────────────────────────────

describe('DELETE /api/providers/[id] (scope=tenant)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockGetProviderConfigById.mockResolvedValue(mockProvider as any);
    mockDeleteProviderConfig.mockResolvedValue(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireProjectContext.mockResolvedValue({ projectId: 'proj-1' } as any);
  });

  it('deletes a provider config (tenant scope, admin)', async () => {
    const res = await DELETE(
      new NextRequest('http://localhost/api/providers/pv-1?scope=tenant', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', ...ADMIN_HEADERS },
      }),
      idParams,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('returns 403 for non-admin tenant scope delete', async () => {
    const res = await DELETE(
      new NextRequest('http://localhost/api/providers/pv-1?scope=tenant', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', ...ADMIN_HEADERS, 'x-user-role': 'viewer' },
      }),
      idParams,
    );
    expect(res.status).toBe(403);
  });

  it('returns 401 when headers are missing', async () => {
    const res = await DELETE(makeReq('DELETE', '/api/providers/pv-1', {}), idParams);
    expect(res.status).toBe(401);
  });
});

// ─── DELETE (project scope) ───────────────────────────────────────────────────

describe('DELETE /api/providers/[id] (project scope)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockGetProviderConfigById.mockResolvedValue(mockProvider as any);
    mockDeleteProviderConfig.mockResolvedValue(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireProjectContext.mockResolvedValue({ projectId: 'proj-1' } as any);
  });

  it('deletes a provider config (project scope)', async () => {
    const res = await DELETE(makeReq('DELETE', '/api/providers/pv-1'), idParams);
    expect(res.status).toBe(200);
  });

  it('returns 404 when provider not assigned to project', async () => {
    mockGetProviderConfigById.mockResolvedValueOnce({
      ...mockProvider,
      projectId: 'other-proj',
      projectIds: ['other-proj'],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const res = await DELETE(makeReq('DELETE', '/api/providers/pv-1'), idParams);
    expect(res.status).toBe(404);
  });
});
