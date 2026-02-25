import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/alerts', () => ({
  AlertService: {
    getRule: vi.fn(),
    updateRule: vi.fn(),
    deleteRule: vi.fn(),
    toggleRule: vi.fn(),
  },
}));

import {
  GET,
  PUT,
  DELETE,
  PATCH,
} from '@/app/api/alerts/rules/[ruleId]/route';
import { AlertService } from '@/lib/services/alerts';

const mockGetRule = AlertService.getRule as ReturnType<typeof vi.fn>;
const mockUpdateRule = AlertService.updateRule as ReturnType<typeof vi.fn>;
const mockDeleteRule = AlertService.deleteRule as ReturnType<typeof vi.fn>;
const mockToggleRule = AlertService.toggleRule as ReturnType<typeof vi.fn>;

function makeRequest(
  opts: { body?: unknown; headers?: Record<string, string> } = {},
) {
  return new NextRequest('http://localhost/api/alerts/rules/rule-1', {
    method: 'GET',
    headers: {
      'x-tenant-db-name': 'tenant_acme',
      'x-user-id': 'user-1',
      ...opts.headers,
    },
    ...(opts.body ? { body: JSON.stringify(opts.body), method: 'POST' } : {}),
  });
}

const mockParams = { params: Promise.resolve({ ruleId: 'rule-1' }) };

const mockRule = {
  _id: 'rule-1',
  name: 'High Error Rate',
  metric: 'error_rate',
  operator: 'gt',
  threshold: 0.1,
  enabled: true,
};

describe('GET /api/alerts/rules/[ruleId]', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the rule on success', async () => {
    mockGetRule.mockResolvedValue(mockRule);
    const req = makeRequest();
    const res = await GET(req, mockParams);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.rule.name).toBe('High Error Rate');
  });

  it('returns 404 when rule not found', async () => {
    mockGetRule.mockResolvedValue(null);
    const req = makeRequest();
    const res = await GET(req, mockParams);
    expect(res.status).toBe(404);
  });

  it('returns 401 when headers missing', async () => {
    const req = new NextRequest('http://localhost/api/alerts/rules/rule-1');
    const res = await GET(req, mockParams);
    expect(res.status).toBe(401);
  });

  it('returns 500 on unexpected error', async () => {
    mockGetRule.mockRejectedValue(new Error('DB error'));
    const req = makeRequest();
    const res = await GET(req, mockParams);
    expect(res.status).toBe(500);
  });
});

describe('PUT /api/alerts/rules/[ruleId]', () => {
  beforeEach(() => vi.clearAllMocks());

  it('updates the rule and returns 200', async () => {
    const updated = { ...mockRule, name: 'Updated Rule' };
    mockUpdateRule.mockResolvedValue(updated);
    const req = makeRequest({ body: { name: 'Updated Rule' } });
    const res = await PUT(req, mockParams);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.rule.name).toBe('Updated Rule');
  });

  it('passes updatedBy as userId', async () => {
    mockUpdateRule.mockResolvedValue(mockRule);
    const req = makeRequest({ body: { name: 'x' } });
    await PUT(req, mockParams);
    expect(mockUpdateRule).toHaveBeenCalledWith(
      'tenant_acme',
      'rule-1',
      expect.objectContaining({ updatedBy: 'user-1' }),
    );
  });

  it('returns 404 when rule not found after update', async () => {
    mockUpdateRule.mockResolvedValue(null);
    const req = makeRequest({ body: {} });
    const res = await PUT(req, mockParams);
    expect(res.status).toBe(404);
  });

  it('returns 401 when headers missing', async () => {
    const req = new NextRequest('http://localhost/api/alerts/rules/rule-1', {
      method: 'PUT',
      body: JSON.stringify({}),
    });
    const res = await PUT(req, mockParams);
    expect(res.status).toBe(401);
  });

  it('returns 500 on unexpected error', async () => {
    mockUpdateRule.mockRejectedValue(new Error('DB error'));
    const req = makeRequest({ body: {} });
    const res = await PUT(req, mockParams);
    expect(res.status).toBe(500);
  });
});

describe('DELETE /api/alerts/rules/[ruleId]', () => {
  beforeEach(() => vi.clearAllMocks());

  it('deletes the rule and returns success', async () => {
    mockDeleteRule.mockResolvedValue(true);
    const req = makeRequest();
    const res = await DELETE(req, mockParams);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
  });

  it('returns 404 when rule not found', async () => {
    mockDeleteRule.mockResolvedValue(false);
    const req = makeRequest();
    const res = await DELETE(req, mockParams);
    expect(res.status).toBe(404);
  });

  it('returns 401 when headers missing', async () => {
    const req = new NextRequest('http://localhost/api/alerts/rules/rule-1', {
      method: 'DELETE',
    });
    const res = await DELETE(req, mockParams);
    expect(res.status).toBe(401);
  });

  it('returns 500 on unexpected error', async () => {
    mockDeleteRule.mockRejectedValue(new Error('DB error'));
    const req = makeRequest();
    const res = await DELETE(req, mockParams);
    expect(res.status).toBe(500);
  });
});

describe('PATCH /api/alerts/rules/[ruleId] (toggle)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('enables the rule and returns 200', async () => {
    const toggled = { ...mockRule, enabled: true };
    mockToggleRule.mockResolvedValue(toggled);
    const req = makeRequest({ body: { enabled: true } });
    const res = await PATCH(req, mockParams);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.rule.enabled).toBe(true);
  });

  it('disables the rule and returns 200', async () => {
    const toggled = { ...mockRule, enabled: false };
    mockToggleRule.mockResolvedValue(toggled);
    const req = makeRequest({ body: { enabled: false } });
    const res = await PATCH(req, mockParams);
    expect(res.status).toBe(200);
  });

  it('returns 400 when enabled is not boolean', async () => {
    const req = makeRequest({ body: { enabled: 'yes' } });
    const res = await PATCH(req, mockParams);
    expect(res.status).toBe(400);
  });

  it('returns 400 when enabled property is missing', async () => {
    const req = makeRequest({ body: {} });
    const res = await PATCH(req, mockParams);
    expect(res.status).toBe(400);
  });

  it('returns 404 when rule not found', async () => {
    mockToggleRule.mockResolvedValue(null);
    const req = makeRequest({ body: { enabled: true } });
    const res = await PATCH(req, mockParams);
    expect(res.status).toBe(404);
  });

  it('returns 401 when headers missing', async () => {
    const req = new NextRequest('http://localhost/api/alerts/rules/rule-1', {
      method: 'PATCH',
      body: JSON.stringify({ enabled: true }),
    });
    const res = await PATCH(req, mockParams);
    expect(res.status).toBe(401);
  });

  it('passes correct args to toggleRule', async () => {
    mockToggleRule.mockResolvedValue(mockRule);
    const req = makeRequest({ body: { enabled: false } });
    await PATCH(req, mockParams);
    expect(mockToggleRule).toHaveBeenCalledWith(
      'tenant_acme',
      'rule-1',
      false,
      'user-1',
    );
  });
});
