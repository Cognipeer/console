import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/prompts', () => ({
  listPromptDeployments: vi.fn(),
  promotePromptVersion: vi.fn(),
  planPromptDeployment: vi.fn(),
  activatePromptDeployment: vi.fn(),
  rollbackPromptDeployment: vi.fn(),
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

import { GET, POST } from '@/server/api/routes/prompts/[id]/deployments/route';
import {
  listPromptDeployments,
  promotePromptVersion,
  planPromptDeployment,
  activatePromptDeployment,
  rollbackPromptDeployment,
} from '@/lib/services/prompts';
import { requireProjectContext } from '@/lib/services/projects/projectContext';

const mockListDeployments = vi.mocked(listPromptDeployments);
const mockPromoteVersion = vi.mocked(promotePromptVersion);
const mockPlanDeployment = vi.mocked(planPromptDeployment);
const mockActivateDeployment = vi.mocked(activatePromptDeployment);
const mockRollbackDeployment = vi.mocked(rollbackPromptDeployment);
const mockRequireProjectContext = vi.mocked(requireProjectContext);

const mockDeployments = {
  dev: { environment: 'dev', versionId: 'v1', status: 'active' },
  staging: null,
  prod: null,
};

const mockPrompt = { _id: 'prompt-1', name: 'My Prompt', tenantId: 'tenant-id-1' };

const mockProjectContext = {
  tenantDbName: 'tenant_test',
  tenantId: 'tenant-id-1',
  userId: 'user-1',
  projectId: 'proj-1',
  role: 'owner',
};

const mockParams = { params: Promise.resolve({ id: 'prompt-1' }) };

function makeRequest(method: string, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/prompts/prompt-1/deployments', {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-tenant-db-name': 'tenant_test',
      'x-tenant-id': 'tenant-id-1',
      'x-user-id': 'user-1',
      ...headers,
    },
    body: method !== 'GET' ? JSON.stringify(body) : undefined,
  });
}

describe('GET /api/prompts/[id]/deployments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireProjectContext.mockResolvedValue(mockProjectContext as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockListDeployments.mockResolvedValue(mockDeployments as any);
  });

  it('returns deployments on success', async () => {
    const res = await GET(makeRequest('GET'), mockParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('dev');
  });

  it('returns 404 when prompt deployments null', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockListDeployments.mockResolvedValueOnce(null as any);
    const res = await GET(makeRequest('GET'), mockParams);
    expect(res.status).toBe(404);
  });

  it('returns 401 when x-tenant-db-name missing', async () => {
    const res = await GET(makeRequest('GET', {}, { 'x-tenant-db-name': '' }), mockParams);
    expect(res.status).toBe(401);
  });

  it('returns ProjectContextError status on context failure', async () => {
    const { ProjectContextError } = await import('@/lib/services/projects/projectContext');
    mockRequireProjectContext.mockRejectedValueOnce(new ProjectContextError('No project', 400));
    const res = await GET(makeRequest('GET'), mockParams);
    expect(res.status).toBe(400);
  });

  it('returns 500 on service error', async () => {
    mockListDeployments.mockRejectedValueOnce(new Error('fail'));
    const res = await GET(makeRequest('GET'), mockParams);
    expect(res.status).toBe(500);
  });
});

describe('POST /api/prompts/[id]/deployments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireProjectContext.mockResolvedValue(mockProjectContext as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockPromoteVersion.mockResolvedValue(mockPrompt as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockPlanDeployment.mockResolvedValue(mockPrompt as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockActivateDeployment.mockResolvedValue(mockPrompt as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRollbackDeployment.mockResolvedValue(mockPrompt as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockListDeployments.mockResolvedValue(mockDeployments as any);
  });

  it('promotes version successfully', async () => {
    const res = await POST(
      makeRequest('POST', { action: 'promote', environment: 'dev', versionId: 'v2' }),
      mockParams,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('prompt');
    expect(body).toHaveProperty('deployments');
    expect(mockPromoteVersion).toHaveBeenCalled();
  });

  it('plans deployment successfully', async () => {
    const res = await POST(
      makeRequest('POST', { action: 'plan', environment: 'staging', note: 'planning' }),
      mockParams,
    );
    expect(res.status).toBe(200);
    expect(mockPlanDeployment).toHaveBeenCalled();
  });

  it('activates deployment successfully', async () => {
    const res = await POST(
      makeRequest('POST', { action: 'activate', environment: 'prod' }),
      mockParams,
    );
    expect(res.status).toBe(200);
    expect(mockActivateDeployment).toHaveBeenCalled();
  });

  it('rolls back deployment successfully', async () => {
    const res = await POST(
      makeRequest('POST', { action: 'rollback', environment: 'prod' }),
      mockParams,
    );
    expect(res.status).toBe(200);
    expect(mockRollbackDeployment).toHaveBeenCalled();
  });

  it('returns 400 for invalid environment', async () => {
    const res = await POST(
      makeRequest('POST', { action: 'promote', environment: 'invalid', versionId: 'v1' }),
      mockParams,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('environment');
  });

  it('returns 400 for invalid action', async () => {
    const res = await POST(
      makeRequest('POST', { action: 'unknown', environment: 'dev' }),
      mockParams,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('action');
  });

  it('returns 400 when promote action is missing versionId', async () => {
    const res = await POST(
      makeRequest('POST', { action: 'promote', environment: 'dev' }),
      mockParams,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('versionId');
  });

  it('returns 404 when prompt not found', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockPromoteVersion.mockResolvedValueOnce(null as any);
    const res = await POST(
      makeRequest('POST', { action: 'promote', environment: 'dev', versionId: 'v1' }),
      mockParams,
    );
    expect(res.status).toBe(404);
  });

  it('returns 401 when authorization headers missing', async () => {
    const res = await POST(
      makeRequest('POST', { action: 'plan', environment: 'dev' }, { 'x-tenant-db-name': '' }),
      mockParams,
    );
    expect(res.status).toBe(401);
  });
});
