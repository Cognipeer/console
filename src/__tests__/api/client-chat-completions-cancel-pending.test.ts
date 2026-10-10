/**
 * `POST /client/v1/chat/completions` with an agent as the model and a `conversation_id`: a message to a session
 * that waits on a request, under the agent's `cancel_pending` setting, cancels that request - which is answering
 * it with "no", so it takes the engine's `agent.approve` (the decision itself: api/agent-session-authz.test.ts).
 * Only the wiring is checked here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/apiTokenAuth', () => {
  class ApiTokenAuthError extends Error {
    status: number;

    constructor(message: string, status = 401) {
      super(message);
      this.status = status;
    }
  }
  return { ApiTokenAuthError, requireApiTokenFromHeader: vi.fn() };
});

vi.mock('@/lib/database', () => {
  const getDatabase = vi.fn();
  return {
    getDatabase,
    runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(await getDatabase()),
  };
});
vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));

const hoisted = vi.hoisted(() => ({
  cancelPending: vi.fn(),
  getConversationById: vi.fn(),
  runAgentCompletion: vi.fn(),
  agent: { _id: 'agent-1', key: 'support-agent', status: 'active', config: { humanInTheLoop: { onUserMessageWhilePending: 'cancel_pending' } } },
}));

vi.mock('@/server/api/plugins/agent-approval-authz', () => ({
  refuseCancelPending: hoisted.cancelPending,
  CANCEL_PENDING_FORBIDDEN_MESSAGE: 'sending a message would cancel the open request',
}));
vi.mock('@/lib/services/agents/agentService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/agents/agentService')>();
  return { ...actual, getConversationById: hoisted.getConversationById };
});
vi.mock('@/server/api/plugins/agent-openai-bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/api/plugins/agent-openai-bridge')>();
  return {
    ...actual,
    resolveAgentModel: vi.fn(async () => hoisted.agent),
    runAgentCompletion: hoisted.runAgentCompletion,
  };
});

import { getDatabase } from '@/lib/database';
import { requireApiTokenFromHeader } from '@/lib/services/apiTokenAuth';
import { clientInferenceApiPlugin } from '@/server/api/plugins/client-inference';
import { createMockDb } from '../helpers/db.mock';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const AUTH_CTX = {
  token: 'tok_abc',
  tokenRecord: { _id: 'tok-1', userId: 'user-1' },
  tenant: { licenseType: 'STARTER' },
  tenantId: 'tenant-1',
  tenantSlug: 'acme',
  tenantDbName: 'tenant_acme',
  projectId: 'proj-1',
  user: { _id: 'user-1', role: 'user', tenantId: 'tenant-1' },
};
const conversation = { _id: 'conv-1', projectId: 'proj-1', agentKey: 'support-agent', createdBy: 'user-9', runtimeStatus: 'requires_action', messages: [] };

describe('chat completions with an agent: a message that would cancel an open request', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  const send = (extra: Record<string, unknown> = {}) => app.inject({
    method: 'POST', url: '/api/client/v1/chat/completions', headers: { authorization: 'Bearer tok_abc' },
    payload: { model: 'support-agent', messages: [{ role: 'user', content: 'never mind' }], conversation_id: 'conv-1', ...extra },
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    (requireApiTokenFromHeader as ReturnType<typeof vi.fn>).mockResolvedValue(AUTH_CTX);
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(createMockDb({ runWithTenant: <T>(_n: string, fn: () => T) => fn() } as never));
    hoisted.getConversationById.mockResolvedValue(conversation);
    hoisted.cancelPending.mockResolvedValue(null);
    hoisted.runAgentCompletion.mockResolvedValue({ content: 'ok', conversationId: 'conv-1' });
    app = await createFastifyApiTestApp(clientInferenceApiPlugin);
  });
  afterEach(async () => {
    await app.close();
  });

  it('is 403 (action_forbidden, with the decision id) for a token the engine does not let answer; nothing runs', async () => {
    hoisted.cancelPending.mockResolvedValue({ decisionId: 'dec-8' });
    const res = await send();
    expect(res.statusCode).toBe(403);
    expect(parseJsonBody<{ error: Record<string, unknown> }>(res.body).error).toMatchObject({
      type: 'permission_error', code: 'action_forbidden', decision_id: 'dec-8',
    });
    expect(hoisted.runAgentCompletion).not.toHaveBeenCalled();
    expect(hoisted.cancelPending).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tenantDbName: 'tenant_acme', conversation, agent: hoisted.agent }),
    );
  });

  it('runs for a token that may answer', async () => {
    const res = await send();
    expect(res.statusCode).toBe(200);
    expect(hoisted.runAgentCompletion).toHaveBeenCalledTimes(1);
  });

  it('asks nothing for a first message, or for a conversation of another agent or project', async () => {
    await send({ conversation_id: undefined });
    hoisted.getConversationById.mockResolvedValue({ ...conversation, projectId: 'proj-2' });
    await send();
    hoisted.getConversationById.mockResolvedValue({ ...conversation, agentKey: 'another-agent' });
    await send();
    expect(hoisted.cancelPending).not.toHaveBeenCalled();
  });
});
