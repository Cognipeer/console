import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/models/modelService', () => ({
  listModels: vi.fn(),
  listModelProviders: vi.fn(),
  getUsageAggregate: vi.fn(),
}));

vi.mock('@/lib/services/projects/projectContext', () => ({
  resolveProjectContext: vi.fn(),
  ProjectContextError: class ProjectContextError extends Error {
    status: number;
    constructor(message: string, status = 400) {
      super(message);
      this.status = status;
    }
  },
}));

vi.mock('@/lib/utils/dashboardDateFilter', () => ({
  parseDashboardDateFilterFromSearchParams: vi.fn().mockReturnValue({ from: null, to: null }),
  isDateInDashboardRange: vi.fn().mockReturnValue(true),
}));

import { listModels, listModelProviders, getUsageAggregate } from '@/lib/services/models/modelService';
import { resolveProjectContext } from '@/lib/services/projects/projectContext';
import { modelsApiPlugin } from '@/server/api/plugins/models';
import {
  createFastifyApiTestApp,
  parseJsonBody,
} from '../helpers/fastify-api';

const HEADERS = {
  'x-license-type': 'FREE',
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': 'tenant-1',
  'x-tenant-slug': 'acme',
  'x-user-id': 'user-1',
  'x-user-role': 'owner',
};

const mockModel = (category: string, key: string) => ({
  key,
  name: `Model ${key}`,
  category,
  providerKey: 'openai',
  createdAt: new Date().toISOString(),
});

const mockAgg = {
  totalCalls: 100,
  successCalls: 90,
  errorCalls: 10,
  totalInputTokens: 5000,
  totalOutputTokens: 3000,
  totalTokens: 8000,
  totalToolCalls: 5,
  cacheHits: 20,
  avgLatencyMs: 250,
  costSummary: { totalCost: 1.25 },
  timeseries: [
    { period: '2025-01-01T00:00:00Z', callCount: 50, totalTokens: 4000 },
    { period: '2025-01-02T00:00:00Z', callCount: 50, totalTokens: 4000 },
  ],
};

describe('GET /api/models/dashboard', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    (resolveProjectContext as ReturnType<typeof vi.fn>).mockResolvedValue({
      projectId: 'proj-1',
      project: { _id: 'proj-1' },
      user: { _id: 'user-1', role: 'owner', projectIds: ['proj-1'] },
    });
    (listModels as ReturnType<typeof vi.fn>).mockResolvedValue([
      mockModel('llm', 'gpt-4'),
      mockModel('embedding', 'text-embedding-3'),
    ]);
    (listModelProviders as ReturnType<typeof vi.fn>).mockResolvedValue([{ key: 'openai' }]);
    (getUsageAggregate as ReturnType<typeof vi.fn>).mockResolvedValue(mockAgg);
    app = await createFastifyApiTestApp(modelsApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns overview with correct model counts', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/models/dashboard', headers: HEADERS });
    expect(res.statusCode).toBe(200);
    const body = parseJsonBody<{
      overview: { totalModels: number; llmCount: number; embeddingCount: number };
      topModels: unknown[];
      daily: unknown[];
    }>(res.body);
    expect(body.overview.totalModels).toBe(2);
    expect(body.overview.llmCount).toBe(1);
    expect(body.overview.embeddingCount).toBe(1);
    expect(body.topModels).toBeInstanceOf(Array);
    expect(body.daily).toBeInstanceOf(Array);
  });

  it('returns 401 when required headers missing', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/models/dashboard' });
    expect(res.statusCode).toBe(401);
  });

  it('handles empty models list gracefully', async () => {
    (listModels as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    const res = await app.inject({ method: 'GET', url: '/api/models/dashboard', headers: HEADERS });
    const body = parseJsonBody<{ overview: { totalModels: number }; topModels: unknown[]; daily: unknown[] }>(res.body);
    expect(body.overview.totalModels).toBe(0);
    expect(body.topModels).toHaveLength(0);
    expect(body.daily).toHaveLength(0);
  });

  it('returns 500 on unexpected error', async () => {
    (listModels as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('DB crash'));
    const res = await app.inject({ method: 'GET', url: '/api/models/dashboard', headers: HEADERS });
    expect(res.statusCode).toBe(500);
  });
});
