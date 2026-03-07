import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/agentTracing', () => ({
  AgentTracingService: {
    listSessions: vi.fn(),
    listThreads: vi.fn(),
    getSession: vi.fn(),
    getThread: vi.fn(),
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

import { GET as getSessions } from '@/server/api/routes/tracing/sessions/route';
import { GET as getThreads } from '@/server/api/routes/tracing/threads/route';
import { AgentTracingService } from '@/lib/services/agentTracing';
import { requireProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';

const HEADERS = {
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': 'tenant-1',
  'x-user-id': 'user-1',
};

function makeReq(path: string, method = 'GET', headers: Record<string, string> = HEADERS) {
  return new NextRequest(`http://localhost${path}`, { method, headers });
}

const MOCK_PROJECT = { projectId: 'proj-1' };

const MOCK_SESSIONS_RESULT = {
  sessions: [
    { _id: 'sess-1', agent: 'my-agent', status: 'completed', events: [] },
  ],
  total: 1,
};

const MOCK_THREADS_RESULT = {
  threads: [
    { threadId: 'thread-1', sessions: [], agent: 'my-agent' },
  ],
  total: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  (requireProjectContext as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_PROJECT);
  (AgentTracingService.listSessions as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_SESSIONS_RESULT);
  (AgentTracingService.listThreads as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_THREADS_RESULT);
});

describe('GET /api/tracing/sessions', () => {
  it('returns sessions 200', async () => {
    const req = makeReq('/api/tracing/sessions');
    const res = await getSessions(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.sessions).toHaveLength(1);
    expect(body.total).toBe(1);
  });

  it('returns 401 when headers missing', async () => {
    const req = makeReq('/api/tracing/sessions', 'GET', {});
    const res = await getSessions(req);
    expect(res.status).toBe(401);
  });

  it('passes query and agent filters', async () => {
    const req = makeReq('/api/tracing/sessions?query=test&agent=my-agent');
    await getSessions(req);
    expect(AgentTracingService.listSessions).toHaveBeenCalledWith(
      'tenant_acme',
      'proj-1',
      expect.objectContaining({ query: 'test', agent: 'my-agent' }),
    );
  });

  it('passes status filter', async () => {
    const req = makeReq('/api/tracing/sessions?status=completed');
    await getSessions(req);
    expect(AgentTracingService.listSessions).toHaveBeenCalledWith(
      'tenant_acme', 'proj-1',
      expect.objectContaining({ status: 'completed' }),
    );
  });

  it('passes pagination params', async () => {
    const req = makeReq('/api/tracing/sessions?limit=20&skip=10');
    await getSessions(req);
    expect(AgentTracingService.listSessions).toHaveBeenCalledWith(
      'tenant_acme', 'proj-1',
      expect.objectContaining({ limit: '20', skip: '10' }),
    );
  });

  it('returns ProjectContextError status', async () => {
    const e = new (ProjectContextError as any)('No project', 404);
    (requireProjectContext as ReturnType<typeof vi.fn>).mockRejectedValue(e);
    const res = await getSessions(makeReq('/api/tracing/sessions'));
    expect(res.status).toBe(404);
  });

  it('returns 500 on unexpected error', async () => {
    (AgentTracingService.listSessions as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db error'));
    const res = await getSessions(makeReq('/api/tracing/sessions'));
    expect(res.status).toBe(500);
  });
});

describe('GET /api/tracing/threads', () => {
  it('returns threads 200', async () => {
    const req = makeReq('/api/tracing/threads');
    const res = await getThreads(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.threads).toHaveLength(1);
  });

  it('returns 401 when headers missing', async () => {
    const req = makeReq('/api/tracing/threads', 'GET', {});
    const res = await getThreads(req);
    expect(res.status).toBe(401);
  });

  it('passes threadId filter', async () => {
    const req = makeReq('/api/tracing/threads?threadId=thread-1');
    await getThreads(req);
    expect(AgentTracingService.listThreads).toHaveBeenCalledWith(
      'tenant_acme', 'proj-1',
      expect.objectContaining({ threadId: 'thread-1' }),
    );
  });

  it('passes agent and status filters', async () => {
    const req = makeReq('/api/tracing/threads?agent=bot&status=running');
    await getThreads(req);
    expect(AgentTracingService.listThreads).toHaveBeenCalledWith(
      'tenant_acme', 'proj-1',
      expect.objectContaining({ agent: 'bot', status: 'running' }),
    );
  });

  it('returns ProjectContextError status', async () => {
    const e = new (ProjectContextError as any)('Forbidden', 403);
    (requireProjectContext as ReturnType<typeof vi.fn>).mockRejectedValue(e);
    const res = await getThreads(makeReq('/api/tracing/threads'));
    expect(res.status).toBe(403);
  });

  it('returns 500 on unexpected error', async () => {
    (AgentTracingService.listThreads as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db error'));
    const res = await getThreads(makeReq('/api/tracing/threads'));
    expect(res.status).toBe(500);
  });
});
