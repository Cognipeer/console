import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/guardrail', () => ({
  evaluateGuardrail: vi.fn(),
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

import { POST } from '@/app/api/guardrails/evaluate/route';
import { evaluateGuardrail } from '@/lib/services/guardrail';
import { requireProjectContext } from '@/lib/services/projects/projectContext';

const mockEvaluateGuardrail = vi.mocked(evaluateGuardrail);
const mockRequireProjectContext = vi.mocked(requireProjectContext);

const BASE_HEADERS = {
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': 'tenant-1',
  'x-user-id': 'user-1',
};

const mockPassedResult = {
  passed: true,
  guardrailKey: 'pii-guard',
  guardrailName: 'PII Guard',
  action: 'allow',
  findings: [],
};

const mockBlockedResult = {
  passed: false,
  guardrailKey: 'pii-guard',
  guardrailName: 'PII Guard',
  action: 'block',
  findings: [{ category: 'pii_detection', message: 'Email detected', block: true }],
};

function makeReq(headers?: Record<string, string>, body?: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/guardrails/evaluate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(headers ?? BASE_HEADERS) },
    body: JSON.stringify(body ?? { guardrail_key: 'pii-guard', text: 'Hello world' }),
  });
}

describe('POST /api/guardrails/evaluate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireProjectContext.mockResolvedValue({ projectId: 'proj-1' } as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockEvaluateGuardrail.mockResolvedValue(mockPassedResult as any);
  });

  it('returns 200 with passed result when text passes guardrail', async () => {
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.passed).toBe(true);
    expect(body.guardrail_key).toBe('pii-guard');
    expect(body.message).toBeNull();
  });

  it('returns 200 with blocked result and message when text is blocked', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockEvaluateGuardrail.mockResolvedValueOnce(mockBlockedResult as any);
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.passed).toBe(false);
    expect(body.action).toBe('block');
    expect(body.findings).toHaveLength(1);
    expect(body.message).toContain('Content blocked');
  });

  it('returns 401 when x-tenant-db-name is missing', async () => {
    const { 'x-tenant-db-name': _, ...headersWithout } = BASE_HEADERS;
    const res = await POST(makeReq(headersWithout));
    expect(res.status).toBe(401);
  });

  it('returns 401 when x-user-id is missing', async () => {
    const { 'x-user-id': _, ...headersWithout } = BASE_HEADERS;
    const res = await POST(makeReq(headersWithout));
    expect(res.status).toBe(401);
  });

  it('returns 400 when guardrail_key is missing', async () => {
    const res = await POST(makeReq(BASE_HEADERS, { text: 'Hello' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/guardrail_key/i);
  });

  it('returns 400 when text is missing', async () => {
    const res = await POST(makeReq(BASE_HEADERS, { guardrail_key: 'pii-guard' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/text/i);
  });

  it('calls evaluateGuardrail with correct arguments', async () => {
    await POST(makeReq());
    expect(mockEvaluateGuardrail).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantDbName: 'tenant_acme',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        guardrailKey: 'pii-guard',
        text: 'Hello world',
      }),
    );
  });

  it('returns 404 when guardrail not found', async () => {
    mockEvaluateGuardrail.mockRejectedValueOnce(new Error('Guardrail not found'));
    const res = await POST(makeReq());
    expect(res.status).toBe(404);
  });

  it('returns 500 on unexpected service error', async () => {
    mockEvaluateGuardrail.mockRejectedValueOnce(new Error('Service crashed'));
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
  });

  it('propagates ProjectContextError status', async () => {
    const { ProjectContextError: PCE } = await import('@/lib/services/projects/projectContext');
    mockRequireProjectContext.mockRejectedValueOnce(new PCE('No project', 403));
    const res = await POST(makeReq());
    expect(res.status).toBe(403);
  });

  it('includes all expected fields in response', async () => {
    const res = await POST(makeReq());
    const body = await res.json();
    expect(body).toHaveProperty('passed');
    expect(body).toHaveProperty('guardrail_key');
    expect(body).toHaveProperty('guardrail_name');
    expect(body).toHaveProperty('action');
    expect(body).toHaveProperty('findings');
    expect(body).toHaveProperty('message');
  });
});
