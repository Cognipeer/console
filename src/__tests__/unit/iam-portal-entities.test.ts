/**
 * The entities of the portal rules: a Portal that carries its access list and an
 * Agent that is run through one (portalEntities.ts), and the seam through which
 * the enterprise overlay announces portals (enterprise/iam-portal.ts).
 *
 * The decision itself is the engine's (iam-portal-policies.test.ts); here the
 * shapes the managed rules read are pinned, and the one optimisation - cutting a
 * long access list down to the requester's slice - is proved decision-equivalent
 * with a seeded property test against the managed set itself.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  hasIamPortalResolver,
  registerIamPortalResolver,
  resolveIamPortal,
  type IamPortalFacts,
} from '@/enterprise/iam-portal';
import { statefulIsAuthorized } from '@/lib/iam/cedar';
import { buildAuthorizeCall, ensureManagedPolicySet } from '@/lib/iam/engine';
import { actionEntities, principalEntities, resourceEntities, userPrincipal } from '@/lib/iam/entities';
import {
  PORTAL_ENTITY_SLICE_THRESHOLD,
  portalAgentResource,
  portalCedarEntity,
  portalResource,
  type PortalAccessInput,
} from '@/lib/iam/portalEntities';
import { isRuntimeEnforced, enforcedChannelsOf } from '@/lib/iam/runtimeEnforced';
import { mulberry32 } from '../helpers/iamTestDb';

const attrsOf = (entity: { attrs: Record<string, unknown> }) => entity.attrs;
/** Cedar's entity uid is a union (`{ type, id }` or an escaped form); the builders only ever write the plain one. */
const uidOf = (entity: { uid: unknown }) => entity.uid as { type: string; id: string };
const ref = (type: string, id: string) => ({ __entity: { type, id } });

afterEach(() => registerIamPortalResolver(null));

describe('the Portal entity', () => {
  const access: PortalAccessInput = { mode: 'selected', userIds: ['u1', 'u2'], groupIds: ['g1'] };

  it('carries the access list as typed entity references - never plain strings', () => {
    const entity = portalCedarEntity('P1', access);
    expect(entity.uid).toEqual({ type: 'Portal', id: 'P1' });
    expect(entity.parents).toEqual([]);
    expect(attrsOf(entity)).toEqual({
      service: 'portals',
      adminService: true,
      mode: 'selected',
      allowedUsers: [ref('User', 'u1'), ref('User', 'u2')],
      allowedGroups: [ref('Group', 'g1')],
    });
  });

  it('is the resource of portal.use, with the portal\'s key', () => {
    const resource = portalResource({ id: 'P1', key: 'branch', access });
    expect(resource).toMatchObject({ kind: 'resource', type: 'portal', id: 'P1', service: 'portals', key: 'branch' });
    const { uid, entities } = resourceEntities(resource);
    expect(uid).toEqual({ type: 'Portal', id: 'P1' });
    expect(entities).toHaveLength(1);
    expect(attrsOf(entities[0])).toMatchObject({ key: 'branch', mode: 'selected', allowedUsers: [ref('User', 'u1'), ref('User', 'u2')] });
  });

  it('is `in` nothing and cannot claim another service through its attributes', () => {
    const resource = portalResource({ id: 'P1', access });
    expect(resource.kind === 'resource' && resource.attrs).toBeTruthy();
    // the generic builder lets extra attributes in, but never over the ones the managed rules trust
    const { entities } = resourceEntities({ ...(resource as object), attrs: { service: 'agents', adminService: false, mode: 'all' } } as never);
    expect(attrsOf(entities[0])).toMatchObject({ service: 'portals', adminService: true, mode: 'all' });
  });

  it('survives ids with quotes, backslashes and unicode', () => {
    const odd = ['we"ird', 'back\\slash', 'ünï-çödé-用户', "o'brien", 'sp ace'];
    const entity = portalCedarEntity('P"1', { mode: 'selected', userIds: odd, groupIds: odd });
    expect(uidOf(entity).id).toBe('P"1');
    expect(attrsOf(entity).allowedUsers).toEqual(odd.map((id) => ref('User', id)));
    expect(attrsOf(entity).allowedGroups).toEqual(odd.map((id) => ref('Group', id)));
  });

  it('reads anything it cannot understand as the safe side: not "all", and no entry that is not a text', () => {
    const bad = portalCedarEntity('P1', { mode: 'everyone' as never, userIds: ['u1', 7, null, '', { id: 'x' }] as never, groupIds: 'g1' as never });
    expect(attrsOf(bad)).toMatchObject({ mode: 'selected', allowedUsers: [ref('User', 'u1')], allowedGroups: [] });
    const missing = portalCedarEntity('P1', undefined as never);
    expect(attrsOf(missing)).toMatchObject({ mode: 'selected', allowedUsers: [], allowedGroups: [] });
  });
});

describe('an agent run through a portal', () => {
  const portal = { id: 'P1', access: { mode: 'selected', userIds: ['u1'], groupIds: [] } as PortalAccessInput };

  it('is in the portal AND its project, names the portal, and brings the portal along', () => {
    const resource = portalAgentResource({ id: 'a1', key: 'support', projectId: 'proj-1' }, portal);
    expect(resource).toMatchObject({
      kind: 'resource', type: 'agent', id: 'a1', service: 'agents', key: 'support', projectId: 'proj-1',
      parents: [{ type: 'Portal', id: 'P1' }],
      attrs: { portal: ref('Portal', 'P1') },
    });
    const { uid, entities } = resourceEntities(resource, 'tenant_x');
    expect(uid).toEqual({ type: 'Agent', id: 'a1' });
    const agent = entities.find((e) => uidOf(e).type === 'Agent')!;
    expect(agent.parents).toEqual([{ type: 'Project', id: 'proj-1' }, { type: 'Portal', id: 'P1' }]);
    expect(attrsOf(agent)).toMatchObject({ service: 'agents', adminService: false, key: 'support', portal: ref('Portal', 'P1') });
    expect(entities.filter((e) => uidOf(e).type === 'Portal')).toHaveLength(1);
    expect(attrsOf(entities.find((e) => uidOf(e).type === 'Portal')!)).toMatchObject({ mode: 'selected', allowedUsers: [ref('User', 'u1')] });
    expect(entities.map((e) => uidOf(e).type).sort()).toEqual(['Agent', 'Portal', 'Project', 'Tenant']);
  });

  it('needs no project', () => {
    const { entities } = resourceEntities(portalAgentResource({ id: 'a1' }, portal));
    expect(entities.map((e) => uidOf(e).type).sort()).toEqual(['Agent', 'Portal']);
    expect(entities.find((e) => uidOf(e).type === 'Agent')!.parents).toEqual([{ type: 'Portal', id: 'P1' }]);
  });
});

describe('cutting a long access list down to the requester\'s slice', () => {
  const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}-${i}`);

  it('leaves a list up to the threshold whole, and any list when nobody is asking', () => {
    const access: PortalAccessInput = { mode: 'selected', userIds: ids('u', 100), groupIds: ids('g', 100) }; // exactly 200 entries
    expect(access.userIds.length + access.groupIds.length).toBe(PORTAL_ENTITY_SLICE_THRESHOLD);
    expect(attrsOf(portalCedarEntity('P', access, { userId: 'u-5', groupIds: [] })).allowedUsers).toHaveLength(100);
    const longer: PortalAccessInput = { ...access, userIds: ids('u', 101) };
    expect(attrsOf(portalCedarEntity('P', longer)).allowedUsers).toHaveLength(101); // no requester: the whole list (the Access check)
  });

  it('keeps only what concerns the requester above it', () => {
    const access: PortalAccessInput = { mode: 'selected', userIds: ids('u', 150), groupIds: ids('g', 150) };
    const listed = attrsOf(portalCedarEntity('P', access, { userId: 'u-7', groupIds: ['g-3', 'g-900', 'other'] }));
    expect(listed).toMatchObject({ mode: 'selected', allowedUsers: [ref('User', 'u-7')], allowedGroups: [ref('Group', 'g-3')] });
    const stranger = attrsOf(portalCedarEntity('P', access, { userId: 'nobody', groupIds: [] }));
    expect(stranger).toMatchObject({ mode: 'selected', allowedUsers: [], allowedGroups: [] });
    // the mode is never cut away
    const open = attrsOf(portalCedarEntity('P', { mode: 'all', userIds: ids('u', 500), groupIds: [] }, { userId: 'x', groupIds: [] }));
    expect(open).toMatchObject({ mode: 'all', allowedUsers: [] });
  });

  it('is decision-equivalent to the whole list for every requester (seeded property test over the managed rules)', () => {
    expect(ensureManagedPolicySet().ok).toBe(true);
    const seed = Number(process.env.IAM_FUZZ_SEED ?? 20261010);
    const rand = mulberry32(seed);
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(rand() * items.length)];
    const sizes = [0, 1, 3, 40, 99, 100, 101, 250, 600];
    let allowed = 0;
    let denied = 0;

    const decide = (resource: ReturnType<typeof portalResource>, userId: string, groupIds: string[], action: string, channel: string) => {
      const principal = userPrincipal({ userId, user: { role: pick(['user', 'user', 'admin', 'owner']) }, groupIds });
      const built = buildAuthorizeCall({ tenant: 'tenant_prop', principal, action, resource, context: { channel } }, 'tenant_prop');
      const result = statefulIsAuthorized({ ...built.call, policySetId: 'managed:rbac' });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.errors.join('; '));
      expect(result.errors, 'a managed rule errored').toEqual([]);
      return result.allowed;
    };

    for (let i = 0; i < 500; i++) {
      const users = ids('u', pick(sizes));
      const groups = ids('g', pick(sizes));
      const mode = rand() < 0.15 ? 'all' : 'selected';
      const access: PortalAccessInput = { mode, userIds: users, groupIds: groups };
      // a requester who is on the list one way or the other, or on neither
      const kind = pick(['user', 'group', 'both', 'neither']);
      const userId = kind === 'user' || kind === 'both' ? (users.length ? pick(users) : 'u-x') : `stranger-${i}`;
      const own = kind === 'group' || kind === 'both' ? (groups.length ? [pick(groups)] : ['g-x']) : [];
      const groupIds = [...own, ...ids('other', Math.floor(rand() * 4))];
      const expected = mode === 'all' || users.includes(userId) || groups.some((g) => groupIds.includes(g));

      const whole = decide(portalResource({ id: 'P', access }), userId, groupIds, 'portal.use', 'portal');
      const slice = decide(portalResource({ id: 'P', access }, { userId, groupIds }), userId, groupIds, 'portal.use', 'portal');
      expect(whole, `portal.use whole, case ${i}, seed ${seed}`).toBe(expected);
      expect(slice, `portal.use slice, case ${i}, seed ${seed}`).toBe(expected);

      const agentWhole = decide(portalAgentResource({ id: 'a', projectId: 'p' }, { id: 'P', access }), userId, groupIds, 'agent.invoke', 'portal');
      const agentSlice = decide(portalAgentResource({ id: 'a', projectId: 'p' }, { id: 'P', access }, { userId, groupIds }), userId, groupIds, 'agent.invoke', 'portal');
      expect(agentWhole, `agent.invoke whole, case ${i}`).toBe(expected);
      expect(agentSlice, `agent.invoke slice, case ${i}`).toBe(expected);
      if (expected) allowed++;
      else denied++;
    }
    // the generator really covered both outcomes
    expect(allowed).toBeGreaterThan(50);
    expect(denied).toBeGreaterThan(50);
  });

  it('builds the principal entities the rules read (sanity: groups are parents of the user)', () => {
    const { entities } = principalEntities(userPrincipal({ userId: 'u', user: { role: 'user' }, groupIds: ['g1'] }));
    expect(entities[0].parents).toEqual([{ type: 'Group', id: 'g1' }]);
    expect(actionEntities('portal.use', 'read')[0].parents).toEqual([{ type: 'Action', id: 'Read' }]);
  });
});

describe('the portal seam', () => {
  const facts: IamPortalFacts = {
    id: 'P1', key: 'branch', name: 'Branch assistant', status: 'enabled',
    access: { mode: 'selected', userIds: ['u1'], groupIds: ['g1'] }, agentIds: ['a1'],
  };
  const tenant = { tenantDbName: 'tenant_x', tenantId: 't1' };

  it('knows nothing until the overlay registers a resolver, and the portal rules are not enforced then', async () => {
    expect(hasIamPortalResolver()).toBe(false);
    expect(await resolveIamPortal(tenant, 'P1')).toBeNull();
    expect(isRuntimeEnforced('portal.use')).toBe(false);
    expect(isRuntimeEnforced('agent.invoke', 'portal')).toBe(false);
    expect(enforcedChannelsOf('portal.use')).toEqual([]);
  });

  it('passes the workspace and the portal id to the resolver, and says the portal rules are enforced in the portal channel only', async () => {
    const seen: unknown[] = [];
    registerIamPortalResolver(async (t, id) => {
      seen.push([t, id]);
      return id === 'P1' ? facts : null;
    });
    expect(hasIamPortalResolver()).toBe(true);
    expect(await resolveIamPortal(tenant, 'P1')).toEqual(facts);
    expect(await resolveIamPortal(tenant, 'nope')).toBeNull();
    expect(seen).toEqual([[tenant, 'P1'], [tenant, 'nope']]);

    expect(isRuntimeEnforced('portal.use')).toBe(true);
    expect(isRuntimeEnforced('portal.use', 'portal')).toBe(true);
    expect(isRuntimeEnforced('portal.use', 'dashboard')).toBe(false);
    expect(isRuntimeEnforced('agent.invoke', 'api')).toBe(false);
    expect(isRuntimeEnforced('agent.delete')).toBe(false); // evaluated by the Access check only
    expect(isRuntimeEnforced('agents.write')).toBe(false); // a service action is the gates', not a runtime's
    expect(enforcedChannelsOf('agent.invoke')).toEqual(['portal']);
  });

  it('answers null for a resolver that throws or answers nothing - it never guesses a portal', async () => {
    registerIamPortalResolver(async () => {
      throw new Error('database down');
    });
    expect(await resolveIamPortal(tenant, 'P1')).toBeNull();
    registerIamPortalResolver(async () => undefined as never);
    expect(await resolveIamPortal(tenant, 'P1')).toBeNull();
  });

  it('a later registration replaces the earlier one, and null clears it', async () => {
    registerIamPortalResolver(async () => ({ ...facts, name: 'first' }));
    registerIamPortalResolver(async () => ({ ...facts, name: 'second' }));
    expect((await resolveIamPortal(tenant, 'P1'))?.name).toBe('second');
    registerIamPortalResolver(null);
    expect(hasIamPortalResolver()).toBe(false);
  });
});
