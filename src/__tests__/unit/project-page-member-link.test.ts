// @vitest-environment jsdom
/**
 * `/dashboard/projects/<id>?member=<userId>` (where the Access check sends you
 * from a "Project limit" reason) opens that member's project permission editor,
 * once: the link is dropped from the address so a refresh does not reopen it.
 */

import { createElement, Suspense } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { installApiMock, installDomStubs, mount, settle, text, type Mounted } from '../helpers/iamCenterUi';

const nav = vi.hoisted(() => ({ search: '' }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard/projects/proj-a',
}));

// The tabs are other components with their own tests; here only what the page hands to the members tab matters.
vi.mock('@/components/projects/ProjectMembersManager', async () => {
  const { createElement: h } = await import('react');
  return { default: (p: { projectId: string; openMemberId?: string | null }) => h('div', null, `members project=${p.projectId} open=${p.openMemberId ?? 'none'}`) };
});
vi.mock('@/components/projects/ProjectProvidersManager', async () => {
  const { createElement: h } = await import('react');
  return { default: () => h('div', null, 'providers') };
});
vi.mock('@/components/settings/QuotaManagement', async () => {
  const { createElement: h } = await import('react');
  return { default: () => h('div', null, 'quotas') };
});

import ProjectDetailPage from '@/app/dashboard/projects/[projectId]/page';

let mounted: Mounted;

beforeAll(() => installDomStubs());

afterEach(async () => {
  await mounted?.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

async function renderPage(search: string) {
  nav.search = search;
  window.history.replaceState(null, '', `/dashboard/projects/proj-a${search ? `?${search}` : ''}`);
  installApiMock([
    ['GET', '/api/projects', () => ({ projects: [{ _id: 'proj-a', name: 'Alpha', key: 'alpha' }], activeProjectId: 'proj-a' })],
    ['GET', '/api/auth/session', () => ({ authenticated: true, role: 'admin' })],
  ]);
  mounted = await mount(
    createElement(Suspense, { fallback: null }, createElement(ProjectDetailPage, { params: Promise.resolve({ projectId: 'proj-a' }) })),
  );
  await settle(200);
}

describe('the project page', () => {
  it('hands the member of the link to the members tab and removes the link from the address', async () => {
    await renderPage('member=u-ann');
    expect(text()).toContain('members project=proj-a open=u-ann');
    expect(window.location.search).toBe('');
  });

  it('keeps the other parameters of the address', async () => {
    await renderPage('member=u-ann&tab=users');
    expect(text()).toContain('open=u-ann');
    expect(window.location.search).toBe('?tab=users');
  });

  it('opens no editor without a link', async () => {
    await renderPage('');
    expect(text()).toContain('members project=proj-a open=none');
  });
});
