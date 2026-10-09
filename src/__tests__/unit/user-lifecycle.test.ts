/**
 * setUserStatus / listener seam / revokeUserApiTokens / cleanupDeletedUser.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  db: {
    findUserById: vi.fn(),
    updateUser: vi.fn(),
    listApiTokens: vi.fn(),
    deleteApiToken: vi.fn(),
  },
  recordAuditLog: vi.fn(),
  invalidateUserAuthState: vi.fn(),
  invalidateApiTokenAuthCache: vi.fn(),
}));

vi.mock('@/lib/database', () => ({
  runWithTenantScope: vi.fn(async (_name: string, fn: (db: unknown) => unknown) => fn(h.db)),
}));
// Run the audit write inline so the test can assert on it deterministically;
// like the real helper, a rejection is absorbed and never reaches the caller.
vi.mock('@/lib/core/asyncTask', () => ({
  criticalFireAndForget: (_label: string, fn: () => Promise<void>) => { fn().catch(() => undefined); },
}));
vi.mock('@/lib/services/audit/auditService', () => ({ recordAuditLog: h.recordAuditLog }));
vi.mock('@/lib/services/apiTokenAuth', () => ({
  invalidateApiTokenAuthCache: h.invalidateApiTokenAuthCache,
}));
vi.mock('@/lib/services/users/userAuthState', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/users/userAuthState')>()),
  invalidateUserAuthState: h.invalidateUserAuthState,
}));

import {
  cleanupDeletedUser,
  notifyUserStatusChanged,
  onUserStatusChanged,
  revokeUserApiTokens,
  setUserStatus,
} from '@/lib/services/users/userLifecycle';
import { hashApiToken } from '@/lib/services/apiTokens/tokenHashing';

const base = {
  tenantDbName: 'tenant_acme',
  tenantId: 't1',
  actor: { type: 'user' as const, userId: 'admin-1', email: 'a@acme.test', role: 'admin' },
  targetUserId: 'u2',
  requestId: 'req-1',
  ipAddress: '10.0.0.1',
  userAgent: 'vitest',
};
const member = { _id: 'u2', tenantId: 't1', role: 'user', email: 'u2@acme.test' };

beforeEach(() => {
  vi.clearAllMocks();
  h.db.findUserById.mockResolvedValue(member);
  h.db.updateUser.mockImplementation(async (_id: string, patch: object) => ({ ...member, ...patch }));
  h.recordAuditLog.mockResolvedValue(undefined);
  h.invalidateUserAuthState.mockResolvedValue(undefined);
  h.invalidateApiTokenAuthCache.mockResolvedValue(undefined);
});

describe('setUserStatus guards', () => {
  it('refuses to change your own account (400) before touching the database', async () => {
    const res = await setUserStatus({ ...base, targetUserId: 'admin-1', status: 'disabled' });
    expect(res).toEqual({
      ok: false,
      httpStatus: 400,
      error: 'You cannot change the status of your own account',
    });
    expect(h.db.findUserById).not.toHaveBeenCalled();
  });

  it('refuses a differently formatted id that resolves to the actor own row (400, no write)', async () => {
    h.db.findUserById.mockResolvedValue({ ...member, _id: 'abc123' });
    const res = await setUserStatus({
      ...base,
      actor: { ...base.actor, userId: 'abc123' },
      targetUserId: 'ABC123',
      status: 'disabled',
    });
    expect(res).toEqual({
      ok: false,
      httpStatus: 400,
      error: 'You cannot change the status of your own account',
    });
    expect(h.db.updateUser).not.toHaveBeenCalled();
  });

  it('404s an unknown user', async () => {
    h.db.findUserById.mockResolvedValue(null);
    const res = await setUserStatus({ ...base, status: 'disabled' });
    expect(res).toEqual({ ok: false, httpStatus: 404, error: 'User not found' });
    expect(h.db.updateUser).not.toHaveBeenCalled();
  });

  it('404s a user that belongs to another tenant', async () => {
    h.db.findUserById.mockResolvedValue({ ...member, tenantId: 'other' });
    const res = await setUserStatus({ ...base, status: 'disabled' });
    expect(res).toMatchObject({ ok: false, httpStatus: 404 });
  });

  it('never targets an owner, for disable or enable', async () => {
    h.db.findUserById.mockResolvedValue({ ...member, role: 'owner' });
    for (const status of ['disabled', 'active'] as const) {
      const res = await setUserStatus({ ...base, status });
      expect(res).toEqual({ ok: false, httpStatus: 403, error: 'Owner accounts cannot be disabled' });
    }
    expect(h.db.updateUser).not.toHaveBeenCalled();
  });
});

describe('setUserStatus writes', () => {
  it('disable writes status/disabledAt/disabledBy/disabledReason with a trimmed reason', async () => {
    const res = await setUserStatus({ ...base, status: 'disabled', reason: '  left the company  ' });
    expect(res.ok).toBe(true);
    expect(h.db.updateUser).toHaveBeenCalledTimes(1);
    const [id, patch] = h.db.updateUser.mock.calls[0];
    expect(id).toBe('u2');
    expect(patch).toMatchObject({
      status: 'disabled',
      disabledBy: 'admin-1',
      disabledReason: 'left the company',
    });
    expect(patch.disabledAt).toBeInstanceOf(Date);
    if (res.ok) expect(res.user.status).toBe('disabled');
  });

  it('stores null when no / blank reason is given and caps the reason at 500 chars', async () => {
    await setUserStatus({ ...base, status: 'disabled', reason: '   ' });
    expect(h.db.updateUser.mock.calls[0][1].disabledReason).toBeNull();

    await setUserStatus({ ...base, status: 'disabled', reason: 'x'.repeat(900) });
    expect(h.db.updateUser.mock.calls[1][1].disabledReason).toHaveLength(500);
  });

  it('enable clears every lifecycle field with null', async () => {
    h.db.findUserById.mockResolvedValue({ ...member, status: 'disabled', disabledBy: 'admin-1' });
    const res = await setUserStatus({ ...base, status: 'active' });
    expect(res.ok).toBe(true);
    expect(h.db.updateUser).toHaveBeenCalledWith('u2', {
      status: 'active',
      disabledAt: null,
      disabledBy: null,
      disabledReason: null,
    });
  });

  it('is idempotent: same status returns the current user with no write, audit, cache or notify', async () => {
    const listener = vi.fn();
    const off = onUserStatusChanged(listener);

    // active -> active (legacy row without a status field)
    const a = await setUserStatus({ ...base, status: 'active' });
    // disabled -> disabled
    h.db.findUserById.mockResolvedValue({ ...member, status: 'disabled' });
    const b = await setUserStatus({ ...base, status: 'disabled' });
    off();

    expect(a).toEqual({ ok: true, user: member });
    expect(b.ok).toBe(true);
    expect(h.db.updateUser).not.toHaveBeenCalled();
    expect(h.recordAuditLog).not.toHaveBeenCalled();
    expect(h.invalidateUserAuthState).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it('404s when the row vanishes between the read and the write', async () => {
    h.db.updateUser.mockResolvedValue(null);
    const res = await setUserStatus({ ...base, status: 'disabled' });
    expect(res).toMatchObject({ ok: false, httpStatus: 404 });
    expect(h.invalidateUserAuthState).not.toHaveBeenCalled();
  });

  it('lets a database error throw rather than reporting success', async () => {
    h.db.updateUser.mockRejectedValue(new Error('write failed'));
    await expect(setUserStatus({ ...base, status: 'disabled' })).rejects.toThrow('write failed');
  });
});

describe('setUserStatus side effects', () => {
  it('invalidates the cached auth state for the target', async () => {
    await setUserStatus({ ...base, status: 'disabled' });
    expect(h.invalidateUserAuthState).toHaveBeenCalledWith('tenant_acme', 'u2');
  });

  it('writes a user.disable / user.enable audit row with actor and reason', async () => {
    await setUserStatus({
      ...base,
      status: 'disabled',
      reason: 'offboarded',
      actor: { type: 'api_token', userId: 'admin-1', apiTokenId: 'tok-9', role: 'admin' },
    });
    expect(h.recordAuditLog).toHaveBeenCalledWith(
      { tenantDbName: 'tenant_acme', tenantId: 't1' },
      expect.objectContaining({
        action: 'security',
        actorType: 'api_token',
        actorUserId: 'admin-1',
        apiTokenId: 'tok-9',
        actorRole: 'admin',
        event: 'user.disable',
        outcome: 'success',
        resourceType: 'user',
        resourceId: 'u2',
        service: 'members',
        metadata: { reason: 'offboarded' },
        requestId: 'req-1',
        ipAddress: '10.0.0.1',
        userAgent: 'vitest',
      }),
    );

    h.db.findUserById.mockResolvedValue({ ...member, status: 'disabled' });
    await setUserStatus({ ...base, status: 'active' });
    expect(h.recordAuditLog.mock.calls[1][1]).toMatchObject({
      event: 'user.enable',
      actorType: 'user',
      actorEmail: 'a@acme.test',
    });
  });

  it('does not fail the request when the audit write rejects', async () => {
    h.recordAuditLog.mockRejectedValue(new Error('audit down'));
    const res = await setUserStatus({ ...base, status: 'disabled' });
    expect(res.ok).toBe(true);
    expect(h.recordAuditLog).toHaveBeenCalledTimes(1);
  });

  it('notifies listeners with the new status', async () => {
    const listener = vi.fn();
    const off = onUserStatusChanged(listener);
    await setUserStatus({ ...base, status: 'disabled' });
    off();
    expect(listener).toHaveBeenCalledWith({
      tenantDbName: 'tenant_acme',
      tenantId: 't1',
      userId: 'u2',
      status: 'disabled',
    });
  });
});

describe('status listener seam', () => {
  const evt = { tenantDbName: 'd', tenantId: 't', userId: 'u', status: 'disabled' as const };

  it('unsubscribe stops delivery', () => {
    const listener = vi.fn();
    const off = onUserStatusChanged(listener);
    notifyUserStatusChanged(evt);
    off();
    notifyUserStatusChanged(evt);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('isolates a throwing listener and a rejecting listener from the others and the caller', async () => {
    const good = vi.fn();
    const offs = [
      onUserStatusChanged(() => { throw new Error('sync boom'); }),
      onUserStatusChanged(async () => { throw new Error('async boom'); }),
      onUserStatusChanged(good),
    ];
    expect(() => notifyUserStatusChanged(evt)).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    offs.forEach((off) => off());
    expect(good).toHaveBeenCalledWith(evt);
  });

  it('does not wait for a slow listener', () => {
    let finished = false;
    const off = onUserStatusChanged(() => new Promise<void>((r) => setTimeout(() => { finished = true; r(); }, 50)));
    notifyUserStatusChanged(evt);
    expect(finished).toBe(false);
    off();
  });
});

describe('revokeUserApiTokens', () => {
  it('deletes every token of the user and evicts each auth-cache entry', async () => {
    h.db.listApiTokens.mockResolvedValue([
      { _id: 'a', tokenHash: 'hash-a' },
      { _id: 'b', tokenHash: 'hash-b' },
    ]);
    h.db.deleteApiToken.mockResolvedValue(true);

    await expect(revokeUserApiTokens('tenant_acme', 'u2')).resolves.toEqual({ revoked: 2, failed: 0 });
    expect(h.db.listApiTokens).toHaveBeenCalledWith('u2');
    expect(h.db.deleteApiToken).toHaveBeenCalledWith('a', 'u2');
    expect(h.db.deleteApiToken).toHaveBeenCalledWith('b', 'u2');
    expect(h.invalidateApiTokenAuthCache).toHaveBeenCalledWith('hash-a');
    expect(h.invalidateApiTokenAuthCache).toHaveBeenCalledWith('hash-b');
  });

  it('hashes a legacy plaintext token so its cache entry is still evicted', async () => {
    h.db.listApiTokens.mockResolvedValue([{ _id: 'a', token: 'cgt_plain' }]);
    h.db.deleteApiToken.mockResolvedValue(true);
    await revokeUserApiTokens('tenant_acme', 'u2');
    expect(h.invalidateApiTokenAuthCache).toHaveBeenCalledWith(hashApiToken('cgt_plain'));
  });

  it('keeps going after one token fails and reports it', async () => {
    h.db.listApiTokens.mockResolvedValue([
      { _id: 'a', tokenHash: 'hash-a' },
      { _id: 'b', tokenHash: 'hash-b' },
    ]);
    h.db.deleteApiToken.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(true);
    await expect(revokeUserApiTokens('tenant_acme', 'u2')).resolves.toEqual({ revoked: 1, failed: 1 });
    expect(h.invalidateApiTokenAuthCache).toHaveBeenCalledWith('hash-b');
  });

  it('a user with no tokens is a no-op', async () => {
    h.db.listApiTokens.mockResolvedValue([]);
    await expect(revokeUserApiTokens('tenant_acme', 'u2')).resolves.toEqual({ revoked: 0, failed: 0 });
  });
});

describe('cleanupDeletedUser', () => {
  it('revokes tokens and invalidates auth state', async () => {
    h.db.listApiTokens.mockResolvedValue([{ _id: 'a', tokenHash: 'hash-a' }]);
    h.db.deleteApiToken.mockResolvedValue(true);
    await cleanupDeletedUser('tenant_acme', 'u2');
    expect(h.db.deleteApiToken).toHaveBeenCalledWith('a', 'u2');
    expect(h.invalidateUserAuthState).toHaveBeenCalledWith('tenant_acme', 'u2');
  });

  it('notifies status listeners with a disabled event when a tenantId is given', async () => {
    h.db.listApiTokens.mockResolvedValue([]);
    const listener = vi.fn();
    const off = onUserStatusChanged(listener);
    await cleanupDeletedUser('tenant_acme', 'u2', 't1');
    off();
    expect(listener).toHaveBeenCalledWith({ tenantDbName: 'tenant_acme', tenantId: 't1', userId: 'u2', status: 'disabled' });
  });

  it('never throws, and still invalidates auth state when listing tokens fails', async () => {
    h.db.listApiTokens.mockRejectedValue(new Error('db down'));
    await expect(cleanupDeletedUser('tenant_acme', 'u2')).resolves.toBeUndefined();
    expect(h.invalidateUserAuthState).toHaveBeenCalledWith('tenant_acme', 'u2');
  });
});
