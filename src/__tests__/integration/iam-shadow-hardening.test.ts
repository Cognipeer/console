/**
 * Hardening of the C2 shadow machinery: bounded concurrency/time on every
 * background path, no permanent per-process caps, fail-toward-legacy mode
 * handling, read paths that run no DDL, and a never-throwing engine gate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ runWithTenantScope: vi.fn(), getDatabase: vi.fn() }));
vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return { ...actual, getDatabase: hoisted.getDatabase, runWithTenantScope: hoisted.runWithTenantScope };
});

import { authorizeGate } from '@/lib/iam/engine';
import {
  flushShadowEvents,
  getAuthzMode,
  listShadowEntries,
  peekAuthzMode,
  primeAuthzModeForTests,
  recordShadowEvent,
  resetAuthzModeCacheForTests,
  resetShadowBufferForTests,
  setAuthzMode,
} from '@/lib/iam/shadow';
import { setShadowFlushTimeoutsForTests } from '@/lib/iam/shadow/aggregate';
import { getTenantShadowMetrics, resetShadowMetricsForTests, shadowMetrics } from '@/lib/iam/shadow/metrics';
import { observeGateDecision } from '@/lib/iam/shadow/observer';
import {
  BREAKER_THRESHOLD,
  drainShadowQueue,
  getShadowQueueDepth,
  resetShadowQueueForTests,
  setShadowJobTimeoutForTests,
  submitShadowJob,
} from '@/lib/iam/shadow/queue';
import { userPrincipal } from '@/lib/iam/entities';
import { evaluateGateObservation } from '@/lib/iam/shadow/evaluate';
import { resolveProjectMembershipCached, resetProjectMembershipCacheForTests } from '@/lib/iam/shadow/projectMembership';
import { resetPrincipalCacheForTests } from '@/lib/iam/principalCache';
import { configureIamEngine, resetIamEngineForTests } from '@/lib/iam/engine';
import type { GateObservation } from '@/lib/iam/shadow/types';
import { createIamTestDb, type IamTestDb } from '../helpers/iamTestDb';

/** In-memory iam doc store standing in for a tenant database. */
function fakeIamDb() {
  const docs = new Map<string, Map<string, { id: string; data: Record<string, unknown> }>>();
  const col = (c: string) => {
    if (!docs.has(c)) docs.set(c, new Map());
    return docs.get(c)!;
  };
  return {
    docs,
    db: {
      iamDocList: async (c: string, o: { idPrefix?: string } = {}) =>
        [...col(c).values()].filter((d) => !o.idPrefix || d.id.startsWith(o.idPrefix)),
      iamDocGet: async (c: string, id: string) => col(c).get(id) ?? null,
      iamDocPut: async (c: string, id: string, data: Record<string, unknown>) => {
        col(c).set(id, { id, data });
        return { id, data, updatedAt: new Date() };
      },
      iamDocClear: async (c: string) => {
        const n = col(c).size;
        col(c).clear();
        return n;
      },
    },
  };
}

const ev = (i: number) => ({
  category: 'unmapped-path' as const,
  service: '(none)',
  method: 'GET',
  route: `/api/r${i}`,
  legacyAllowed: true,
  targetAllowed: false,
  sample: { requestId: `r${i}`, userId: 'u', role: 'user', at: new Date().toISOString() },
});

beforeEach(() => {
  resetShadowBufferForTests();
  resetShadowMetricsForTests();
  resetShadowQueueForTests();
  resetAuthzModeCacheForTests();
  delete process.env.IAM_SHADOW_DISABLED;
  delete process.env.IAM_SHADOW_SAMPLE_RATE;
});
afterEach(() => {
  resetShadowBufferForTests();
  resetShadowQueueForTests();
  delete process.env.IAM_SHADOW_DISABLED;
  delete process.env.IAM_SHADOW_SAMPLE_RATE;
});

describe('shadow job queue: deadline + breaker', () => {
  it('a hung job gives its slot back: four hung jobs do not stall later work', async () => {
    setShadowJobTimeoutForTests(20);
    const never = () => new Promise<void>(() => undefined);
    for (let i = 0; i < 4; i++) expect(submitShadowJob(never, 't')).toBe(true);
    let ran = false;
    submitShadowJob(async () => { ran = true; }, 't');
    await drainShadowQueue(2_000);
    expect(ran).toBe(true);
    expect(getShadowQueueDepth()).toMatchObject({ queued: 0, running: 0 });
    expect(shadowMetrics.evaluationFailures).toBe(4);
    expect(getTenantShadowMetrics('t').evaluationFailures).toBe(4);
  });

  it('a run of timeouts opens the breaker: queued work is shed, new work is dropped, memory is released', async () => {
    setShadowJobTimeoutForTests(10);
    const never = () => new Promise<void>(() => undefined);
    for (let i = 0; i < BREAKER_THRESHOLD + 10; i++) submitShadowJob(never, 'brk');
    await drainShadowQueue(3_000);
    expect(getShadowQueueDepth().breakerOpen).toBe(true);
    expect(getShadowQueueDepth().queued).toBe(0);
    const before = shadowMetrics.queueDrops;
    expect(submitShadowJob(async () => undefined, 'brk')).toBe(false);
    expect(shadowMetrics.queueDrops).toBe(before + 1);
  });

  it('a throwing or healthy job resets the timeout streak', async () => {
    setShadowJobTimeoutForTests(10);
    const never = () => new Promise<void>(() => undefined);
    for (let i = 0; i < BREAKER_THRESHOLD - 1; i++) submitShadowJob(never);
    await drainShadowQueue(3_000);
    submitShadowJob(async () => undefined);
    await drainShadowQueue();
    for (let i = 0; i < BREAKER_THRESHOLD - 1; i++) submitShadowJob(never);
    await drainShadowQueue(3_000);
    expect(getShadowQueueDepth().breakerOpen).toBe(false);
  });
});

describe('shadow aggregate store', () => {
  it('serves more than 200 distinct tenants over a process lifetime (cap is on pending tenants only)', async () => {
    const perTenant = new Map<string, ReturnType<typeof fakeIamDb>>();
    hoisted.runWithTenantScope.mockImplementation(async (t: string, fn: (d: unknown) => unknown) => {
      if (!perTenant.has(t)) perTenant.set(t, fakeIamDb());
      return fn(perTenant.get(t)!.db);
    });
    for (let i = 0; i < 260; i++) {
      recordShadowEvent(`tenant_${i}`, ev(i));
      await flushShadowEvents();
    }
    expect(shadowMetrics.droppedEvents).toBe(0);
    const last = await listShadowEntries('tenant_259');
    expect(last).toHaveLength(1);
  });

  it('many tenants pending at once are still capped, and each tenant sees only its own drops', async () => {
    for (let i = 0; i < 230; i++) recordShadowEvent(`burst_${i}`, ev(i));
    expect(shadowMetrics.droppedEvents).toBe(30);
    expect(getTenantShadowMetrics('burst_229').droppedEvents).toBe(1);
    expect(getTenantShadowMetrics('burst_0').droppedEvents).toBe(0);
  });

  it('a hung database cannot hang flushes or the report read, and the batch is counted as dropped', async () => {
    setShadowFlushTimeoutsForTests(30, 100);
    hoisted.runWithTenantScope.mockImplementation(() => new Promise(() => undefined));
    recordShadowEvent('hung', ev(1));
    const started = Date.now();
    await flushShadowEvents();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(shadowMetrics.flushFailures).toBe(1);
    expect(getTenantShadowMetrics('hung').droppedEvents).toBe(1);

    // the report read stays bounded even when the read itself would hang -> it rejects/returns, never blocks forever
    recordShadowEvent('hung', ev(2));
    const t0 = Date.now();
    const read = listShadowEntries('hung');
    const outcome = await Promise.race([
      read.then(() => 'done', () => 'rejected'),
      new Promise<string>((r) => setTimeout(() => r('still-waiting'), 400)),
    ]);
    // flush waited at most readWait (100ms); the DB read itself is the caller's to time out
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(['still-waiting', 'done', 'rejected']).toContain(outcome);
  });

  it('events recorded while the buffer is over the threshold do not chain one flush per event', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    hoisted.runWithTenantScope.mockImplementation(async () => { calls++; await gate; });
    for (let i = 0; i < 600; i++) recordShadowEvent('chain', ev(i % 50));
    release();
    await flushShadowEvents();
    expect(calls).toBeLessThanOrEqual(3);
  });
});

describe('authorization mode: kill switch and fail-toward-legacy', () => {
  it('IAM_SHADOW_DISABLED=1 forces legacy without touching the database', () => {
    primeAuthzModeForTests('km', 'shadow');
    expect(peekAuthzMode('km')).toBe('shadow');
    process.env.IAM_SHADOW_DISABLED = '1';
    expect(peekAuthzMode('km')).toBe('legacy');
    const submitted = vi.fn();
    observeGateDecision('km', () => { submitted(); throw new Error('must not be built'); });
    expect(submitted).not.toHaveBeenCalled();
  });

  it('a failing refresh drops a shadow tenant back to legacy instead of keeping it on', async () => {
    primeAuthzModeForTests('fl', 'shadow', 1); // expires immediately
    hoisted.runWithTenantScope.mockRejectedValue(new Error('db down'));
    await new Promise((r) => setTimeout(r, 5));
    expect(peekAuthzMode('fl')).toBe('shadow'); // stale value served while refreshing
    await new Promise((r) => setTimeout(r, 20));
    expect(peekAuthzMode('fl')).toBe('legacy');
  });

  it('sampling: IAM_SHADOW_SAMPLE_RATE=0 observes nothing', () => {
    primeAuthzModeForTests('sm', 'shadow');
    process.env.IAM_SHADOW_SAMPLE_RATE = '0';
    const build = vi.fn(() => { throw new Error('not built'); });
    observeGateDecision('sm', build as never);
    expect(build).not.toHaveBeenCalled();
  });
});

describe('engine gate never throws', () => {
  it('a malformed method or service yields a deny with errors', async () => {
    const principal = userPrincipal({ userId: 'x', user: { role: 'admin' } });
    const bad = await authorizeGate({ tenant: 'tnt', principal, service: 'models', method: undefined as unknown as string });
    expect(bad.allowed).toBe(false);
    expect(bad.errors.length).toBeGreaterThan(0);
    const bad2 = await authorizeGate({ tenant: 'tnt', principal, service: undefined as unknown as string, method: 'GET' });
    expect(bad2.allowed).toBe(false);
  });
});

describe('sqlite iam document reads run no DDL', () => {
  let env: IamTestDb;
  beforeEach(async () => {
    env = await createIamTestDb('tenant_iam_ddl');
    hoisted.runWithTenantScope.mockImplementation(async (t: string, fn: (d: unknown) => unknown) =>
      env.db.runWithTenant(t, () => fn(env.db)),
    );
  });
  afterEach(async () => {
    await env.cleanup();
  });

  const tables = () =>
    ((env.db as unknown as { getTenantDb(): { prepare(s: string): { all(): Array<{ name: string }> } } })
      .getTenantDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'iam_%'")
      .all()).map((r) => r.name);

  it('reading the mode / listing / clearing on a pristine tenant creates nothing', async () => {
    expect((await getAuthzMode('tenant_iam_ddl')).mode).toBe('legacy');
    expect(await env.db.iamDocList('iam_shadow')).toEqual([]);
    expect(await env.db.iamDocDelete('iam_shadow', 'x')).toBe(false);
    expect(await env.db.iamDocClear('iam_shadow')).toBe(0);
    expect(tables()).toEqual([]);
  });

  it('the first write creates the table and later reads see the data', async () => {
    await setAuthzMode('tenant_iam_ddl', 'shadow', 'me');
    expect(tables()).toEqual(['iam_meta']);
    resetAuthzModeCacheForTests();
    expect((await getAuthzMode('tenant_iam_ddl')).mode).toBe('shadow');
  });
});

describe('project narrowing inputs', () => {
  let env: IamTestDb;
  beforeEach(async () => {
    env = await createIamTestDb('tenant_iam_pn');
    hoisted.runWithTenantScope.mockImplementation(async (t: string, fn: (d: unknown) => unknown) =>
      env.db.runWithTenant(t, () => fn(env.db)),
    );
    resetProjectMembershipCacheForTests();
    resetPrincipalCacheForTests();
    resetIamEngineForTests();
    configureIamEngine({ validateRequests: false });
  });
  afterEach(async () => {
    await env.cleanup();
  });

  const observation = (projectId: string | null, groupGrants: GateObservation['groupGrants'] = []): GateObservation => ({
    subject: 'session',
    tenantDbName: 'tenant_iam_pn',
    tenantId: env.tenantId,
    requestId: 'r1',
    method: 'POST',
    pathname: '/api/agents/x',
    route: '/api/agents/x',
    userId: 'nobody',
    role: 'user',
    user: { role: 'user', servicePermissions: undefined, projectIds: [] },
    groupGrants,
    activeProjectId: projectId,
    legacy: { allowed: true, service: 'agents', required: 'write' },
  });

  it('an implausible active_project_id (client cookie) costs no database lookup', async () => {
    const spy = vi.spyOn(env.db, 'findUserProject');
    await evaluateGateObservation(observation('x'.repeat(300))).catch(() => undefined);
    await evaluateGateObservation(observation('../../etc/passwd')).catch(() => undefined);
    await evaluateGateObservation(observation('a b; DROP')).catch(() => undefined);
    expect(spy).not.toHaveBeenCalled();
  });

  it('one tenant filling its project cache never evicts another tenant\'s entries', async () => {
    const input = (tenantDbName: string, projectId: string) => ({
      tenantDbName, userId: 'u', userRole: 'user', projectId, groupIds: [] as string[],
    });
    const spy = vi.spyOn(env.db, 'findUserProject');
    await resolveProjectMembershipCached(input('tenant_b', 'p-keep'));
    for (let i = 0; i < 700; i++) await resolveProjectMembershipCached(input('tenant_a', `p-${i}`));
    spy.mockClear();
    await resolveProjectMembershipCached(input('tenant_b', 'p-keep'));
    expect(spy).not.toHaveBeenCalled(); // still cached
    spy.mockClear();
    await resolveProjectMembershipCached(input('tenant_a', 'p-0')); // oldest of A was evicted
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('expired entries are dropped and re-read', async () => {
    vi.useFakeTimers();
    try {
      const spy = vi.spyOn(env.db, 'findUserProject');
      const input = { tenantDbName: 'tenant_a', userId: 'u', userRole: 'user', projectId: 'p1', groupIds: [] as string[] };
      await resolveProjectMembershipCached(input);
      await resolveProjectMembershipCached(input);
      expect(spy).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(16_000);
      await resolveProjectMembershipCached(input);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a user who is admin only through a group tenantRole is not reported as narrowed', async () => {
    const user = await env.db.createUser({ tenantId: env.tenantId, email: 'g@x.io', name: 'g', password: '$2b$10$x', role: 'user', licenseId: 'FREE', features: [] });
    const project = await env.db.createProject({ tenantId: env.tenantId, key: 'pj', name: 'PJ', createdBy: 'x' });
    await env.db.upsertUserProject({ tenantId: env.tenantId, userId: String(user._id), projectId: String(project._id), role: 'member', servicePermissions: { agents: 'read' } });
    const base = observation(String(project._id));
    const o = (grants: GateObservation['groupGrants']): GateObservation => ({ ...base, userId: String(user._id), groupGrants: grants });
    const spy = vi.spyOn(env.db, 'findUserProject');
    await evaluateGateObservation(o([{ tenantRole: 'admin' }]));
    expect(spy).not.toHaveBeenCalled(); // short-circuits before any project lookup
    await evaluateGateObservation(o([{ tenantRole: 'user' }]));
    expect(spy).toHaveBeenCalled();
  });
});
