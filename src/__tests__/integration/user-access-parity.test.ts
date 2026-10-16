/**
 * The storage behind the access endpoints, on BOTH SQLite and MongoDB with the real stores:
 *
 *   accessRequest      kept on the person (set, read back as a Date, overwritten), exposed on the directory rows
 *   memberships        written by applyProjectGrants with their source, an existing row's role updated, nothing doubled
 *   external accounts  createExternalAccount makes the account a verified assertion makes: external, no sign-in, found by identity
 *   issuers            read from the delegations of the workspace, secrets never touched
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const hoisted = vi.hoisted(() => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return {
    ...actual,
    getDatabase: hoisted.getDatabase,
    runWithTenantScope: async (tenantDbName: string, fn: (db: DatabaseProvider) => unknown) => {
      const db = await hoisted.getDatabase();
      return db.runWithTenant(tenantDbName, () => fn(db));
    },
  };
});

import { drainPendingTasks } from '@/lib/core/asyncTask';
import type { DatabaseProvider } from '@/lib/database';
import { listDirectory } from '@/lib/iam/directory';
import { listDelegationIssuers } from '@/lib/iam/delegationIssuers';
import { createExternalAccount } from '@/lib/iam/externalAccount';
import { putTokenDelegation } from '@/lib/iam/tokenDelegation';
import { applyProjectGrants } from '@/lib/services/users/projectGrants';
import { describeForEachProvider } from './db-parity.helper';

describeForEachProvider('user access storage', (getDb) => {
  let db: DatabaseProvider;
  let tenantId: string;
  let tenantDbName: string;
  let p1: string;
  let p2: string;
  let userId: string;
  const run = <T,>(fn: () => Promise<T>): Promise<T> => db.runWithTenant!(tenantDbName, fn);

  beforeAll(async () => {
    hoisted.getDatabase.mockImplementation(async () => getDb());
    db = getDb();
    const slug = `access-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    tenantDbName = `tenant_${slug}`;
    tenantId = String((await db.createTenant({ companyName: 'Acme', slug, dbName: tenantDbName, licenseType: 'FREE', ownerId: 'pending' }))._id);
    await run(async () => {
      p1 = String((await db.createProject({ tenantId, key: 'one', name: 'One', createdBy: 't' }))._id);
      p2 = String((await db.createProject({ tenantId, key: 'two', name: 'Two', createdBy: 't' }))._id);
      userId = String((await db.createUser({
        tenantId, email: 'lost@acme.example', name: 'Lost', password: '$2b$10$x', role: 'user', licenseId: 'FREE', features: [],
      }))._id);
    });
  });
  afterAll(async () => {
    await drainPendingTasks();
    hoisted.getDatabase.mockReset();
  });

  it('keeps an access request on the person: absent at first, a Date and the message after, overwritten by the next one', async () => {
    expect((await run(() => db.findUserById(userId)))?.accessRequest ?? null).toBeNull();

    const first = new Date('2026-10-01T10:00:00.000Z');
    await run(() => db.updateUser(userId, { accessRequest: { at: first, message: 'please' } }));
    const stored = await run(() => db.findUserById(userId));
    expect(new Date(stored!.accessRequest!.at).toISOString()).toBe(first.toISOString());
    expect(stored!.accessRequest!.message).toBe('please');

    const second = new Date('2026-10-03T10:00:00.000Z');
    await run(() => db.updateUser(userId, { accessRequest: { at: second } }));
    const again = await run(() => db.findUserById(userId));
    expect(new Date(again!.accessRequest!.at).toISOString()).toBe(second.toISOString());
    expect(again!.accessRequest!.message).toBeUndefined();
  });

  it('does not lose the request when something else about the person changes', async () => {
    await run(() => db.updateUser(userId, { name: 'Lost Lou' }));
    expect((await run(() => db.findUserById(userId)))?.accessRequest?.at).toBeTruthy();
  });

  it('exposes the request on the rows of the people list', async () => {
    const page = await listDirectory(
      { tenantId, tenantDbName } as never,
      { id: 'viewer', role: 'owner' } as never,
      { type: 'user', limit: 50, offset: 0 },
    );
    const row = page.items.find((item) => item.id === userId);
    expect(row).toMatchObject({ type: 'user', accessRequest: { at: '2026-10-03T10:00:00.000Z', message: null } });
  });

  it('writes memberships as manual rows, updates a role in place and never doubles a row', async () => {
    const first = await run(() => applyProjectGrants(db, {
      tenantId, userId, actorId: 'actor-1',
      grants: [{ projectId: p1, role: 'member' }, { projectId: p2, role: 'member' }],
    }));
    expect(first).toEqual({ added: [p1, p2], updated: [], skipped: [] });

    const second = await run(() => applyProjectGrants(db, {
      tenantId, userId, actorId: 'actor-2',
      grants: [{ projectId: p1, role: 'member' }, { projectId: p2, role: 'project_admin' }],
    }));
    expect(second).toEqual({ added: [], updated: [p2], skipped: [{ projectId: p1, reason: 'already_member' }] });

    const rows = await run(() => db.listUserProjectsByUser(userId));
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.projectId === p2)).toMatchObject({ role: 'project_admin', invitedBy: 'actor-1', source: 'manual' });
    expect(rows.find((r) => r.projectId === p1)).toMatchObject({ role: 'member', invitedBy: 'actor-1', source: 'manual' });
  });

  it('creates the external account of a verified assertion: external, no sign-in, the User role, found by its identity', async () => {
    const issuer = 'https://idp.example.com/realms/acme';
    const created = await run(() => createExternalAccount(db, { tenantId, issuer, subject: 'sub-1', licenseId: 'FREE', name: 'Ayşe' }));
    expect(created).toMatchObject({ kind: 'external', canLogin: false, role: 'user', name: 'Ayşe', externalIds: { [issuer]: 'sub-1' } });

    const holders = await run(() => db.findUsersByExternalIdentity(issuer, 'sub-1'));
    expect(holders.map((h) => String(h._id))).toEqual([String(created._id)]);
    expect(await run(() => db.findUsersByExternalIdentity(issuer, 'sub-2'))).toEqual([]);
  });

  it('lists the issuers that have a delegation, once each, without any secret', async () => {
    expect(await listDelegationIssuers(tenantDbName)).toEqual([]);
    const trust = (issuer: string) => ({
      issuer, audience: 'console', algorithms: ['HS256' as const], keys: { hsSecrets: [{ kid: 'k', secret: 'a-shared-secret-of-at-least-32-characters-ok' }] }, requireSingleUse: false as const,
    });
    const mapping = { matchBy: ['externalId' as const], jit: 'external' as const };
    await putTokenDelegation(tenantDbName, 'tok-a', { enabled: true, trust: trust('https://b.example'), mapping, allowPrivileged: false }, 't');
    await putTokenDelegation(tenantDbName, 'tok-b', { enabled: false, trust: trust('https://a.example'), mapping, allowPrivileged: false }, 't');
    await putTokenDelegation(tenantDbName, 'tok-c', { enabled: false, trust: trust('https://b.example'), mapping, allowPrivileged: false }, 't');

    const issuers = await listDelegationIssuers(tenantDbName);
    expect(issuers).toEqual([
      { issuer: 'https://a.example', enabled: false, tokens: 1 },
      { issuer: 'https://b.example', enabled: true, tokens: 2 },
    ]);
    expect(JSON.stringify(issuers)).not.toContain('secret');
  });
});
