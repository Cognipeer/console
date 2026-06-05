/**
 * API tests — client Evaluation surface (`/api/client/v1/evaluation/*`).
 * Mocks the service layer; verifies token auth, snake_case serialization,
 * suite-run triggering, run listing/filters and error mapping.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/apiTokenAuth', () => {
  class ApiTokenAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  return { requireApiToken: vi.fn(), ApiTokenAuthError };
});

vi.mock('@/lib/services/evaluation/service', () => ({
  listSuites: vi.fn(),
  runSuite: vi.fn(),
  listRuns: vi.fn(),
  getRun: vi.fn(),
}));

import {
  GET as suitesGET,
} from '@/server/api/routes/client/v1/evaluation/suites/route';
import {
  POST as suiteRunPOST,
} from '@/server/api/routes/client/v1/evaluation/suites/[key]/run/route';
import {
  GET as runsGET,
} from '@/server/api/routes/client/v1/evaluation/runs/route';
import {
  GET as runGET,
} from '@/server/api/routes/client/v1/evaluation/runs/[id]/route';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { listSuites, runSuite, listRuns, getRun } from '@/lib/services/evaluation/service';

const CTX = {
  tenantId: 'tenant-1',
  tenantDbName: 'tenant_acme',
  projectId: 'proj-1',
  tokenRecord: { userId: 'user-1' },
};

const SUITE = {
  id: 's-1',
  key: 'smoke',
  name: 'Smoke Suite',
  targetKey: 'gpt-target',
  datasetKey: 'smoke-data',
  judgeModelKey: 'judge-1',
  scorers: [{ type: 'assertion', weight: 1 }],
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

const RUN = {
  id: 'r-1',
  suiteKey: 'smoke',
  targetKey: 'gpt-target',
  datasetKey: 'smoke-data',
  status: 'completed',
  aggregate: { total: 2, completed: 2, failed: 0, passed: 1, passRate: 0.5, avgScore: 0.75, avgLatencyMs: 12 },
  items: [
    {
      itemId: 'q1',
      passed: true,
      score: 1,
      latencyMs: 10,
      output: { text: 'ok' },
      scores: [{ scorerType: 'assertion', score: 1, passed: true, weight: 1 }],
    },
  ],
  startedAt: new Date('2026-01-01T00:00:01Z'),
  finishedAt: new Date('2026-01-01T00:00:02Z'),
};

function req(method: string, url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`, { method });
}

beforeEach(() => {
  vi.clearAllMocks();
  (requireApiToken as ReturnType<typeof vi.fn>).mockResolvedValue(CTX);
  (listSuites as ReturnType<typeof vi.fn>).mockResolvedValue([SUITE]);
  (runSuite as ReturnType<typeof vi.fn>).mockResolvedValue(RUN);
  (listRuns as ReturnType<typeof vi.fn>).mockResolvedValue([RUN]);
  (getRun as ReturnType<typeof vi.fn>).mockResolvedValue(RUN);
});

describe('GET /api/client/v1/evaluation/suites', () => {
  it('returns suites scoped to the token project, in snake_case', async () => {
    const res = await suitesGET(req('GET', '/api/client/v1/evaluation/suites'));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(listSuites).toHaveBeenCalledWith('tenant_acme', { projectId: 'proj-1' });
    expect(json.suites[0]).toMatchObject({
      key: 'smoke',
      target_key: 'gpt-target',
      dataset_key: 'smoke-data',
      judge_model_key: 'judge-1',
    });
  });

  it('returns 401 on ApiTokenAuthError', async () => {
    (requireApiToken as ReturnType<typeof vi.fn>).mockRejectedValue(new ApiTokenAuthError('Invalid token', 401));
    const res = await suitesGET(req('GET', '/api/client/v1/evaluation/suites'));
    expect(res.status).toBe(401);
  });
});

describe('POST /api/client/v1/evaluation/suites/:key/run', () => {
  const params = { params: Promise.resolve({ key: 'smoke' }) };

  it('runs the named suite and returns the scored run', async () => {
    const res = await suiteRunPOST(req('POST', '/api/client/v1/evaluation/suites/smoke/run'), params);
    const json = await res.json();
    expect(res.status).toBe(201);
    expect(runSuite).toHaveBeenCalledWith(expect.objectContaining({
      tenantDbName: 'tenant_acme',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      createdBy: 'user-1',
      suiteKey: 'smoke',
    }));
    expect(json.run).toMatchObject({ id: 'r-1', suite_key: 'smoke', status: 'completed' });
    expect(json.run.aggregate).toMatchObject({ pass_rate: 0.5, avg_score: 0.75, avg_latency_ms: 12 });
    expect(json.run.items[0]).toMatchObject({ item_id: 'q1', output_text: 'ok' });
    expect(json.run.items[0].scores[0]).toMatchObject({ scorer_type: 'assertion', passed: true });
  });

  it('maps a "not found" service error to 404', async () => {
    (runSuite as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Evaluation suite "smoke" not found'));
    const res = await suiteRunPOST(req('POST', '/api/client/v1/evaluation/suites/smoke/run'), params);
    expect(res.status).toBe(404);
  });
});

describe('GET /api/client/v1/evaluation/runs', () => {
  it('lists runs and forwards suite_key + clamped limit', async () => {
    const res = await runsGET(req('GET', '/api/client/v1/evaluation/runs?suite_key=smoke&limit=999'));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(listRuns).toHaveBeenCalledWith('tenant_acme', { projectId: 'proj-1', suiteKey: 'smoke', limit: 200 });
    // List view is a summary — no per-item array.
    expect(json.runs[0]).toMatchObject({ id: 'r-1', suite_key: 'smoke' });
    expect(json.runs[0].items).toBeUndefined();
  });
});

describe('GET /api/client/v1/evaluation/runs/:id', () => {
  it('returns the full run with items', async () => {
    const res = await runGET(req('GET', '/api/client/v1/evaluation/runs/r-1'), { params: Promise.resolve({ id: 'r-1' }) });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(getRun).toHaveBeenCalledWith('tenant_acme', 'r-1');
    expect(json.run.items).toHaveLength(1);
  });

  it('returns 404 when the run does not exist', async () => {
    (getRun as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await runGET(req('GET', '/api/client/v1/evaluation/runs/missing'), { params: Promise.resolve({ id: 'missing' }) });
    expect(res.status).toBe(404);
  });
});
