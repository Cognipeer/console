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

vi.mock('@/lib/services/guardrail', () => ({
  evaluateGuardrail: vi.fn(),
}));

import { POST } from '@/server/api/routes/client/v1/guardrails/evaluate/route';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { evaluateGuardrail } from '@/lib/services/guardrail';

const DEFAULT_CTX = {
  tenantId: 'tenant-1',
  tenantDbName: 'tenant_acme',
  projectId: 'proj-1',
  tokenRecord: { userId: 'user-1' },
};

function makeReq(body: object): NextRequest {
  return new NextRequest('http://localhost/api/client/v1/guardrails/evaluate', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

const VALID_BODY = {
  guardrail_key: 'pii-guard',
  text: 'Hello, my name is John Doe',
};

describe('POST /api/client/v1/guardrails/evaluate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (requireApiToken as ReturnType<typeof vi.fn>).mockResolvedValue(DEFAULT_CTX);
  });

  it('returns 401 on ApiTokenAuthError', async () => {
    (requireApiToken as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ApiTokenAuthError('Invalid token', 401),
    );

    const res = await POST(makeReq(VALID_BODY));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('Invalid token');
  });

  it('returns 400 when guardrail_key is missing', async () => {
    const res = await POST(makeReq({ text: 'hello' }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain('guardrail_key');
  });

  it('returns 400 when text is missing', async () => {
    const res = await POST(makeReq({ guardrail_key: 'pii-guard' }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain('text');
  });

  it('returns 400 when guardrail_key is not a string', async () => {
    const res = await POST(makeReq({ guardrail_key: 123, text: 'hello' }));
    expect(res.status).toBe(400);
  });

  it('returns 200 with passed: true when guardrail passes', async () => {
    (evaluateGuardrail as ReturnType<typeof vi.fn>).mockResolvedValue({
      passed: true,
      guardrailKey: 'pii-guard',
      guardrailName: 'PII Guard',
      action: 'flag',
      findings: [],
    });

    const res = await POST(makeReq(VALID_BODY));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.passed).toBe(true);
    expect(json.guardrail_key).toBe('pii-guard');
    expect(json.message).toBeNull();
    expect(json.findings).toEqual([]);
  });

  it('returns 200 with passed: false and message when guardrail blocks', async () => {
    (evaluateGuardrail as ReturnType<typeof vi.fn>).mockResolvedValue({
      passed: false,
      guardrailKey: 'pii-guard',
      guardrailName: 'PII Guard',
      action: 'block',
      findings: [{ category: 'pii', message: 'PII detected', block: true }],
    });

    const res = await POST(makeReq(VALID_BODY));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.passed).toBe(false);
    expect(json.message).toContain('Content blocked');
    expect(json.message).toContain('Pii');
  });

  it('includes non-blocking findings in response', async () => {
    (evaluateGuardrail as ReturnType<typeof vi.fn>).mockResolvedValue({
      passed: false,
      guardrailKey: 'content-guard',
      guardrailName: 'Content Guard',
      action: 'flag',
      findings: [{ category: 'profanity', message: 'Mild language detected', block: false }],
    });

    const res = await POST(makeReq({ guardrail_key: 'content-guard', text: 'some text' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.message).toBe('Content flagged by guardrail.');
  });

  it('calls evaluateGuardrail with correct args', async () => {
    (evaluateGuardrail as ReturnType<typeof vi.fn>).mockResolvedValue({
      passed: true,
      guardrailKey: 'pii-guard',
      guardrailName: 'PII Guard',
      action: 'block',
      findings: [],
    });

    await POST(makeReq(VALID_BODY));

    expect(evaluateGuardrail).toHaveBeenCalledWith({
      tenantDbName: 'tenant_acme',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      guardrailKey: 'pii-guard',
      text: 'Hello, my name is John Doe',
    });
  });

  it('returns 404 when error message contains "not found"', async () => {
    (evaluateGuardrail as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Guardrail pii-guard not found'),
    );

    const res = await POST(makeReq(VALID_BODY));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toContain('not found');
  });

  it('returns 500 on unexpected error', async () => {
    (evaluateGuardrail as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Provider connection failed'),
    );

    const res = await POST(makeReq(VALID_BODY));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Provider connection failed');
  });
});
