/**
 * Regression test for F-03 (finance-institution assessment, 2026-09-05):
 * `loadThreadOr404` resolved a thread purely by tenant + threadId — the
 * caller's project was never checked, so a token scoped to project A could
 * fetch project B's thread (agent conversation) just by knowing or guessing
 * its id. `findAgentConversationById` has no projectId parameter at all, so
 * the check has to happen in `loadThreadOr404` itself after the load.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/services/apiTokenAuth', () => {
  class ApiTokenAuthError extends Error {
    status: number;
    constructor(message: string, status = 401) {
      super(message);
      this.name = 'ApiTokenAuthError';
      this.status = status;
    }
  }
  return {
    ApiTokenAuthError,
    requireApiTokenFromHeader: vi.fn(),
  };
});

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
}));

vi.mock('@/lib/security/rbac', () => ({
  getPermissionServiceForPath: vi.fn(),
  authorizeServiceRequest: vi.fn(),
}));

vi.mock('@/lib/core/lifecycle', () => ({
  isShuttingDown: vi.fn().mockReturnValue(false),
}));

vi.mock('@/lib/services/agents', () => ({
  createAgentRecord: vi.fn(),
  createConversation: vi.fn(),
  executeAgentChat: vi.fn(),
  getAgentByKey: vi.fn(),
  getConversationById: vi.fn(),
  listAgents: vi.fn(),
  updateAgentRecord: vi.fn(),
}));

vi.mock('@/server/api/plugins/guardrail-bindings', () => ({
  resolveConfigGuardrailBindings: vi.fn().mockResolvedValue([]),
}));

import { requireApiTokenFromHeader } from '@/lib/services/apiTokenAuth';
import { getDatabase } from '@/lib/database';
import { getPermissionServiceForPath, authorizeServiceRequest } from '@/lib/security/rbac';
import { getAgentByKey, getConversationById } from '@/lib/services/agents';
import { clientAssistantsApiPlugin } from '@/server/api/plugins/client-assistants';
import { createFastifyApiTestApp } from '../helpers/fastify-api';

const AUTH_CTX_PROJECT_A = {
  token: 'tok_a',
  tokenRecord: { _id: 'tok-1', userId: 'user-1' },
  tenant: { licenseType: 'STARTER' },
  tenantId: 'tenant-1',
  tenantSlug: 'acme',
  tenantDbName: 'tenant_acme',
  projectId: 'proj-a',
  user: { _id: 'user-1', role: 'user', tenantId: 'tenant-1' },
};

const CONVERSATION_IN_PROJECT_B = {
  _id: 'conv-1',
  tenantId: 'tenant-1',
  projectId: 'proj-b',
  agentKey: 'support-bot',
  title: 'A project-B thread',
  messages: [],
  createdBy: 'other-user',
};

const runWithTenant = vi.fn(<T>(_db: string, fn: () => T | Promise<T>) => fn());

function mockFn(fn: unknown): ReturnType<typeof vi.fn> {
  return fn as ReturnType<typeof vi.fn>;
}

async function buildApp() {
  return createFastifyApiTestApp(clientAssistantsApiPlugin);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFn(requireApiTokenFromHeader).mockResolvedValue(AUTH_CTX_PROJECT_A);
  mockFn(getDatabase).mockResolvedValue({ runWithTenant });
  mockFn(getPermissionServiceForPath).mockReturnValue(null);
  mockFn(authorizeServiceRequest).mockReturnValue({ allowed: true });
});

describe('client Assistants API — thread ownership across projects', () => {
  it('404s when a project-A token requests a thread that belongs to project B', async () => {
    mockFn(getConversationById).mockResolvedValue(CONVERSATION_IN_PROJECT_B);
    mockFn(getAgentByKey).mockResolvedValue({ key: 'support-bot', status: 'active' });
    const app = await buildApp();

    const res = await app.inject({
      method: 'GET',
      url: '/api/client/v1/threads/thread_conv-1',
      headers: { authorization: 'Bearer tok' },
    });

    expect(res.statusCode).toBe(404);
    // The cross-project record must never reach the response body.
    expect(res.body).not.toContain('project-B');
  });

  it('200s and resolves the agent project-scoped when the thread belongs to the caller\'s own project', async () => {
    const ownConversation = { ...CONVERSATION_IN_PROJECT_B, projectId: 'proj-a', title: 'My own thread' };
    mockFn(getConversationById).mockResolvedValue(ownConversation);
    mockFn(getAgentByKey).mockResolvedValue({ key: 'support-bot', status: 'active' });
    const app = await buildApp();

    const res = await app.inject({
      method: 'GET',
      url: '/api/client/v1/threads/thread_conv-1',
      headers: { authorization: 'Bearer tok' },
    });

    expect(res.statusCode).toBe(200);
    // The agent lookup backing loadThreadOr404 must be scoped to the
    // conversation's own project, not left unscoped.
    expect(getAgentByKey).toHaveBeenCalledWith('tenant_acme', 'support-bot', 'proj-a');
  });
});
