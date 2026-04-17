import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/agentTracing', () => ({
  AgentTracingService: {
    getSessionDetail: vi.fn(),
    getThreadDetail: vi.fn(),
  },
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

import { GET as getSessionDetail } from '@/server/api/routes/tracing/sessions/[sessionId]/route';
import { GET as getThreadDetail } from '@/server/api/routes/tracing/threads/[threadId]/route';
import { AgentTracingService } from '@/lib/services/agentTracing';
import { requireProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';

const mockGetSessionDetail = AgentTracingService.getSessionDetail as ReturnType<typeof vi.fn>;
const mockGetThreadDetail = AgentTracingService.getThreadDetail as ReturnType<typeof vi.fn>;
const mockRequireProjectContext = requireProjectContext as ReturnType<typeof vi.fn>;

const mockContext = { projectId: 'project-1' };

function makeBaseRequest(url: string) {
  return new NextRequest(url, {
    headers: {
      'x-tenant-db-name': 'tenant_acme',
      'x-tenant-id': 'tenant-1',
      'x-user-id': 'user-1',
    },
  });
}

describe('GET /api/tracing/sessions/[sessionId]', () => {
  const mockSessionParams = { params: Promise.resolve({ sessionId: 'sess-1' }) };

  const mockSession = {
    _id: 'sess-1',
    sessionId: 'sess-1',
    agentName: 'agent-x',
    status: 'completed',
    events: [{ type: 'start', ts: 1000 }],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireProjectContext.mockResolvedValue(mockContext);
  });

  it('returns session detail on success', async () => {
    mockGetSessionDetail.mockResolvedValue(mockSession);
    const req = makeBaseRequest('http://localhost/api/tracing/sessions/sess-1');
    const res = await getSessionDetail(req, mockSessionParams);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.sessionId).toBe('sess-1');
    expect(body.events).toHaveLength(1);
  });

  it('returns 404 when session not found', async () => {
    mockGetSessionDetail.mockResolvedValue(null);
    const req = makeBaseRequest('http://localhost/api/tracing/sessions/sess-1');
    const res = await getSessionDetail(req, mockSessionParams);
    expect(res.status).toBe(404);
  });

  it('returns 401 when headers missing', async () => {
    const req = new NextRequest('http://localhost/api/tracing/sessions/sess-1');
    const res = await getSessionDetail(req, mockSessionParams);
    expect(res.status).toBe(401);
  });

  it('returns ProjectContextError status', async () => {
    mockRequireProjectContext.mockRejectedValue(
      new ProjectContextError('No project', 400),
    );
    const req = makeBaseRequest('http://localhost/api/tracing/sessions/sess-1');
    const res = await getSessionDetail(req, mockSessionParams);
    expect(res.status).toBe(400);
  });

  it('calls service with correct args', async () => {
    mockGetSessionDetail.mockResolvedValue(mockSession);
    const req = makeBaseRequest('http://localhost/api/tracing/sessions/sess-1');
    await getSessionDetail(req, mockSessionParams);
    expect(mockGetSessionDetail).toHaveBeenCalledWith(
      'tenant_acme',
      'project-1',
      'sess-1',
      { includeEventContent: true },
    );
  });

  it('returns 500 on unexpected error', async () => {
    mockGetSessionDetail.mockRejectedValue(new Error('DB error'));
    const req = makeBaseRequest('http://localhost/api/tracing/sessions/sess-1');
    const res = await getSessionDetail(req, mockSessionParams);
    expect(res.status).toBe(500);
  });
});

describe('GET /api/tracing/threads/[threadId]', () => {
  const mockThreadParams = { params: Promise.resolve({ threadId: 'thread-1' }) };

  const mockThread = {
    threadId: 'thread-1',
    sessions: [{ sessionId: 'sess-1', agentName: 'agent-x', status: 'completed' }],
    totalSessions: 1,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireProjectContext.mockResolvedValue(mockContext);
  });

  it('returns thread detail on success', async () => {
    mockGetThreadDetail.mockResolvedValue(mockThread);
    const req = makeBaseRequest('http://localhost/api/tracing/threads/thread-1');
    const res = await getThreadDetail(req, mockThreadParams);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.threadId).toBe('thread-1');
    expect(body.sessions).toHaveLength(1);
  });

  it('returns 404 when thread not found', async () => {
    mockGetThreadDetail.mockResolvedValue(null);
    const req = makeBaseRequest('http://localhost/api/tracing/threads/thread-1');
    const res = await getThreadDetail(req, mockThreadParams);
    expect(res.status).toBe(404);
  });

  it('returns 401 when headers missing', async () => {
    const req = new NextRequest('http://localhost/api/tracing/threads/thread-1');
    const res = await getThreadDetail(req, mockThreadParams);
    expect(res.status).toBe(401);
  });

  it('returns ProjectContextError status', async () => {
    mockRequireProjectContext.mockRejectedValue(
      new ProjectContextError('Forbidden', 403),
    );
    const req = makeBaseRequest('http://localhost/api/tracing/threads/thread-1');
    const res = await getThreadDetail(req, mockThreadParams);
    expect(res.status).toBe(403);
  });

  it('calls service with correct args', async () => {
    mockGetThreadDetail.mockResolvedValue(mockThread);
    const req = makeBaseRequest('http://localhost/api/tracing/threads/thread-1');
    await getThreadDetail(req, mockThreadParams);
    expect(mockGetThreadDetail).toHaveBeenCalledWith(
      'tenant_acme',
      'project-1',
      'thread-1',
    );
  });

  it('returns 500 on unexpected error', async () => {
    mockGetThreadDetail.mockRejectedValue(new Error('DB error'));
    const req = makeBaseRequest('http://localhost/api/tracing/threads/thread-1');
    const res = await getThreadDetail(req, mockThreadParams);
    expect(res.status).toBe(500);
  });
});
