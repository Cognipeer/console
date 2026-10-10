/**
 * Policy spec compiler (A1): shape validation, Cedar injection resistance, every
 * condition kind evaluated by the real engine, and the token-ownership rule
 * (a user / group principal also matches the tokens its people own).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return {
    ...actual,
    getDatabase: hoisted.getDatabase,
    runWithTenantScope: async (tenantDbName: string, fn: (db: any) => unknown) => {
      const db = await hoisted.getDatabase();
      return db.runWithTenant(tenantDbName, () => fn(db));
    },
  };
});

import { authorize, authorizeGate, configureIamEngine, resetIamEngineForTests } from '@/lib/iam/engine';
import { tokenPrincipal, userPrincipal, type IamPrincipal } from '@/lib/iam/entities';
import { policyToJson, splitPolicyText } from '@/lib/iam/cedar';
import { normalizeIp, parseCidr, buildCedarContext } from '@/lib/iam/context';
import {
  cedarString,
  compileSpec,
  compileSpecToCedar,
  currentCatalogView,
  isSafeId,
  parsePolicySpec,
  type PolicySpec,
} from '@/lib/iam/policySpec';
import { reloadConfig } from '@/lib/core/config';
import { createPolicy, deletePolicy, listPolicies, updatePolicy, validateCustomPolicyText } from '@/lib/iam/store';
import { registerIamPortalResolver } from '@/enterprise/iam-portal';
import { portalAgentResource, portalResource } from '@/lib/iam/portalEntities';
import { createIamTestDb, mulberry32, type IamTestDb } from '../helpers/iamTestDb';

let env: IamTestDb;
const tenant = () => env.tenantDbName;

beforeAll(async () => {
  env = await createIamTestDb('tenant_policy_spec');
  hoisted.getDatabase.mockResolvedValue(env.db);
});
afterAll(async () => {
  configureIamEngine({ validateRequests: false });
  await env.cleanup();
});
beforeEach(async () => {
  configureIamEngine({ validateRequests: true, versionCheckMs: 5_000 });
  resetIamEngineForTests();
  for (const p of await listPolicies(tenant())) await deletePolicy(tenant(), p.policyId);
});

const base = (over: Partial<PolicySpec> = {}): PolicySpec => ({
  effect: 'forbid',
  principals: { any: true },
  actions: ['agents.write'],
  resources: { any: true },
  ...over,
});

async function install(spec: PolicySpec, id?: string) {
  const out = await compileSpec(spec);
  expect(out.errors, JSON.stringify(out.errors)).toEqual([]);
  expect(out.ok).toBe(true);
  return createPolicy(tenant(), { policyId: id, name: 'spec', cedar: out.cedar, spec: out.spec! }, 'tester');
}

const member = (userId = 'u1', groupIds: string[] = [], role = 'user'): IamPrincipal =>
  userPrincipal({ userId, user: { role }, groupIds });
const tokenOf = (tokenId: string, owner: IamPrincipal, scope: Record<string, string> | null = null, projectId?: string): IamPrincipal =>
  tokenPrincipal({ tokenId, owner, scope: scope as never, projectId });

const gate = async (principal: IamPrincipal, service: string, method: string, context: Record<string, unknown> = {}) => {
  const res = await authorizeGate({ tenant: tenant(), principal, service, method, context: context as never });
  expect(res.failed, JSON.stringify(res.errors)).toBeFalsy();
  return res;
};

// ── shape ────────────────────────────────────────────────────────────────

describe('parsePolicySpec', () => {
  it('accepts the documented shape and normalises it', () => {
    const r = parsePolicySpec({
      effect: 'permit',
      principals: { users: ['u1', 'u1', 'u2'], groups: ['g1'], anyToken: true },
      actions: ['agents.read', 'Write', 'agents.read'],
      resources: { services: ['agents', 'agents', 'models'], projects: ['p1'], resources: [{ type: 'agent', id: 'a1' }, { type: 'agent', id: 'a1' }] },
      conditions: { validFrom: '2026-01-01', validUntil: '2026-12-31T23:59:59+02:00', ipRanges: ['10.0.0.0/8', '10.0.0.0/08', '2001:DB8::/32'], channels: ['api', 'api', 'dashboard'] },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec.principals).toEqual({ users: ['u1', 'u2'], groups: ['g1'], anyToken: true });
    expect(r.spec.actions).toEqual(['agents.read', 'Write']);
    expect(r.spec.resources).toEqual({ services: ['agents', 'models'], projects: ['p1'], resources: [{ type: 'agent', id: 'a1' }] });
    expect(r.spec.conditions).toEqual({
      validFrom: '2026-01-01T00:00:00.000Z',
      validUntil: '2026-12-31T21:59:59.000Z',
      ipRanges: ['10.0.0.0/8', '2001:db8::/32'],
      channels: ['api', 'dashboard'],
    });
  });

  it.each([
    ['not an object', 'nope', /must be an object/],
    ['an array', [], /must be an object/],
    ['bad effect', { ...base(), effect: 'allow' }, /effect must be/],
    ['no principals', { ...base(), principals: undefined }, /who the policy applies to/],
    ['empty principals', { ...base(), principals: {} }, /at least one user, group or token/],
    ['any + specific principals', { ...base(), principals: { any: true, users: ['u1'] } }, /cannot be combined/],
    ['any=false', { ...base(), principals: { any: false } }, /can only be true/],
    ['unknown principal key', { ...base(), principals: { everyone: true } }, /Unknown field/],
    ['no actions', { ...base(), actions: [] }, /at least one action/],
    ['unknown action', { ...base(), actions: ['nope.nope'] }, /not an action of the catalog/],
    ['no resources', { ...base(), resources: undefined }, /what the policy applies to/],
    ['empty resources', { ...base(), resources: {} }, /where the policy applies/],
    ['unknown service', { ...base(), resources: { services: ['spaceship'] } }, /is not a service/],
    ['unknown resource type', { ...base(), resources: { resources: [{ type: 'spaceship', id: 'x' }] } }, /is not a resource type/],
    ['bad date', { ...base(), conditions: { validFrom: 'yesterday' } }, /ISO 8601/],
    ['from after until', { ...base(), conditions: { validFrom: '2027-01-01', validUntil: '2026-01-01' } }, /must not be later/],
    ['bad cidr', { ...base(), conditions: { ipRanges: ['10.0.0.0/33'] } }, /prefix length/],
    ['not an ip', { ...base(), conditions: { ipRanges: ['hello'] } }, /not a valid IP/],
    ['bad channel', { ...base(), conditions: { channels: ['sms'] } }, /not a channel/],
    ['unknown condition', { ...base(), conditions: { weekdays: ['mon'] } }, /Unknown field/],
    ['unknown top-level key', { ...base(), extra: 1 }, /Unknown field/],
  ])('rejects %s', (_label, input, message) => {
    const r = parsePolicySpec(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.message).join(' | ')).toMatch(message as RegExp);
  });

  it('enforces list limits', () => {
    const many = Array.from({ length: 501 }, (_, i) => `user${i}`);
    const r = parsePolicySpec(base({ principals: { users: many } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].message).toMatch(/At most 500/);
    const tooManyRanges = parsePolicySpec(base({ conditions: { ipRanges: Array.from({ length: 51 }, (_, i) => `10.0.${i}.0/24`) } }));
    expect(tooManyRanges.ok).toBe(false);
  });
});

// ── injection ────────────────────────────────────────────────────────────

describe('no Cedar injection', () => {
  const evil = [
    'x"; permit(principal, action, resource); //',
    'u1" || true || principal == User::"x',
    '\\"; forbid(principal, action, resource); //',
    'a\nb', 'tab\there', 'ünïcode', '日本語', 'a b', "u'1", 'u"1', 'u\\1', 'u}1', 'u{1', 'u;1', '${x}', '`x`', '/* c */', '\u0000', 'u‮1',
  ];

  it.each(evil)('refuses %j as an id', (value) => {
    expect(isSafeId(value)).toBe(false);
    const r = parsePolicySpec(base({ principals: { users: [value] }, resources: { projects: [value] } }));
    expect(r.ok).toBe(false);
  });

  it('writes strings through one escaping function that Cedar reads back unchanged', () => {
    const rnd = mulberry32(20261009);
    const alphabet = ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~';
    for (let i = 0; i < 400; i++) {
      const len = 1 + Math.floor(rnd() * 24);
      const value = Array.from({ length: len }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join('');
      const text = `permit(principal == User::${cedarString(value)}, action, resource);`;
      const parts = splitPolicyText(text);
      expect(parts.ok && parts.policies.length, JSON.stringify(value)).toBe(1);
      const json = policyToJson(text);
      expect(json.ok).toBe(true);
      if (json.ok) {
        const principal = (json.json as unknown as { principal: { op: string; entity: { id: string } } }).principal;
        expect(principal.op).toBe('==');
        expect(principal.entity.id).toBe(value);
      }
    }
  });

  it('refuses to write control characters or non-ASCII into a policy at all', () => {
    for (const value of ['a\nb', 'é', '\u0000', 'a b']) expect(() => cedarString(value)).toThrow();
  });

  it('a spec can only ever compile to ONE statement of the intended shape', () => {
    const out = compileSpecToCedar(parsedOk(base({ principals: { users: ['u1', 'u-2'], groups: ['g.1'] }, resources: { projects: ['p:1'] } })));
    const parts = splitPolicyText(out);
    expect(parts.ok && parts.policies).toHaveLength(1);
    expect(out).not.toMatch(/permit\s*\([\s\S]*permit/);
  });
});

function parsedOk(spec: PolicySpec): PolicySpec {
  const r = parsePolicySpec(spec, currentCatalogView());
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.spec;
}

// ── addresses ────────────────────────────────────────────────────────────

describe('addresses and context', () => {
  it('normalises request addresses to what Cedar accepts', () => {
    expect(normalizeIp('10.1.2.3')).toBe('10.1.2.3');
    expect(normalizeIp('::ffff:10.1.2.3')).toBe('10.1.2.3');
    expect(normalizeIp('::FFFF:A01:203')).toBe('10.1.2.3');
    expect(normalizeIp('[2001:DB8::1]')).toBe('2001:db8::1');
    expect(normalizeIp('fe80::1%eth0')).toBe('fe80::1');
    for (const bad of ['unknown', '', undefined, null, '1.2.3', '300.1.1.1', '10.0.0.1, 10.0.0.2', 'a'.repeat(100)]) {
      expect(normalizeIp(bad as never)).toBeNull();
    }
  });

  it('validates CIDR ranges', () => {
    expect(parseCidr('10.0.0.0/8')).toEqual({ ok: true, cidr: '10.0.0.0/8' });
    expect(parseCidr('192.168.1.7')).toEqual({ ok: true, cidr: '192.168.1.7' });
    expect(parseCidr('2001:db8::/32')).toEqual({ ok: true, cidr: '2001:db8::/32' });
    for (const bad of ['10.0.0.0/33', '::/129', '10.0.0.0/', '10.0.0.0/-1', 'abc', '', '::ffff:10.0.0.0/104', '10.0.0.0/8/8']) {
      expect(parseCidr(bad).ok, bad).toBe(false);
    }
  });

  it('never lets an unusable address fail the whole decision (it is simply left out)', async () => {
    await install(base({ effect: 'forbid', conditions: { ipRanges: ['10.0.0.0/8'] } }));
    for (const ip of ['unknown', 'not an ip', '::ffff:1.2.3.4%x', '']) {
      const res = await authorizeGate({ tenant: tenant(), principal: member(), service: 'agents', method: 'POST', context: { ip } });
      expect(res.failed, ip).toBeFalsy();
      expect(res.allowed, ip).toBe(true); // the IP condition cannot be shown to hold: the forbid does not apply
    }
    expect(buildCedarContext({ ip: 'unknown' }).ip).toBeUndefined();
  });
});

// ── semantics, evaluated by the real engine ──────────────────────────────

describe('principals', () => {
  it('a user policy matches that user AND the tokens the user owns', async () => {
    await install(base({ principals: { users: ['u1'] } }));
    const u1 = member('u1');
    const u2 = member('u2');
    expect((await gate(u1, 'agents', 'POST')).allowed).toBe(false);
    expect((await gate(u2, 'agents', 'POST')).allowed).toBe(true);
    expect((await gate(tokenOf('t-of-u1', u1), 'agents', 'POST')).allowed).toBe(false);
    expect((await gate(tokenOf('t-of-u2', u2), 'agents', 'POST')).allowed).toBe(true);
    // reads are not covered by the action list
    expect((await gate(u1, 'agents', 'GET')).allowed).toBe(true);
  });

  it('a group forbid cannot be bypassed with a token of a member', async () => {
    await install(base({ principals: { groups: ['g-eng'] } }));
    const inGroup = member('u1', ['g-eng']);
    const outside = member('u2', ['g-other']);
    expect((await gate(inGroup, 'agents', 'POST')).allowed).toBe(false);
    expect((await gate(tokenOf('t1', inGroup), 'agents', 'POST')).allowed).toBe(false);
    expect((await gate(tokenOf('t1', inGroup, { agents: 'admin' }), 'agents', 'POST')).allowed).toBe(false);
    expect((await gate(outside, 'agents', 'POST')).allowed).toBe(true);
    expect((await gate(tokenOf('t2', outside), 'agents', 'POST')).allowed).toBe(true);
  });

  it('a group permit reaches the tokens of its members', async () => {
    // plain users have no access to the `members` service; the policy grants the group read on it
    await install(base({ effect: 'permit', principals: { groups: ['g-hr'] }, actions: ['members.read'] }));
    const hr = member('u1', ['g-hr']);
    expect((await gate(hr, 'members', 'GET')).allowed).toBe(true);
    expect((await gate(tokenOf('t-hr', hr), 'members', 'GET')).allowed).toBe(true);
    expect((await gate(member('u2', ['g-x']), 'members', 'GET')).allowed).toBe(false);
  });

  it('a token policy matches that token only', async () => {
    await install(base({ principals: { tokens: ['t1'] } }));
    const owner = member('u1');
    expect((await gate(tokenOf('t1', owner), 'agents', 'POST')).allowed).toBe(false);
    expect((await gate(tokenOf('t2', owner), 'agents', 'POST')).allowed).toBe(true);
    expect((await gate(owner, 'agents', 'POST')).allowed).toBe(true);
  });

  it('anyUser means sessions only, anyToken tokens only, any everyone', async () => {
    const owner = member('u1');
    const tok = tokenOf('t1', owner);
    await install(base({ principals: { anyUser: true } }), 'p-any-user');
    expect([(await gate(owner, 'agents', 'POST')).allowed, (await gate(tok, 'agents', 'POST')).allowed]).toEqual([false, true]);
    await deletePolicy(tenant(), 'p-any-user');

    await install(base({ principals: { anyToken: true } }), 'p-any-token');
    expect([(await gate(owner, 'agents', 'POST')).allowed, (await gate(tok, 'agents', 'POST')).allowed]).toEqual([true, false]);
    await deletePolicy(tenant(), 'p-any-token');

    await install(base({ principals: { any: true } }), 'p-any');
    expect([(await gate(owner, 'agents', 'POST')).allowed, (await gate(tok, 'agents', 'POST')).allowed]).toEqual([false, false]);
  });

  it('several selections are a union', async () => {
    await install(base({ principals: { users: ['u1'], groups: ['g1'], tokens: ['t9'] } }));
    expect((await gate(member('u1'), 'agents', 'POST')).allowed).toBe(false);
    expect((await gate(member('u5', ['g1']), 'agents', 'POST')).allowed).toBe(false);
    expect((await gate(tokenOf('t9', member('u7')), 'agents', 'POST')).allowed).toBe(false);
    expect((await gate(member('u7'), 'agents', 'POST')).allowed).toBe(true);
  });
});

describe('actions and resources', () => {
  it('level groups cover every action of that level; services narrow them', async () => {
    await install(base({ actions: ['Write'], resources: { services: ['agents', 'models'] } }));
    const user = member();
    expect((await gate(user, 'agents', 'POST')).allowed).toBe(false);
    expect((await gate(user, 'models', 'DELETE')).allowed).toBe(false);
    expect((await gate(user, 'prompts', 'POST')).allowed).toBe(true); // other service
    expect((await gate(user, 'agents', 'GET')).allowed).toBe(true); // a read
  });

  it('several actions are a union (service and resource actions mixed)', async () => {
    await install(base({ actions: ['agents.write', 'agent.delete'] }));
    const user = member();
    const agent = { kind: 'resource', type: 'agent', id: 'a1', service: 'agents' } as const;
    expect((await gate(user, 'agents', 'POST')).allowed).toBe(false);
    expect((await authorize({ tenant: tenant(), principal: user, action: 'agent.delete', resource: agent })).allowed).toBe(false);
    expect((await authorize({ tenant: tenant(), principal: user, action: 'agent.update', resource: agent })).allowed).toBe(true);
  });

  it('a project selection matches resources inside the project and service checks made in its context', async () => {
    await install(base({ actions: ['Write'], resources: { projects: ['p-frozen'] } }));
    const user = member();
    expect((await gate(user, 'agents', 'POST', { projectId: 'p-frozen' })).allowed).toBe(false);
    expect((await gate(user, 'agents', 'POST', { projectId: 'p-other' })).allowed).toBe(true);
    expect((await gate(user, 'agents', 'POST')).allowed).toBe(true);
    const inFrozen = { kind: 'resource', type: 'agent', id: 'a1', service: 'agents', projectId: 'p-frozen' } as const;
    const inOther = { ...inFrozen, projectId: 'p-other' } as const;
    expect((await authorize({ tenant: tenant(), principal: user, action: 'agent.delete', resource: inFrozen })).allowed).toBe(false);
    expect((await authorize({ tenant: tenant(), principal: user, action: 'agent.delete', resource: inOther })).allowed).toBe(true);
  });

  it('a permit limited to one resource matches that resource only', async () => {
    // (A FORBID limited to one resource cannot be saved: the request gates do not check individual
    // resources, so it would never block anything - see the next test. A permit is harmless.)
    await install(base({ effect: 'permit', actions: ['agent.invoke'], resources: { resources: [{ type: 'agent', id: 'a-invokable' }] } }));
    const user = member('u1', [], 'user');
    const noAgents = userPrincipal({ userId: 'u9', user: { role: 'user', servicePermissions: { agents: 'none' } } });
    const res = (id: string) => ({ kind: 'resource', type: 'agent', id, service: 'agents' }) as const;
    expect((await authorize({ tenant: tenant(), principal: noAgents, action: 'agent.invoke', resource: res('a-invokable') })).allowed).toBe(true);
    expect((await authorize({ tenant: tenant(), principal: noAgents, action: 'agent.invoke', resource: res('a-other') })).allowed).toBe(false);
    expect((await authorize({ tenant: tenant(), principal: user, action: 'agent.invoke', resource: res('a-other') })).allowed).toBe(true); // RBAC already allows
  });

  it('a forbid that no request gate can match is refused, with the reasons; a permit only warns', async () => {
    const onlyResources = await compileSpec(base({ actions: ['agent.delete', 'agent.update'], resources: { resources: [{ type: 'agent', id: 'a-locked' }] } }));
    expect(onlyResources.ok).toBe(false);
    expect(onlyResources.errors.map((e) => e.code).sort()).toEqual(['not_enforced_actions', 'not_enforced_resources']);
    expect(onlyResources.cedar).toContain('forbid');

    const portalOnly = await compileSpec(base({ conditions: { channels: ['portal'] } }));
    expect(portalOnly.ok).toBe(false);
    expect(portalOnly.errors.map((e) => e.code)).toEqual(['not_enforced_channel']);

    // partly reachable: saved, with a warning per unreachable part
    const partly = await compileSpec(base({
      actions: ['agent.delete', 'agents.write'],
      resources: { services: ['agents'], resources: [{ type: 'agent', id: 'a1' }] },
      conditions: { channels: ['api', 'portal'] },
    }));
    expect(partly.ok).toBe(true);
    expect(partly.warnings.map((w) => w.code).sort()).toEqual(['partly_enforced_actions', 'partly_enforced_channel', 'partly_enforced_resources']);

    const permit = await compileSpec(base({ effect: 'permit', actions: ['agent.invoke'], resources: { resources: [{ type: 'agent', id: 'a1' }] } }));
    expect(permit.ok).toBe(true);
    expect(permit.warnings.map((w) => w.code).sort()).toEqual(['not_enforced_actions', 'not_enforced_resources'].sort());
  });

  it('warns that blocking Admin does not stop changes to an administration service', async () => {
    const out = await compileSpec(base({ actions: ['members.admin'] }));
    expect(out.ok).toBe(true);
    expect(out.warnings).toEqual([expect.objectContaining({ code: 'admin_checked_as_write', params: { services: 'members' } })]);
    // Choosing Write as well (or instead) removes the warning
    expect((await compileSpec(base({ actions: ['members.admin', 'members.write'] }))).warnings.map((w) => w.code)).not.toContain('admin_checked_as_write');
    expect((await compileSpec(base({ actions: ['Admin'], resources: { services: ['agents'] } }))).warnings.map((w) => w.code)).not.toContain('admin_checked_as_write');
    expect((await compileSpec(base({ actions: ['Admin'] }))).warnings.map((w) => w.code)).toContain('admin_checked_as_write');
    // an ordinary service is checked as written
    expect((await compileSpec(base({ actions: ['agents.admin'] }))).warnings.map((w) => w.code)).not.toContain('admin_checked_as_write');
  });

  it('a prototype key is not a resource type', () => {
    for (const type of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const r = parsePolicySpec(base({ resources: { resources: [{ type, id: 'abc' }] } }));
      expect(r.ok, type).toBe(false);
      if (!r.ok) expect(r.errors[0].message).toMatch(/not a resource type/);
    }
  });

  it('a date-time without a zone is refused (it would be read in the server\'s timezone); a bare date is UTC', () => {
    const naive = parsePolicySpec(base({ conditions: { validFrom: '2026-10-09T10:00' } }));
    expect(naive.ok).toBe(false);
    if (!naive.ok) expect(naive.errors[0].message).toMatch(/time zone/);
    expect(parsePolicySpec(base({ conditions: { validFrom: '2026-10-09 10:00:30' } })).ok).toBe(false);
    for (const ok of ['2026-10-09T10:00Z', '2026-10-09T10:00:00+03:00', '2026-10-09T10:00:00.123-0200', '2026-10-09']) {
      expect(parsePolicySpec(base({ conditions: { validFrom: ok } })).ok, ok).toBe(true);
    }
    const bare = parsePolicySpec(base({ conditions: { validFrom: '2026-10-09' } }));
    expect(bare.ok && bare.spec.conditions?.validFrom).toBe('2026-10-09T00:00:00.000Z');
  });
});

describe('conditions', () => {
  const at = (iso: string) => ({ now: iso });

  it('validFrom / validUntil form a time window (inclusive)', async () => {
    await install(base({ conditions: { validFrom: '2026-06-01T00:00:00Z', validUntil: '2026-06-30T23:59:59Z' } }));
    const user = member();
    const allowed = async (iso: string) => (await gate(user, 'agents', 'POST', at(iso))).allowed;
    expect(await allowed('2026-05-31T23:59:59Z')).toBe(true);
    expect(await allowed('2026-06-01T00:00:00Z')).toBe(false);
    expect(await allowed('2026-06-15T12:00:00Z')).toBe(false);
    expect(await allowed('2026-06-30T23:59:59Z')).toBe(false);
    expect(await allowed('2026-07-01T00:00:00Z')).toBe(true);
  });

  it('either bound alone works, and "now" defaults to the real time', async () => {
    await install(base({ conditions: { validFrom: '2999-01-01T00:00:00Z' } }), 'future-only');
    expect((await gate(member(), 'agents', 'POST')).allowed).toBe(true); // not valid yet
    expect((await gate(member(), 'agents', 'POST', at('3000-01-01T00:00:00Z'))).allowed).toBe(false);
    await deletePolicy(tenant(), 'future-only');

    await install(base({ conditions: { validUntil: '2999-01-01T00:00:00Z' } }), 'until-only');
    expect((await gate(member(), 'agents', 'POST')).allowed).toBe(false); // still in force today
    expect((await gate(member(), 'agents', 'POST', at('3000-01-01T00:00:00Z'))).allowed).toBe(true);
  });

  it('ipRanges match IPv4 and IPv6 callers, including IPv4-mapped addresses', async () => {
    await install(base({ conditions: { ipRanges: ['10.0.0.0/8', '192.168.1.7', '2001:db8::/32'] } }));
    const user = member();
    const denied = async (ip: string) => !(await gate(user, 'agents', 'POST', { ip })).allowed;
    expect(await denied('10.20.30.40')).toBe(true);
    expect(await denied('::ffff:10.20.30.40')).toBe(true);
    expect(await denied('192.168.1.7')).toBe(true);
    expect(await denied('192.168.1.8')).toBe(false);
    expect(await denied('2001:db8:1::5')).toBe(true);
    expect(await denied('2001:db9::1')).toBe(false);
    expect(await denied('11.0.0.1')).toBe(false);
    expect((await gate(user, 'agents', 'POST')).allowed).toBe(true); // no address known
  });

  it('channels match the caller kind', async () => {
    await install(base({ conditions: { channels: ['api'] } }));
    const user = member();
    expect((await gate(user, 'agents', 'POST', { channel: 'api' })).allowed).toBe(false);
    expect((await gate(user, 'agents', 'POST', { channel: 'dashboard' })).allowed).toBe(true);
    expect((await gate(user, 'agents', 'POST')).allowed).toBe(true);
  });

  it('all conditions must hold together', async () => {
    await install(base({ conditions: { ipRanges: ['10.0.0.0/8'], channels: ['api'], validUntil: '2999-01-01T00:00:00Z' } }));
    const user = member();
    const ctx = { ip: '10.1.1.1', channel: 'api' };
    expect((await gate(user, 'agents', 'POST', ctx)).allowed).toBe(false);
    expect((await gate(user, 'agents', 'POST', { ...ctx, ip: '11.1.1.1' })).allowed).toBe(true);
    expect((await gate(user, 'agents', 'POST', { ...ctx, channel: 'dashboard' })).allowed).toBe(true);
    expect((await gate(user, 'agents', 'POST', { ...ctx, now: '3000-01-01T00:00:00Z' })).allowed).toBe(true);
  });
});

describe('permits and disabled policies', () => {
  it('a permit grants what RBAC does not', async () => {
    await install(base({ effect: 'permit', principals: { users: ['u1'] }, actions: ['members.read'] }));
    expect((await gate(member('u1'), 'members', 'GET')).allowed).toBe(true);
    expect((await gate(member('u2'), 'members', 'GET')).allowed).toBe(false);
    // ... but not write: it only covers read
    expect((await gate(member('u1'), 'members', 'POST')).allowed).toBe(false);
  });

  it('a disabled spec policy changes nothing, an enabled one does', async () => {
    const policy = await install(base({ principals: { users: ['u1'] } }), 'toggle');
    expect((await gate(member('u1'), 'agents', 'POST')).allowed).toBe(false);
    await updatePolicy(tenant(), policy.policyId, { enabled: false }, 'tester');
    expect((await gate(member('u1'), 'agents', 'POST')).allowed).toBe(true);
    await updatePolicy(tenant(), policy.policyId, { enabled: true }, 'tester');
    expect((await gate(member('u1'), 'agents', 'POST')).allowed).toBe(false);
    expect((await gate(member('u2'), 'agents', 'POST')).allowed).toBe(true);
  });
});

describe('compiled text', () => {
  it('is readable, validates against the schema and warns about policies that can never apply', async () => {
    const out = await compileSpec(base({ actions: ['models.read'], resources: { services: ['agents'] } }));
    expect(out.ok).toBe(true);
    expect(out.cedar).toContain('forbid (');
    expect(out.cedar).toContain('Action::"models.read"');
    expect(out.warnings.map((w) => w.message).join(' ')).toMatch(/never apply/);
  });

  it('does not warn about a service that no action matches when another selector may still match', async () => {
    const out = await compileSpec(base({ actions: ['models.read'], resources: { services: ['agents'], projects: ['p1'] } }));
    expect(out.ok).toBe(true);
    expect(out.warnings.map((w) => w.message).join(' ')).not.toMatch(/never apply/);
    const resourceOnly = await compileSpec(base({ actions: ['models.read'], resources: { resources: [{ type: 'agent', id: 'a1' }] } }));
    expect(resourceOnly.warnings.map((w) => w.message).join(' ')).toMatch(/never apply/);
  });

  it('warns that the owner cannot be locked out of the Authorization Engine', async () => {
    const out = await compileSpec(base({ actions: ['iam.write'], resources: { services: ['iam'] } }));
    expect(out.ok).toBe(true);
    expect(out.warnings.map((w) => w.message).join(' ')).toMatch(/owner/);
  });

  it('reports problems without Cedar for an invalid spec', async () => {
    const out = await compileSpec({ effect: 'permit' });
    expect(out.ok).toBe(false);
    expect(out.cedar).toBe('');
    expect(out.errors.length).toBeGreaterThan(0);
  });

  it('uses a single action == for one concrete action and in [...] otherwise', () => {
    const view = currentCatalogView();
    expect(compileSpecToCedar(parsedOk(base()), view)).toContain('action == Action::"agents.write"');
    expect(compileSpecToCedar(parsedOk(base({ actions: ['Write'] })), view)).toContain('action in Action::"Write"');
    expect(compileSpecToCedar(parsedOk(base({ actions: ['agents.write', 'Read'] })), view)).toContain('action in [Action::"agents.write", Action::"Read"]');
  });
});

describe('references are verified with set queries, not one read per id', () => {
  it('a spec naming hundreds of people costs a handful of queries and still finds the missing ones', async () => {
    const ids: string[] = [];
    await env.db.runWithTenant(tenant(), async () => {
      for (let i = 0; i < 230; i++) {
        const u = await env.db.createUser({ tenantId: env.tenantId, email: `ref${i}@x.example`, name: `Ref ${i}`, password: 'h', role: 'user', licenseId: 'FREE', features: [] });
        ids.push(String(u._id));
      }
    });
    const group = await env.db.runWithTenant(tenant(), () => env.db.createGroup({ tenantId: env.tenantId, name: 'Refs', createdBy: 't', source: 'local' } as never));
    const project = await env.db.createProject({ tenantId: env.tenantId, key: 'refs', name: 'Refs', createdBy: 'x' });
    const point = vi.spyOn(env.db, 'findUserById');
    const pointGroup = vi.spyOn(env.db, 'findGroupById');
    const pointProject = vi.spyOn(env.db, 'findProjectById');
    const users = vi.spyOn(env.db, 'iamListUsers');
    try {
      const spec = base({ principals: { users: ids, groups: [String(group._id)] }, resources: { projects: [String(project._id)] } });
      const ok = await compileSpec(spec, { tenantDbName: tenant(), tenantId: env.tenantId });
      expect(ok.errors, JSON.stringify(ok.errors)).toEqual([]);
      expect(ok.ok).toBe(true);
      expect(point).not.toHaveBeenCalled();
      expect(pointGroup).not.toHaveBeenCalled();
      expect(pointProject).not.toHaveBeenCalled();
      expect(users.mock.calls.length).toBeLessThanOrEqual(2); // 230 ids in chunks of 200

      // the ones that are not there are named, also past the first chunk
      const missing = await compileSpec(
        base({ principals: { users: [...ids.slice(0, 210), 'ffffffffffffffffffffffff', 'not-an-objectid'] }, resources: { projects: ['gone-project'] } }),
        { tenantDbName: tenant(), tenantId: env.tenantId },
      );
      expect(missing.ok).toBe(false);
      expect(missing.errors.map((e) => e.message).sort()).toEqual([
        'The project "gone-project" does not exist in this workspace',
        'The user "ffffffffffffffffffffffff" does not exist in this workspace',
        'The user "not-an-objectid" does not exist in this workspace',
      ]);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('rules on the caller\'s address say what they depend on', () => {
  const saved = process.env.TRUSTED_PROXIES;
  afterEach(() => {
    if (saved === undefined) delete process.env.TRUSTED_PROXIES;
    else process.env.TRUSTED_PROXIES = saved;
    reloadConfig();
  });

  it('warns while the server trusts no proxy (the address is then the connection\'s own), and stops once one is configured', async () => {
    delete process.env.TRUSTED_PROXIES;
    reloadConfig();
    const spec = base({ conditions: { ipRanges: ['203.0.113.0/24'] } });
    const warned = await compileSpec(spec);
    expect(warned.ok).toBe(true);
    expect(warned.warnings.map((w) => w.code)).toContain('trusted_proxies_unset');
    // a rule that does not look at the address is not bothered with it
    expect((await compileSpec(base())).warnings.map((w) => w.code)).not.toContain('trusted_proxies_unset');

    process.env.TRUSTED_PROXIES = '10.0.0.0/8';
    reloadConfig();
    expect((await compileSpec(spec)).warnings.map((w) => w.code)).not.toContain('trusted_proxies_unset');
  });
});

describe('rules about portals', () => {
  // The three rules an administrator writes first: block a person from a portal, block one agent in portals, block a group's
  // reading in portals. Where there are no portals (no enterprise overlay) none of them can ever apply, so none is accepted.
  const forbidUserOnPortal = base({ principals: { users: ['u-1'] }, actions: ['portal.use'], resources: { resources: [{ type: 'portal', id: 'P1' }] } });
  const forbidAgentInPortals = base({
    principals: { anyUser: true }, actions: ['agent.invoke'], resources: { resources: [{ type: 'agent', id: 'A1' }] }, conditions: { channels: ['portal'] },
  });
  const forbidReadInPortals = base({ principals: { groups: ['g1'] }, actions: ['Read'], resources: { any: true }, conditions: { channels: ['portal'] } });
  const rawUser = 'forbid (principal == User::"u-1", action == Action::"portal.use", resource == Portal::"P1");';
  const rawInPortal = 'forbid (principal, action in [Action::"portal.use", Action::"agent.invoke"], resource) when { resource in Portal::"P1" };';
  const codes = (issues: Array<{ code?: string }>) => issues.map((i) => i.code).sort();

  afterEach(() => registerIamPortalResolver(null));

  describe('without portals', () => {
    it('refuses all three, for the reasons it always gave', async () => {
      const user = await compileSpec(forbidUserOnPortal);
      expect(user.ok).toBe(false);
      expect(codes(user.errors)).toEqual(['not_enforced_actions', 'not_enforced_resources']);
      const agent = await compileSpec(forbidAgentInPortals);
      expect(agent.ok).toBe(false);
      expect(codes(agent.errors)).toEqual(['not_enforced_actions', 'not_enforced_channel', 'not_enforced_resources']);
      const read = await compileSpec(forbidReadInPortals);
      expect(read.ok).toBe(false);
      expect(codes(read.errors)).toEqual(['not_enforced_channel']);
    });

    it('refuses the same rules written as Cedar', () => {
      expect(validateCustomPolicyText(rawUser).valid).toBe(false);
      expect(validateCustomPolicyText(rawUser).errors[0].message).toMatch(/individual resources|whole services/);
      expect(validateCustomPolicyText(rawInPortal).valid).toBe(false);
    });
  });

  describe('where portals exist', () => {
    beforeEach(() => registerIamPortalResolver(async () => null));

    it('accepts all three, without a warning that the rule is partly inert', async () => {
      for (const spec of [forbidUserOnPortal, forbidAgentInPortals, forbidReadInPortals]) {
        const out = await compileSpec(spec);
        expect(out.ok, JSON.stringify(spec)).toBe(true);
        // (a rule that covers a level also carries the note that the owner cannot be locked out of the Authorization Engine: no code)
        expect(codes(out.warnings).filter(Boolean)).toEqual([]);
      }
      const read = await compileSpec(forbidReadInPortals);
      expect(read.cedar).toContain('context has channel && ["portal"].contains(context.channel)');
    });

    it('accepts the same rules written as Cedar', () => {
      expect(validateCustomPolicyText(rawUser)).toMatchObject({ valid: true, errors: [] });
      expect(validateCustomPolicyText(rawInPortal)).toMatchObject({ valid: true, errors: [] });
      expect(validateCustomPolicyText('forbid (principal, action, resource == Agent::"a1");').valid).toBe(true); // every action, one agent: reaches agent.invoke
      expect(validateCustomPolicyText('forbid (principal, action in Action::"Read", resource in Project::"p1");').valid).toBe(true);
    });

    it('still refuses what nothing asks about, even next to portals', async () => {
      expect(validateCustomPolicyText('forbid (principal, action == Action::"agent.delete", resource == Agent::"a1");').valid).toBe(false);
      expect(validateCustomPolicyText('forbid (principal, action == Action::"portal.get", resource == Portal::"P1");').valid).toBe(false);
      // opening a portal is not about a tool, a project is not a portal's, and the dashboard channel does not open portals
      expect(codes((await compileSpec(base({ actions: ['portal.use'], resources: { services: ['models'] } }))).errors)).toEqual(['portal_wrong_scope']);
      expect(codes((await compileSpec(base({ actions: ['portal.use'], conditions: { channels: ['dashboard'] } }))).errors)).toEqual(['portal_wrong_channel']);
      expect(codes((await compileSpec(base({ actions: ['agents.write'], conditions: { channels: ['portal'] } }))).errors)).toEqual(['not_enforced_channel']);
    });

    it('says only what is true about a rule that is partly about portals', async () => {
      // the Write level is asked at the gates AND (as agent.invoke) by portals: no channel warning
      const both = await compileSpec(base({ actions: ['portal.use', 'agents.write'], conditions: { channels: ['api', 'portal'] } }));
      expect(both.ok).toBe(true);
      expect(codes(both.warnings)).not.toContain('partly_enforced_channel');
      // portal channel plus an action the portal runtime does not ask: the other channels still carry it
      const other = await compileSpec(base({ actions: ['agents.write'], conditions: { channels: ['api', 'portal'] } }));
      expect(codes(other.warnings)).toEqual(['partly_enforced_channel']);
      // a specific agent is checked in portals; a specific tool is not
      const mixed = await compileSpec(base({
        actions: ['agent.invoke', 'agents.write'], resources: { services: ['agents'], resources: [{ type: 'agent', id: 'a1' }, { type: 'tool', id: 't1' }] },
      }));
      expect(mixed.ok).toBe(true);
      expect(codes(mixed.warnings)).toEqual(['partly_enforced_resources']);
      const agentsOnly = await compileSpec(base({
        actions: ['agent.invoke', 'agents.write'], resources: { services: ['agents'], resources: [{ type: 'agent', id: 'a1' }] },
      }));
      expect(codes(agentsOnly.warnings)).toEqual([]);
    });

    it('an allow rule is told that the portal list is the only thing that lets anyone in', async () => {
      const onlyPortal = await compileSpec(base({ effect: 'permit', actions: ['portal.use'], resources: { resources: [{ type: 'portal', id: 'P1' }] } }));
      expect(onlyPortal.ok).toBe(true);
      expect(codes(onlyPortal.warnings)).toEqual(['portal_access_list_grants']);
      // when it also works at the gates it is advice, not "this does nothing"
      const alsoElsewhere = await compileSpec(base({ effect: 'permit', actions: ['Read'], resources: { any: true }, conditions: { channels: ['portal', 'dashboard'] } }));
      expect(codes(alsoElsewhere.warnings)).toEqual(['partly_portal_access_list_grants']);
      // a plain allow that never mentions portals says nothing about them
      expect(codes((await compileSpec(base({ effect: 'permit', actions: ['Read'], resources: { any: true } }))).warnings)).toEqual([]);
    });

    it('a rule it accepts really blocks: the stored deny rule decides the portal check', async () => {
      const compiled = await compileSpec(forbidUserOnPortal);
      expect(compiled.ok).toBe(true);
      await createPolicy(tenant(), { policyId: 'no-u1', name: 'Block u-1 from P1', cedar: compiled.cedar, spec: compiled.spec }, 'tester');
      const access = { mode: 'all' as const, userIds: [], groupIds: [] };
      const open = (userId: string, id = 'P1') => authorize({
        tenant: tenant(), principal: userPrincipal({ userId, user: { role: 'user' } }), action: 'portal.use',
        resource: portalResource({ id, access }), context: { channel: 'portal' },
      });
      expect(await open('u-1')).toMatchObject({ allowed: false, reasons: ['custom:no-u1'] });
      expect((await open('u-2')).allowed).toBe(true);
      expect((await open('u-1', 'P2')).allowed).toBe(true);

      const agentRule = await compileSpec(forbidAgentInPortals);
      await createPolicy(tenant(), { policyId: 'no-a1', name: 'No A1 in portals', cedar: agentRule.cedar, spec: agentRule.spec }, 'tester');
      const run = (channel: string, id = 'A1') => authorize({
        tenant: tenant(), principal: userPrincipal({ userId: 'u-2', user: { role: 'user' } }), action: 'agent.invoke',
        resource: portalAgentResource({ id, projectId: 'p1' }, { id: 'P1', access }), context: { channel },
      });
      expect(await run('portal')).toMatchObject({ allowed: false, reasons: ['custom:no-a1'] });
      expect((await run('portal', 'A2')).allowed).toBe(true);
      expect((await run('dashboard')).allowed).toBe(true); // the dashboard playground is not a portal
    });
  });
});
