/**
 * The Limits tab's whole round trip through the real quota API against BOTH
 * real backends: create a group limit and an agent-run limit, read them back
 * with the names resolved, enforce them for real members, move one to another
 * project, switch one off, delete one.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';

process.env.QUOTA_POLICY_CACHE_TTL_SECONDS = '0';

const hoisted = vi.hoisted(() => ({ getDatabase: vi.fn() }));
import type { DatabaseProvider } from '@/lib/database';
vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return {
    ...actual,
    getDatabase: hoisted.getDatabase,
    runWithTenantScope: async (tenantDbName: string, fn: (db: DatabaseProvider) => unknown) => {
      const db: DatabaseProvider = await hoisted.getDatabase();
      return db.runWithTenant?.(tenantDbName, () => fn(db));
    },
  };
});

import { reloadConfig } from '@/lib/core/config';
import { checkRateLimit, resetQuotaGroupCacheForTests } from '@/lib/quota/quotaGuard';
import { enforceAgentRunQuota } from '@/lib/services/agents/agentQuota';
import { quotaApiPlugin } from '@/server/api/plugins/quota';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';
import { describeForEachProvider } from './db-parity.helper';

beforeAll(() => reloadConfig());
afterAll(() => {
  delete process.env.QUOTA_POLICY_CACHE_TTL_SECONDS;
  reloadConfig();
});

const rpm = (perMinute: number) => ({ rateLimit: { requests: { perMinute } } });

describeForEachProvider('quota policy API, end to end', (getDb) => {
  let db: DatabaseProvider;
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  let dbName: string;
  let tenantId: string;
  let headers: Record<string, string>;
  let projects: { main: string; other: string };

  beforeEach(async () => {
    hoisted.getDatabase.mockImplementation(async () => getDb());
    db = getDb();
    const slug = `qapi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dbName = `tenant_${slug}`;
    const tenant = await db.createTenant({ companyName: 'Q', slug, dbName, licenseType: 'FREE', ownerId: 'pending' });
    tenantId = String(tenant._id);
    await db.switchToTenant(dbName);
    const owner = await db.createUser({
      tenantId, email: 'owner@x.io', name: 'Owner', password: '$2b$10$x', role: 'owner', licenseId: 'FREE', features: [],
    });
    projects = {
      main: String((await db.createProject({ tenantId, key: 'main', name: 'Main', createdBy: 'test' }))._id),
      other: String((await db.createProject({ tenantId, key: 'other', name: 'Other', createdBy: 'test' }))._id),
    };
    headers = {
      'content-type': 'application/json',
      'x-license-type': 'STARTER',
      'x-tenant-db-name': dbName,
      'x-tenant-id': tenantId,
      'x-tenant-slug': slug,
      'x-user-email': 'owner@x.io',
      'x-user-id': String(owner._id),
      'x-user-role': 'owner',
    };
    resetQuotaGroupCacheForTests();
    app = await createFastifyApiTestApp(quotaApiPlugin);
  });

  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown) => {
    const { 'content-type': contentType, ...bare } = headers;
    return app.inject({
      method,
      url: `/api/quota${url}`,
      headers: body === undefined ? bare : { ...bare, 'content-type': contentType },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
  };
  type PolicyRow = {
    _id: string;
    label: string;
    scope?: string;
    domain?: string;
    groupMode?: string;
    enabled?: boolean;
    projectName?: string;
    target?: Record<string, unknown>;
  };
  const policiesOf = async (query = '') =>
    parseJsonBody<{ policies: PolicyRow[] }>((await call('GET', `/policies${query}`)).body).policies;

  it('creates, names, enforces, moves, switches off and deletes limits', async () => {
    const group = await db.createGroup({ tenantId, name: 'Branch staff', createdBy: 'test', source: 'local' } as never);
    const alice = await db.createUser({ tenantId, email: 'alice@x.io', name: 'Alice', password: '$2b$10$x', role: 'user', licenseId: 'FREE', features: [] });
    const bob = await db.createUser({ tenantId, email: 'bob@x.io', name: 'Bob', password: '$2b$10$x', role: 'user', licenseId: 'FREE', features: [] });
    for (const user of [alice, bob]) {
      await db.addGroupMember({ groupId: String(group._id), userId: String(user._id), tenantId, role: 'member' });
    }
    await db.createAgent({
      tenantId, projectId: projects.main, key: 'credit-bot', name: 'Credit assistant', config: { modelKey: 'm' }, status: 'active', createdBy: 'test',
    });

    // 1. create: a shared group limit on agent runs (no project) and a limit narrowed to one agent
    const created = await call('POST', '/policies', {
      scope: 'group', scopeId: String(group._id), groupMode: 'shared', domain: 'agent', priority: 20, label: 'Branch runs', limits: rpm(3),
    });
    expect(created.statusCode).toBe(201);
    const groupPolicyId = parseJsonBody<{ policy: { _id: string } }>(created.body).policy._id;

    const narrowed = await call('POST', `/policies?projectId=${projects.main}`, {
      scope: 'resource', scopeId: 'credit-bot', domain: 'agent', label: 'Credit bot only', limits: rpm(1),
    });
    expect(narrowed.statusCode).toBe(201);
    const narrowedId = parseJsonBody<{ policy: { _id: string } }>(narrowed.body).policy._id;

    // 2. list with names: the group, the agent and the project each limit points at
    const rows = await policiesOf('?include=targets');
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r]));
    expect(byLabel['Branch runs']).toMatchObject({
      scope: 'group', groupMode: 'shared', target: { type: 'group', label: 'Branch staff' },
    });
    expect(byLabel['Branch runs'].projectName).toBeUndefined();
    expect(byLabel['Credit bot only']).toMatchObject({
      target: { type: 'agent', label: 'Credit assistant', sublabel: 'credit-bot' }, projectName: 'Main',
    });

    // 3. the limits are in force for the real members (agent runs, shared pool of 3)
    const run = (who: unknown, agentKey = 'support-bot') =>
      enforceAgentRunQuota({ tenantDbName: dbName, tenantId, projectId: projects.main, agentKey, userId: String(who) });
    await run(alice._id);
    await run(bob._id);
    await run(alice._id);
    await expect(run(bob._id)).rejects.toThrow(/Group rate limit exceeded for requests perMinute \(4\/3\)/);

    // 4. switch the group limit off: the very next run passes (policy cache invalidated by the write)
    expect((await call('PATCH', `/policies/${groupPolicyId}`, { enabled: false })).statusCode).toBe(200);
    await expect(run(bob._id)).resolves.toBeUndefined();

    // 5. move the narrowed limit to another project; the old project no longer has it
    const moved = await call('PATCH', `/policies/${narrowedId}`, { projectId: projects.other });
    expect(moved.statusCode).toBe(200);
    expect((await policiesOf(`?projectId=${projects.main}`)).map((r) => r._id)).not.toContain(narrowedId);
    expect((await policiesOf(`?projectId=${projects.other}`)).map((r) => r._id)).toContain(narrowedId);

    // 6. a limit can become tenant-wide again, and a group limit's mode can change
    expect((await call('PATCH', `/policies/${groupPolicyId}`, { groupMode: 'perMember', enabled: true })).statusCode).toBe(200);
    const after = (await policiesOf()).find((r) => r._id === groupPolicyId)!;
    expect(after).toMatchObject({ groupMode: 'perMember', enabled: true });
    expect(await db.listTenantWideQuotaPolicies(tenantId)).toHaveLength(1);

    // 7. delete
    expect((await call('DELETE', `/policies/${narrowedId}?projectId=${projects.other}`)).statusCode).toBe(200);
    expect((await call('DELETE', `/policies/${groupPolicyId}`)).statusCode).toBe(200);
    expect(await policiesOf()).toEqual([]);
  });

  it('keeps the project Quotas tab\'s own limit working next to group limits', async () => {
    const group = await db.createGroup({ tenantId, name: 'Staff', createdBy: 'test', source: 'local' } as never);
    const alice = await db.createUser({ tenantId, email: 'alice@x.io', name: 'Alice', password: '$2b$10$x', role: 'user', licenseId: 'FREE', features: [] });
    await db.addGroupMember({ groupId: String(group._id), userId: String(alice._id), tenantId, role: 'member' });

    // The project quota exactly as that tab writes it (scope tenant, domain global, priority 100)...
    const projectQuota = await call('POST', `/policies?projectId=${projects.main}`, {
      projectId: projects.main, scope: 'tenant', domain: 'global', priority: 100, enabled: true, label: 'Project quota', limits: rpm(10),
    });
    expect(projectQuota.statusCode).toBe(201);
    // ...and a group limit above it, which the project quota caps.
    await call('POST', '/policies', {
      scope: 'group', scopeId: String(group._id), domain: 'llm', priority: 10, label: 'Staff', limits: rpm(500),
    });

    // The tab lists the project's policies; only the project quota is its own.
    const listed = await policiesOf(`?projectId=${projects.main}`);
    expect(listed.filter((p) => p.scope !== 'group' && p.domain !== 'agent').map((p) => p.label)).toEqual(['Project quota']);

    // 10 requests/minute is the ceiling, whatever the group was promised.
    const ctx = { tenantDbName: dbName, tenantId, projectId: projects.main, domain: 'llm' as const, userId: String(alice._id) };
    const outcomes: boolean[] = [];
    for (let i = 0; i < 12; i += 1) outcomes.push((await checkRateLimit(ctx, { requests: 1 })).allowed);
    expect(outcomes.filter(Boolean)).toHaveLength(10);
  });
});
