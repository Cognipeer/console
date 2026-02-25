import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/models/modelService', () => ({
  getModelById: vi.fn(),
  listUsageLogs: vi.fn(),
  getUsageAggregate: vi.fn(),
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

import { GET as getModelLogs } from '@/app/api/models/[id]/logs/route';
import { GET as getModelUsage } from '@/app/api/models/[id]/usage/route';
import {
  getModelById,
  listUsageLogs,
  getUsageAggregate,
} from '@/lib/services/models/modelService';
import { requireProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';

const mockGetModelById = getModelById as ReturnType<typeof vi.fn>;
const mockListUsageLogs = listUsageLogs as ReturnType<typeof vi.fn>;
const mockGetUsageAggregate = getUsageAggregate as ReturnType<typeof vi.fn>;
const mockRequireProjectContext = requireProjectContext as ReturnType<typeof vi.fn>;

const mockParams = { params: Promise.resolve({ id: 'model-1' }) };
const mockContext = { projectId: 'project-1' };
const mockModel = { _id: 'model-1', key: 'gpt-4o', name: 'GPT-4o', projectId: 'project-1' };

function makeRequest(url: string) {
  return new NextRequest(url, {
    headers: {
      'x-tenant-db-name': 'tenant_acme',
      'x-tenant-id': 'tenant-1',
      'x-user-id': 'user-1',
    },
  });
}

describe('GET /api/models/[id]/logs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireProjectContext.mockResolvedValue(mockContext);
    mockGetModelById.mockResolvedValue(mockModel);
  });

  it('returns logs on success', async () => {
    const logs = [
      { _id: 'log-1', modelKey: 'gpt-4o', requestTokens: 100, responseTokens: 200 },
    ];
    mockListUsageLogs.mockResolvedValue(logs);
    const req = makeRequest('http://localhost/api/models/model-1/logs');
    const res = await getModelLogs(req, mockParams);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.logs).toHaveLength(1);
  });

  it('returns 404 when model not found', async () => {
    mockGetModelById.mockResolvedValue(null);
    const req = makeRequest('http://localhost/api/models/model-1/logs');
    const res = await getModelLogs(req, mockParams);
    expect(res.status).toBe(404);
  });

  it('returns 401 when headers missing', async () => {
    const req = new NextRequest('http://localhost/api/models/model-1/logs');
    const res = await getModelLogs(req, mockParams);
    expect(res.status).toBe(401);
  });

  it('caps limit at 200', async () => {
    mockListUsageLogs.mockResolvedValue([]);
    const req = makeRequest('http://localhost/api/models/model-1/logs?limit=999');
    await getModelLogs(req, mockParams);
    expect(mockListUsageLogs).toHaveBeenCalledWith(
      'tenant_acme',
      'gpt-4o',
      'project-1',
      expect.objectContaining({ limit: 200 }),
    );
  });

  it('passes skip and limit correctly', async () => {
    mockListUsageLogs.mockResolvedValue([]);
    const req = makeRequest('http://localhost/api/models/model-1/logs?limit=10&skip=20');
    await getModelLogs(req, mockParams);
    expect(mockListUsageLogs).toHaveBeenCalledWith(
      'tenant_acme',
      'gpt-4o',
      'project-1',
      expect.objectContaining({ limit: 10, skip: 20 }),
    );
  });

  it('returns ProjectContextError status', async () => {
    mockRequireProjectContext.mockRejectedValue(
      new ProjectContextError('No project', 400),
    );
    const req = makeRequest('http://localhost/api/models/model-1/logs');
    const res = await getModelLogs(req, mockParams);
    expect(res.status).toBe(400);
  });

  it('returns 500 on unexpected error', async () => {
    mockListUsageLogs.mockRejectedValue(new Error('DB error'));
    const req = makeRequest('http://localhost/api/models/model-1/logs');
    const res = await getModelLogs(req, mockParams);
    expect(res.status).toBe(500);
  });
});

describe('GET /api/models/[id]/usage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireProjectContext.mockResolvedValue(mockContext);
    mockGetModelById.mockResolvedValue(mockModel);
  });

  it('returns usage aggregate on success', async () => {
    const aggregate = [
      { date: '2025-01-01', totalCalls: 50, totalTokens: 10000 },
    ];
    mockGetUsageAggregate.mockResolvedValue(aggregate);
    const req = makeRequest('http://localhost/api/models/model-1/usage');
    const res = await getModelUsage(req, mockParams);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.usage).toHaveLength(1);
    expect(body.usage[0].totalCalls).toBe(50);
  });

  it('returns 404 when model not found', async () => {
    mockGetModelById.mockResolvedValue(null);
    const req = makeRequest('http://localhost/api/models/model-1/usage');
    const res = await getModelUsage(req, mockParams);
    expect(res.status).toBe(404);
  });

  it('returns 401 when headers missing', async () => {
    const req = new NextRequest('http://localhost/api/models/model-1/usage');
    const res = await getModelUsage(req, mockParams);
    expect(res.status).toBe(401);
  });

  it('passes groupBy param to getUsageAggregate', async () => {
    mockGetUsageAggregate.mockResolvedValue([]);
    const req = makeRequest('http://localhost/api/models/model-1/usage?groupBy=hour');
    await getModelUsage(req, mockParams);
    expect(mockGetUsageAggregate).toHaveBeenCalledWith(
      'tenant_acme',
      'gpt-4o',
      'project-1',
      expect.objectContaining({ groupBy: 'hour' }),
    );
  });

  it('defaults groupBy to day', async () => {
    mockGetUsageAggregate.mockResolvedValue([]);
    const req = makeRequest('http://localhost/api/models/model-1/usage');
    await getModelUsage(req, mockParams);
    expect(mockGetUsageAggregate).toHaveBeenCalledWith(
      'tenant_acme',
      'gpt-4o',
      'project-1',
      expect.objectContaining({ groupBy: 'day' }),
    );
  });

  it('returns ProjectContextError status', async () => {
    mockRequireProjectContext.mockRejectedValue(
      new ProjectContextError('No project', 400),
    );
    const req = makeRequest('http://localhost/api/models/model-1/usage');
    const res = await getModelUsage(req, mockParams);
    expect(res.status).toBe(400);
  });

  it('returns 500 on unexpected error', async () => {
    mockGetUsageAggregate.mockRejectedValue(new Error('DB error'));
    const req = makeRequest('http://localhost/api/models/model-1/usage');
    const res = await getModelUsage(req, mockParams);
    expect(res.status).toBe(500);
  });
});
