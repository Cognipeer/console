/**
 * API route tests — POST /api/client/v1/tracing/sessions
 *
 * Tests HTTP surface without real DB or quota services.
 * All dependencies are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@/lib/services/apiTokenAuth', () => ({
  requireApiToken: vi.fn(),
  ApiTokenAuthError: class ApiTokenAuthError extends Error {
    status: number;
    constructor(message: string, status = 401) {
      super(message);
      this.name = 'ApiTokenAuthError';
      this.status = status;
    }
  },
}));

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
}));

vi.mock('@/lib/quota/quotaGuard', () => ({
  checkPerRequestLimits: vi.fn().mockResolvedValue({ allowed: true, effectiveLimits: { quotas: {}, perRequest: {} } }),
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, effectiveLimits: { quotas: {}, perRequest: {} } }),
  checkResourceQuota: vi.fn().mockResolvedValue({ allowed: true, effectiveLimits: { quotas: {}, perRequest: {} } }),
}));

vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));

const QUOTA_PASS = { allowed: true, effectiveLimits: { quotas: {}, perRequest: {} } };
const QUOTA_FAIL = { allowed: false, reason: 'Quota exceeded', effectiveLimits: { quotas: {}, perRequest: {} } };

import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { getDatabase } from '@/lib/database';
import { checkPerRequestLimits, checkRateLimit, checkResourceQuota } from '@/lib/quota/quotaGuard';
import { createMockDb } from '../helpers/db.mock';
import { drainPendingTasks } from '@/lib/core/asyncTask';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MOCK_AUTH = {
  token: 'sk-test-token',
  tokenRecord: { _id: 'tok-1', tenantId: 'tenant-1', userId: 'user-1', projectId: 'proj-1', token: 'sk-test-token', name: 'Test' },
  tenant: { _id: 'tenant-1', slug: 'acme', dbName: 'tenant_acme', licenseType: 'FREE', companyName: 'Acme' },
  tenantId: 'tenant-1',
  tenantSlug: 'acme',
  tenantDbName: 'tenant_acme',
  projectId: 'proj-1',
};

function buildRequest(
  body: Record<string, unknown>,
  opts: { contentLength?: number; token?: string } = {},
) {
  const bodyStr = JSON.stringify(body);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${opts.token ?? 'sk-test-token'}`,
    'content-length': String(opts.contentLength ?? Buffer.byteLength(bodyStr)),
  };
  return new NextRequest('http://localhost/api/client/v1/tracing/sessions', {
    method: 'POST',
    headers,
    body: bodyStr,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/client/v1/tracing/sessions', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();

    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    (requireApiToken as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_AUTH);
    (checkPerRequestLimits as ReturnType<typeof vi.fn>).mockResolvedValue(QUOTA_PASS);
    (checkRateLimit as ReturnType<typeof vi.fn>).mockResolvedValue(QUOTA_PASS);
    (checkResourceQuota as ReturnType<typeof vi.fn>).mockResolvedValue(QUOTA_PASS);
  });

  // ── Auth & Validation ────────────────────────────────────────────────────────

  it('returns 413 when content-length exceeds limit', async () => {
    const { POST } = await import('@/server/api/routes/client/v1/tracing/sessions/route');

    const req = buildRequest({ sessionId: 's1' }, { contentLength: 999_999_999 });
    const res = await POST(req);

    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toMatch(/Payload too large/i);
  });

  it('returns 401 when requireApiToken throws ApiTokenAuthError', async () => {
    const { POST } = await import('@/server/api/routes/client/v1/tracing/sessions/route');

    (requireApiToken as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ApiTokenAuthError('Unauthorized', 401),
    );

    const req = buildRequest({ sessionId: 's1' });
    const res = await POST(req);

    expect(res.status).toBe(401);
  });

  it('returns 400 when sessionId is missing', async () => {
    const { POST } = await import('@/server/api/routes/client/v1/tracing/sessions/route');

    const req = buildRequest({ status: 'completed' }); // no sessionId
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/sessionId/i);
  });

  // ── Quota checks ─────────────────────────────────────────────────────────────

  it('returns 429 when per-request limits are exceeded', async () => {
    const { POST } = await import('@/server/api/routes/client/v1/tracing/sessions/route');

    (checkPerRequestLimits as ReturnType<typeof vi.fn>).mockResolvedValue(QUOTA_FAIL);

    const req = buildRequest({ sessionId: 's1', status: 'completed' });
    const res = await POST(req);

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toMatch(/quota/i);
  });

  it('returns 429 when rate limit is exceeded', async () => {
    const { POST } = await import('@/server/api/routes/client/v1/tracing/sessions/route');

    (checkRateLimit as ReturnType<typeof vi.fn>).mockResolvedValue(QUOTA_FAIL);

    const req = buildRequest({ sessionId: 's1', status: 'completed' });
    const res = await POST(req);

    expect(res.status).toBe(429);
  });

  // ── Happy path ───────────────────────────────────────────────────────────────

  it('returns 200 with sessionId for minimal valid payload', async () => {
    const { POST } = await import('@/server/api/routes/client/v1/tracing/sessions/route');

    const req = buildRequest({ sessionId: 'sess-minimal', status: 'completed' });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.sessionId).toBe('sess-minimal');
    expect(body.eventsStored).toBe(0);
  });

  it('calls createAgentTracingSession when session is new', async () => {
    const { POST } = await import('@/server/api/routes/client/v1/tracing/sessions/route');
    db.findAgentTracingSessionById.mockResolvedValue(null); // new session

    const req = buildRequest({
      sessionId: 'sess-new',
      status: 'completed',
      agent: { name: 'my-agent', model: 'gpt-4o' },
    });
    await POST(req);
    await drainPendingTasks();

    expect(db.createAgentTracingSession).toHaveBeenCalledTimes(1);
    const call = db.createAgentTracingSession.mock.calls[0][0];
    expect(call.sessionId).toBe('sess-new');
    expect(call.agentName).toBe('my-agent');
    expect(call.modelsUsed).toContain('gpt-4o');
  });

  it('calls updateAgentTracingSession when session already exists', async () => {
    const { POST } = await import('@/server/api/routes/client/v1/tracing/sessions/route');
    db.findAgentTracingSessionById.mockResolvedValue({ sessionId: 'sess-existing', tenantId: 'tenant-1', projectId: 'proj-1', agent: {}, config: {}, summary: {}, status: 'completed', startedAt: new Date(), errors: [], modelsUsed: [], toolsUsed: [], eventCounts: {}, totalEvents: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCachedInputTokens: 0 });

    const req = buildRequest({ sessionId: 'sess-existing', status: 'completed' });
    await POST(req);
    await drainPendingTasks();

    expect(db.updateAgentTracingSession).toHaveBeenCalledTimes(1);
    expect(db.createAgentTracingSession).not.toHaveBeenCalled();
  });

  it('persists each event with createAgentTracingEvent', async () => {
    const { POST } = await import('@/server/api/routes/client/v1/tracing/sessions/route');

    const events = [
      { id: 'e1', type: 'llm', sequence: 1, model: 'gpt-4o' },
      { id: 'e2', type: 'tool', sequence: 2, actor: { scope: 'tool', name: 'search' } },
    ];

    const req = buildRequest({ sessionId: 'sess-events', status: 'completed', events });
    const res = await POST(req);
    await drainPendingTasks();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.eventsStored).toBe(2);
    expect(db.createAgentTracingEvent).toHaveBeenCalledTimes(2);
  });

  it('extracts modelsUsed from event.model fields', async () => {
    const { POST } = await import('@/server/api/routes/client/v1/tracing/sessions/route');

    const events = [
      { id: 'e1', type: 'llm', sequence: 1, model: 'claude-3-5-sonnet' },
      { id: 'e2', type: 'llm', sequence: 2, modelName: 'gpt-4o' },
    ];
    const req = buildRequest({ sessionId: 'sess-models', status: 'completed', events });
    await POST(req);
    await drainPendingTasks();

    const sessionCall = db.createAgentTracingSession.mock.calls[0][0];
    expect(sessionCall.modelsUsed).toContain('claude-3-5-sonnet');
    expect(sessionCall.modelsUsed).toContain('gpt-4o');
  });

  it('extracts toolsUsed from actor.scope=tool events', async () => {
    const { POST } = await import('@/server/api/routes/client/v1/tracing/sessions/route');

    const events = [
      { id: 'e1', type: 'tool', sequence: 1, actor: { scope: 'tool', name: 'wikipedia' } },
    ];
    const req = buildRequest({ sessionId: 'sess-tools', status: 'completed', events });
    await POST(req);
    await drainPendingTasks();

    const sessionCall = db.createAgentTracingSession.mock.calls[0][0];
    expect(sessionCall.toolsUsed).toContain('wikipedia');
  });

  it('stores threadId when provided', async () => {
    const { POST } = await import('@/server/api/routes/client/v1/tracing/sessions/route');

    const req = buildRequest({
      sessionId: 'sess-thread',
      status: 'completed',
      threadId: '  thread-abc  ', // leading/trailing spaces should be trimmed
    });
    await POST(req);
    await drainPendingTasks();

    const sessionCall = db.createAgentTracingSession.mock.calls[0][0];
    expect(sessionCall.threadId).toBe('thread-abc');
  });

  it('returns 200 even when async DB write fails (fire-and-forget)', async () => {
    const { POST } = await import('@/server/api/routes/client/v1/tracing/sessions/route');
    db.createAgentTracingSession.mockRejectedValue(new Error('DB connection lost'));

    const req = buildRequest({ sessionId: 'sess-err', status: 'completed' });
    const res = await POST(req);

    // Response is returned before the async DB write, so status is 200
    expect(res.status).toBe(200);
    // The error is logged internally by fireAndForget but does not propagate
    await drainPendingTasks();
  });
});
