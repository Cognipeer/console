import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/prompts', () => ({
  comparePromptVersions: vi.fn(),
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

import { GET } from '@/server/api/routes/prompts/[id]/compare/route';
import { comparePromptVersions } from '@/lib/services/prompts';
import { requireProjectContext } from '@/lib/services/projects/projectContext';

const mockComparePromptVersions = vi.mocked(comparePromptVersions);
const mockRequireProjectContext = vi.mocked(requireProjectContext);

const mockProjectContext = {
  tenantDbName: 'tenant_test',
  tenantId: 'tenant-id-1',
  userId: 'user-1',
  projectId: 'proj-1',
  role: 'owner',
};

const mockParams = { params: Promise.resolve({ id: 'prompt-1' }) };

function makeRequest(search = '', headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost/api/prompts/prompt-1/compare${search}`, {
    method: 'GET',
    headers: {
      'x-tenant-db-name': 'tenant_test',
      'x-tenant-id': 'tenant-id-1',
      'x-user-id': 'user-1',
      ...headers,
    },
  });
}

const mockComparison = {
  from: { versionId: 'v-1', template: 'Hello {{name}}' },
  to: { versionId: 'v-2', template: 'Hi {{name}}' },
  diff: [{ type: 'changed', line: 1 }],
};

describe('GET /api/prompts/[id]/compare', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireProjectContext.mockResolvedValue(mockProjectContext as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockComparePromptVersions.mockResolvedValue(mockComparison as any);
  });

  it('returns comparison result', async () => {
    const res = await GET(makeRequest('?fromVersionId=v-1&toVersionId=v-2'), mockParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.comparison).toBeDefined();
  });

  it('calls comparePromptVersions with correct args', async () => {
    await GET(makeRequest('?fromVersionId=v-1&toVersionId=v-2'), mockParams);
    expect(mockComparePromptVersions).toHaveBeenCalledWith(
      'tenant_test',
      'proj-1',
      'prompt-1',
      'v-1',
      'v-2',
    );
  });

  it('returns 400 when fromVersionId is missing', async () => {
    const res = await GET(makeRequest('?toVersionId=v-2'), mockParams);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('fromVersionId');
  });

  it('returns 400 when toVersionId is missing', async () => {
    const res = await GET(makeRequest('?fromVersionId=v-1'), mockParams);
    expect(res.status).toBe(400);
  });

  it('returns 401 when headers are missing', async () => {
    const res = await GET(makeRequest('?fromVersionId=v-1&toVersionId=v-2', { 'x-user-id': '' }), mockParams);
    expect(res.status).toBe(401);
  });

  it('returns 404 when comparison returns null', async () => {
    mockComparePromptVersions.mockResolvedValueOnce(null);
    const res = await GET(makeRequest('?fromVersionId=v-1&toVersionId=v-2'), mockParams);
    expect(res.status).toBe(404);
  });

  it('returns 500 on unexpected error', async () => {
    mockComparePromptVersions.mockRejectedValueOnce(new Error('DB error'));
    const res = await GET(makeRequest('?fromVersionId=v-1&toVersionId=v-2'), mockParams);
    expect(res.status).toBe(500);
  });
});
