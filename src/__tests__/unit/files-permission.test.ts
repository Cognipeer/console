/**
 * The Files permission checks behind choosing a session-files bucket: real RBAC
 * (role defaults, explicit grants, group grants, a token's own scope).
 */

import { describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ resolveSessionRbacContext: vi.fn() }));
vi.mock('@/server/api/fastify-utils', () => ({ resolveSessionRbacContext: hoisted.resolveSessionRbacContext }));

import { sessionHasFilesPermission, tokenHasFilesPermission } from '@/server/api/plugins/files-permission';

const token = (user: Record<string, unknown> | undefined, servicePermissions?: Record<string, string> | null) => ({
  user, tokenRecord: { servicePermissions },
}) as never;

describe('token callers', () => {
  it('follow the owner’s permission, and a token scope can only narrow it', () => {
    expect(tokenHasFilesPermission(token({ role: 'user' }), 'write')).toBe(true);
    expect(tokenHasFilesPermission(token({ role: 'owner' }), 'write')).toBe(true);
    // The owner's own grant: Files read only.
    expect(tokenHasFilesPermission(token({ role: 'user', servicePermissions: { files: 'read' } }), 'read')).toBe(true);
    expect(tokenHasFilesPermission(token({ role: 'user', servicePermissions: { files: 'read' } }), 'write')).toBe(false);
    // A token scoped to read stays read-only for an admin owner; an unlisted service is none.
    expect(tokenHasFilesPermission(token({ role: 'admin' }, { files: 'read' }), 'write')).toBe(false);
    expect(tokenHasFilesPermission(token({ role: 'admin' }, { files: 'read' }), 'read')).toBe(true);
    expect(tokenHasFilesPermission(token({ role: 'admin' }, { agents: 'write' }), 'read')).toBe(false);
    expect(tokenHasFilesPermission(token(undefined), 'read')).toBe(false);
  });
});

describe('signed-in callers', () => {
  it('count group grants as well as their own', async () => {
    hoisted.resolveSessionRbacContext.mockResolvedValue({ user: { role: 'user', servicePermissions: { files: 'none' } }, groupGrants: [] });
    expect(await sessionHasFilesPermission({} as never, 'read')).toBe(false);

    hoisted.resolveSessionRbacContext.mockResolvedValue({
      user: { role: 'user', servicePermissions: { files: 'none' } },
      groupGrants: [{ servicePermissions: { files: 'write' } }],
    });
    expect(await sessionHasFilesPermission({} as never, 'write')).toBe(true);

    hoisted.resolveSessionRbacContext.mockResolvedValue({ user: { role: 'user', servicePermissions: { files: 'read' } }, groupGrants: [] });
    expect(await sessionHasFilesPermission({} as never, 'read')).toBe(true);
    expect(await sessionHasFilesPermission({} as never, 'write')).toBe(false);
  });
});
