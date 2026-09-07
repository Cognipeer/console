/**
 * Regression test for a CodeQL-flagged gap on the OIDC/SSO PR:
 * `issueSessionForAuthenticatedUser` is the shared tail every authenticator
 * (local password, LDAP, OIDC/SSO ticket exchange) calls to actually issue a
 * session — but only the local `/auth/login` route rate-limited its own
 * entry point. A new external-auth callback that calls this function
 * directly (as the SSO ticket-exchange endpoint does) shipped with no
 * throttling of its own. The guard now lives inside the shared function
 * itself, so every caller — present and future — is covered without having
 * to remember to add it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ITenant, IUser } from '@/lib/database';

vi.mock('@/lib/services/auth/rateLimiter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/auth/rateLimiter')>();
  return { ...actual, checkRateLimit: vi.fn() };
});

import { checkRateLimit, SESSION_ISSUANCE_RATE_LIMIT } from '@/lib/services/auth/rateLimiter';
import { issueSessionForAuthenticatedUser } from '@/server/api/plugins/auth';

const tenant = { _id: 'tenant-1', dbName: 'tenant_acme', slug: 'acme', companyName: 'Acme' } as ITenant;
const user = { _id: 'user-1', email: 'a@acme.com', role: 'admin' } as unknown as IUser;

function mockReply() {
  const reply = {
    header: vi.fn().mockReturnThis(),
    setCookie: vi.fn().mockReturnThis(),
    clearCookie: vi.fn().mockReturnThis(),
    code: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };
  return reply as unknown as FastifyReply & typeof reply;
}

const request = { ip: '203.0.113.9', cookies: {} } as unknown as FastifyRequest;

/** Throws if touched — proves the rate-limit guard short-circuits before any DB work. */
const untouchableDb = new Proxy(
  {},
  {
    get(_t, prop) {
      throw new Error(`db.${String(prop)} should not be called when the request is rate-limited`);
    },
  },
) as Parameters<typeof issueSessionForAuthenticatedUser>[0];

afterEach(() => {
  vi.mocked(checkRateLimit).mockReset();
});

describe('issueSessionForAuthenticatedUser — session-issuance rate limit', () => {
  it('rejects with 429 and never touches the database once the limit is exhausted', async () => {
    vi.mocked(checkRateLimit).mockReturnValue({
      allowed: false,
      remaining: 0,
      resetAt: new Date(Date.now() + 60_000),
      retryAfterSeconds: 60,
    });
    const reply = mockReply();

    await issueSessionForAuthenticatedUser(untouchableDb, tenant, user, request, reply);

    expect(reply.code).toHaveBeenCalledWith(429);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('Too many') }),
    );
  });

  it('checks the shared per-IP key with SESSION_ISSUANCE_RATE_LIMIT, covering every caller (local login, LDAP, SSO)', async () => {
    vi.mocked(checkRateLimit).mockReturnValue({
      allowed: false,
      remaining: 0,
      resetAt: new Date(Date.now() + 60_000),
      retryAfterSeconds: 60,
    });
    const reply = mockReply();

    await issueSessionForAuthenticatedUser(untouchableDb, tenant, user, request, reply);

    expect(checkRateLimit).toHaveBeenCalledWith(`session:${request.ip}`, SESSION_ISSUANCE_RATE_LIMIT);
  });
});
