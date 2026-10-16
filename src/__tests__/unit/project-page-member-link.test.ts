// @vitest-environment jsdom
/**
 * The project page's tab routing. `/dashboard/projects/<id>?member=<userId>` (where the Access
 * check sends you from a "Project limit" reason) lands on the Members tab, which opens that
 * member's permission editor itself; the old `?tab=users` / `?tab=quotas` spellings still work.
 */

import { createElement, Suspense } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { installApiMock, installDomStubs, mount, settle, text, type Mounted } from '../helpers/iamCenterUi';

const nav = vi.hoisted(() => ({ search: '', replace: undefined as unknown as ReturnType<typeof vi.fn> }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ push: vi.fn(), replace: nav.replace ?? vi.fn(), prefetch: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard/projects/proj-a',
}));

// The tabs are other components with their own tests; here only which one the page shows matters.
const stub = vi.hoisted(() => (label: string) => async () => {
  const { createElement: h } = await import('react');
  return { default: (p: { projectId: string }) => h('div', null, `${label} project=${p.projectId}`) };
});
vi.mock('@/components/projects/detail/OverviewTab', stub('overview'));
vi.mock('@/components/projects/detail/MembersTab', stub('members'));
vi.mock('@/components/projects/detail/TokensTab', stub('tokens'));
vi.mock('@/components/projects/detail/LimitsTab', stub('limits'));
vi.mock('@/components/projects/ProjectProvidersManager', stub('providers'));

import ProjectDetailPage from '@/app/dashboard/projects/[projectId]/page';

let mounted: Mounted;

beforeAll(() => installDomStubs());

afterEach(async () => {
  await mounted?.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
  try {
    sessionStorage.clear();
  } catch {
    /* no storage */
  }
});

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

async function renderPage(search: string, role = 'admin') {
  nav.search = search;
  window.history.replaceState(null, '', `/dashboard/projects/proj-a${search ? `?${search}` : ''}`);
  installApiMock([
    ['GET', '/api/projects', () => ({ projects: [{ _id: 'proj-a', name: 'Alpha', key: 'alpha' }], activeProjectId: 'proj-a' })],
    ['GET', '/api/auth/session', () => ({ authenticated: true, role })],
  ]);
  mounted = await mount(
    createElement(Suspense, { fallback: null }, createElement(ProjectDetailPage, { params: Promise.resolve({ projectId: 'proj-a' }) })),
  );
  await settle(200);
}

describe('the project page', () => {
  it('opens on the overview', async () => {
    await renderPage('');
    expect(text()).toContain('overview project=proj-a');
    expect(text()).not.toContain('members project=');
  });

  it('lands the member link on the Members tab', async () => {
    await renderPage('member=u-ann');
    expect(text()).toContain('members project=proj-a');
  });

  it('keeps the old tab spellings working', async () => {
    await renderPage('tab=users');
    expect(text()).toContain('members project=proj-a');
    await mounted.unmount();
    await renderPage('tab=quotas');
    expect(text()).toContain('limits project=proj-a');
  });

  it('shows the Limits tab to tenant admins only', async () => {
    await renderPage('tab=limits', 'member');
    expect(text()).not.toContain('limits project=');
    expect(text()).toContain('overview project=proj-a');
  });
});
