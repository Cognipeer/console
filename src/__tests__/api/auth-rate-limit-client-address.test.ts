/**
 * The auth routes key their rate limits on the client address Fastify
 * resolves (`request.ip`). With the default `trustProxy: true` that is the
 * left-most X-Forwarded-For entry, which can be any text. Through the real
 * routes: forwarded values that are not IP addresses share one bucket per
 * route (so the limiter's state stays small), while valid addresses keep
 * their own bucket and the limits and responses stay as they were.
 */
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));
vi.mock('bcryptjs', () => ({
  default: { compare: vi.fn(), hash: vi.fn().mockResolvedValue('$2a$10$hashed') },
  compare: vi.fn(),
  hash: vi.fn().mockResolvedValue('$2a$10$hashed'),
}));
vi.mock('@/lib/license/token-manager', () => ({
  TokenManager: { generateToken: vi.fn().mockResolvedValue('mock-jwt-token') },
}));
vi.mock('@/lib/license/license-manager', () => ({
  LicenseManager: { getFeaturesForLicense: vi.fn().mockReturnValue(['LLM_CHAT']) },
  LicenseType: {},
}));
vi.mock('@/lib/email/mailer', () => ({ sendEmail: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/services/projects/projectService', () => ({
  ensureDefaultProject: vi.fn().mockResolvedValue({ _id: 'proj-1', key: '__default__' }),
}));

import { getDatabase } from '@/lib/database';
import {
  LOGIN_RATE_LIMIT,
  PASSWORD_RESET_RATE_LIMIT,
  REGISTER_RATE_LIMIT,
  getRateLimitLongestKeyLength,
  getRateLimitStoreSize,
} from '@/lib/services/auth/rateLimiter';
import { authApiPlugin } from '@/server/api/plugins/auth';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const routes = [
  { name: 'login', url: '/api/auth/login', limit: LOGIN_RATE_LIMIT.maxAttempts, body: {} },
  { name: 'register', url: '/api/auth/register', limit: REGISTER_RATE_LIMIT.maxAttempts, body: {} },
  {
    name: 'forgot-password',
    url: '/api/auth/forgot-password',
    limit: PASSWORD_RESET_RATE_LIMIT.maxAttempts,
    body: { email: 'jane@acme.com', slug: 'acme' },
  },
  { name: 'reset-password', url: '/api/auth/reset-password', limit: PASSWORD_RESET_RATE_LIMIT.maxAttempts, body: {} },
];

describe('auth routes: client address in the rate-limit key', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(createMockDb());
    app = await createFastifyApiTestApp(authApiPlugin, { trustProxy: true });
  });

  afterEach(async () => {
    await app.close();
  });

  function post(url: string, body: unknown, forwardedFor: string) {
    return app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json', 'x-forwarded-for': forwardedFor },
      payload: JSON.stringify(body),
    });
  }

  it.each(routes)('$name: forwarded values that are not addresses are limited as one client', async (route) => {
    const forwarded = [
      'z'.repeat(12_000),
      'unknown',
      'not-an-ip',
      `::1%${'a'.repeat(5_000)}`,
      randomBytes(4_000).toString('hex'),
    ];
    const next = (i: number) => forwarded[i % forwarded.length] + (i >= forwarded.length ? `-${i}` : '');

    for (let i = 0; i < route.limit; i++) {
      const response = await post(route.url, route.body, next(i));
      expect(response.statusCode, `attempt ${i + 1}`).not.toBe(429);
    }
    const refused = await post(route.url, route.body, next(route.limit));

    expect(refused.statusCode).toBe(429);
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    expect(getRateLimitStoreSize()).toBe(1);
    expect(getRateLimitLongestKeyLength()).toBeLessThan(64);
  });

  it('login: valid addresses keep a bucket each, apart from the shared one', async () => {
    const login = (forwardedFor: string) => post('/api/auth/login', {}, forwardedFor);

    for (let i = 0; i < LOGIN_RATE_LIMIT.maxAttempts; i++) {
      expect((await login('203.0.113.9')).statusCode).toBe(400);
    }
    expect((await login('203.0.113.9')).statusCode).toBe(429);

    expect((await login('203.0.113.10')).statusCode).toBe(400);
    expect((await login('2001:db8::9')).statusCode).toBe(400);
    expect((await login('not-an-address')).statusCode).toBe(400);
    expect(getRateLimitStoreSize()).toBe(4);
  });

  it('login: the same address with a different port is the same client', async () => {
    // Each attempt arrives from a new connection, so the port is different every time.
    for (let i = 0; i < LOGIN_RATE_LIMIT.maxAttempts; i++) {
      expect((await post('/api/auth/login', {}, `203.0.113.9:${40000 + i}`)).statusCode).toBe(400);
      expect((await post('/api/auth/login', {}, `[2001:db8::7]:${40000 + i}`)).statusCode).toBe(400);
    }

    expect((await post('/api/auth/login', {}, '203.0.113.9:50000')).statusCode).toBe(429);
    expect((await post('/api/auth/login', {}, '[2001:db8::7]:50000')).statusCode).toBe(429);
    expect(getRateLimitStoreSize()).toBe(2);
  });

  it('login: a refused request is answered as before', async () => {
    for (let i = 0; i < LOGIN_RATE_LIMIT.maxAttempts; i++) await post('/api/auth/login', {}, '203.0.113.9');

    const refused = await post('/api/auth/login', {}, '203.0.113.9');

    expect(refused.statusCode).toBe(429);
    expect(parseJsonBody<{ error: string }>(refused.body)).toEqual({
      error: 'Too many login attempts. Please try again later.',
    });
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    expect(refused.headers['x-ratelimit-remaining']).toBe('0');
    expect(Number.isNaN(Date.parse(String(refused.headers['x-ratelimit-reset'])))).toBe(false);
  });
});
