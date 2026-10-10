/**
 * The IAM center has a server gate: an end user gets "not found" (the page does not
 * load; the API refuses them as well), an unauthenticated visitor is sent to
 * sign in, and the role is the account's current one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  identity: null as unknown,
  canOpen: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));
vi.mock('@/lib/auth/serverIdentity', () => ({
  getCurrentIdentity: async () => h.identity,
  canOpenIamCenter: (...args: unknown[]) => h.canOpen(...args),
}));

import IamLayout from '@/app/dashboard/iam/layout';

const identity = (patch: Record<string, unknown> = {}) => ({
  tenantDbName: 'tenant_acme',
  tenantId: 't1',
  userId: 'u1',
  email: 'a@acme.com',
  state: 'active',
  role: 'user',
  ...patch,
});

beforeEach(() => {
  h.identity = identity();
  h.canOpen.mockReset();
});

describe('/dashboard/iam layout gate', () => {
  it('answers "not found" to someone who may not open the center', async () => {
    h.canOpen.mockResolvedValue(false);
    await expect(IamLayout({ children: 'kids' })).rejects.toThrow('NOT_FOUND');
    expect(h.canOpen).toHaveBeenCalledWith(h.identity);
  });

  it.each([
    ['an owner', 'owner'],
    ['an admin', 'admin'],
    ['someone with an iam grant', 'user'],
  ])('renders the page for %s', async (_label, role) => {
    h.identity = identity({ role });
    h.canOpen.mockResolvedValue(true);
    await expect(IamLayout({ children: 'kids' })).resolves.toBe('kids');
  });

  it('sends a visitor without a session to sign in, before asking anything else', async () => {
    h.identity = null;
    await expect(IamLayout({ children: 'kids' })).rejects.toThrow('REDIRECT:/login');
    expect(h.canOpen).not.toHaveBeenCalled();
  });

  it.each(['disabled', 'missing'])('sends a %s account to sign in', async (state) => {
    h.identity = identity({ state });
    await expect(IamLayout({ children: 'kids' })).rejects.toThrow('REDIRECT:/login');
    expect(h.canOpen).not.toHaveBeenCalled();
  });
});
