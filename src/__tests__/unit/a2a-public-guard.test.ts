/**
 * Request limits on the public A2A endpoints: the agent card and message routes
 * share the per-address and per-endpoint request rates used by public MCP.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { getConfigSource, setConfigSource } from '@/lib/core/config';
import { resetRateLimitStore } from '@/lib/services/auth/rateLimiter';
import { resetPublicGuardState } from '@/lib/services/mcp/publicGuard';

const lookups = vi.hoisted(() => ({ findTenantById: vi.fn() }));

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(async () => ({ findTenantById: lookups.findTenantById })),
}));

import { publicA2aApiPlugin } from '@/server/api/plugins/public-a2a';

const originalSource = getConfigSource();
const cardUrl = (slug: string) => `/public/a2a/t1/${slug}/.well-known/agent-card.json`;

beforeEach(() => {
  setConfigSource({ name: 'test', get: (key) => (key === 'MCP_PUBLIC_RATE_LIMIT_PER_MINUTE' ? '2' : undefined) });
  resetRateLimitStore();
  resetPublicGuardState();
  lookups.findTenantById.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  setConfigSource(originalSource);
});

describe('public A2A request limits', () => {
  it('turns a malformed slug away without a tenant lookup', async () => {
    const app = Fastify();
    await app.register(publicA2aApiPlugin);
    const res = await app.inject({ method: 'GET', url: cardUrl('bad slug!!') });
    expect(res.statusCode).toBe(404);
    expect(lookups.findTenantById).not.toHaveBeenCalled();
    await app.close();
  });

  it('refuses a client address that is over its request rate', async () => {
    const app = Fastify();
    await app.register(publicA2aApiPlugin);
    // Address-wide limit is ten times the per-endpoint one (2 -> 20).
    let last = 0;
    for (let i = 0; i < 21; i += 1) {
      const res = await app.inject({ method: 'GET', url: cardUrl('abcdefgh12345678') });
      last = res.statusCode;
    }
    expect(last).toBe(429);
    await app.close();
  });
});
