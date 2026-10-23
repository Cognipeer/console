// @vitest-environment jsdom
/**
 * The IAM trail of the breadcrumb (IAM / People / <name>, IAM / Policies / <name>): every crumb
 * leads to a page that exists. `/dashboard/iam/principals`, `/principals/<type>` and
 * `/policies` are folders (they redirect to the tabs of the center), and the generic trail
 * never links a folder known to have no page.
 */

import { createElement } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installDomStubs, mount, settle, text, type Mounted } from '../helpers/iamCenterUi';

const nav = vi.hoisted(() => ({ pathname: '/dashboard' }));
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import DashboardBreadcrumbs from '@/components/layout/DashboardBreadcrumbs';
import { BREADCRUMB_RESOLVERS } from '@/components/layout/breadcrumbResolvers';
import { hasNoPage, iamCrumbPlan } from '@/components/layout/iamBreadcrumbs';
import { policiesListHref, principalsListHref } from '@/components/iam/links';
import {
  LAST_LIST_URL_KEY,
  lastListUrlFor,
  readLastListUrl,
  sanitizeLastListUrl,
  writeLastListUrl,
} from '@/components/iam/principals/lastList';

const seg = (path: string) => path.split('/').filter(Boolean);

describe('redirect targets of the pageless IAM addresses', () => {
  it('sends /principals to the principals tab and /principals/<type> to that kind', () => {
    expect(principalsListHref()).toBe('/dashboard/iam?tab=principals');
    expect(principalsListHref('user')).toBe('/dashboard/iam?tab=principals&principalType=user');
    expect(principalsListHref('group')).toBe('/dashboard/iam?tab=principals&principalType=group');
    expect(principalsListHref('token')).toBe('/dashboard/iam?tab=principals&principalType=token');
  });
  it('sends an unknown kind to the plain tab', () => {
    expect(principalsListHref('robot')).toBe('/dashboard/iam?tab=principals');
    expect(principalsListHref('')).toBe('/dashboard/iam?tab=principals');
  });
  it('sends /policies to the policies tab', () => {
    expect(policiesListHref()).toBe('/dashboard/iam?tab=policies');
  });
});

describe('iamCrumbPlan', () => {
  it('is not an IAM trail outside the center', () => {
    expect(iamCrumbPlan(seg('/dashboard/models/abc'))).toBeNull();
    expect(iamCrumbPlan(seg('/dashboard'))).toBeNull();
    expect(iamCrumbPlan(seg('/other/iam'))).toBeNull();
  });

  it('is Dashboard / IAM on the center itself', () => {
    expect(iamCrumbPlan(seg('/dashboard/iam'))).toEqual([
      { segmentIndex: 0, href: '/dashboard' },
      { segmentIndex: 1, href: null },
    ]);
  });

  it('is IAM / People / <name> on a person, People leading to the people list', () => {
    expect(iamCrumbPlan(seg('/dashboard/iam/principals/user/u1'))).toEqual([
      { segmentIndex: 0, href: '/dashboard' },
      { segmentIndex: 1, href: '/dashboard/iam' },
      { segmentIndex: 3, label: 'people', href: '/dashboard/iam?tab=principals&principalType=user' },
      { segmentIndex: 4, href: null },
    ]);
  });

  it('names groups and tokens by their kind', () => {
    expect(iamCrumbPlan(seg('/dashboard/iam/principals/group/g1'))?.[2]).toMatchObject({
      label: 'groups',
      href: '/dashboard/iam?tab=principals&principalType=group',
    });
    expect(iamCrumbPlan(seg('/dashboard/iam/principals/token/t1'))?.[2]).toMatchObject({ label: 'tokens' });
  });

  it('leads People back to the remembered list view of the same kind only', () => {
    const last = '/dashboard/iam?tab=principals&principalType=user&q=ayse&role=admin';
    expect(iamCrumbPlan(seg('/dashboard/iam/principals/user/u1'), last)?.[2].href).toBe(last);
    expect(iamCrumbPlan(seg('/dashboard/iam/principals/group/g1'), last)?.[2].href).toBe(
      '/dashboard/iam?tab=principals&principalType=group',
    );
  });

  it('never links the current crumb, and links no folder', () => {
    for (const path of [
      '/dashboard/iam/principals',
      '/dashboard/iam/principals/user',
      '/dashboard/iam/policies',
      '/dashboard/iam/principals/user/u1',
      '/dashboard/iam/policies/p1',
    ]) {
      const plan = iamCrumbPlan(seg(path))!;
      expect(plan[plan.length - 1].href, path).toBeNull();
      for (const item of plan) {
        if (item.href) expect(item.href, path).toMatch(/^\/dashboard(\/iam(\?tab=[a-z]+.*)?)?$|^\/dashboard\/iam\?tab=/);
      }
    }
  });

  it('is IAM / Policies / <name> on a policy', () => {
    expect(iamCrumbPlan(seg('/dashboard/iam/policies/p1'))).toEqual([
      { segmentIndex: 0, href: '/dashboard' },
      { segmentIndex: 1, href: '/dashboard/iam' },
      { segmentIndex: 2, label: 'policies', href: '/dashboard/iam?tab=policies' },
      { segmentIndex: 3, href: null },
    ]);
  });
});

describe('hasNoPage', () => {
  it('knows the folders without a page', () => {
    expect(hasNoPage(seg('/dashboard/redteam/campaigns/c1'), 2)).toBe(true);
    expect(hasNoPage(seg('/dashboard/redteam/campaigns/c1'), 3)).toBe(false);
    expect(hasNoPage(seg('/dashboard/models/m1'), 2)).toBe(false);
  });

  it('knows the dynamic folder without a page, not the static page beside it', () => {
    expect(hasNoPage(seg('/dashboard/vector/pinecone/idx-1'), 2)).toBe(true);
    expect(hasNoPage(seg('/dashboard/vector/pinecone/idx-1'), 3)).toBe(false);
    expect(hasNoPage(seg('/dashboard/vector/migrations/m1'), 2)).toBe(false);
    expect(hasNoPage(seg('/dashboard/prompt-optimizer/runs/r1'), 2)).toBe(true);
  });
});

describe('the remembered list view', () => {
  beforeEach(() => window.sessionStorage.clear());

  it('accepts only a same-origin principals-list address', () => {
    expect(sanitizeLastListUrl('/dashboard/iam?tab=principals&q=a')).toBe('/dashboard/iam?tab=principals&q=a');
    expect(sanitizeLastListUrl('/dashboard/iam?tab=policies')).toBeNull();
    expect(sanitizeLastListUrl('/dashboard/models?tab=principals')).toBeNull();
    expect(sanitizeLastListUrl('https://evil.example/dashboard/iam?tab=principals')).toBeNull();
    expect(sanitizeLastListUrl('//evil.example/dashboard/iam?tab=principals')).toBeNull();
    expect(sanitizeLastListUrl('javascript:alert(1)')).toBeNull();
    expect(sanitizeLastListUrl(null)).toBeNull();
    expect(sanitizeLastListUrl('')).toBeNull();
  });

  it('writes the list view without the form or person it had open, and reads it back', () => {
    writeLastListUrl('/dashboard/iam?tab=principals&principalType=group&q=ops&edit=role&new=1&principalId=x');
    expect(window.sessionStorage.getItem(LAST_LIST_URL_KEY)).toBe('/dashboard/iam?tab=principals&principalType=group&q=ops');
    expect(readLastListUrl()).toBe('/dashboard/iam?tab=principals&principalType=group&q=ops');
  });

  it('ignores an address that is not a list view and a poisoned storage value', () => {
    writeLastListUrl('/dashboard/iam?tab=audit');
    expect(window.sessionStorage.getItem(LAST_LIST_URL_KEY)).toBeNull();
    window.sessionStorage.setItem(LAST_LIST_URL_KEY, 'https://evil.example/x');
    expect(readLastListUrl()).toBeNull();
  });

  it('does not throw when storage is unavailable', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readLastListUrl()).toBeNull();
    spy.mockRestore();
  });

  it('matches a list view to the kind it shows (people by default)', () => {
    expect(lastListUrlFor('user', '/dashboard/iam?tab=principals&q=a')).toBe('/dashboard/iam?tab=principals&q=a');
    expect(lastListUrlFor('group', '/dashboard/iam?tab=principals&q=a')).toBeNull();
    expect(lastListUrlFor('token', '/dashboard/iam?tab=principals&principalType=token')).not.toBeNull();
    expect(lastListUrlFor('user', null)).toBeNull();
  });
});

describe('the IAM name resolver', () => {
  const iam = () => BREADCRUMB_RESOLVERS.find((r) => r.id === 'custom:iam')!;
  const ctx = (path: string) => ({ segments: seg(path), cache: new Map<string, string>() });
  afterEach(() => vi.unstubAllGlobals());

  it('names a person at the last crumb, without the effective-permission table', async () => {
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (url: unknown) => {
      asked.push(String(url));
      return { ok: true, status: 200, json: async () => ({ principal: { label: 'Ayşe Demir' } }) };
    });
    expect(await iam().resolve(ctx('/dashboard/iam/principals/user/u1'))).toEqual([{ index: 4, label: 'Ayşe Demir' }]);
    expect(asked).toEqual(['/api/iam/principals/user/u1?effective=0']);
  });

  it('names a policy', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => ({ policyId: 'p1', name: 'Deny exports' }) }));
    expect(await iam().resolve(ctx('/dashboard/iam/policies/p1'))).toEqual([{ index: 3, label: 'Deny exports' }]);
  });

  it('asks for nothing on the folders, an unknown kind or another page', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    for (const path of ['/dashboard/iam', '/dashboard/iam/principals', '/dashboard/iam/principals/user', '/dashboard/iam/principals/robot/x', '/dashboard/iam/policies', '/dashboard/models/m1']) {
      expect(await iam().resolve(ctx(path)), path).toEqual([]);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('the breadcrumb of an IAM page', () => {
  let mounted: Mounted;
  beforeAll(() => installDomStubs());
  beforeEach(() => {
    window.sessionStorage.clear();
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = String(input);
      if (url.startsWith('/api/iam/principals/user/u1')) {
        return { ok: true, status: 200, json: async () => ({ principal: { label: 'Ayşe Demir' } }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
  });
  afterEach(async () => {
    await mounted?.unmount();
    vi.unstubAllGlobals();
  });

  const render = async (path: string, locale = 'en') => {
    nav.pathname = path;
    mounted = await mount(createElement(DashboardBreadcrumbs), locale);
    await settle(50);
  };
  const hrefs = () => Array.from(document.querySelectorAll('a')).map((a) => a.getAttribute('href'));

  it('reads IAM center / People / <name> and links People to the people list', async () => {
    await render('/dashboard/iam/principals/user/u1');
    expect(text()).toContain('People');
    expect(text()).toContain('Ayşe Demir');
    expect(text()).not.toContain('Principals');
    expect(hrefs()).toEqual(['/dashboard', '/dashboard/iam', '/dashboard/iam?tab=principals&principalType=user']);
    expect(document.title).toBe('Ayşe Demir · People · IAM center - Cognipeer Console');
  });

  it('leads People back to the remembered list view', async () => {
    window.sessionStorage.setItem(LAST_LIST_URL_KEY, '/dashboard/iam?tab=principals&q=ayse');
    await render('/dashboard/iam/principals/user/u1');
    expect(hrefs()).toContain('/dashboard/iam?tab=principals&q=ayse');
  });

  it('falls back to the id while the name is unknown', async () => {
    await render('/dashboard/iam/principals/user/zzzzzz1234567890');
    expect(text()).toContain('zzzzzz…7890');
  });

  it('shows the policy trail in Turkish', async () => {
    await render('/dashboard/iam/policies/p1', 'tr');
    expect(text()).toContain('Politikalar');
    expect(hrefs()).toContain('/dashboard/iam?tab=policies');
  });

  it('never links a folder without a page on the generic trail', async () => {
    await render('/dashboard/redteam/campaigns/c1');
    expect(hrefs()).not.toContain('/dashboard/redteam/campaigns');
  });
});
