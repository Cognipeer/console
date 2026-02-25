import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/alerts', () => ({
  AlertService: {
    listRules: vi.fn(),
    createRule: vi.fn(),
    getRule: vi.fn(),
    updateRule: vi.fn(),
    deleteRule: vi.fn(),
    toggleRule: vi.fn(),
  },
  VALID_METRICS: ['error_rate', 'latency_p99', 'request_count'],
  VALID_WINDOWS: [5, 15, 30, 60],
  VALID_MODULES: ['llm', 'vector', 'tracing'],
  MODULE_METRICS: { llm: ['error_rate', 'latency_p99'], vector: ['request_count'] },
}));

vi.mock('@/lib/services/projects/projectContext', () => {
  class ProjectContextError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  return {
    requireProjectContext: vi.fn(),
    ProjectContextError,
  };
});

import { GET, POST } from '@/app/api/alerts/rules/route';
import { GET as ruleGet, PUT as rulePut } from '@/app/api/alerts/rules/[ruleId]/route';
import { AlertService } from '@/lib/services/alerts';
import { requireProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';

const HEADERS = {
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': 'tenant-1',
  'x-user-id': 'user-1',
};

const PROJECT_CTX = {
  projectId: 'proj-1',
  tenantId: 'tenant-1',
  tenantDbName: 'tenant_acme',
};

const MOCK_RULE = {
  _id: 'rule-1',
  name: 'High Error Rate',
  module: 'llm',
  metric: 'error_rate',
  condition: { operator: 'gt', threshold: 0.1 },
  windowMinutes: 15,
  enabled: true,
};

function makeReq(path: string, method = 'GET', body?: object, headers: Record<string, string> = HEADERS): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: new Headers({ 'Content-Type': 'application/json', ...headers }),
    body: body ? JSON.stringify(body) : undefined,
  });
}

// ---- GET /api/alerts/rules ----
describe('GET /api/alerts/rules', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (requireProjectContext as ReturnType<typeof vi.fn>).mockResolvedValue(PROJECT_CTX);
  });

  it('returns 200 with rules list', async () => {
    (AlertService.listRules as ReturnType<typeof vi.fn>).mockResolvedValue([MOCK_RULE]);

    const res = await GET(makeReq('/api/alerts/rules'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.rules).toHaveLength(1);
    expect(json.meta).toBeDefined();
    expect(json.meta.validMetrics).toBeDefined();
  });

  it('returns 401 when tenant headers are missing', async () => {
    const res = await GET(makeReq('/api/alerts/rules', 'GET', undefined, {}));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('Unauthorized');
  });

  it('returns project context error status when thrown', async () => {
    (requireProjectContext as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ProjectContextError('No project selected', 400),
    );

    const res = await GET(makeReq('/api/alerts/rules'));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('No project selected');
  });

  it('returns 500 on service error', async () => {
    (AlertService.listRules as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('DB read failed'),
    );

    const res = await GET(makeReq('/api/alerts/rules'));
    const json = await res.json();

    expect(res.status).toBe(500);
  });
});

// ---- POST /api/alerts/rules ----
describe('POST /api/alerts/rules', () => {
  const VALID_BODY = {
    name: 'High Error Rate',
    module: 'llm',
    metric: 'error_rate',
    condition: { operator: 'gt', threshold: 0.1 },
    windowMinutes: 15,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (requireProjectContext as ReturnType<typeof vi.fn>).mockResolvedValue(PROJECT_CTX);
  });

  it('returns 201 with created rule', async () => {
    (AlertService.createRule as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_RULE);

    const res = await POST(makeReq('/api/alerts/rules', 'POST', VALID_BODY));
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.rule).toMatchObject({ name: 'High Error Rate' });
  });

  it('returns 401 when headers are missing', async () => {
    const res = await POST(makeReq('/api/alerts/rules', 'POST', VALID_BODY, {}));
    expect(res.status).toBe(401);
  });

  it('returns 400 when name is missing', async () => {
    const res = await POST(makeReq('/api/alerts/rules', 'POST', { ...VALID_BODY, name: '' }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain('name');
  });

  it('returns 400 when module is invalid', async () => {
    const res = await POST(makeReq('/api/alerts/rules', 'POST', { ...VALID_BODY, module: 'invalid' }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain('module');
  });

  it('returns 400 when metric is invalid', async () => {
    const res = await POST(makeReq('/api/alerts/rules', 'POST', { ...VALID_BODY, metric: 'bad_metric' }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain('metric');
  });

  it('returns 400 when condition threshold is missing', async () => {
    const res = await POST(makeReq('/api/alerts/rules', 'POST', {
      ...VALID_BODY,
      condition: { operator: 'gt' },
    }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain('condition');
  });

  it('returns 400 when windowMinutes is invalid', async () => {
    const res = await POST(makeReq('/api/alerts/rules', 'POST', {
      ...VALID_BODY,
      windowMinutes: 999,
    }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain('windowMinutes');
  });

  it('returns 500 on service error', async () => {
    (AlertService.createRule as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Creation failed'),
    );

    const res = await POST(makeReq('/api/alerts/rules', 'POST', VALID_BODY));
    expect(res.status).toBe(500);
  });
});

// ---- GET /api/alerts/rules/:ruleId ----
describe('GET /api/alerts/rules/:ruleId', () => {
  const ROUTE_CTX = { params: Promise.resolve({ ruleId: 'rule-1' }) };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 200 with rule', async () => {
    (AlertService.getRule as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_RULE);

    const res = await ruleGet(makeReq('/api/alerts/rules/rule-1'), ROUTE_CTX);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.rule).toMatchObject({ name: 'High Error Rate' });
  });

  it('returns 404 when rule does not exist', async () => {
    (AlertService.getRule as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const res = await ruleGet(makeReq('/api/alerts/rules/rule-nonexistent'), ROUTE_CTX);
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toBe('Rule not found');
  });

  it('returns 401 when headers are missing', async () => {
    const res = await ruleGet(makeReq('/api/alerts/rules/rule-1', 'GET', undefined, {}), ROUTE_CTX);
    expect(res.status).toBe(401);
  });

  it('returns 500 on service error', async () => {
    (AlertService.getRule as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB error'));

    const res = await ruleGet(makeReq('/api/alerts/rules/rule-1'), ROUTE_CTX);
    expect(res.status).toBe(500);
  });
});

// ---- PUT /api/alerts/rules/:ruleId ----
describe('PUT /api/alerts/rules/:ruleId', () => {
  const ROUTE_CTX = { params: Promise.resolve({ ruleId: 'rule-1' }) };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 200 with updated rule', async () => {
    const updated = { ...MOCK_RULE, name: 'Updated Rule' };
    (AlertService.updateRule as ReturnType<typeof vi.fn>).mockResolvedValue(updated);

    const res = await rulePut(makeReq('/api/alerts/rules/rule-1', 'PUT', { name: 'Updated Rule' }), ROUTE_CTX);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.rule.name).toBe('Updated Rule');
  });

  it('returns 401 when headers are missing', async () => {
    const res = await rulePut(
      makeReq('/api/alerts/rules/rule-1', 'PUT', { name: 'x' }, {}),
      ROUTE_CTX,
    );
    expect(res.status).toBe(401);
  });

  it('returns 500 on service error', async () => {
    (AlertService.updateRule as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Update failed'));

    const res = await rulePut(makeReq('/api/alerts/rules/rule-1', 'PUT', { name: 'test' }), ROUTE_CTX);
    expect(res.status).toBe(500);
  });
});
