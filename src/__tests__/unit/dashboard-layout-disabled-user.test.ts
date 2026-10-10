/**
 * SSR guards of the dashboard layouts.
 *
 * A disabled account still holds a valid JWT, so the layouts must bounce it to
 * /login exactly like a deleted account.
 *
 * A member's projects count however they were given - directly, in the legacy
 * list, or through a group - exactly as the session endpoint and the project
 * switcher count them. A guard that looked at direct memberships only would send
 * a member whose only project comes from a group to "no project".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  headerValues: {} as Record<string, string>,
  db: {
    switchToTenant: vi.fn(),
    findUserById: vi.fn(),
    listUserProjectsByUser: vi.fn(),
    listGroupMembersByUser: vi.fn(),
    listGroupProjectsByGroup: vi.fn(),
    listGroupProjectsByProject: vi.fn(),
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

describe('dashboard layout (which projects count)', () => {
  const asMember = () => {
    h.headerValues['x-user-role'] = 'user';
    h.db.listUserProjectsByUser.mockResolvedValue([]);
    h.db.listGroupMembersByUser.mockResolvedValue([]);
    h.db.listGroupProjectsByGroup.mockResolvedValue([]);
  };

  it('sends a member with no project of any kind to /no-project', async () => {
    asMember();
    h.db.findUserById.mockResolvedValue({ _id: 'u1', role: 'user', status: 'active', projectIds: [] });
    await expect(DashboardRouteLayout({ children: null })).rejects.toThrow('REDIRECT:/no-project');
  });

  it('lets a member in through a direct membership, the legacy list, or a group', async () => {
    asMember();
    h.db.findUserById.mockResolvedValue({ _id: 'u1', role: 'user', status: 'active', projectIds: [] });
    h.db.listUserProjectsByUser.mockResolvedValue([{ projectId: 'p-direct' }]);
    await expect(DashboardRouteLayout({ children: null })).resolves.toBeTruthy();

    asMember();
    h.db.findUserById.mockResolvedValue({ _id: 'u1', role: 'user', status: 'active', projectIds: ['p-legacy'] });
    await expect(DashboardRouteLayout({ children: null })).resolves.toBeTruthy();

    asMember();
    h.db.findUserById.mockResolvedValue({ _id: 'u1', role: 'user', status: 'active', projectIds: [] });
    h.db.listGroupMembersByUser.mockResolvedValue([{ groupId: 'g1' }]);
    h.db.listGroupProjectsByGroup.mockResolvedValue([{ projectId: 'p-via-group', groupId: 'g1' }]);
    await expect(DashboardRouteLayout({ children: null })).resolves.toBeTruthy();
    expect(h.db.listGroupProjectsByGroup).toHaveBeenCalledWith('g1');
  });

  it('does not count a group that has no project', async () => {
    asMember();
    h.db.findUserById.mockResolvedValue({ _id: 'u1', role: 'user', status: 'active', projectIds: [] });
    h.db.listGroupMembersByUser.mockResolvedValue([{ groupId: 'g1' }]);
    h.db.listGroupProjectsByGroup.mockResolvedValue([]);
    await expect(DashboardRouteLayout({ children: null })).rejects.toThrow('REDIRECT:/no-project');
  });

  it('does not look at memberships for a workspace admin', async () => {
    h.db.findUserById.mockResolvedValue({ _id: 'u1', role: 'admin', status: 'active' });
    await expect(DashboardRouteLayout({ children: null })).resolves.toBeTruthy();
    expect(h.db.listUserProjectsByUser).not.toHaveBeenCalled();
    expect(h.db.listGroupMembersByUser).not.toHaveBeenCalled();
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

  describe('a member who is not an admin', () => {
    const asMember = () => {
      h.headerValues['x-user-role'] = 'user';
      h.getUserAuthState.mockResolvedValue('active');
      h.db.findProjectById.mockResolvedValue({ _id: 'p1', tenantId: 't1' });
      h.db.findUserProject.mockResolvedValue(null);
      h.db.findUserById.mockResolvedValue({ _id: 'u1', role: 'user', projectIds: [] });
      h.db.listGroupMembersByUser.mockResolvedValue([]);
      h.db.listGroupProjectsByProject.mockResolvedValue([]);
    };

    it('may open a project through a group that is assigned to it', async () => {
      asMember();
      h.db.listGroupMembersByUser.mockResolvedValue([{ groupId: 'g1' }]);
      h.db.listGroupProjectsByProject.mockResolvedValue([{ groupId: 'g1', projectId: 'p1', role: 'member', servicePermissions: {} }]);
      await expect(render()).resolves.toBe('kids');
    });

    it('does not get a project through a group that is not theirs, or from a project nobody gave them', async () => {
      asMember();
      h.db.listGroupMembersByUser.mockResolvedValue([{ groupId: 'g-other' }]);
      h.db.listGroupProjectsByProject.mockResolvedValue([{ groupId: 'g1', projectId: 'p1', role: 'member', servicePermissions: {} }]);
      await expect(render()).rejects.toThrow('NOT_FOUND');

      asMember();
      await expect(render()).rejects.toThrow('NOT_FOUND');
    });

    it('still lets in a direct member and a legacy member without asking about groups', async () => {
      asMember();
      h.db.findUserProject.mockResolvedValue({ projectId: 'p1' });
      await expect(render()).resolves.toBe('kids');

      asMember();
      h.db.findUserById.mockResolvedValue({ _id: 'u1', role: 'user', projectIds: ['p1'] });
      await expect(render()).resolves.toBe('kids');
      expect(h.db.listGroupMembersByUser).not.toHaveBeenCalled();
    });
  });
});
