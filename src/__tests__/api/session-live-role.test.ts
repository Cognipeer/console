/**
 * The role a handler decides on is the role the account has NOW, not the one the
 * session was issued with: a demoted admin loses an admin-only handler at once, a
 * promoted user gains one at once.
 *
 *  - a route the permission gate guards: the row the gate has just read decides;
 *  - every cookie request: the session hook corrects the context to the account's
 *    current role (the briefly cached identity), or refuses the request (503) when
 *    that cannot be read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

const h = vi.hoisted(() => ({
  db: null as unknown,
  store: new Map<string, unknown>(),
  getUserAuthState: vi.fn(),
  getUserIdentity: vi.fn(),
}));

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(async () => h.db),
  runWithTenantScope: vi.fn(async (_name: string, fn: (db: unknown) => unknown) => fn(h.db)),
}));
vi.mock('@/lib/core/cache', () => ({
  getCache: vi.fn(async () => ({
    get: vi.fn(async (key: string) => h.store.get(key)),
    set: vi.fn(async (key: string, value: unknown) => { h.store.set(key, value); }),
    del: vi.fn(async (key: string) => { h.store.delete(key); }),
  })),
}));
vi.mock('@/lib/services/users/userAuthState', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/users/userAuthState')>();
  return { ...actual, getUserAuthState: h.getUserAuthState, getUserIdentity: h.getUserIdentity };
});
vi.mock('@/lib/quota/quotaGuard', () => ({
  checkResourceQuota: vi.fn().mockResolvedValue({ allowed: true }),
}));
vi.mock('@/lib/services/projects/projectContext', () => {
  class ProjectContextError extends Error {
    status: number;
    constructor(message: string, status = 400) {
      super(message);
      this.status = status;
    }
  }
  return {
    ProjectContextError,
    resolveProjectContext: vi.fn().mockResolvedValue({ projectId: 'proj-1' }),
  };
});

import type { FastifyReply } from 'fastify';
import { rejectInactiveSessionAccount } from '@/server/api/fastify-utils';
import { tokensApiPlugin } from '@/server/api/plugins/tokens';
import { createFastifyApiTestApp } from '../helpers/fastify-api';

const TENANT = 'tenant-1';
const DB_NAME = 'tenant_acme';

function sessionAs(sessionRole: string) {
  return {
    'x-license-type': 'STARTER',
    'x-tenant-db-name': DB_NAME,
    'x-tenant-id': TENANT,
    'x-tenant-slug': 'acme',
    'x-user-email': 'person@acme.test',
    'x-user-id': 'person-1',
    'x-user-role': sessionRole,
  };
}

describe('live role of the session', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  let db: ReturnType<typeof createMockDb>;
  /** The role the account holds in the database right now. */
  let storedRole: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    h.store.clear();
    storedRole = 'user';
    db = createMockDb();
    h.db = db;
    db.findUserById.mockImplementation(async (id: string) =>
      (id === 'person-1' ? { _id: 'person-1', tenantId: TENANT, role: storedRole, canLogin: true } : null) as never);
    app = await createFastifyApiTestApp(tokensApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  const projectTokens = (sessionRole: string) => app.inject({
    method: 'GET',
    url: '/api/tokens?scope=project',
    headers: sessionAs(sessionRole),
  });

  describe('a route the permission gate guards', () => {
    it('refuses an admin-only handler to someone who was demoted since the session was issued', async () => {
      storedRole = 'user';
      expect((await projectTokens('admin')).statusCode).toBe(403);
      storedRole = 'project_admin';
      expect((await projectTokens('admin')).statusCode).toBe(403);
    });

    it('lets someone who was promoted since the session was issued through at once', async () => {
      storedRole = 'admin';
      expect((await projectTokens('user')).statusCode).toBe(200);
      storedRole = 'owner';
      expect((await projectTokens('user')).statusCode).toBe(200);
    });

    it('takes the next request after a change, with nothing to invalidate', async () => {
      storedRole = 'admin';
      expect((await projectTokens('admin')).statusCode).toBe(200);
      storedRole = 'user';
      expect((await projectTokens('admin')).statusCode).toBe(403);
      storedRole = 'admin';
      expect((await projectTokens('admin')).statusCode).toBe(200);
    });
  });

  describe('the session hook (every cookie request)', () => {
    /** A reply and request as the hook sees them: the context headers the session was issued with. */
    function hookFor(sessionRole: string) {
      const headers: Record<string, string> = { 'x-user-role': sessionRole, 'x-user-id': 'person-1' };
      const sent: { status?: number; body?: unknown } = {};
      const reply = {
        request: { apiContextHeaders: headers },
        code: (status: number) => { sent.status = status; return reply; },
        send: (body: unknown) => { sent.body = body; return reply; },
        clearCookie: vi.fn(),
      };
      return { headers, sent, reply: reply as unknown as FastifyReply };
    }
    const session = { tenantDbName: DB_NAME, tenantId: TENANT, userId: 'person-1' };

    beforeEach(() => {
      h.getUserAuthState.mockResolvedValue('active');
      h.getUserIdentity.mockResolvedValue({ state: 'active', role: 'user' });
    });

    it('hands the handlers the role the account has now', async () => {
      const { headers, reply } = hookFor('admin');
      expect(await rejectInactiveSessionAccount(reply, session)).toBe(false);
      expect(headers['x-user-role']).toBe('user');
      expect(h.getUserIdentity).toHaveBeenCalledWith(DB_NAME, TENANT, 'person-1');

      h.getUserIdentity.mockResolvedValue({ state: 'active', role: 'owner' });
      const promoted = hookFor('user');
      await rejectInactiveSessionAccount(promoted.reply, session);
      expect(promoted.headers['x-user-role']).toBe('owner');
    });

    it('leaves a role that did not change alone', async () => {
      h.getUserIdentity.mockResolvedValue({ state: 'active', role: 'admin' });
      const { headers, reply } = hookFor('admin');
      expect(await rejectInactiveSessionAccount(reply, session)).toBe(false);
      expect(headers['x-user-role']).toBe('admin');
    });

    it('leaves the session role alone when the account holds a role this version does not know', async () => {
      h.getUserIdentity.mockResolvedValue({ state: 'active', role: null });
      const { headers, reply } = hookFor('admin');
      expect(await rejectInactiveSessionAccount(reply, session)).toBe(false);
      expect(headers['x-user-role']).toBe('admin');
    });

    it('refuses the request (503) when the role of the account cannot be read', async () => {
      h.getUserIdentity.mockRejectedValue(new Error('db down'));
      const { headers, sent, reply } = hookFor('admin');
      expect(await rejectInactiveSessionAccount(reply, session)).toBe(true);
      expect(sent).toEqual({ status: 503, body: { error: 'Service Unavailable', message: 'Unable to verify session' } });
      expect(headers['x-user-role']).toBe('admin');
    });

    it('does not read the role of an account that is turned away anyway', async () => {
      for (const state of ['disabled', 'missing'] as const) {
        h.getUserAuthState.mockResolvedValue(state);
        const { sent, reply } = hookFor('admin');
        expect(await rejectInactiveSessionAccount(reply, session)).toBe(true);
        expect(sent.status).toBe(401);
      }
      expect(h.getUserIdentity).not.toHaveBeenCalled();
    });

    it('does nothing for a request that carries no session context', async () => {
      const reply = { request: {}, code: vi.fn(), send: vi.fn() } as unknown as FastifyReply;
      expect(await rejectInactiveSessionAccount(reply, session)).toBe(false);
      expect(h.getUserIdentity).not.toHaveBeenCalled();
    });
  });
});
