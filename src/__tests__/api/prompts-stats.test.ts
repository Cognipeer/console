import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockDb = vi.hoisted(() => ({
  switchToTenant: vi.fn(),
  listPromptVersions: vi.fn(),
}));

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn().mockResolvedValue(mockDb),
}));

vi.mock('@/lib/services/prompts', () => ({
  listPrompts: vi.fn(),
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

import { GET } from '@/server/api/routes/prompts/stats/route';
import { listPrompts } from '@/lib/services/prompts';
import { requireProjectContext } from '@/lib/services/projects/projectContext';

const mockListPrompts = vi.mocked(listPrompts);
const mockRequireProjectContext = vi.mocked(requireProjectContext);

const mockProjectContext = {
  tenantDbName: 'tenant_test',
  tenantId: 'tenant-id-1',
  userId: 'user-1',
  projectId: 'proj-1',
  role: 'owner',
};

const mockPrompts = [
  { id: 'p-1', key: 'greeting', name: 'Greeting', template: 'Hello {{name}}!', currentVersion: 1, updatedAt: new Date('2024-01-02'), createdAt: new Date('2024-01-01') },
  { id: 'p-2', key: 'farewell', name: 'Farewell', template: 'Goodbye', currentVersion: 2, updatedAt: new Date('2024-01-03'), createdAt: new Date('2024-01-01') },
];

function makeRequest(headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/prompts/stats', {
    method: 'GET',
    headers: {
      'x-tenant-db-name': 'tenant_test',
      'x-tenant-id': 'tenant-id-1',
      'x-user-id': 'user-1',
      ...headers,
    },
  });
}

describe('GET /api/prompts/stats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireProjectContext.mockResolvedValue(mockProjectContext as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockListPrompts.mockResolvedValue(mockPrompts as any);
    mockDb.switchToTenant.mockResolvedValue(undefined);
    mockDb.listPromptVersions.mockResolvedValue([{ _id: 'v-1' }, { _id: 'v-2' }]);
  });

  it('returns prompt stats', async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.overview).toBeDefined();
    expect(typeof body.overview.totalPrompts).toBe('number');
  });

  it('includes total prompts count', async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.overview.totalPrompts).toBe(2);
  });

  it('returns 401 when headers are missing', async () => {
    const res = await GET(makeRequest({ 'x-user-id': '' }));
    expect(res.status).toBe(401);
  });

  it('returns recentlyUpdated list', async () => {
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(Array.isArray(body.recentlyUpdated)).toBe(true);
    expect(body.recentlyUpdated.length).toBeLessThanOrEqual(6);
  });

  it('returns totalVersions summed across prompts', async () => {
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.overview.totalVersions).toBe(4); // 2 prompts × 2 versions each
  });

  it('returns versionDistribution array', async () => {
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(Array.isArray(body.versionDistribution)).toBe(true);
  });

  it('returns 500 on unexpected error', async () => {
    mockListPrompts.mockRejectedValueOnce(new Error('DB error'));
    const res = await GET(makeRequest());
    expect(res.status).toBe(500);
  });
});
