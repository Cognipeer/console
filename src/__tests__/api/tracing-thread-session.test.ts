/**
 * `GET /api/tracing/threads/:threadId/session` — the agent session a trace thread
 * belongs to, so the request inspector can draw a recorded `session-file://` picture
 * from the session's content route. It only names the session (the resolution itself
 * is covered in unit/agent-trace-session.test.ts; faked here).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));
vi.mock('@/server/api/fastify-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/api/fastify-utils')>();
  return {
    ...actual,
    requireProjectContextForRequest: vi.fn(),
    sendProjectContextError: vi.fn().mockReturnValue(null),
  };
});
vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/services/agentTracing', () => ({ AgentTracingService: {} }));
vi.mock('@/lib/services/agents/traceSession', () => ({ resolveTraceSession: vi.fn() }));

import { getDatabase } from '@/lib/database';
import { requireProjectContextForRequest } from '@/server/api/fastify-utils';
import { resolveTraceSession } from '@/lib/services/agents/traceSession';
import { tracingApiPlugin } from '@/server/api/plugins/tracing';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const mockFn = (fn: unknown) => fn as ReturnType<typeof vi.fn>;
const CTX = {
  projectId: 'proj-1',
  user: { _id: 'user-1', role: 'member', email: 'a@b.c' },
  session: { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', userId: 'user-1' },
};

let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

beforeEach(async () => {
  vi.clearAllMocks();
  mockFn(requireProjectContextForRequest).mockResolvedValue(CTX);
  mockFn(getDatabase).mockResolvedValue({ runWithTenant: <T>(_name: string, fn: () => T | Promise<T>) => fn() });
  app = await createFastifyApiTestApp(async (instance) => {
    await instance.register(tracingApiPlugin);
  });
});

afterEach(async () => {
  await app.close();
});

describe('GET /api/tracing/threads/:threadId/session', () => {
  it('names the agent and the session of a thread that is one, in the caller’s project', async () => {
    mockFn(resolveTraceSession).mockResolvedValue({ agentId: 'agent-1', sessionId: 'conv-1' });
    const res = await app.inject({ method: 'GET', url: '/api/tracing/threads/conv-1/session' });
    expect(res.statusCode).toBe(200);
    expect(parseJsonBody(res.body)).toEqual({ agentId: 'agent-1', sessionId: 'conv-1' });
    expect(mockFn(resolveTraceSession).mock.calls[0]![0]).toEqual({ tenantDbName: 'tenant_acme', projectId: 'proj-1', threadId: 'conv-1' });
  });

  it('answers 404 for a thread that is no session of this project', async () => {
    mockFn(resolveTraceSession).mockResolvedValue(null);
    const res = await app.inject({ method: 'GET', url: '/api/tracing/threads/some-api-thread/session' });
    expect(res.statusCode).toBe(404);
  });

  it('answers 500 when the lookup fails', async () => {
    mockFn(resolveTraceSession).mockRejectedValue(new Error('db down'));
    const res = await app.inject({ method: 'GET', url: '/api/tracing/threads/conv-1/session' });
    expect(res.statusCode).toBe(500);
  });
});
