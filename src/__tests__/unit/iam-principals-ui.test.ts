import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { I18nProvider, useTranslations } from '@/lib/i18n';
import { theme } from '@/theme/theme';
import AttachedPolicies from '@/components/iam/principals/AttachedPolicies';
import EffectivePermissions, { sourceDetail } from '@/components/iam/principals/EffectivePermissions';
import {
  PrincipalDetailView,
  type PrincipalDetailViewProps,
} from '@/components/iam/principals/PrincipalDetailDrawer';
import {
  parsePrincipalDetail,
  type AttachedPolicy,
  type PrincipalDetail,
  type PrincipalSummary,
} from '@/components/iam/principals/client';

// DataGrid (and the tabs) read the Next.js router; there is none in a static render.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {}, back: () => {}, forward: () => {}, refresh: () => {} }),
  usePathname: () => '/dashboard/iam',
  useSearchParams: () => new URLSearchParams(),
}));

type Locale = 'en' | 'tr';

// The provider's props require `children`; createElement passes them as its third argument.
const Provider = I18nProvider as React.ComponentType<{ locale?: Locale; children?: React.ReactNode }>;

/** Renders a component that needs the namespaced translator, inside the providers of the app. */
function render(
  locale: Locale,
  build: (t: PrincipalDetailViewProps['t']) => React.ReactElement,
): string {
  function Harness() {
    const t = useTranslations('iamPrincipals');
    return build(t);
  }
  return renderToStaticMarkup(
    React.createElement(
      MantineProvider,
      { theme, env: 'test' },
      React.createElement(Provider, { locale }, React.createElement(Harness)),
    ),
  );
}

const labelOf = (service: string) => ({ models: 'Model Hub', members: 'Members', tokens: 'API Tokens' })[service] ?? service;

const ada: PrincipalSummary = {
  type: 'user',
  id: 'u1',
  label: 'Ada Lovelace',
  sublabel: 'ada@example.com',
  role: 'admin',
  status: 'active',
  memberCount: null,
  policyCount: 1,
};

const detail: PrincipalDetail = parsePrincipalDetail(
  {
    principal: ada,
    effective: [
      {
        service: 'models',
        level: 'write',
        sources: [
          { kind: 'role', label: 'admin', level: 'write' },
          { kind: 'group', label: 'Engineering', level: 'write' },
          { kind: 'project', label: 'Platform', level: 'read' },
          { kind: 'mystery', label: 'x', level: 'read' },
        ],
      },
      { service: 'tokens', level: 'read', sources: [{ kind: 'token-scope', label: 'scoped', level: 'read' }] },
      { service: 'members', level: 'none', sources: [] },
    ],
    groups: [{ id: 'g1', name: 'Engineering' }],
    projects: [{ id: 'p1', name: 'Platform', role: 'project_admin' }],
    policies: [
      {
        policyId: 'pol-1',
        name: 'Block exports',
        description: 'No exports at night',
        effect: 'forbid',
        enabled: true,
        spec: { principals: { groups: ['g1'], users: ['u1'] } },
      },
      { policyId: 'pol-2', name: 'Raw rule', effect: 'mixed', enabled: false, spec: null },
    ],
    tokens: [{ type: 'token', id: 't1', label: 'CI pipeline', sublabel: 'cp_8f2a…', status: 'active', policyCount: 1 }],
  },
  'user',
  'u1',
);

function viewProps(patch: Partial<PrincipalDetailViewProps> = {}) {
  return (t: PrincipalDetailViewProps['t']): PrincipalDetailViewProps => ({
    summary: ada,
    detail,
    loading: false,
    error: null,
    projectId: '',
    canManage: true,
    locale: 'en',
    labelOf,
    t,
    onProjectChange: () => {},
    onRetry: () => {},
    onOpen: () => {},
    ...patch,
  });
}

const view = (locale: Locale, patch: Partial<PrincipalDetailViewProps> = {}) =>
  render(locale, (t) => React.createElement(PrincipalDetailView, viewProps(patch)(t)));

// These render whole component trees (jsdom + Mantine) or run the policy engine; on a busy machine the default 5 s is too tight.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

describe('PrincipalDetailView', () => {
  it('renders the identity, the actions and every section for a user', () => {
    const html = view('en');
    expect(html).toContain('Ada Lovelace');
    expect(html).toContain('ada@example.com');
    expect(html).toContain('Admin'); // role badge
    expect(html).toContain('Active');
    expect(html).toContain('Effective permissions');
    expect(html).toContain('Groups');
    expect(html).toContain('Projects');
    expect(html).toContain('Attached policies');
    expect(html).toContain('CI pipeline');
    // actions: deep links of the other tabs
    expect(html).toContain('href="/dashboard/iam?tab=check&amp;principalType=user&amp;principalId=u1"');
    expect(html).toContain('href="/dashboard/iam?tab=policies&amp;new=1&amp;principalType=user&amp;principalId=u1"');
    expect(html).toContain('href="/dashboard/iam?tab=audit&amp;principalType=user&amp;principalId=u1"');
    expect(html).toContain('href="/dashboard/members/u1"');
  });

  it('shows services with their labels, levels and source chips, and hides the ones without access', () => {
    const html = view('en');
    expect(html).toContain('Model Hub');
    expect(html).toContain('API Tokens');
    expect(html).not.toContain('>Members</'); // level none: hidden by default (the "With access" chip is on)
    expect(html).toContain('Role: Admin'); // the role is shown in the user's language
    expect(html).toContain('Group: Engineering');
    expect(html).toContain('Project: Platform');
    expect(html).toContain('Token scope: scoped');
    // an unknown source kind from a newer server still renders
    expect(html).toContain('Other: x');
    expect(html).toContain('data-source-kind="mystery"');
    // filter chips with counts
    expect(html).toContain('With access (2)');
    expect(html).toContain('No access (1)');
  });

  it('hides "Create policy" without iam admin', () => {
    expect(view('en', { canManage: false })).not.toContain('Create policy');
    expect(view('en', { canManage: true })).toContain('Create policy');
  });

  it('offers no simulation for a group and no member page, but its audit trail (the denials of its members)', () => {
    const group: PrincipalSummary = {
      type: 'group',
      id: 'g1',
      label: 'Engineering',
      sublabel: null,
      role: null,
      status: null,
      memberCount: 42,
      policyCount: 0,
    };
    const html = view('en', { summary: group, detail: { ...detail, principal: group, groups: [], tokens: null } });
    expect(html).toContain('Engineering');
    expect(html).toContain('Members: 42');
    expect(html).not.toContain('Simulate access');
    expect(html).not.toContain('Open in Members');
    expect(html).toContain('href="/dashboard/iam?tab=audit&amp;principalType=group&amp;principalId=g1"');
    // a group still gets a policy
    expect(html).toContain('Create policy');
    expect(html).toContain('principalType=group');
  });

  it('shows the owned tokens of a user only', () => {
    expect(view('en')).toContain('API tokens');
    const token: PrincipalSummary = { ...ada, type: 'token', id: 't1', label: 'CI pipeline', role: null };
    const html = view('en', { summary: token, detail: { ...detail, principal: token } });
    expect(html).not.toContain('Tokens this user owns');
  });

  it('shows a skeleton while loading and the error with a retry when the load failed', () => {
    const loading = view('en', { detail: null, loading: true });
    expect(loading).toContain('Ada Lovelace'); // the row it was opened from
    expect(loading).toContain('aria-busy="true"');
    expect(loading).not.toContain('Effective permissions');

    const failed = view('en', { detail: null, loading: false, error: 'Boom' });
    expect(failed).toContain('Could not load the details');
    expect(failed).toContain('Boom');
    expect(failed).toContain('Try again');
  });

  it('offers the project context only when the principal has projects', () => {
    expect(view('en')).toContain('Whole workspace (no project)');
    expect(view('en', { detail: { ...detail, projects: [] } })).not.toContain('Whole workspace (no project)');
    expect(view('en', { projectId: 'p1' })).toContain('Project settings narrow access');
  });

  it('renders in Turkish', () => {
    const html = view('tr');
    expect(html).toContain('Etkin izinler');
    expect(html).toContain('Erişimi simüle et');
    expect(html).toContain('Politika oluştur');
    expect(html).toContain('Erişimi olan (2)');
    expect(html).not.toContain('Effective permissions');
  });

  it('keeps an unknown role or status as sent', () => {
    const html = view('en', { summary: { ...ada, role: 'auditor', status: 'suspended' } });
    expect(html).toContain('auditor');
    expect(html).toContain('suspended');
  });
});

describe('PrincipalDetailView for a token and a group', () => {
  const tokenDetail: PrincipalDetail = parsePrincipalDetail(
    {
      principal: {
        type: 'token',
        id: 't1',
        label: 'CI pipeline',
        sublabel: 'cp_8f2a…',
        role: 'admin',
        status: 'active',
        ownerId: 'u1',
        ownerLabel: 'Ada Lovelace',
        scope: { models: 'read' },
        expiresAt: null,
        lastUsedAt: null,
      },
      effective: [{ service: 'models', level: 'read', sources: [{ kind: 'token-scope', label: 'Token scope', level: 'read' }] }],
      groups: [{ id: 'g1', name: 'Engineering' }],
      policies: [{ policyId: 'pol-1', name: 'Owner rule', effect: 'forbid', enabled: true, spec: { principals: { users: ['u1'] } } }],
      tokens: null,
    },
    'token',
    't1',
  );

  it('names the owner, the scope and the expiry, and does not show the owner\'s role as the token\'s', () => {
    const html = view('en', { summary: tokenDetail.principal, detail: tokenDetail });
    expect(html).toContain('API token');
    expect(html).toContain('Owner');
    expect(html).toContain('Ada Lovelace');
    expect(html).toContain('Scoped');
    expect(html).toContain('Does not expire');
    expect(html).toContain('Never used');
    expect(html).not.toContain('>Admin<'); // the owner is an admin, the token is not a role holder
    // a policy naming the owner reaches the token through its owner
    expect(html).toContain('Via the token owner');
    // a token has no member page; its audit trail and simulation are offered
    expect(html).not.toContain('Open in Members');
    expect(html).toContain('href="/dashboard/iam?tab=check&amp;principalType=token&amp;principalId=t1"');
    expect(html).toContain('href="/dashboard/iam?tab=audit&amp;principalType=token&amp;principalId=t1"');
  });

  it('shows an unscoped token as such', () => {
    const unscoped = parsePrincipalDetail({ principal: { type: 'token', id: 't1', label: 'x', scope: null } }, 'token', 't1');
    expect(view('en', { summary: unscoped.principal, detail: unscoped })).toContain('Unscoped');
  });

  it('shows what a directory group and an LDAP user are', () => {
    const group = parsePrincipalDetail(
      { principal: { type: 'group', id: 'g1', label: 'Eng', memberCount: 4, source: 'ldap', tenantRole: 'admin' } },
      'group',
      'g1',
    );
    const groupHtml = view('en', { summary: group.principal, detail: group });
    expect(groupHtml).toContain('Directory group');
    expect(groupHtml).toContain('Every member gets the Admin role');

    const user = parsePrincipalDetail(
      { principal: { type: 'user', id: 'u1', label: 'Ada', role: 'user', authProvider: 'ldap', canLogin: false } },
      'user',
      'u1',
    );
    const userHtml = view('en', { summary: user.principal, detail: user });
    expect(userHtml).toContain('LDAP');
    expect(userHtml).toContain('Cannot sign in');
  });

  it('says how a project was reached and folds a long list', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, name: `Project ${i}`, role: 'project_admin', via: 'implicit' }));
    const d = parsePrincipalDetail({ principal: ada, projects: many }, 'user', 'u1');
    const html = view('en', { detail: d });
    expect(html).toContain('Every project (owner and admins)');
    // 12 projects, 8 rows shown (the project picker lists all of them, so count the rows by their "via" line)
    expect(html.match(/Every project \(owner and admins\)/g)).toHaveLength(8);
    expect(html).toContain('Show all (12)');

    const viaGroup = parsePrincipalDetail(
      { principal: ada, projects: [{ id: 'p1', name: 'Prod', role: 'member', via: 'group', groupName: 'Engineering' }] },
      'user',
      'u1',
    );
    expect(view('en', { detail: viaGroup })).toContain('Via group Engineering');
  });

  it('lists the owned tokens with their prefix, last use and scope', () => {
    const d = parsePrincipalDetail(
      {
        principal: ada,
        tokens: [{ id: 't1', label: 'CI pipeline', prefix: 'cp_8f2a', scoped: true, status: 'expired', expiresAt: '2026-01-01T00:00:00.000Z', lastUsedAt: null }],
      },
      'user',
      'u1',
    );
    const html = view('en', { detail: d });
    expect(html).toContain('cp_8f2a…');
    expect(html).toContain('Never used');
    expect(html).toContain('Expired');
    expect(html).toContain('Scoped');
  });
});

describe('source chips', () => {
  const t = (key: string) => `ns.${key}`;
  const names = new Map([['pol-1', 'Block exports']]);
  const src = (kind: string, label: string) => ({ kind, label, level: null });

  it('says nothing after the kind when the server only repeated it', () => {
    expect(sourceDetail(src('direct', 'Direct permission'), names, t)).toBe('');
    expect(sourceDetail(src('token-scope', 'Token scope'), names, t)).toBe('');
    expect(sourceDetail(src('project', 'Project'), names, t)).toBe('');
    expect(sourceDetail(src('policy', 'Custom policy'), names, t)).toBe('');
    expect(sourceDetail(src('role', ''), names, t)).toBe('');
  });

  it('keeps the names the server gave', () => {
    expect(sourceDetail(src('group', 'Engineering'), names, t)).toBe('Engineering');
    expect(sourceDetail(src('project', 'Platform'), names, t)).toBe('Platform');
  });

  it('turns policy ids into policy names and leaves unknown ids alone', () => {
    expect(sourceDetail(src('policy', 'pol-1'), names, t)).toBe('Block exports');
    expect(sourceDetail(src('policy', 'pol-1, pol-9'), names, t)).toBe('Block exports, pol-9');
  });

  it('shows a role in the user\'s language and an unknown role as sent', () => {
    // `t` echoes the namespaced key for a missing message, which translateOr treats as "missing"
    const tr = (key: string) => (key === 'roles.admin' ? 'Yönetici' : `iamPrincipals.${key}`);
    expect(sourceDetail(src('role', 'admin'), names, tr)).toBe('Yönetici');
    expect(sourceDetail(src('role', 'auditor'), names, tr)).toBe('auditor');
  });
});

describe('EffectivePermissions', () => {
  it('says so when the principal has no access at all, and lists everything instead', () => {
    const rows = [
      { service: 'models', level: 'none' as const, sources: [] },
      { service: 'tokens', level: 'none' as const, sources: [] },
    ];
    const html = render('en', (t) => React.createElement(EffectivePermissions, { rows, labelOf, policyNames: new Map(), t }));
    // with nothing to use, the default view shows every service rather than an empty table
    expect(html).toContain('Model Hub');
    expect(html).toContain('API Tokens');
    expect(html).toContain('No access');
  });

  it('is empty-safe', () => {
    const html = render('en', (t) => React.createElement(EffectivePermissions, { rows: [], labelOf, policyNames: new Map(), t }));
    expect(html).toContain('This principal has no access to any service.');
  });
});

describe('AttachedPolicies', () => {
  const policy = (patch: Partial<AttachedPolicy>): AttachedPolicy => ({
    policyId: 'p',
    name: 'Policy',
    description: '',
    effect: 'permit',
    enabled: true,
    principals: { any: false, anyUser: false, anyToken: false, users: [], groups: [], tokens: [] },
    updatedAt: null,
    ...patch,
  });

  const renderPolicies = (policies: AttachedPolicy[], principal = { type: 'user' as const, id: 'u1' }) =>
    render('en', (t) =>
      React.createElement(AttachedPolicies, {
        policies,
        principal,
        groups: [{ id: 'g1', name: 'Engineering' }],
        t,
      }),
    );

  it('says when nothing applies', () => {
    expect(renderPolicies([])).toContain('No custom policy applies to this principal.');
  });

  it('explains why a policy applies and links to its editor', () => {
    const html = renderPolicies([
      policy({
        policyId: 'pol 1',
        name: 'Block exports',
        effect: 'forbid',
        principals: { any: false, anyUser: false, anyToken: false, users: ['u1'], groups: ['g1'], tokens: [] },
      }),
    ]);
    expect(html).toContain('Block exports');
    expect(html).toContain('Deny');
    expect(html).toContain('Named in the policy');
    expect(html).toContain('Via group Engineering');
    // A policy is enabled or disabled: there is no mode badge and no "would deny" counter any more.
    expect(html).not.toContain('Monitor');
    expect(html).not.toContain('Enforced');
    expect(html).not.toContain('would be denied');
    expect(html).toContain('href="/dashboard/iam?tab=policies&amp;policyId=pol+1"');
  });

  it('marks disabled, raw and everyone policies', () => {
    const html = renderPolicies([
      policy({ policyId: 'a', name: 'Raw rule', principals: null, enabled: false, effect: 'mixed' }),
      policy({ policyId: 'b', name: 'For all', principals: { any: true, anyUser: false, anyToken: false, users: [], groups: [], tokens: [] } }),
    ]);
    expect(html).toContain('Disabled');
    expect(html).toContain('Cedar policy');
    expect(html).toContain('Mixed');
    expect(html).toContain('Everyone');
  });

});

describe('the tabs render their first frame', () => {
  // No effects run in a static render: this is the loading state, which also proves the tabs
  // survive being rendered outside the Next.js router (no search params).
  it('Principals: segments, search box and a skeleton, in both languages', async () => {
    const { default: PrincipalsTab } = await import('@/components/iam/principals/PrincipalsTab');
    const en = render('en', () => React.createElement(PrincipalsTab, { canManage: true }));
    expect(en).toContain('Users');
    expect(en).toContain('Groups');
    expect(en).toContain('API tokens');
    expect(en).toContain('Search users by name or email…');
    expect(en).toContain('aria-busy="true"');
    const tr = render('tr', () => React.createElement(PrincipalsTab, { canManage: false }));
    expect(tr).toContain('Kullanıcılar');
    expect(tr).toContain('Kullanıcıları ad veya e-postayla arayın…');
  });

  it('Audit: views, filters and the export button, in both languages', async () => {
    const { default: AuditTab } = await import('@/components/iam/audit/AuditTab');
    const en = render('en', () => React.createElement(AuditTab));
    expect(en).toContain('Denials');
    expect(en).toContain('Policy changes');
    // The monitor view is gone ("Model Monitoring" in the service list is a different thing).
    expect(en).not.toMatch(/>Monitor</);
    expect(en).toContain('Export CSV');
    expect(en).toContain('Date range');
    expect(en).toContain('Last 30 days'); // denials without a date range look 30 days back
    expect(en).toContain('Service');
    const tr = render('tr', () => React.createElement(AuditTab));
    expect(tr).toContain('Reddedilenler');
    expect(tr).toContain('CSV olarak dışa aktar');
  });
});
