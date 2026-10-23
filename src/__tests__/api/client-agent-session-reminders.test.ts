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

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
  runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(await getDatabase()),
}));

vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));

const hoisted = vi.hoisted(() => ({ getConversationById: vi.fn(), listReminders: vi.fn(), cancelReminder: vi.fn() }));

vi.mock('@/lib/services/agents', () => ({ getConversationById: hoisted.getConversationById }));
// Who may touch a session is decided (and tested) in agent-session-access; here it only finds the conversation in the token's project.
vi.mock('@/server/api/plugins/agent-session-access', () => ({
  loadSessionForPrincipal: async (_request: unknown, conversationId: string, options: { projectId?: string }) => {
    const found = await hoisted.getConversationById('tenant_acme', conversationId);
    return found && found.projectId === options.projectId
      ? { ok: true, conversation: found, userId: 'user-1', owner: found.createdBy === 'user-1' }
      : { ok: false, status: 404, reason: 'not_found' };
  },
  sendClientSessionRefusal: (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, _request: unknown, refusal: { status: number; reason: string }) =>
    reply.code(refusal.status).send({ error: { type: 'not_found_error', message: 'Session not found', code: 'session_not_found' } }),
  sendAuthorizationUnavailable: () => undefined,
  sendClientListUnavailable: () => undefined,
  sessionListScope: async () => ({ all: true }),
  sessionStreamStillAllowed: async () => true,
  decideSessionAccess: async () => ({ ok: true, userId: 'user-1', owner: true }),
}));
vi.mock('@/lib/services/agents/agentReminders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/agents/agentReminders')>();
  return { ...actual, listReminders: hoisted.listReminders, cancelReminder: hoisted.cancelReminder };
});

import { getDatabase } from '@/lib/database';
import { requireApiTokenFromHeader } from '@/lib/services/apiTokenAuth';
import { clientAgentSessionsApiPlugin } from '@/server/api/plugins/client-agent-sessions';
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
  user: { _id: 'user-1', role: 'user', tenantId: 'tenant-1', email: 'ada@example.com' },
};

const runWithTenant = vi.fn(<T>(_tenantDbName: string, fn: () => T | Promise<T>) => fn());
const conversation = (overrides: Record<string, unknown> = {}) => ({
  _id: 'conv-1', tenantId: 'tenant-1', projectId: 'proj-1', agentKey: 'support-agent', messages: [], createdBy: 'user-1', ...overrides,
});
const reminder = (over: Record<string, unknown> = {}) => ({
  _id: 'rem-1',
  agentKey: 'support-agent',
  conversationId: 'conv-1',
  status: 'scheduled',
  channel: 'reminder',
  userMessage: 'Check the ticket again.',
  notBefore: new Date('2026-10-19T15:00:00Z'),
  metadata: { reminder_chain: '2', reminder_set_by_run: 'run_prev' },
  createdAt: new Date('2026-10-19T14:00:00Z'),
  ...over,
});
const URL = '/api/client/v1/agents/sessions/conv-1/reminders';
const headers = { authorization: 'Bearer tok_abc' };

describe('/client/v1/agents/sessions/:id/reminders', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    (requireApiTokenFromHeader as ReturnType<typeof vi.fn>).mockResolvedValue(AUTH_CTX);
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(createMockDb({ runWithTenant } as never));
    hoisted.getConversationById.mockResolvedValue(conversation());
    app = await createFastifyApiTestApp(clientAgentSessionsApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET lists the waiting reminders of the session as a list', async () => {
    hoisted.listReminders.mockResolvedValue([reminder()]);
    const res = await app.inject({ method: 'GET', url: URL, headers });
    expect(res.statusCode).toBe(200);
    expect(parseJsonBody(res.body)).toEqual({
      object: 'list',
      data: [{
        id: 'run_rem-1',
        object: 'agent.reminder',
        agent: 'support-agent',
        session_id: 'conv-1',
        status: 'scheduled',
        fire_at: Math.floor(Date.parse('2026-10-19T15:00:00Z') / 1000),
        message: 'Check the ticket again.',
        reason: null,
        set_by_run: 'run_prev',
        chain: 2,
        created_at: Math.floor(Date.parse('2026-10-19T14:00:00Z') / 1000),
        completed_at: null,
        error: null,
      }],
    });
    expect(hoisted.listReminders).toHaveBeenCalledWith(
      { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', projectId: 'proj-1' },
      expect.objectContaining({ agentKey: 'support-agent', conversationId: 'conv-1', active: true }),
    );
  });

  it('GET status=all includes finished ones; an unknown status is a 400', async () => {
    hoisted.listReminders.mockResolvedValue([]);
    const all = await app.inject({ method: 'GET', url: `${URL}?status=all`, headers });
    expect(all.statusCode).toBe(200);
    expect(hoisted.listReminders).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ active: false }));
    const bad = await app.inject({ method: 'GET', url: `${URL}?status=done`, headers });
    expect(bad.statusCode).toBe(400);
  });

  it('GET 404s for a session of another project', async () => {
    hoisted.getConversationById.mockResolvedValue(conversation({ projectId: 'proj-other' }));
    const res = await app.inject({ method: 'GET', url: URL, headers });
    expect(res.statusCode).toBe(404);
    expect(hoisted.listReminders).not.toHaveBeenCalled();
  });

  it('DELETE cancels a waiting reminder of this session as the token\'s user', async () => {
    hoisted.cancelReminder.mockResolvedValue({ kind: 'canceled', run: reminder({ status: 'canceled' }) });
    const res = await app.inject({ method: 'DELETE', url: `${URL}/run_rem-1`, headers });
    expect(res.statusCode).toBe(200);
    expect(parseJsonBody<{ reminder: { id: string; status: string } }>(res.body).reminder).toMatchObject({ id: 'run_rem-1', status: 'canceled' });
    expect(hoisted.cancelReminder).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'proj-1' }),
      'run_rem-1',
      { agentKey: 'support-agent', conversationId: 'conv-1', actor: { userId: 'user-1', tokenId: 'tok-1', via: 'api' } },
    );
  });

  it('DELETE is a 404 for an unknown reminder and a 409 for one that already fired', async () => {
    hoisted.cancelReminder.mockResolvedValueOnce({ kind: 'not_found' });
    const missing = await app.inject({ method: 'DELETE', url: `${URL}/run_nope`, headers });
    expect(missing.statusCode).toBe(404);
    expect(parseJsonBody<{ error: { code: string } }>(missing.body).error.code).toBe('reminder_not_found');

    hoisted.cancelReminder.mockResolvedValueOnce({ kind: 'not_scheduled', run: reminder({ status: 'succeeded' }) });
    const fired = await app.inject({ method: 'DELETE', url: `${URL}/run_rem-1`, headers });
    expect(fired.statusCode).toBe(409);
    expect(parseJsonBody<{ error: { code: string } }>(fired.body).error.code).toBe('reminder_not_scheduled');
  });
});
