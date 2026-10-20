/**
 * Public key set of a workspace's Console identity issuer, /api/public/identity/... — served
 * without a token, cacheable, rate limited per client address, and a 404 for anything that is
 * not a workspace.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const hoisted = vi.hoisted(() => ({
  tenantDbName: vi.fn(),
  jwks: vi.fn(),
}));

vi.mock('@/lib/iam/consoleIdentity', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/iam/consoleIdentity')>()),
  consoleIdentityTenantDbName: hoisted.tenantDbName,
  getConsoleIdentityJwks: hoisted.jwks,
}));

import { getConfigSource, setConfigSource } from '@/lib/core/config';
import { ConsoleIdentityError } from '@/lib/iam/consoleIdentity';
import { resetRateLimitStore } from '@/lib/services/auth/rateLimiter';
import { publicIdentityApiPlugin } from '@/server/api/plugins/public-identity';
import { buildMcpTestApp } from '../helpers/mcp-http';

const originalSource = getConfigSource();
const TENANT = '65f0c1d2a3b4c5d6e7f80001';
const KEY = { kty: 'RSA', n: 'modulus', e: 'AQAB', kid: 'kid-1', alg: 'RS256', use: 'sig' };

let app: FastifyInstance;

beforeAll(async () => {
  setConfigSource({ name: 'test', get: (key) => ({ APP_URL: 'https://console.example.com', JWT_SECRET: 'public-identity-test-secret-32-chars-min' } as Record<string, string>)[key] });
  app = await buildMcpTestApp(publicIdentityApiPlugin);
});

afterAll(async () => {
  await app.close();
  setConfigSource(originalSource);
});

beforeEach(() => {
  resetRateLimitStore();
  hoisted.tenantDbName.mockImplementation(async (id: string) => {
    if (id === TENANT) return 'tenant_db';
    throw new ConsoleIdentityError('unknown_workspace');
  });
  hoisted.jwks.mockResolvedValue({ keys: [KEY] });
});

afterEach(() => vi.clearAllMocks());

describe('GET /api/public/identity/:tenantId/.well-known/jwks.json', () => {
  it('serves the key set to anyone, cacheable', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/public/identity/${TENANT}/.well-known/jwks.json` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ keys: [KEY] });
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(hoisted.jwks).toHaveBeenCalledWith('tenant_db');
  });

  it('keeps an empty key set briefly cacheable only', async () => {
    hoisted.jwks.mockResolvedValue({ keys: [] });
    const res = await app.inject({ method: 'GET', url: `/api/public/identity/${TENANT}/.well-known/jwks.json` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ keys: [] });
    expect(res.headers['cache-control']).toBe('public, max-age=30');
  });

  it('is a 404 for an unknown or malformed workspace id', async () => {
    const unknown = await app.inject({ method: 'GET', url: '/api/public/identity/0123456789abcdef01234567/.well-known/jwks.json' });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: 'Not found' });

    hoisted.tenantDbName.mockClear();
    const malformed = await app.inject({ method: 'GET', url: `/api/public/identity/${'x'.repeat(65)}/.well-known/jwks.json` });
    expect(malformed.statusCode).toBe(404);
    expect(hoisted.tenantDbName).not.toHaveBeenCalled();
  });

  it('says nothing about an internal failure', async () => {
    hoisted.jwks.mockRejectedValue(new Error('connection to tenant_db refused'));
    const res = await app.inject({ method: 'GET', url: `/api/public/identity/${TENANT}/.well-known/jwks.json` });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('tenant_db');
  });

  it('rate limits one client address', async () => {
    let last = 0;
    for (let i = 0; i < 121; i += 1) {
      last = (await app.inject({ method: 'GET', url: `/api/public/identity/${TENANT}/.well-known/jwks.json` })).statusCode;
    }
    expect(last).toBe(429);
    const res = await app.inject({ method: 'GET', url: `/api/public/identity/${TENANT}/.well-known/openid-configuration` });
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('GET /api/public/identity/:tenantId/.well-known/openid-configuration', () => {
  it('points at the issuer and its key set on the configured URL', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/public/identity/${TENANT}/.well-known/openid-configuration` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      issuer: `https://console.example.com/api/public/identity/${TENANT}`,
      jwks_uri: `https://console.example.com/api/public/identity/${TENANT}/.well-known/jwks.json`,
      id_token_signing_alg_values_supported: ['RS256'],
    });
  });

  it('does not take the issuer from request headers', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/public/identity/${TENANT}/.well-known/openid-configuration`,
      headers: { host: 'evil.example.net', 'x-forwarded-host': 'evil.example.net', 'x-forwarded-proto': 'http' },
    });
    expect(res.json().issuer).toBe(`https://console.example.com/api/public/identity/${TENANT}`);
  });
});
