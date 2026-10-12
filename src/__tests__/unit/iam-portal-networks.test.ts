/**
 * The portal network setting: validation (what the portal form saves), the entity attributes (what the
 * engine reads) and the TypeScript test of "is this address in the list" (what the form's self-test shows),
 * which must give the same answer as the managed rule in the engine.
 */
import { describe, expect, it } from 'vitest';
import { statefulIsAuthorized } from '@/lib/iam/cedar';
import { buildAuthorizeCall, ensureManagedPolicySet } from '@/lib/iam/engine';
import { userPrincipal } from '@/lib/iam/entities';
import { portalResource } from '@/lib/iam/portalEntities';
import {
  checkPortalNetwork,
  cidrContainsAddress,
  PORTAL_MAX_NETWORKS,
  portalNetworkAttrs,
  validatePortalNetworks,
} from '@/lib/iam/portalNetworks';

describe('validatePortalNetworks', () => {
  it('reads an absent setting as "any network"', () => {
    expect(validatePortalNetworks(undefined)).toEqual({ ok: true, value: { mode: 'any', cidrs: [] } });
    expect(validatePortalNetworks(null)).toEqual({ ok: true, value: { mode: 'any', cidrs: [] } });
    expect(validatePortalNetworks({})).toEqual({ ok: true, value: { mode: 'any', cidrs: [] } });
  });

  it('normalises ranges, folds duplicates and keeps the order', () => {
    const result = validatePortalNetworks({
      mode: 'allow_list',
      cidrs: [' 10.0.0.0/8 ', '192.168.1.7', '10.0.0.0/8', '2001:DB8::/32', '2001:0db8:0:0:0:0:0:0/32'],
    });
    expect(result).toEqual({ ok: true, value: { mode: 'allow_list', cidrs: ['10.0.0.0/8', '192.168.1.7', '2001:db8::/32'] } });
  });

  it('keeps a staged list while the boundary is off', () => {
    expect(validatePortalNetworks({ mode: 'any', cidrs: ['10.0.0.0/8'] })).toEqual({ ok: true, value: { mode: 'any', cidrs: ['10.0.0.0/8'] } });
  });

  it('refuses an allow list with nothing in it, a bad mode and non-lists', () => {
    expect(validatePortalNetworks({ mode: 'allow_list', cidrs: [] })).toMatchObject({ ok: false, issues: [{ code: 'empty_allow_list' }] });
    expect(validatePortalNetworks({ mode: 'allow_list' })).toMatchObject({ ok: false, issues: [{ code: 'empty_allow_list' }] });
    expect(validatePortalNetworks({ mode: 'block_list', cidrs: [] })).toMatchObject({ ok: false, issues: [{ code: 'invalid_mode' }] });
    expect(validatePortalNetworks({ mode: 'any', cidrs: 'x' })).toMatchObject({ ok: false, issues: [{ code: 'cidrs_not_a_list' }] });
    expect(validatePortalNetworks('10.0.0.0/8')).toMatchObject({ ok: false, issues: [{ code: 'not_an_object' }] });
    expect(validatePortalNetworks([])).toMatchObject({ ok: false, issues: [{ code: 'not_an_object' }] });
  });

  it('names every bad range with its position', () => {
    const result = validatePortalNetworks({ mode: 'allow_list', cidrs: ['10.0.0.0/8', 'office', '10.0.0.0/33', 42, '::ffff:10.0.0.1/104', '1.2.3.4/'] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => [i.code, i.index])).toEqual([
      ['invalid_cidr', 1], ['invalid_cidr', 2], ['invalid_cidr', 3], ['invalid_cidr', 4], ['invalid_cidr', 5],
    ]);
    expect(result.issues[0].value).toBe('office');
  });

  it('accepts exactly as many ranges as the rules have slots', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `10.${i}.0.0/16`);
    expect(validatePortalNetworks({ mode: 'allow_list', cidrs: many(PORTAL_MAX_NETWORKS) }).ok).toBe(true);
    expect(validatePortalNetworks({ mode: 'allow_list', cidrs: many(PORTAL_MAX_NETWORKS + 1) })).toMatchObject({ ok: false, issues: [{ code: 'too_many' }] });
  });
});

describe('portalNetworkAttrs', () => {
  it('adds nothing for a portal that never listed networks', () => {
    expect(portalNetworkAttrs(undefined)).toEqual({});
    expect(portalNetworkAttrs(null)).toEqual({});
    expect(portalNetworkAttrs({ mode: 'bogus' as never, cidrs: ['10.0.0.0/8'] })).toEqual({});
  });

  it('marks "any" without ranges and writes one slot per usable range', () => {
    expect(portalNetworkAttrs({ mode: 'any', cidrs: ['10.0.0.0/8'] })).toEqual({ networkMode: 'any' });
    expect(portalNetworkAttrs({ mode: 'allow_list', cidrs: ['10.0.0.0/8', 'junk', '2001:db8::/32'] })).toEqual({
      networkMode: 'allow_list',
      net0: { __extn: { fn: 'ip', arg: '10.0.0.0/8' } },
      net1: { __extn: { fn: 'ip', arg: '2001:db8::/32' } },
    });
  });

  it('never writes more slots than the rules read', () => {
    const attrs = portalNetworkAttrs({ mode: 'allow_list', cidrs: Array.from({ length: PORTAL_MAX_NETWORKS + 5 }, (_, i) => `10.${i}.0.0/16`) });
    expect(Object.keys(attrs)).toHaveLength(PORTAL_MAX_NETWORKS + 1);
    expect(attrs[`net${PORTAL_MAX_NETWORKS}`]).toBeUndefined();
  });
});

describe('cidrContainsAddress / checkPortalNetwork', () => {
  it('matches inside a range and not outside, per family', () => {
    expect(cidrContainsAddress('10.0.0.0/8', '10.255.255.255')).toBe(true);
    expect(cidrContainsAddress('10.0.0.0/8', '11.0.0.0')).toBe(false);
    expect(cidrContainsAddress('192.168.1.7', '192.168.1.7')).toBe(true);
    expect(cidrContainsAddress('192.168.1.7', '192.168.1.8')).toBe(false);
    expect(cidrContainsAddress('0.0.0.0/0', '8.8.8.8')).toBe(true);
    expect(cidrContainsAddress('2001:db8::/32', '2001:db8:ffff::1')).toBe(true);
    expect(cidrContainsAddress('2001:db8::/32', '2001:db9::1')).toBe(false);
    expect(cidrContainsAddress('::/0', '2001:db8::1')).toBe(true);
    // The families never mix.
    expect(cidrContainsAddress('::/0', '10.0.0.1')).toBe(false);
    expect(cidrContainsAddress('0.0.0.0/0', '::1')).toBe(false);
  });

  it('gives the verdict a form can show', () => {
    const list = { mode: 'allow_list' as const, cidrs: ['10.0.0.0/8', '203.0.113.0/24'] };
    expect(checkPortalNetwork(undefined, '8.8.8.8')).toEqual({ allowed: true, reason: 'any' });
    expect(checkPortalNetwork({ mode: 'any', cidrs: [] }, '8.8.8.8')).toEqual({ allowed: true, reason: 'any' });
    expect(checkPortalNetwork(list, '203.0.113.50')).toEqual({ allowed: true, reason: 'listed', matched: '203.0.113.0/24' });
    expect(checkPortalNetwork(list, '::ffff:10.1.1.1')).toEqual({ allowed: true, reason: 'listed', matched: '10.0.0.0/8' });
    expect(checkPortalNetwork(list, '8.8.8.8')).toEqual({ allowed: false, reason: 'not_listed' });
    expect(checkPortalNetwork(list, undefined)).toEqual({ allowed: false, reason: 'unknown_address' });
    expect(checkPortalNetwork(list, 'localhost')).toEqual({ allowed: false, reason: 'unknown_address' });
    expect(checkPortalNetwork({ mode: 'allow_list', cidrs: [] }, '10.0.0.1')).toEqual({ allowed: false, reason: 'not_listed' });
  });
});

describe('the TypeScript answer and the engine agree', () => {
  const principal = userPrincipal({ userId: 'parity-user', user: { role: 'user' } });
  const ranges = [
    '10.0.0.0/8', '172.16.0.0/12', '192.168.1.7', '203.0.113.64/26', '0.0.0.0/32', '255.255.255.255/32',
    '2001:db8::/32', 'fd00::/8', '::1', '2001:db8:abcd::/48',
  ];
  const addresses = [
    '10.0.0.0', '10.255.255.255', '11.0.0.0', '172.15.255.255', '172.16.0.1', '172.31.255.255', '172.32.0.0',
    '192.168.1.7', '192.168.1.6', '203.0.113.63', '203.0.113.64', '203.0.113.127', '203.0.113.128', '0.0.0.0', '255.255.255.255',
    '8.8.8.8', '1.1.1.1', '127.0.0.1',
    '2001:db8::1', '2001:db8:ffff:ffff::1', '2001:db9::1', 'fd12:3456::1', 'fe80::1', '::1', '::2', '2001:db8:abcd:1::5', '2001:db8:abce::1',
  ];

  it('for every address against every single range and against the whole list', () => {
    const managed = ensureManagedPolicySet();
    expect(managed.ok).toBe(true);
    if (!managed.ok) return;
    const decide = (cidrs: string[], ip: string): boolean => {
      // A listed person, so the access list is not what refuses: only the boundary can.
      const portal = { id: 'P', key: 'p', access: { mode: 'selected' as const, userIds: [principal.userId], groupIds: [], networks: { mode: 'allow_list' as const, cidrs } } };
      const { call } = buildAuthorizeCall(
        { tenant: 'iam-parity', principal, action: 'portal.use', resource: portalResource(portal), context: { channel: 'portal', ip } },
        'iam-parity',
      );
      const decision = statefulIsAuthorized({ ...call, policySetId: managed.setId });
      if (!decision.ok) throw new Error(decision.errors.join('; '));
      expect(decision.errors).toEqual([]);
      return decision.allowed;
    };
    for (const cidr of ranges) {
      for (const ip of addresses) {
        expect(decide([cidr], ip), `${ip} in ${cidr}`).toBe(checkPortalNetwork({ mode: 'allow_list', cidrs: [cidr] }, ip).allowed);
      }
    }
    for (const ip of addresses) {
      expect(decide(ranges, ip), `${ip} in the whole list`).toBe(checkPortalNetwork({ mode: 'allow_list', cidrs: ranges }, ip).allowed);
    }
  });
});
