// @vitest-environment jsdom
/**
 * Where "My account" and the personal tokens page are reached from: the account
 * menu of the top bar for everyone, and a link from the tokens page that only
 * owners and admins get (to manage everybody's tokens in the IAM center).
 */
import { createElement } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { click, installApiMock, installDomStubs, jsonResponse, mount, q, qa, settle, text, type Mounted } from '../helpers/iamCenterUi';
import { DashboardUserProvider } from '@/components/layout/DashboardUserContext';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/dashboard/tokens',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/image', () => ({ default: () => null }));
// The project pill is another component with its own data layer.
vi.mock('@/components/projects/ProjectPill', () => ({ default: () => null }));
// The personal list itself is not under test here.
vi.mock('@/components/settings/TokenManagement', () => ({ default: () => createElement('div', null, 'token-management') }));

import TopbarV2 from '@/components/layout/launcher/TopbarV2';
import TokensPage from '@/app/dashboard/tokens/page';

let mounted: Mounted;

beforeAll(() => installDomStubs());
afterEach(async () => {
  await mounted?.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

describe('the account menu', () => {
  const noop = () => {};
  async function renderTopbar(onNavigate: (href: string) => void, locale = 'en') {
    installApiMock([]);
    mounted = await mount(
      createElement(TopbarV2, {
        user: { name: 'Ann Lee', email: 'ann@example.com', licenseType: 'ENTERPRISE' },
        isTenantAdmin: false,
        onSearchClick: noop,
        onLauncherClick: noop,
        onDocsClick: noop,
        onLogout: noop,
        onNavigate,
        onMobileNavClick: noop,
      } as never),
      locale,
    );
    await settle(60);
  }

  it('has "My account" for every signed-in person, and it opens the account page', async () => {
    const onNavigate = vi.fn();
    await renderTopbar(onNavigate);
    await click(q('button[aria-label="Account menu"]'));
    await settle(80);
    const items = qa('[role="menuitem"]');
    const mine = items.find((i) => i.textContent === 'My account');
    expect(mine).toBeDefined();
    await click(mine);
    expect(onNavigate).toHaveBeenCalledWith('/dashboard/account');
  });

  it('says it in Turkish', async () => {
    await renderTopbar(vi.fn(), 'tr');
    await click(q('button[aria-label="Account menu"]'));
    await settle(80);
    expect(qa('[role="menuitem"]').map((i) => i.textContent)).toContain('Hesabım');
  });
});

describe('the personal tokens page', () => {
  async function renderPage(role: 'owner' | 'admin' | 'project_admin' | 'user') {
    installApiMock([['GET', '/api/auth/session', () => jsonResponse({}, 200)]]);
    mounted = await mount(
      createElement(
        DashboardUserProvider as never,
        { value: { name: 'x', email: 'x@y.z', licenseType: 'ee', role } } as never,
        createElement(TokensPage),
      ),
    );
    await settle(50);
  }

  it('says every role sees only its own tokens here', async () => {
    await renderPage('user');
    const note = q('[data-testid="tokens-page-note"]')!;
    expect(note.textContent).toContain('Your API tokens in this project');
    expect(note.textContent).toContain('Everyone sees only their own tokens here');
    expect(text()).toContain('token-management');
  });

  it.each(['owner', 'admin'] as const)('gives %s a link to everybody\'s tokens in the IAM center', async (role) => {
    await renderPage(role);
    const link = qa<HTMLAnchorElement>('a').find((a) => a.textContent === 'Manage everyone\'s tokens');
    expect(link?.getAttribute('href')).toBe('/dashboard/iam?tab=principals&principalType=token');
  });

  it.each(['project_admin', 'user'] as const)('gives %s no such link', async (role) => {
    await renderPage(role);
    expect(qa('a').some((a) => a.textContent === 'Manage everyone\'s tokens')).toBe(false);
  });
});
