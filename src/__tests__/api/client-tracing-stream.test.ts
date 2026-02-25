import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockDb = vi.hoisted(() => ({
  switchToTenant: vi.fn(),
  findAgentTracingSessionById: vi.fn(),
  agentTracingAgentExists: vi.fn().mockResolvedValue(false),
  listAgentTracingSessions: vi.fn().mockResolvedValue({ total: 0, sessions: [] }),
  createAgentTracingSession: vi.fn(),
  updateAgentTracingSession: vi.fn(),
  createAgentTracingEvent: vi.fn(),
}));

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn().mockResolvedValue(mockDb),
}));

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

vi.mock('@/lib/quota/quotaGuard', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  checkPerRequestLimits: vi.fn().mockResolvedValue({ allowed: true, effectiveLimits: { quotas: {} } }),
  checkResourceQuota: vi.fn().mockResolvedValue({ allowed: true }),
}));

import { POST as startPOST } from '@/app/api/client/v1/tracing/sessions/stream/[sessionId]/start/route';
import { POST as eventsPOST } from '@/app/api/client/v1/tracing/sessions/stream/[sessionId]/events/route';
import { POST as endPOST } from '@/app/api/client/v1/tracing/sessions/stream/[sessionId]/end/route';

import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';

const mockRequireApiToken = vi.mocked(requireApiToken);

const DEFAULT_CTX = {
  tenantId: 'tenant-1',
  tenantDbName: 'tenant_acme',
  projectId: 'proj-1',
  tenant: { licenseType: 'PRO' },
  token: 'tok-1',
  tokenRecord: { _id: 'tr-1', userId: 'user-1' },
  user: { _id: 'user-1', email: 'test@example.com' },
};

const mockSession = {
  _id: 's-1',
  sessionId: 'sess-abc',
  projectId: 'proj-1',
  agentName: 'my-agent',
  totalEvents: 2,
  totalInputTokens: 100,
  totalOutputTokens: 50,
  totalCachedInputTokens: 0,
  totalBytesIn: 0,
  totalBytesOut: 0,
  status: 'in_progress',
  startedAt: new Date(),
  modelsUsed: ['gpt-4'],
  toolsUsed: [],
  eventCounts: {},
  summary: { totalDurationMs: 0, totalInputTokens: 100, totalOutputTokens: 50, totalCachedInputTokens: 0, totalBytesIn: 0, totalBytesOut: 0, eventCounts: {} },
  errors: [],
};

const sessionParams = { params: Promise.resolve({ sessionId: 'sess-abc' }) };

function makeReq(method: string, path: string, body?: Record<string, unknown>) {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// ─── Start ───────────────────────────────────────────────────────────────────

describe('POST /api/client/v1/tracing/sessions/stream/[sessionId]/start', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireApiToken.mockResolvedValue(DEFAULT_CTX as any);
    mockDb.findAgentTracingSessionById.mockResolvedValue(null);
    mockDb.agentTracingAgentExists.mockResolvedValue(false);
    mockDb.listAgentTracingSessions.mockResolvedValue({ total: 0, sessions: [] });
    mockDb.createAgentTracingSession.mockResolvedValue(undefined);
    mockDb.updateAgentTracingSession.mockResolvedValue(undefined);
  });

  it('starts a new session', async () => {
    const res = await startPOST(
      makeReq('POST', '/api/client/v1/tracing/sessions/stream/sess-abc/start', {
        agent: { name: 'my-agent', version: '1.0', model: 'gpt-4' },
      }),
      sessionParams,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessionId).toBe('sess-abc');
    expect(body.status).toBe('in_progress');
    expect(mockDb.createAgentTracingSession).toHaveBeenCalled();
  });

  it('updates an already-started session', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockDb.findAgentTracingSessionById.mockResolvedValueOnce(mockSession as any);
    const res = await startPOST(
      makeReq('POST', '/api/client/v1/tracing/sessions/stream/sess-abc/start', {}),
      sessionParams,
    );
    expect(res.status).toBe(200);
    expect(mockDb.updateAgentTracingSession).toHaveBeenCalled();
    expect(mockDb.createAgentTracingSession).not.toHaveBeenCalled();
  });

  it('returns 429 when rate limit exceeded', async () => {
    const { checkRateLimit } = await import('@/lib/quota/quotaGuard');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false, reason: 'Rate limit' } as any);
    const res = await startPOST(makeReq('POST', '/api/client/v1/tracing/sessions/stream/sess-abc/start', {}), sessionParams);
    expect(res.status).toBe(429);
  });

  it('returns 401 on auth error', async () => {
    mockRequireApiToken.mockRejectedValueOnce(new ApiTokenAuthError('Unauthorized', 401));
    const res = await startPOST(makeReq('POST', '/api/client/v1/tracing/sessions/stream/sess-abc/start', {}), sessionParams);
    expect(res.status).toBe(401);
  });
});

// ─── Events ──────────────────────────────────────────────────────────────────

describe('POST /api/client/v1/tracing/sessions/stream/[sessionId]/events', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireApiToken.mockResolvedValue(DEFAULT_CTX as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockDb.findAgentTracingSessionById.mockResolvedValue(mockSession as any);
    mockDb.createAgentTracingEvent.mockResolvedValue(undefined);
    mockDb.updateAgentTracingSession.mockResolvedValue(undefined);
  });

  it('adds an event to a session', async () => {
    const res = await eventsPOST(
      makeReq('POST', '/api/client/v1/tracing/sessions/stream/sess-abc/events', {
        event: { id: 'ev-1', type: 'llm', sequence: 1, inputTokens: 10, outputTokens: 5 },
      }),
      sessionParams,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessionId).toBe('sess-abc');
    expect(body.totalEvents).toBe(3); // 2 existing + 1
    expect(mockDb.createAgentTracingEvent).toHaveBeenCalled();
    expect(mockDb.updateAgentTracingSession).toHaveBeenCalled();
  });

  it('returns 400 when event is missing', async () => {
    const res = await eventsPOST(
      makeReq('POST', '/api/client/v1/tracing/sessions/stream/sess-abc/events', {}),
      sessionParams,
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 when session not found', async () => {
    mockDb.findAgentTracingSessionById.mockResolvedValueOnce(null);
    const res = await eventsPOST(
      makeReq('POST', '/api/client/v1/tracing/sessions/stream/sess-abc/events', { event: { type: 'llm' } }),
      sessionParams,
    );
    expect(res.status).toBe(404);
  });

  it('returns 429 when rate limit exceeded', async () => {
    const { checkRateLimit } = await import('@/lib/quota/quotaGuard');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false, reason: 'Rate limit' } as any);
    const res = await eventsPOST(
      makeReq('POST', '/api/client/v1/tracing/sessions/stream/sess-abc/events', { event: {} }),
      sessionParams,
    );
    expect(res.status).toBe(429);
  });

  it('returns 401 on auth error', async () => {
    mockRequireApiToken.mockRejectedValueOnce(new ApiTokenAuthError('Unauthorized', 401));
    const res = await eventsPOST(
      makeReq('POST', '/api/client/v1/tracing/sessions/stream/sess-abc/events', { event: {} }),
      sessionParams,
    );
    expect(res.status).toBe(401);
  });
});

// ─── End ─────────────────────────────────────────────────────────────────────

describe('POST /api/client/v1/tracing/sessions/stream/[sessionId]/end', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireApiToken.mockResolvedValue(DEFAULT_CTX as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockDb.findAgentTracingSessionById.mockResolvedValue(mockSession as any);
    mockDb.updateAgentTracingSession.mockResolvedValue(undefined);
  });

  it('ends a session', async () => {
    const res = await endPOST(
      makeReq('POST', '/api/client/v1/tracing/sessions/stream/sess-abc/end', {
        status: 'success',
        durationMs: 2500,
        errors: [],
      }),
      sessionParams,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessionId).toBe('sess-abc');
    expect(body.status).toBe('success');
    expect(mockDb.updateAgentTracingSession).toHaveBeenCalled();
  });

  it('ends a session with error status', async () => {
    const res = await endPOST(
      makeReq('POST', '/api/client/v1/tracing/sessions/stream/sess-abc/end', {
        status: 'error',
        errors: [{ message: 'Tool failed' }],
      }),
      sessionParams,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('error');
  });

  it('returns 404 when session not found', async () => {
    mockDb.findAgentTracingSessionById.mockResolvedValueOnce(null);
    const res = await endPOST(
      makeReq('POST', '/api/client/v1/tracing/sessions/stream/sess-abc/end', {}),
      sessionParams,
    );
    expect(res.status).toBe(404);
  });

  it('returns 429 when rate limit exceeded', async () => {
    const { checkRateLimit } = await import('@/lib/quota/quotaGuard');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false, reason: 'Rate limit' } as any);
    const res = await endPOST(
      makeReq('POST', '/api/client/v1/tracing/sessions/stream/sess-abc/end', {}),
      sessionParams,
    );
    expect(res.status).toBe(429);
  });

  it('returns 401 on auth error', async () => {
    mockRequireApiToken.mockRejectedValueOnce(new ApiTokenAuthError('Unauthorized', 401));
    const res = await endPOST(
      makeReq('POST', '/api/client/v1/tracing/sessions/stream/sess-abc/end', {}),
      sessionParams,
    );
    expect(res.status).toBe(401);
  });
});
