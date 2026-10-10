/**
 * The server layouts that gate a page on the role - Providers and Resources (owners and
 * admins) and the pages of one project (owners and admins, or a member of that project) -
 * decide on the role the account has NOW, not on the one the session was issued with.
 *
 * The navigation menu is built from the account record, so a page that read the session's
 * header instead would disagree with it for as long as the sign-in lasts: a person promoted
 * to admin would see Providers in the menu and get "not found" on the page, and a demoted
 * admin would keep the page shells. In every case below the header carries the OPPOSITE of
 * the account's role, so a layout that still trusted it fails.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  headerValues: {} as Record<string, string>,
  getUserIdentity: vi.fn(),
  db: {
    switchToTenant: vi.fn(),
    findProjectById: vi.fn(),
    findUserProject: vi.fn(),
    findUserById: vi.fn(),
    listGroupMembersByUser: vi.fn(),
    listGroupProjectsByProject: vi.fn(),
  },
}));

vi.mock('next/headers', () => ({
  headers: async () => ({ get: (name: string) => h.headerValues[name] ?? null }),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));
vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(async () => h.db),
  runWithTenantScope: vi.fn(async (_name: string, fn: (db: unknown) => unknown) => fn(h.db)),
}));
vi.mock('@/lib/services/users/userAuthState', () => ({ getUserIdentity: h.getUserIdentity }));

import ProvidersLayout from '@/app/dashboard/providers/layout';
import ResourcesLayout from '@/app/dashboard/resources/layout';
import ProjectLayout from '@/app/dashboard/projects/[projectId]/layout';

/** What the account record says now. */
const accountIs = (state: string, role: string | null) =>
  h.getUserIdentity.mockResolvedValue({ state, role });
/** What the session was issued with (the header the middleware writes). */
const sessionSaysRole = (role: string) => {
  h.headerValues['x-user-role'] = role;
};

beforeEach(() => {
  vi.clearAllMocks();
  h.headerValues = {
    'x-tenant-db-name': 'tenant_acme',
    'x-tenant-id': 't1',
    'x-user-id': 'u1',
    'x-user-email': 'a@acme.com',
    'x-user-role': 'user',
  };
  accountIs('active', 'user');
  h.db.findProjectById.mockResolvedValue({ _id: 'p1', tenantId: 't1' });
  h.db.findUserProject.mockResolvedValue(null);
  h.db.findUserById.mockResolvedValue({ _id: 'u1', role: 'user', projectIds: [] });
  h.db.listGroupMembersByUser.mockResolvedValue([]);
  h.db.listGroupProjectsByProject.mockResolvedValue([]);
});

describe.each([
  ['Providers', ProvidersLayout],
  ['Resources', ResourcesLayout],
])('%s layout', (_name, Layout) => {
  const render = () => Layout({ children: 'kids' });

  it.each(['owner', 'admin'])('lets %s in', async (role) => {
    accountIs('active', role);
    await expect(render()).resolves.toBe('kids');
  });

  it('lets in a person who was promoted to admin after signing in', async () => {
    sessionSaysRole('user');
    accountIs('active', 'admin');
    await expect(render()).resolves.toBe('kids');
  });

  it('closes the page to an admin who was demoted after signing in', async () => {
    sessionSaysRole('admin');
    accountIs('active', 'user');
    await expect(render()).rejects.toThrow('NOT_FOUND');
    accountIs('active', 'project_admin');
    await expect(render()).rejects.toThrow('NOT_FOUND');
  });

  it('answers "not found" to a member, a project admin and an account with an unknown role', async () => {
    for (const role of ['user', 'project_admin', null]) {
      sessionSaysRole('admin');
      accountIs('active', role);
      await expect(render()).rejects.toThrow('NOT_FOUND');
    }
  });

  it.each(['disabled', 'missing'])('sends a %s account to sign in, whatever its session says', async (state) => {
    sessionSaysRole('owner');
    accountIs(state, state === 'disabled' ? 'admin' : null);
    await expect(render()).rejects.toThrow('REDIRECT:/login');
  });

  it('sends a visitor without a session to sign in, before reading any account', async () => {
    delete h.headerValues['x-user-id'];
    await expect(render()).rejects.toThrow('REDIRECT:/login');
    expect(h.getUserIdentity).not.toHaveBeenCalled();
  });

  it('does not render when the account cannot be read (fail closed)', async () => {
    h.getUserIdentity.mockRejectedValue(new Error('db down'));
    await expect(render()).rejects.toThrow('db down');
  });
});

describe('project layout', () => {
  const render = () => ProjectLayout({ children: 'kids', params: Promise.resolve({ projectId: 'p1' }) });

  it('lets in a person who was promoted to admin without asking about memberships', async () => {
    sessionSaysRole('user');
    accountIs('active', 'admin');
    await expect(render()).resolves.toBe('kids');
    expect(h.db.findUserProject).not.toHaveBeenCalled();
    expect(h.db.findProjectById).not.toHaveBeenCalled();
  });

  it('holds a demoted admin to the project memberships', async () => {
    sessionSaysRole('admin');
    accountIs('active', 'user');
    await expect(render()).rejects.toThrow('NOT_FOUND');
    expect(h.db.findUserProject).toHaveBeenCalledWith('u1', 'p1');
  });

  it('still lets a demoted admin into a project they are a member of', async () => {
    sessionSaysRole('admin');
    accountIs('active', 'project_admin');
    h.db.findUserProject.mockResolvedValue({ projectId: 'p1' });
    await expect(render()).resolves.toBe('kids');
  });

  it('answers "not found" for a project of another workspace, whatever the role in the session', async () => {
    sessionSaysRole('admin');
    accountIs('active', 'user');
    h.db.findProjectById.mockResolvedValue({ _id: 'p1', tenantId: 'other' });
    await expect(render()).rejects.toThrow('NOT_FOUND');
  });

  it.each(['disabled', 'missing'])('sends a %s account to sign in even when the session says owner', async (state) => {
    sessionSaysRole('owner');
    accountIs(state, state === 'disabled' ? 'owner' : null);
    await expect(render()).rejects.toThrow('REDIRECT:/login');
  });

  it('sends a visitor without a session to sign in', async () => {
    delete h.headerValues['x-tenant-id'];
    await expect(render()).rejects.toThrow('REDIRECT:/login');
    expect(h.getUserIdentity).not.toHaveBeenCalled();
  });
});
