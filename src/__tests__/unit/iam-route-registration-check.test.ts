/**
 * The registration-time check (assertRouteDeclared, called by the onRoute hook of
 * fastifyApiPlugin): an /api route nothing declares stops the app from building
 * under test / AUTHZ_STRICT_REGISTRATION=1, and is only logged otherwise (the
 * request-time gate already refuses it, a production server must never fail to boot over it).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';

const routeLogger = vi.hoisted(() => ({
  error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), log: vi.fn(),
}));

vi.mock('@/lib/core/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/core/logger')>();
  return {
    ...actual,
    createLogger: (scope: string, ...rest: unknown[]) => (scope === 'api:routes'
      ? routeLogger
      : (actual.createLogger as (...args: unknown[]) => unknown)(scope, ...rest)),
  };
});

import { authz } from '@/lib/iam/routeAuthz';
import { assertRouteDeclared } from '@/lib/iam/routeRegistry';
import { isStrictRouteRegistration, UNDECLARED_ROUTE_EXCEPTIONS } from '@/lib/iam/routeDeclarationRules';
import { getConfig, reloadConfig } from '@/lib/core/config';
import { enterpriseApiPlugins } from '@/enterprise/registry';
import { fastifyApiPlugin } from '@/server/api/plugin';

afterEach(() => {
  vi.unstubAllEnvs();
  reloadConfig();
  routeLogger.error.mockClear();
});

describe('isStrictRouteRegistration', () => {
  it('is on under test and with AUTHZ_STRICT_REGISTRATION=1, off otherwise', () => {
    expect(isStrictRouteRegistration({ nodeEnv: 'test', iam: { strictRegistration: false } })).toBe(true);
    expect(isStrictRouteRegistration({ nodeEnv: 'production', iam: { strictRegistration: true } })).toBe(true);
    expect(isStrictRouteRegistration({ nodeEnv: 'development', iam: { strictRegistration: true } })).toBe(true);
    expect(isStrictRouteRegistration({ nodeEnv: 'production', iam: { strictRegistration: false } })).toBe(false);
    expect(isStrictRouteRegistration({ nodeEnv: 'development', iam: { strictRegistration: false } })).toBe(false);
    expect(isStrictRouteRegistration({ nodeEnv: 'production' })).toBe(false);
  });

  it('reads the environment through the configuration', () => {
    expect(isStrictRouteRegistration()).toBe(true); // vitest runs with NODE_ENV=test
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AUTHZ_STRICT_REGISTRATION', '');
    reloadConfig();
    expect(isStrictRouteRegistration()).toBe(false);
    vi.stubEnv('AUTHZ_STRICT_REGISTRATION', '1');
    reloadConfig();
    expect(isStrictRouteRegistration()).toBe(true);
    expect(getConfig().iam.strictRegistration).toBe(true);
  });
});

describe('assertRouteDeclared', () => {
  const report = vi.fn();
  afterEach(() => report.mockClear());

  it('throws in strict mode for a route nothing declares', () => {
    expect(() => assertRouteDeclared({ method: 'GET', url: '/api/zz-nothing/:id', config: undefined }, { strict: true, report }))
      .toThrow(/GET \/api\/zz-nothing\/:id is not declared/);
    expect(report).not.toHaveBeenCalled();
  });

  it('only reports when strict is off, and returns the problem', () => {
    const problem = assertRouteDeclared({ method: ['GET', 'HEAD'], url: '/api/zz-nothing', config: undefined }, { strict: false, report });
    expect(problem).toMatch(/GET,HEAD \/api\/zz-nothing is not declared/);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(problem, { method: 'GET,HEAD', url: '/api/zz-nothing' });
  });

  it('accepts an explicit declaration of any kind, and a prefix-mapped path', () => {
    for (const config of [authz.public(), authz.authenticated(), authz.self('verifies a signed link itself'), authz.service('agents')]) {
      expect(assertRouteDeclared({ method: 'POST', url: '/api/zz-nothing', config }, { strict: true, report })).toBeNull();
    }
    expect(assertRouteDeclared({ method: 'GET', url: '/api/agents/:id', config: undefined }, { strict: true, report })).toBeNull();
    expect(assertRouteDeclared({ method: 'GET', url: '/api/client/v1/models', config: { rawBody: true } }, { strict: true, report })).toBeNull();
    expect(report).not.toHaveBeenCalled();
  });

  it('treats a malformed declaration like none', () => {
    expect(() => assertRouteDeclared({ method: 'GET', url: '/api/zz-nothing', config: { authz: { kind: 'service', service: 'nope' } } }, { strict: true, report }))
      .toThrow(/not declared/);
  });

  it('skips what is outside /api and the exception list, and what the caller exempts', () => {
    expect(assertRouteDeclared({ method: 'GET', url: '/_next/zz', config: undefined }, { strict: true, report })).toBeNull();
    for (const url of ['/api/health/live', '/api/public/zz/:slug', '/api/gpu/agent/zz', '/api/sandbox/agent/zz']) {
      expect(assertRouteDeclared({ method: 'GET', url, config: undefined }, { strict: true, report }), url).toBeNull();
    }
    expect(UNDECLARED_ROUTE_EXCEPTIONS.length).toBeGreaterThan(0);
    for (const entry of UNDECLARED_ROUTE_EXCEPTIONS) expect(entry.reason.length).toBeGreaterThan(10);
    expect(assertRouteDeclared({ method: 'GET', url: '/api/zz-nothing', config: undefined }, { strict: true, report, isExempt: (p) => p === '/api/zz-nothing' })).toBeNull();
    expect(report).not.toHaveBeenCalled();
  });
});

describe('the onRoute hook of the API plugin', () => {
  async function buildWithExtraRoute(path: string, config?: unknown): Promise<void> {
    const registrar = (app: import('fastify').FastifyInstance) => {
      app.get(path, { config: config as never }, async () => ({ ok: true }));
    };
    enterpriseApiPlugins.push(registrar);
    const app = Fastify({ logger: false });
    try {
      await app.register(cookie);
      await app.register(fastifyApiPlugin, { prefix: '/api' });
      await app.ready();
    } finally {
      enterpriseApiPlugins.splice(enterpriseApiPlugins.indexOf(registrar), 1);
      await app.close();
    }
  }

  it('refuses to build the app under test when a route is undeclared', async () => {
    await expect(buildWithExtraRoute('/zz-undeclared/:id')).rejects.toThrow(/\/api\/zz-undeclared\/:id is not declared/);
    expect(routeLogger.error).not.toHaveBeenCalled();
  }, 60_000);

  it('builds with AUTHZ_STRICT_REGISTRATION off outside test, logging one error for the route', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('AUTHZ_STRICT_REGISTRATION', '');
    reloadConfig();
    await buildWithExtraRoute('/zz-undeclared/:id');
    expect(routeLogger.error).toHaveBeenCalledTimes(1);
    expect(String(routeLogger.error.mock.calls[0][0])).toMatch(/\/api\/zz-undeclared\/:id is not declared/);
  }, 60_000);

  it('throws outside test too when AUTHZ_STRICT_REGISTRATION=1', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('AUTHZ_STRICT_REGISTRATION', '1');
    reloadConfig();
    await expect(buildWithExtraRoute('/zz-undeclared')).rejects.toThrow(/not declared/);
  }, 60_000);

  it('accepts a declared route and a route under a public prefix', async () => {
    await buildWithExtraRoute('/zz-declared', authz.authenticated());
    await buildWithExtraRoute('/public/hooks/zz/:id');
    expect(routeLogger.error).not.toHaveBeenCalled();
  }, 60_000);
});
