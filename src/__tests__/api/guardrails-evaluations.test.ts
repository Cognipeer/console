import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockDb = vi.hoisted(() => ({
  switchToTenant: vi.fn(),
  findGuardrailById: vi.fn(),
  listGuardrailEvaluationLogs: vi.fn(),
  aggregateGuardrailEvaluations: vi.fn(),
}));

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn().mockResolvedValue(mockDb),
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

vi.mock('@/lib/utils/dashboardDateFilter', () => ({
  parseDashboardDateFilterFromSearchParams: vi.fn().mockReturnValue({ from: null, to: null }),
}));

import { GET } from '@/server/api/routes/guardrails/[id]/evaluations/route';
import { requireProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';

const mockRequireProjectContext = requireProjectContext as ReturnType<typeof vi.fn>;

const mockParams = { params: Promise.resolve({ id: 'guard-1' }) };
const mockContext = { projectId: 'project-1' };
const mockGuardrail = { _id: 'guard-1', name: 'PII Guard', type: 'pii' };

const mockLogs = [
  { _id: 'log-1', guardRailId: 'guard-1', passed: true, ts: new Date() },
  { _id: 'log-2', guardRailId: 'guard-1', passed: false, ts: new Date() },
];
const mockAggregate = [{ date: '2025-01-01', total: 2, passed: 1, failed: 1 }];

function makeRequest(searchParams = '') {
  return new NextRequest(
    `http://localhost/api/guardrails/guard-1/evaluations${searchParams ? '?' + searchParams : ''}`,
    {
      headers: {
        'x-tenant-db-name': 'tenant_acme',
        'x-tenant-id': 'tenant-1',
        'x-user-id': 'user-1',
      },
    },
  );
}

describe('GET /api/guardrails/[id]/evaluations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireProjectContext.mockResolvedValue(mockContext);
    mockDb.switchToTenant.mockResolvedValue(undefined);
    mockDb.findGuardrailById.mockResolvedValue(mockGuardrail);
    mockDb.listGuardrailEvaluationLogs.mockResolvedValue(mockLogs);
    mockDb.aggregateGuardrailEvaluations.mockResolvedValue(mockAggregate);
  });

  it('returns logs and aggregate on success', async () => {
    const req = makeRequest();
    const res = await GET(req, mockParams);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.logs).toHaveLength(2);
    expect(body.aggregate).toHaveLength(1);
  });

  it('returns 401 when headers missing', async () => {
    const req = new NextRequest('http://localhost/api/guardrails/guard-1/evaluations');
    const res = await GET(req, mockParams);
    expect(res.status).toBe(401);
  });

  it('returns 404 when guardrail not found', async () => {
    mockDb.findGuardrailById.mockResolvedValue(null);
    const req = makeRequest();
    const res = await GET(req, mockParams);
    expect(res.status).toBe(404);
  });

  it('returns ProjectContextError status', async () => {
    mockRequireProjectContext.mockRejectedValue(
      new ProjectContextError('No project', 400),
    );
    const req = makeRequest();
    const res = await GET(req, mockParams);
    expect(res.status).toBe(400);
  });

  it('passes limit and skip to listGuardrailEvaluationLogs', async () => {
    const req = makeRequest('limit=10&skip=5');
    await GET(req, mockParams);
    expect(mockDb.listGuardrailEvaluationLogs).toHaveBeenCalledWith(
      'guard-1',
      expect.objectContaining({ limit: 10, skip: 5 }),
    );
  });

  it('caps limit at 200', async () => {
    const req = makeRequest('limit=999');
    await GET(req, mockParams);
    expect(mockDb.listGuardrailEvaluationLogs).toHaveBeenCalledWith(
      'guard-1',
      expect.objectContaining({ limit: 200 }),
    );
  });

  it('passes passed=true filter', async () => {
    const req = makeRequest('passed=true');
    await GET(req, mockParams);
    expect(mockDb.listGuardrailEvaluationLogs).toHaveBeenCalledWith(
      'guard-1',
      expect.objectContaining({ passed: true }),
    );
  });

  it('passes passed=false filter', async () => {
    const req = makeRequest('passed=false');
    await GET(req, mockParams);
    expect(mockDb.listGuardrailEvaluationLogs).toHaveBeenCalledWith(
      'guard-1',
      expect.objectContaining({ passed: false }),
    );
  });

  it('passes groupBy to aggregateGuardrailEvaluations', async () => {
    const req = makeRequest('groupBy=hour');
    await GET(req, mockParams);
    expect(mockDb.aggregateGuardrailEvaluations).toHaveBeenCalledWith(
      'guard-1',
      expect.objectContaining({ groupBy: 'hour' }),
    );
  });

  it('switches to correct tenant DB', async () => {
    const req = makeRequest();
    await GET(req, mockParams);
    expect(mockDb.switchToTenant).toHaveBeenCalledWith('tenant_acme');
  });

  it('returns 500 on unexpected error', async () => {
    mockDb.listGuardrailEvaluationLogs.mockRejectedValue(new Error('DB error'));
    const req = makeRequest();
    const res = await GET(req, mockParams);
    expect(res.status).toBe(500);
  });
});
