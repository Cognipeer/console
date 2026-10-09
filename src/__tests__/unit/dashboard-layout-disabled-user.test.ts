/**
 * SSR guard: a disabled account still holds a valid JWT, so the dashboard
 * layouts must bounce it to /login exactly like a deleted account.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  headerValues: {} as Record<string, string>,
  db: {
    switchToTenant: vi.fn(),
    findUserById: vi.fn(),
    listUserProjectsByUser: vi.fn(),
    findProjectById: vi.fn(),
    findUserProject: vi.fn(),
  },
  getUserAuthState: vi.fn(),
}));

vi.mock('next/headers', () => ({
  headers: async () => ({ get: (name: string) => h.headerValues[name] ?? null }),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); },
  notFound: () => { throw new Error('NOT_FOUND'); },
}));
vi.mock('@/components/layout/DashboardLayout', () => ({ default: () => null }));
vi.mock('@/lib/database', () => ({ getDatabase: vi.fn(async () => h.db) }));
vi.mock('@/lib/services/support/supportHandoff', () => ({ isSupportEntryPointEnabled: () => false }));
vi.mock('@/lib/services/users/userAuthState', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/users/userAuthState')>()),
  getUserAuthState: h.getUserAuthState,
}));

// The vitest esbuild transform compiles JSX to React.createElement (the app
// itself uses the automatic runtime); a stub is enough since the layout's
// output is never rendered here.
(globalThis as { React?: unknown }).React = { createElement: (...args: unknown[]) => args };

import DashboardRouteLayout from '@/app/dashboard/layout';
import ProjectLayout from '@/app/dashboard/projects/[projectId]/layout';

beforeEach(() => {
  vi.clearAllMocks();
  h.headerValues = {
    'x-tenant-db-name': 'tenant_acme',
    'x-tenant-id': 't1',
    'x-user-id': 'u1',
    'x-user-role': 'admin',
    'x-user-email': 'a@acme.com',
    'x-license-type': 'FREE',
  };
});

describe('dashboard layout', () => {
  it('redirects a disabled user to /login', async () => {
    h.db.findUserById.mockResolvedValue({ _id: 'u1', role: 'admin', status: 'disabled' });
    await expect(DashboardRouteLayout({ children: null })).rejects.toThrow('REDIRECT:/login');
  });

  it('redirects a deleted user to /login (unchanged)', async () => {
    h.db.findUserById.mockResolvedValue(null);
    await expect(DashboardRouteLayout({ children: null })).rejects.toThrow('REDIRECT:/login');
  });

  it('renders for an active user and for a legacy status-less user', async () => {
    for (const status of ['active', undefined]) {
      h.db.findUserById.mockResolvedValue({ _id: 'u1', role: 'admin', status });
      await expect(DashboardRouteLayout({ children: null })).resolves.toBeTruthy();
    }
  });
});

describe('project layout', () => {
  const render = () => ProjectLayout({ children: 'kids', params: Promise.resolve({ projectId: 'p1' }) });

  it('redirects a disabled admin before the admin short-circuit', async () => {
    h.getUserAuthState.mockResolvedValue('disabled');
    await expect(render()).rejects.toThrow('REDIRECT:/login');
  });

  it('redirects a disabled project member even though a membership exists', async () => {
    h.headerValues['x-user-role'] = 'user';
    h.getUserAuthState.mockResolvedValue('disabled');
    h.db.findProjectById.mockResolvedValue({ _id: 'p1', tenantId: 't1' });
    h.db.findUserProject.mockResolvedValue({ projectId: 'p1' });
    await expect(render()).rejects.toThrow('REDIRECT:/login');
  });

  it('lets an active admin through', async () => {
    h.getUserAuthState.mockResolvedValue('active');
    await expect(render()).resolves.toBe('kids');
  });

  it('does not turn a missing user row into a redirect (existing behaviour kept)', async () => {
    h.getUserAuthState.mockResolvedValue('missing');
    await expect(render()).resolves.toBe('kids');
  });
});
