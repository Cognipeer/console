/**
 * `GET /tracing/sessions` narrows to one agent by `agent`, and by `agentName` (the field the rows
 * carry): both reach the sessions read as the same filter.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));
vi.mock('@/server/api/fastify-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/api/fastify-utils')>();
  return {
    ...actual,
    authorizeServiceForRequest: vi.fn(),
    requireProjectContextForRequest: vi.fn(),
    sendProjectContextError: vi.fn().mockReturnValue(null),
  };
});
// Who may see which session is the access module's own subject: here every row is visible.
vi.mock('@/server/api/plugins/agent-session-access', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/api/plugins/agent-session-access')>();
  return {
    ...actual,
    pageOfVisibleRows: vi.fn(async (_request: unknown, input: { start: unknown; limit: number; fetchPage: (p: unknown, n: number) => Promise<{ rows: unknown[]; after: (n: number) => unknown }> }) => {
      const page = await input.fetchPage(input.start, input.limit);
      return { restricted: false, rows: page.rows, next: page.after(page.rows.length) };
    }),
  };
});
vi.mock('@/lib/database', () => ({ getDatabase: vi.fn(), runWithTenantScope: vi.fn() }));
vi.mock('@/lib/services/agentTracing', () => ({
  AgentTracingService: { listSessions: vi.fn() },
}));

import { AgentTracingService } from '@/lib/services/agentTracing';
import { requireProjectContextForRequest } from '@/server/api/fastify-utils';
import { tracingApiPlugin } from '@/server/api/plugins/tracing';
import { createFastifyApiTestApp } from '../helpers/fastify-api';

const mockFn = (fn: unknown) => fn as ReturnType<typeof vi.fn>;
let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

beforeEach(async () => {
  vi.clearAllMocks();
  mockFn(requireProjectContextForRequest).mockResolvedValue({
    projectId: 'proj-1',
    user: { _id: 'user-1', role: 'owner' },
    session: { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', userId: 'user-1' },
  });
  mockFn(AgentTracingService.listSessions).mockResolvedValue({ sessions: [], total: 0 });
  app = await createFastifyApiTestApp(tracingApiPlugin);
});

afterEach(async () => {
  await app.close();
});

describe('GET /tracing/sessions agent filter', () => {
  it.each(['agent', 'agentName'])('?%s=support narrows the read to that agent', async (param) => {
    const res = await app.inject({ method: 'GET', url: `/api/tracing/sessions?${param}=support`, headers: { 'x-tenant-db-name': 'tenant_acme' } });
    expect(res.statusCode).toBe(200);
    expect(mockFn(AgentTracingService.listSessions).mock.calls[0][2]).toMatchObject({ agent: 'support' });
  });
});
