import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/apiTokenAuth', () => {
  class ApiTokenAuthError extends Error {
    status: number;

    constructor(message: string, status = 401) {
      super(message);
      this.status = status;
    }
  }

  return {
    ApiTokenAuthError,
    requireApiTokenFromHeader: vi.fn(),
  };
});

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
}));

vi.mock('@/lib/security/rbac', () => ({
  getPermissionServiceForPath: vi.fn(),
  authorizeServiceRequest: vi.fn(),
}));

vi.mock('@/lib/core/lifecycle', () => ({
  isShuttingDown: vi.fn().mockReturnValue(false),
}));

const hoisted = vi.hoisted(() => ({
  getAgentRunStatus: vi.fn(),
  requestAgentRunCancellation: vi.fn(),
}));

vi.mock('@/lib/services/agents', () => ({
  getAgentRunStatus: hoisted.getAgentRunStatus,
  requestAgentRunCancellation: hoisted.requestAgentRunCancellation,
}));

import { getDatabase } from '@/lib/database';
import { requireApiTokenFromHeader } from '@/lib/services/apiTokenAuth';
import { getPermissionServiceForPath, authorizeServiceRequest } from '@/lib/security/rbac';
import { clientAgentRunsApiPlugin } from '@/server/api/plugins/client-agent-runs';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const AUTH_CTX = {
  token: 'tok_abc',
  tokenRecord: { _id: 'tok-1', userId: 'user-1' },
  tenant: { licenseType: 'STARTER' },
  tenantId: 'tenant-1',
  tenantSlug: 'acme',
  tenantDbName: 'tenant_acme',
  projectId: 'proj-1',
  user: { _id: 'user-1', role: 'user', tenantId: 'tenant-1' },
};

const runWithTenant = vi.fn(<T>(_tenantDbName: string, fn: () => T | Promise<T>) => fn());

describe('client agent runs routes', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    (requireApiTokenFromHeader as ReturnType<typeof vi.fn>).mockResolvedValue(AUTH_CTX);
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue({ runWithTenant });
    (getPermissionServiceForPath as ReturnType<typeof vi.fn>).mockReturnValue(null);
    (authorizeServiceRequest as ReturnType<typeof vi.fn>).mockReturnValue({ allowed: true });
    app = await createFastifyApiTestApp(clientAgentRunsApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /api/client/v1/agents/runs/:runId returns serialized status', async () => {
    hoisted.getAgentRunStatus.mockResolvedValue({
      _id: 'run-1',
      mode: 'background',
      agentKey: 'support-agent',
      conversationId: 'conv-1',
      status: 'running',
      result: null,
      errorReason: null,
      errorMessage: null,
      createdAt: new Date('2024-01-01T00:00:00Z'),
      startedAt: new Date('2024-01-01T00:00:01Z'),
      completedAt: null,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/client/v1/agents/runs/run-1',
      headers: { authorization: '******' },
    });

    expect(res.statusCode).toBe(200);
    expect(hoisted.getAgentRunStatus).toHaveBeenCalledWith('tenant_acme', 'tenant-1', 'proj-1', 'run-1');
    const body = parseJsonBody<{ id: string; object: string; status: string }>(res.body);
    expect(body.id).toBe('run_run-1');
    expect(body.object).toBe('agent.run');
    expect(body.status).toBe('running');
  });

  it('GET returns a structured 404 for a sync reservation row (an internal lock, not a caller-owned run)', async () => {
    hoisted.getAgentRunStatus.mockResolvedValue({
      _id: 'run-1',
      mode: 'sync',
      agentKey: 'support-agent',
      conversationId: 'conv-1',
      status: 'running',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/client/v1/agents/runs/run_run-1',
      headers: { authorization: '******' },
    });

    expect(res.statusCode).toBe(404);
    expect(parseJsonBody<{ error: { code: string } }>(res.body).error.code).toBe('agent_run_not_found');
  });

  it('POST /api/client/v1/agents/runs/:runId/cancel requests cancellation in tenant/project scope', async () => {
    hoisted.requestAgentRunCancellation.mockResolvedValue({
      kind: 'accepted',
      run: {
        _id: 'run-1',
        agentKey: 'support-agent',
        conversationId: 'conv-1',
        status: 'running',
        result: null,
        errorReason: null,
        errorMessage: null,
        createdAt: new Date('2024-01-01T00:00:00Z'),
        startedAt: new Date('2024-01-01T00:00:01Z'),
        completedAt: null,
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/client/v1/agents/runs/run-1/cancel',
      headers: { authorization: '******' },
    });

    expect(res.statusCode).toBe(200);
    expect(hoisted.requestAgentRunCancellation).toHaveBeenCalledWith('tenant_acme', 'tenant-1', 'proj-1', 'run-1');
  });
});
