/**
 * POST /api/tokens/revoke - revoke many tokens by id, whatever project they live in.
 *
 * Each id is judged by the same "never upward" rule as DELETE /api/tokens/:id, one at
 * a time, so one refused token does not stop the rest. Owners and admins are in every
 * project; anyone else revokes a token of their own wherever it lives and somebody
 * else's only in a project they are in. Revoking is per owner (a page of tokens must
 * not flush every principal of the workspace), evicts each token's cached auth record,
 * and leaves one audit row per token.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

const h = vi.hoisted(() => ({ recordAuditLog: vi.fn() }));

vi.mock('@/lib/database', () => {
  const getDatabase = vi.fn();
  return {
    getDatabase,
    // The gate reads the caller (and the engine its policies) through the tenant scope.
    runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(await getDatabase()),
  };
});
vi.mock('@/lib/services/audit/auditService', () => ({ recordAuditLog: h.recordAuditLog }));
// the real lookup, watched: how often a request asks about the caller's projects
vi.mock('@/lib/services/projects/accessibleProjects', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/projects/accessibleProjects')>();
  return { ...actual, collectAccessibleProjectIds: vi.fn(actual.collectAccessibleProjectIds) };
});
vi.mock('@/lib/quota/quotaGuard', () => ({ checkResourceQuota: vi.fn().mockResolvedValue({ allowed: true }) }));
vi.mock('@/lib/services/apiTokenAuth', () => ({
  ApiTokenAuthError: class extends Error {},
  apiAuthCacheKey: vi.fn(),
  invalidateApiTokenAuthCache: vi.fn(),
  requireApiTokenFromHeader: vi.fn(),
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

import { getDatabase } from '@/lib/database';
import { resetRateLimitStore } from '@/lib/services/auth/rateLimiter';
import { invalidateApiTokenAuthCache } from '@/lib/services/apiTokenAuth';
import { collectAccessibleProjectIds } from '@/lib/services/projects/accessibleProjects';
import { enqueueAuditLog } from '@/server/api/plugin';
import { tokensApiPlugin } from '@/server/api/plugins/tokens';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const TENANT = 'tenant-1';

const USERS: Record<string, Record<string, unknown>> = {
  'owner-1': { _id: 'owner-1', role: 'owner', tenantId: TENANT, canLogin: true },
  'admin-1': { _id: 'admin-1', role: 'admin', tenantId: TENANT, canLogin: true },
  'admin-2': { _id: 'admin-2', role: 'admin', tenantId: TENANT, canLogin: true },
  'pa-1': { _id: 'pa-1', role: 'project_admin', tenantId: TENANT, canLogin: true },
  'pa-legacy': { _id: 'pa-legacy', role: 'project_admin', tenantId: TENANT, canLogin: true, projectIds: ['proj-2'] },
  'user-1': { _id: 'user-1', role: 'user', tenantId: TENANT, canLogin: true },
  'user-2': { _id: 'user-2', role: 'user', tenantId: TENANT, canLogin: true },
  'svc-1': { _id: 'svc-1', role: 'user', tenantId: TENANT, canLogin: false },
};

interface TokenRow {
  _id: string;
  userId: string;
  tenantId: string;
  projectId?: string;
  label: string;
  tokenHash: string;
}
const row = (id: string, userId: string, extra: Partial<TokenRow> = {}): TokenRow => ({
  _id: id, userId, tenantId: TENANT, projectId: 'proj-1', label: `label of ${id}`, tokenHash: `hash-of-${id}`, ...extra,
});

const sessionHeaders = (userId: string) => ({
  'content-type': 'application/json',
  'x-license-type': 'STARTER',
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': TENANT,
  'x-tenant-slug': 'acme',
  'x-user-id': userId,
  'x-user-role': String(USERS[userId].role),
});

type RevokeReply = {
  requested: number; revoked: number; skipped: number; failed: number;
  results: Array<{ id: string; outcome: string; code?: string }>;
  code?: string;
};

describe('POST /api/tokens/revoke', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  let db: ReturnType<typeof createMockDb>;
  let tokens: TokenRow[];

  beforeEach(async () => {
    vi.clearAllMocks();
    resetRateLimitStore();
    h.recordAuditLog.mockResolvedValue(undefined);
    tokens = [
      row('tok-owner', 'owner-1'),
      row('tok-admin', 'admin-1'),
      row('tok-admin2', 'admin-2'),
      row('tok-pa', 'pa-1'),
      row('tok-user1', 'user-1'),
      row('tok-user2', 'user-2', { projectId: 'proj-2' }), // another project
      row('tok-svc', 'svc-1', { projectId: undefined }), // no project at all
      row('tok-svc-p1', 'svc-1'), // a service account's, in the project the project_admin is in
      row('tok-svc-p2', 'svc-1', { projectId: 'proj-2' }), // ... and in one they are not in
      row('tok-pa-p2', 'pa-1', { projectId: 'proj-2' }), // the project_admin's own, in a project they are not in
      row('tok-ghost', 'ghost-user'), // its account is gone
      row('tok-foreign', 'user-1', { tenantId: 'tenant-2' }),
    ];
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.findUserById.mockImplementation(async (id: string) => {
      if (id === 'not-an-id') throw Object.assign(new Error('input must be a 24 character hex string, 12 byte Uint8Array, or an integer'), { name: 'BSONError' });
      return (USERS[id] ? { ...USERS[id] } : null) as never;
    });
    // direct memberships: the project_admin is in proj-1 only
    db.listUserProjectsByUser.mockImplementation(async (userId: string) =>
      (userId === 'pa-1' || userId === 'pa-legacy' ? [{ userId, projectId: 'proj-1', role: 'member' }] : []) as never);
    db.findApiTokenById.mockImplementation(async (id: string, tenantId: string) =>
      (tokens.find((t) => t._id === id && t.tenantId === tenantId) ?? null) as never);
    db.deleteApiToken.mockImplementation(async (id: string, userId: string) => {
      const before = tokens.length;
      tokens = tokens.filter((t) => !(t._id === id && t.userId === userId));
      return tokens.length < before;
    });
    app = await createFastifyApiTestApp(async (instance) => {
      // the real audit hook, so a doubled row would show
      instance.addHook('onResponse', async (request, reply) => { enqueueAuditLog(request, reply); });
      await instance.register(tokensApiPlugin);
    });
  });

  afterEach(async () => {
    await app.close();
  });

  const revoke = (as: string, body: unknown) => app.inject({
    method: 'POST', url: '/api/tokens/revoke', headers: sessionHeaders(as), payload: JSON.stringify(body),
  });
  const reply = (res: { body: string }) => parseJsonBody<RevokeReply>(res.body);
  const outcome = (res: { body: string }, id: string) => reply(res).results.find((r) => r.id === id);
  const left = () => tokens.map((t) => t._id);

  describe('the request', () => {
    it('needs a non-empty list of token ids', async () => {
      for (const body of [{}, { ids: [] }, { ids: 'tok-user1' }, { ids: ['tok-user1', 7] }, { ids: ['tok-user1', ''] }, [], { ids: null }]) {
        const res = await revoke('owner-1', body);
        expect(res.statusCode, JSON.stringify(body)).toBe(400);
        expect(reply(res).code).toBe('invalid_body');
      }
      expect(db.deleteApiToken).not.toHaveBeenCalled();
    });

    it('takes a page of tokens at most', async () => {
      const ids = Array.from({ length: 101 }, (_, i) => `tok-${i}`);
      const res = await revoke('owner-1', { ids });
      expect([res.statusCode, reply(res).code]).toEqual([400, 'too_many_ids']);
      expect((await revoke('owner-1', { ids: ids.slice(0, 100) })).statusCode).toBe(200);
    });

    it('counts a token named twice once', async () => {
      const res = await revoke('user-1', { ids: ['tok-user1', 'tok-user1'] });
      expect(reply(res)).toMatchObject({ requested: 1, revoked: 1 });
      expect(db.deleteApiToken).toHaveBeenCalledTimes(1);
    });

    it('is rate limited per person', async () => {
      for (let i = 0; i < 20; i += 1) expect((await revoke('user-1', { ids: ['tok-none'] })).statusCode).toBe(200);
      const limited = await revoke('user-1', { ids: ['tok-none'] });
      expect([limited.statusCode, reply(limited).code]).toEqual([429, 'rate_limited']);
      expect(limited.headers['retry-after']).toBeTruthy();
      expect((await revoke('user-2', { ids: ['tok-none'] })).statusCode).toBe(200);
    });
  });

  describe('who may revoke whose', () => {
    it('anyone revokes their own, whatever project it lives in', async () => {
      const res = await revoke('user-2', { ids: ['tok-user2'] });
      expect(res.statusCode).toBe(200);
      expect(reply(res)).toMatchObject({ requested: 1, revoked: 1, skipped: 0, failed: 0 });
      expect(left()).not.toContain('tok-user2');
    });

    it('a member cannot revoke anyone else\'s - and is not told the token exists', async () => {
      const res = await revoke('user-1', { ids: ['tok-user2', 'tok-owner', 'tok-svc', 'tok-nothing'] });
      expect(reply(res)).toMatchObject({ revoked: 0, skipped: 4 });
      expect(outcome(res, 'tok-user2')).toMatchObject({ outcome: 'skipped', code: 'higher_privileges' });
      expect(outcome(res, 'tok-nothing')).toMatchObject({ outcome: 'skipped', code: 'token_not_found' });
      expect(left()).toHaveLength(12);
      expect(db.deleteApiToken).not.toHaveBeenCalled();
    });

    it('an admin revokes a member\'s, a service account\'s, a colleague\'s and its own - in any project, or none - but not the owner\'s', async () => {
      const res = await revoke('admin-1', { ids: ['tok-user1', 'tok-user2', 'tok-svc', 'tok-admin2', 'tok-admin', 'tok-pa', 'tok-owner'] });
      expect(reply(res)).toMatchObject({ requested: 7, revoked: 6, skipped: 1, failed: 0 });
      expect(outcome(res, 'tok-owner')).toMatchObject({ outcome: 'skipped', code: 'higher_privileges' });
      expect(left().sort()).toEqual(['tok-foreign', 'tok-ghost', 'tok-owner', 'tok-pa-p2', 'tok-svc-p1', 'tok-svc-p2']);
    });

    it('a token whose account is gone is the owner role\'s to revoke', async () => {
      const asAdmin = await revoke('admin-1', { ids: ['tok-ghost'] });
      expect(outcome(asAdmin, 'tok-ghost')).toMatchObject({ outcome: 'skipped', code: 'higher_privileges' });
      const asOwner = await revoke('owner-1', { ids: ['tok-ghost', 'tok-owner'] });
      expect(reply(asOwner)).toMatchObject({ revoked: 2 });
    });

    it('a project_admin revokes a service account\'s (in a project they are in) and its own, nobody else\'s', async () => {
      const res = await revoke('pa-1', { ids: ['tok-svc-p1', 'tok-pa', 'tok-user1', 'tok-admin'] });
      expect(reply(res)).toMatchObject({ revoked: 2, skipped: 2 });
      expect(left()).toEqual(expect.arrayContaining(['tok-user1', 'tok-admin']));
      expect(left()).not.toContain('tok-svc-p1');
    });

    describe('a project_admin, who is not in every project', () => {
      it('cannot revoke a service account\'s token in a project they are not in, or in none - and it is skipped as unknown', async () => {
        const res = await revoke('pa-1', { ids: ['tok-svc-p2', 'tok-svc'] });
        expect(reply(res)).toMatchObject({ requested: 2, revoked: 0, skipped: 2, failed: 0 });
        expect(outcome(res, 'tok-svc-p2')).toMatchObject({ outcome: 'skipped', code: 'token_not_found' });
        expect(outcome(res, 'tok-svc')).toMatchObject({ outcome: 'skipped', code: 'token_not_found' });
        expect(left()).toEqual(expect.arrayContaining(['tok-svc-p2', 'tok-svc']));
        expect(db.deleteApiToken).not.toHaveBeenCalled();
        expect(invalidateApiTokenAuthCache).not.toHaveBeenCalled();
        expect(res.body).not.toContain('label of');
      });

      it('revokes one in a project they are in and skips the one beside it in a project they are not in', async () => {
        const res = await revoke('pa-1', { ids: ['tok-svc-p1', 'tok-svc-p2'] });
        expect(reply(res)).toMatchObject({ revoked: 1, skipped: 1 });
        expect(outcome(res, 'tok-svc-p1')).toMatchObject({ outcome: 'revoked' });
        expect(outcome(res, 'tok-svc-p2')).toMatchObject({ outcome: 'skipped', code: 'token_not_found' });
      });

      it('revokes a token of their own wherever it lives, without asking about their projects', async () => {
        const res = await revoke('pa-1', { ids: ['tok-pa-p2', 'tok-pa'] });
        expect(reply(res)).toMatchObject({ revoked: 2, skipped: 0 });
        expect(collectAccessibleProjectIds).not.toHaveBeenCalled();
      });

      it('reaches a project through the legacy list or a group as well', async () => {
        expect(reply(await revoke('pa-legacy', { ids: ['tok-svc-p2'] }))).toMatchObject({ revoked: 1 });

        db.listGroupMembersByUser.mockResolvedValue([{ groupId: 'g1', userId: 'pa-1' }] as never);
        db.listGroupProjectsByGroup.mockResolvedValue([{ groupId: 'g1', projectId: 'proj-2' }] as never);
        expect(reply(await revoke('pa-1', { ids: ['tok-svc'] }))).toMatchObject({ skipped: 1 }); // still no project at all
        tokens.push(row('tok-svc-p2b', 'svc-1', { projectId: 'proj-2' }));
        expect(reply(await revoke('pa-1', { ids: ['tok-svc-p2b'] }))).toMatchObject({ revoked: 1 });
      });

      it('reads their projects once for the whole request, and only when a token that is not theirs gets that far', async () => {
        await revoke('pa-1', { ids: ['tok-svc-p1', 'tok-svc-p2', 'tok-svc', 'tok-pa', 'tok-user1', 'tok-nothing'] });
        expect(collectAccessibleProjectIds).toHaveBeenCalledTimes(1);
        vi.mocked(collectAccessibleProjectIds).mockClear();
        await revoke('pa-1', { ids: ['tok-user1', 'tok-nothing', 'tok-owner'] }); // all refused by the rules before
        expect(collectAccessibleProjectIds).not.toHaveBeenCalled();
      });
    });

    it('owners and admins are in every project: a token of any project, or of none, and no lookup of their projects', async () => {
      for (const as of ['owner-1', 'admin-1']) {
        const res = await revoke(as, { ids: ['tok-svc-p2', 'tok-svc'] });
        expect(reply(res), as).toMatchObject({ revoked: 2 });
        tokens.push(row('tok-svc-p2', 'svc-1', { projectId: 'proj-2' }), row('tok-svc', 'svc-1', { projectId: undefined }));
      }
      expect(collectAccessibleProjectIds).not.toHaveBeenCalled();
    });

    it('never reaches a token of another workspace, or an id the database cannot parse', async () => {
      const res = await revoke('owner-1', { ids: ['tok-foreign', 'not-an-id'] });
      expect(reply(res)).toMatchObject({ revoked: 0, skipped: 2 });
      expect(res.body).not.toContain('label of');
      expect(left()).toContain('tok-foreign');
    });
  });

  describe('how it revokes', () => {
    it('per owner - never the whole workspace - and evicts each token\'s cached record', async () => {
      await revoke('admin-1', { ids: ['tok-user1', 'tok-svc'] });
      expect(db.deleteApiToken).toHaveBeenCalledWith('tok-user1', 'user-1');
      expect(db.deleteApiToken).toHaveBeenCalledWith('tok-svc', 'svc-1');
      expect(db.deleteTenantApiToken).not.toHaveBeenCalled();
      expect(db.deleteProjectApiToken).not.toHaveBeenCalled();
      expect(invalidateApiTokenAuthCache).toHaveBeenCalledWith('hash-of-tok-user1');
      expect(invalidateApiTokenAuthCache).toHaveBeenCalledWith('hash-of-tok-svc');
    });

    it('evicts nothing for a token it did not revoke', async () => {
      await revoke('user-1', { ids: ['tok-owner', 'tok-nothing'] });
      expect(invalidateApiTokenAuthCache).not.toHaveBeenCalled();
    });

    it('reports a token that vanished in between as not found, and one that could not be deleted as failed - and goes on', async () => {
      db.deleteApiToken.mockImplementation(async (id: string, userId: string) => {
        if (id === 'tok-user1') return false; // gone between the lookup and the delete
        if (id === 'tok-admin2') throw new Error('db down');
        tokens = tokens.filter((t) => !(t._id === id && t.userId === userId));
        return true;
      });
      const res = await revoke('admin-1', { ids: ['tok-user1', 'tok-admin2', 'tok-svc'] });
      expect(outcome(res, 'tok-user1')).toMatchObject({ outcome: 'skipped', code: 'token_not_found' });
      expect(outcome(res, 'tok-admin2')).toMatchObject({ outcome: 'failed', code: 'failed' });
      expect(outcome(res, 'tok-svc')).toMatchObject({ outcome: 'revoked' });
      expect(reply(res)).toMatchObject({ requested: 3, revoked: 1, skipped: 1, failed: 1 });
      expect(invalidateApiTokenAuthCache).toHaveBeenCalledTimes(1);
    });
  });

  describe('the trail', () => {
    const rows = async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return h.recordAuditLog.mock.calls.map((call) => call[1] as Record<string, any>);
    };

    it('leaves one row per revoked token - who, whose, which project - and no generic row', async () => {
      await revoke('admin-1', { ids: ['tok-user1', 'tok-svc', 'tok-owner'] });
      const written = await rows();
      expect(written.map((r) => r.event).sort()).toEqual(['token.revoke', 'token.revoke']);
      expect(written.find((r) => r.resourceId === 'tok-user1')).toMatchObject({
        service: 'tokens', resourceType: 'token', actorUserId: 'admin-1', actorRole: 'admin', method: 'POST', path: '/api/tokens/revoke',
        metadata: { tokenId: 'tok-user1', label: 'label of tok-user1', ownerUserId: 'user-1', projectId: 'proj-1', batch: true },
      });
      expect(written.find((r) => r.resourceId === 'tok-svc')?.metadata).toMatchObject({ ownerUserId: 'svc-1', projectId: null });
      expect(JSON.stringify(written)).not.toContain('hash-of');
    });

    it('writes nothing for a refusal of the rules', async () => {
      await revoke('user-1', { ids: ['tok-owner'] });
      expect(await rows()).toEqual([]);
    });
  });
});
