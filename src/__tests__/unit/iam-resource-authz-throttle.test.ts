/**
 * authorizeResourceAccess with the engine, the person's data and the audit write
 * stood in for: what the helper does with each outcome - the repeat window of a
 * refusal, the per-workspace ceiling on audit rows, and every way it can fail
 * (always a refusal with its own id, never an allow, never a throw).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  getPrincipalContext: vi.fn(),
  recordResourceDenial: vi.fn(),
}));

vi.mock('@/lib/iam/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/iam/engine')>();
  return { ...actual, authorize: mocks.authorize };
});
vi.mock('@/lib/iam/principalCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/iam/principalCache')>();
  return { ...actual, getPrincipalContext: mocks.getPrincipalContext };
});
vi.mock('@/lib/iam/denialAudit', () => ({ recordResourceDenial: mocks.recordResourceDenial }));

import { getEnforceStats, resetEnforceStatsForTests } from '@/lib/iam/enforce';
import { portalResource } from '@/lib/iam/portalEntities';
import {
  DENIAL_WINDOW_MS,
  TENANT_AUDIT_ROWS_PER_MINUTE,
  authorizeResourceAccess,
  resetResourceAuthzThrottleForTests,
  type ResourceAuthzInput,
} from '@/lib/iam/resourceAuthz';
import { getResourceAuthzStats, resetResourceAuthzStatsForTests } from '@/lib/iam/resourceAuthzStats';

const ACCESS = { mode: 'selected', userIds: ['u1'], groupIds: ['g1'] } as const;

const input = (over: Partial<ResourceAuthzInput> = {}): ResourceAuthzInput => ({
  tenantDbName: 'tenant_a',
  tenantId: 't1',
  userId: 'u1',
  channel: 'portal',
  action: 'portal.use',
  resource: portalResource({ id: 'P1', access: { ...ACCESS, userIds: [...ACCESS.userIds], groupIds: [...ACCESS.groupIds] } }),
  subject: { portalId: 'P1', portalKey: 'branch', resourceName: 'Branch' },
  client: { ip: '203.0.113.7', method: 'GET', path: '/api/portal/branch/info' },
  ...over,
});

const allow = () => ({ allowed: true, reasons: ['managed:portal:use'], errors: [], obligations: {}, durationUs: 5 });
const deny = (reasons: string[] = ['managed:portal:use-boundary']) => ({ allowed: false, reasons, errors: [], obligations: {}, durationUs: 5 });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-10T10:00:00.000Z'));
  mocks.authorize.mockReset().mockResolvedValue(deny());
  mocks.getPrincipalContext.mockReset().mockResolvedValue({
    user: { role: 'user' }, groupIds: ['g9'], groupGrants: [], projects: ['pr1'], adminProjects: [],
  });
  mocks.recordResourceDenial.mockReset();
  resetResourceAuthzThrottleForTests();
  resetResourceAuthzStatsForTests();
  resetEnforceStatsForTests();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('what it asks of the engine', () => {
  it('describes the person like the dashboard does (role, groups, projects), asks in the portal channel, and sends no project', async () => {
    await authorizeResourceAccess(input({ user: { role: 'admin' } }));
    expect(mocks.getPrincipalContext).toHaveBeenCalledWith({
      tenantDbName: 'tenant_a', tenantId: 't1', userId: 'u1', user: { role: 'admin' }, withProjects: true,
    });
    const call = mocks.authorize.mock.calls[0][0];
    expect(call).toMatchObject({
      tenant: 'tenant_a',
      action: 'portal.use',
      principal: { kind: 'user', userId: 'u1', groupIds: ['g9'], projects: ['pr1'] },
      context: { channel: 'portal', ip: '203.0.113.7', method: 'GET', path: '/api/portal/branch/info' },
    });
    expect(call.context).not.toHaveProperty('projectId');
    expect(call.principal.projDeny).toBeUndefined(); // no project narrowing
  });

  it('hands the resource builder the groups it has just loaded, so a long list can be cut to the requester', async () => {
    const seen: unknown[] = [];
    await authorizeResourceAccess(input({
      resource: (requester) => {
        seen.push(requester);
        return portalResource({ id: 'P1', access: { mode: 'all', userIds: [], groupIds: [] } }, requester);
      },
    }));
    expect(seen).toEqual([{ userId: 'u1', groupIds: ['g9'] }]);
  });
});

describe('an allow', () => {
  it('writes nothing and has no id', async () => {
    mocks.authorize.mockResolvedValue(allow());
    expect(await authorizeResourceAccess(input())).toEqual({ allowed: true, source: 'engine', reasons: [], policyIds: [] });
    expect(mocks.recordResourceDenial).not.toHaveBeenCalled();
    expect(getResourceAuthzStats()).toMatchObject({ decisions: 1, allows: 1, denies: 0, unavailable: 0 });
  });
});

describe('a refusal', () => {
  it('carries an id, the reasons and the custom policies among them, and is audited once', async () => {
    mocks.authorize.mockResolvedValue(deny(['custom:block-x', 'managed:portal:use-boundary']));
    const result = await authorizeResourceAccess(input());
    expect(result).toMatchObject({ allowed: false, source: 'engine', reasons: ['custom:block-x', 'managed:portal:use-boundary'], policyIds: ['block-x'] });
    expect(result.decisionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(mocks.recordResourceDenial).toHaveBeenCalledTimes(1);
    expect(mocks.recordResourceDenial.mock.calls[0][0]).toMatchObject({
      tenantDbName: 'tenant_a', tenantId: 't1', userId: 'u1', userRole: 'user', code: 'forbidden', decisionId: result.decisionId,
      action: 'portal.use', channel: 'portal', resourceType: 'portal', resourceId: 'P1', resourceName: 'Branch', portalId: 'P1', portalKey: 'branch',
      source: 'engine', reasons: ['custom:block-x', 'managed:portal:use-boundary'], policyIds: ['block-x'],
      client: { ip: '203.0.113.7', method: 'GET', path: '/api/portal/branch/info' },
    });
  });

  it('is the same refusal for a repeat inside the window - same id, no second row - and a new one after it', async () => {
    const first = await authorizeResourceAccess(input());
    vi.setSystemTime(Date.now() + DENIAL_WINDOW_MS - 1_000);
    const again = await authorizeResourceAccess(input());
    expect(again.decisionId).toBe(first.decisionId);
    expect(mocks.recordResourceDenial).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 2_000);
    const later = await authorizeResourceAccess(input());
    expect(later.decisionId).not.toBe(first.decisionId);
    expect(mocks.recordResourceDenial).toHaveBeenCalledTimes(2);
  });

  it('is another refusal when the person, the action, the resource, the portal, the workspace or the reasons differ', async () => {
    const ids = new Set<string | undefined>();
    const ask = async (over: Partial<ResourceAuthzInput>, reasons?: string[]) => {
      if (reasons) mocks.authorize.mockResolvedValue(deny(reasons));
      ids.add((await authorizeResourceAccess(input(over))).decisionId);
    };
    await ask({});
    await ask({ userId: 'u2' });
    await ask({ action: 'agent.invoke' });
    await ask({ resource: portalResource({ id: 'P2', access: { ...ACCESS, userIds: [], groupIds: [] } }), subject: { portalId: 'P2' } });
    await ask({ tenantDbName: 'tenant_b', tenantId: 't2' });
    await ask({}, ['custom:other']);
    expect(ids.size).toBe(6);
    expect(mocks.recordResourceDenial).toHaveBeenCalledTimes(6);
  });

  it('is not audited past the per-workspace ceiling - the id is still returned and counted - and rows resume in the next minute', async () => {
    const ids = new Set<string | undefined>();
    for (let i = 0; i < TENANT_AUDIT_ROWS_PER_MINUTE + 5; i++) ids.add((await authorizeResourceAccess(input({ userId: `u-${i}` }))).decisionId);
    expect(ids.size).toBe(TENANT_AUDIT_ROWS_PER_MINUTE + 5);
    expect([...ids].every((id) => !!id)).toBe(true);
    expect(mocks.recordResourceDenial).toHaveBeenCalledTimes(TENANT_AUDIT_ROWS_PER_MINUTE);
    expect(getResourceAuthzStats()).toMatchObject({ denies: TENANT_AUDIT_ROWS_PER_MINUTE + 5, auditSuppressed: 5 });
    // another workspace has its own budget
    await authorizeResourceAccess(input({ tenantDbName: 'tenant_b', tenantId: 't2' }));
    expect(mocks.recordResourceDenial).toHaveBeenCalledTimes(TENANT_AUDIT_ROWS_PER_MINUTE + 1);

    vi.setSystemTime(Date.now() + 61_000);
    await authorizeResourceAccess(input({ userId: 'u-after' }));
    expect(mocks.recordResourceDenial).toHaveBeenCalledTimes(TENANT_AUDIT_ROWS_PER_MINUTE + 2);
  });

  it('stays bounded under a flood of different refusals', async () => {
    for (let i = 0; i < 6_500; i++) {
      mocks.authorize.mockResolvedValue(deny([`custom:r-${i}`]));
      const result = await authorizeResourceAccess(input({ userId: `u-${i}`, tenantDbName: `tenant_${i % 40}` }));
      expect(result.decisionId).toBeTruthy();
    }
    expect(getResourceAuthzStats().denies).toBe(6_500);
  });
});

describe('when it cannot decide', () => {
  it('a failed engine is a refusal that says so, counted and audited like the gates\' (code authorization_unavailable)', async () => {
    mocks.authorize.mockResolvedValue({ allowed: false, reasons: [], errors: ['wasm trap'], obligations: {}, durationUs: 1, failed: true });
    const result = await authorizeResourceAccess(input());
    expect(result).toMatchObject({ allowed: false, unavailable: true, source: 'unavailable', reasons: [], policyIds: [] });
    expect(result.decisionId).toBeTruthy();
    expect(getEnforceStats()).toMatchObject({ unavailable: 1, lastUnavailableReason: 'engine_unavailable' });
    expect(getResourceAuthzStats()).toMatchObject({ unavailable: 1, allows: 0, denies: 0 });
    expect(mocks.recordResourceDenial.mock.calls[0][0]).toMatchObject({ code: 'authorization_unavailable', source: 'unavailable', decisionId: result.decisionId });
  });

  it('an engine that throws is the same', async () => {
    mocks.authorize.mockRejectedValue(new Error('boom'));
    expect(await authorizeResourceAccess(input())).toMatchObject({ allowed: false, unavailable: true });
    expect(getEnforceStats().unavailable).toBe(1);
  });

  it('a person who cannot be loaded is the same, with the principal named as the cause', async () => {
    mocks.getPrincipalContext.mockRejectedValue(new Error('User u1 not found'));
    expect(await authorizeResourceAccess(input())).toMatchObject({ allowed: false, unavailable: true });
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(getEnforceStats()).toMatchObject({ unavailable: 1, lastUnavailableReason: 'principal_unavailable' });
  });

  it('a resource that cannot be built is the same', async () => {
    const result = await authorizeResourceAccess(input({ resource: () => { throw new Error('bad portal'); } }));
    expect(result).toMatchObject({ allowed: false, unavailable: true });
    expect(mocks.authorize).not.toHaveBeenCalled();
  });

  it('a repeated outage within the window keeps one id and one row (every refusal is still counted)', async () => {
    mocks.authorize.mockRejectedValue(new Error('boom'));
    const first = await authorizeResourceAccess(input());
    const second = await authorizeResourceAccess(input());
    expect(second.decisionId).toBe(first.decisionId);
    expect(mocks.recordResourceDenial).toHaveBeenCalledTimes(1);
    expect(getEnforceStats().unavailable).toBe(2);
    expect(getResourceAuthzStats().unavailable).toBe(2);
  });

  it('turns an unusable request into a refusal too - the helper has no way to throw', async () => {
    for (const bad of [undefined, null, 'x', {}, input({ tenantDbName: '' }), input({ userId: '' }), input({ action: 'agents.write' as never }), input({ channel: 'api' as never }), input({ subject: { portalId: '' } })]) {
      const result = await authorizeResourceAccess(bad as never);
      expect(result).toMatchObject({ allowed: false, unavailable: true });
      expect(result.decisionId).toBeTruthy();
    }
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.getPrincipalContext).not.toHaveBeenCalled();
  });
});
