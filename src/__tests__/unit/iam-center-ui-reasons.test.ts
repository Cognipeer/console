/**
 * The pure parts behind the IAM center's plain-words screens: the "decided by"
 * list of an access check (what a built-in policy id stands for, where its
 * setting is changed), the warnings about a rule that can never match, and the
 * numbers of the overview.
 */

import { describe, expect, it } from 'vitest';
import { IamApiError } from '@/components/iam/api';
import { localizedErrorMessage } from '@/components/iam/useErrorText';
import { messages } from '@/lib/i18n/messages';
import {
  hasProjectLimit,
  parseBuiltInReason,
  projectLimitFrom,
  reasonLink,
} from '@/components/iam/check/reasonModel';
import { memberHref, projectMembersHref, TOKENS_HREF } from '@/components/iam/links';
import { INERT_WARNING_CODES, isInertWarning, splitWarnings } from '@/components/iam/policies/issues';
import {
  countLabel,
  countPolicies,
  formatMicros,
  formatRate,
  policyIdOfCedarId,
  skippedPolicies,
} from '@/components/iam/overview/overviewModel';
import { listManagedPolicies } from '@/lib/iam/managedPolicies';
import type { PolicyRow, SimulateReason } from '@/components/iam/api';

const reason = (cedarId: string, managed = true): SimulateReason => ({
  cedarId,
  policyId: null,
  managed,
  name: cedarId,
  effect: cedarId.includes('boundary') ? 'forbid' : 'permit',
});

describe('parseBuiltInReason', () => {
  it('knows what each built-in policy stands for', () => {
    expect(parseBuiltInReason('managed:rbac:user-read')).toEqual({ kind: 'role', level: 'read' });
    expect(parseBuiltInReason('managed:rbac:user-write')).toEqual({ kind: 'role', level: 'write' });
    expect(parseBuiltInReason('managed:rbac:user-admin')).toEqual({ kind: 'role', level: 'admin' });
    expect(parseBuiltInReason('managed:rbac:token-write')).toEqual({ kind: 'tokenOwner', level: 'write' });
    expect(parseBuiltInReason('managed:boundary:project-read')).toEqual({ kind: 'projectLimit', level: 'read' });
    expect(parseBuiltInReason('managed:boundary:project-admin')).toEqual({ kind: 'projectLimit', level: 'admin' });
    expect(parseBuiltInReason('managed:boundary:token-cap-write')).toEqual({ kind: 'tokenScope', level: 'write' });
  });

  it('classifies every built-in policy the engine ships (none falls through to "other")', () => {
    const ids = listManagedPolicies().map((p) => p.id);
    expect(ids.length).toBe(18);
    for (const id of ids) {
      const parsed = parseBuiltInReason(id);
      expect(parsed.kind, id).not.toBe('other');
      // a portal rule is not about a level: it is the portal's access list; an approval rule is the session's owner and the agent's setting
      if (id.startsWith('managed:portal:') || id.startsWith('managed:agent:')) expect(parsed.level, id).toBeNull();
      else expect(parsed.level, id).not.toBeNull();
    }
  });

  it('knows the portal rules: the access list admits, or nothing else can', () => {
    expect(parseBuiltInReason('managed:portal:use')).toEqual({ kind: 'portalList', level: null });
    expect(parseBuiltInReason('managed:portal:agent')).toEqual({ kind: 'portalList', level: null });
    expect(parseBuiltInReason('managed:portal:use-boundary')).toEqual({ kind: 'portalBoundary', level: null });
    expect(parseBuiltInReason('managed:portal:agent-boundary')).toEqual({ kind: 'portalBoundary', level: null });
    expect(parseBuiltInReason('managed:portal:something-new')).toEqual({ kind: 'other', level: null });
  });

  it('knows the approval rules: the session\'s owner and the agent\'s setting appoint', () => {
    expect(parseBuiltInReason('managed:agent:approve')).toEqual({ kind: 'approvalRule', level: null });
    expect(parseBuiltInReason('managed:agent:approve-token')).toEqual({ kind: 'approvalRule', level: null });
    expect(parseBuiltInReason('managed:agent:approve-boundary')).toEqual({ kind: 'other', level: null }); // gone: approvals are appointed
    expect(parseBuiltInReason('managed:agent:something-new')).toEqual({ kind: 'other', level: null });
  });

  it('leaves an id it does not know as "other"', () => {
    expect(parseBuiltInReason('managed:rbac:something-new')).toEqual({ kind: 'other', level: null });
    expect(parseBuiltInReason('custom:p1')).toEqual({ kind: 'other', level: null });
  });

  it('spots a project limit among the reasons', () => {
    expect(hasProjectLimit([reason('managed:rbac:user-read'), reason('managed:boundary:project-write')])).toBe(true);
    expect(hasProjectLimit([reason('managed:rbac:user-read')])).toBe(false);
    // a custom policy that merely carries a similar id is not a project limit
    expect(hasProjectLimit([reason('custom:managed:boundary:project-read', false)])).toBe(false);
    expect(hasProjectLimit([])).toBe(false);
  });
});

describe('where a built-in setting is changed', () => {
  it('a person: where their access is changed, or the project member editor for a project limit', () => {
    expect(reasonLink('role', { type: 'user', id: 'u 1' }, 'p1')).toEqual({ labelKey: 'member', href: memberHref('u 1') });
    expect(reasonLink('projectLimit', { type: 'user', id: 'u1' }, 'p-alpha')).toEqual({
      labelKey: 'projectMember',
      href: '/dashboard/projects/p-alpha?member=u1',
    });
  });

  it('a token: the tokens page; a project limit of a token opens the project', () => {
    expect(reasonLink('role', { type: 'token', id: 't1' }, null)).toEqual({ labelKey: 'token', href: TOKENS_HREF });
    expect(reasonLink('tokenOwner', { type: 'token', id: 't1' }, null)).toEqual({ labelKey: 'token', href: TOKENS_HREF });
    expect(reasonLink('tokenScope', { type: 'token', id: 't1' }, 'p1')).toEqual({ labelKey: 'token', href: TOKENS_HREF });
    expect(reasonLink('projectLimit', { type: 'token', id: 't1' }, 'p1')).toEqual({
      labelKey: 'project',
      href: '/dashboard/projects/p1',
    });
  });

  it('has nowhere to send you for a project limit without a project, or an unknown reason', () => {
    expect(reasonLink('projectLimit', { type: 'user', id: 'u1' }, null)).toBeNull();
    expect(reasonLink('other', { type: 'user', id: 'u1' }, 'p1')).toBeNull();
  });

  it('a portal rule leads to the portal, where its access list is edited', () => {
    const who = { type: 'user', id: 'u1' } as const;
    expect(reasonLink('portalBoundary', who, null, 'P 1')).toEqual({ labelKey: 'portal', href: '/dashboard/portals/P%201' });
    expect(reasonLink('portalList', who, 'p1', 'P1')).toEqual({ labelKey: 'portal', href: '/dashboard/portals/P1' });
    expect(reasonLink('portalBoundary', who, null)).toBeNull();
  });

  it('builds the outside links', () => {
    expect(memberHref('a/b')).toContain(encodeURIComponent('a/b'));
    expect(projectMembersHref('p1')).toBe('/dashboard/projects/p1');
    expect(projectMembersHref('p1', 'u 2')).toBe('/dashboard/projects/p1?member=u%202');
    expect(projectMembersHref('p1', null)).toBe('/dashboard/projects/p1');
  });
});

describe('projectLimitFrom', () => {
  const effective = [
    { service: 'models', sources: [{ kind: 'role', label: 'user', level: 'write' }, { kind: 'project', label: 'Retail', level: 'read' }] },
    { service: 'agents', sources: [{ kind: 'role', label: 'user', level: 'write' }] },
    { service: 'tools', sources: [{ kind: 'project', label: 'Retail', level: 'none' }] },
    { service: 'files', sources: [{ kind: 'project', label: 'Retail', level: 'bogus' }] },
  ];

  it('reads the limit the project sets for the service, with the project name', () => {
    expect(projectLimitFrom(effective, 'models')).toEqual({ level: 'read', projectName: 'Retail' });
    expect(projectLimitFrom(effective, 'tools')).toEqual({ level: 'none', projectName: 'Retail' });
  });

  it('is null when the project does not limit the service, or the service is unknown', () => {
    expect(projectLimitFrom(effective, 'agents')).toBeNull();
    expect(projectLimitFrom(effective, 'nope')).toBeNull();
    expect(projectLimitFrom([], 'models')).toBeNull();
  });

  it('reads an unknown level as no access', () => {
    expect(projectLimitFrom(effective, 'files')).toEqual({ level: 'none', projectName: 'Retail' });
  });
});

describe('warnings about a rule that can never match', () => {
  it('knows the codes the compiler uses', () => {
    expect(INERT_WARNING_CODES).toEqual(['not_enforced_actions', 'not_enforced_resources', 'not_enforced_channel', 'not_asked_actions']);
    for (const code of INERT_WARNING_CODES) expect(isInertWarning({ code, message: 'x' })).toBe(true);
  });

  it('a rule that works in part is advice, not an alarm', () => {
    for (const code of ['partly_not_asked_actions', 'partly_enforced_actions', 'admin_checked_as_write', 'trusted_proxies_unset']) {
      expect(isInertWarning({ code, message: 'x' }), code).toBe(false);
    }
  });

  it('reads the compiler\'s plain English when a warning has no code', () => {
    expect(isInertWarning({ message: 'None of the selected actions belongs to the selected services, so this policy will never apply.' })).toBe(true);
    expect(isInertWarning({ message: 'Something worth a look' })).toBe(false);
  });

  it('splits a list into the loud ones and the rest, keeping their order', () => {
    const list = [
      { code: 'trusted_proxies_unset', message: 'a' },
      { code: 'not_asked_actions', message: 'b' },
      { message: 'c' },
      { code: 'not_enforced_resources', message: 'd' },
    ];
    const { inert, other } = splitWarnings(list);
    expect(inert.map((w) => w.message)).toEqual(['b', 'd']);
    expect(other.map((w) => w.message)).toEqual(['a', 'c']);
    expect(splitWarnings([])).toEqual({ inert: [], other: [] });
  });
});

describe('overview figures', () => {
  const row = (patch: Partial<PolicyRow>): PolicyRow => ({
    policyId: 'p',
    name: 'P',
    description: '',
    effect: 'permit',
    enabled: true,
    spec: null,
    cedar: '',
    statementCount: 1,
    createdAt: '',
    updatedAt: '',
    updatedBy: '',
    updatedByLabel: '',
    ...patch,
  });

  it('counts enabled and disabled policies and the rules they add', () => {
    expect(countPolicies([])).toEqual({ total: 0, enabled: 0, disabled: 0, allowRules: 0, denyRules: 0 });
    const counts = countPolicies([
      row({ policyId: 'a', effect: 'permit' }),
      row({ policyId: 'b', effect: 'forbid' }),
      row({ policyId: 'c', effect: 'forbid', enabled: false }),
      row({ policyId: 'd', effect: 'mixed' }),
    ]);
    // a disabled policy adds no rule; a mixed one adds both kinds
    expect(counts).toEqual({ total: 4, enabled: 3, disabled: 1, allowRules: 2, denyRules: 2 });
  });

  it('turns the statement ids of the engine into the policies behind them', () => {
    expect(policyIdOfCedarId('custom:p-abc#2')).toBe('p-abc');
    expect(policyIdOfCedarId('custom:p-abc')).toBe('p-abc');
    expect(policyIdOfCedarId('managed:rbac:user-read')).toBeNull();
    const custom = [{ policyId: 'p-abc', name: 'Block exports' }];
    expect(skippedPolicies(['custom:p-abc#0', 'custom:p-abc#1', 'custom:p-gone#0', 'managed:x'], custom)).toEqual([
      { policyId: 'p-abc', name: 'Block exports' },
      { policyId: 'p-gone', name: 'p-gone' },
    ]);
  });

  it('says "N+" when a directory count came from a full page', () => {
    expect(countLabel(12, false, 'en')).toBe('12');
    expect(countLabel(100, true, 'en')).toBe('100+');
    expect(countLabel(1500, true, 'en')).toBe('1,500+');
  });

  it('formats latency and rates, with a dash when the server has none', () => {
    expect(formatMicros(null)).toBe('—');
    expect(formatMicros(420.4)).toBe('420 µs');
    expect(formatMicros(1500)).toBe('1.50 ms');
    expect(formatRate(null)).toBe('—');
    expect(formatRate(0.874)).toBe('87%');
  });
});

describe('the words for the errors the center can meet', () => {
  const lookup = (locale: 'en' | 'tr') => (key: string): string | undefined => {
    let node: unknown = messages[locale];
    for (const part of key.split('.')) node = typeof node === 'object' && node !== null ? (node as Record<string, unknown>)[part] : undefined;
    return typeof node === 'string' ? node : undefined;
  };

  it('a delegated admin who may not turn an allow rule on is told so without mentioning a monitor mode', () => {
    const error = new IamApiError('English from the server', 403, 'permit_requires_admin');
    const en = localizedErrorMessage(error, lookup('en'));
    expect(en).toContain('Only workspace owners and admins can turn on a rule that allows access');
    expect(en).toContain('Save it as disabled');
    expect(en).not.toMatch(/monitor/i);
    const tr = localizedErrorMessage(error, lookup('tr'));
    expect(tr).toContain('Devre dışı olarak kaydedin');
    expect(tr).not.toMatch(/izleme|gözlem/i);
  });

  it('an engine that could not decide is said as such (HTTP 503)', () => {
    const error = new IamApiError('Authorization is temporarily unavailable', 503, 'authorization_unavailable');
    expect(localizedErrorMessage(error, lookup('en'))).toBe('Authorization is temporarily unavailable, so the request was not decided. Try again in a moment');
    expect(localizedErrorMessage(error, lookup('tr'))).toContain('Yetkilendirme geçici olarak kullanılamıyor');
  });

  it('keeps the server\'s own text for a code it has no words for, and for a validation error', () => {
    expect(localizedErrorMessage(new IamApiError('Something odd', 500, 'brand_new_code'), lookup('en'))).toBe('Something odd');
    const validation = new IamApiError('The policy is not valid', 400, 'validation', [{ message: 'unknown group' }]);
    expect(localizedErrorMessage(validation, lookup('en'))).toBe('unknown group');
  });
});
