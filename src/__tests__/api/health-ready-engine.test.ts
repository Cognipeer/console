/**
 * GET /api/health/ready reports the authorization engine (`checks.authorization-engine`,
 * registered by bootstrap once its self-test passed):
 *
 *   ok        the engine answers its canned decisions
 *   degraded  requests were refused recently because authorization was unavailable,
 *             or some custom policy statements could not be loaded
 *   down      the managed rules no longer evaluate (the readiness answer is 503)
 *
 * The endpoint is public, so the check carries a few facts about the process and
 * no counters, tenant names or error detail.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const flags = vi.hoisted(() => ({ managedSetFails: false }));

vi.mock('@/server/bootstrap', () => ({ isApplicationReady: () => true }));
vi.mock('@/lib/database', () => {
  const getDatabase = vi.fn();
  return {
    getDatabase,
    runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(await getDatabase()),
  };
});
vi.mock('@/lib/iam/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/iam/engine')>();
  return {
    ...actual,
    ensureManagedPolicySet: () => (flags.managedSetFails
      ? { ok: false as const, error: 'the managed policy set failed to load' }
      : actual.ensureManagedPolicySet()),
  };
});

import type { FastifyInstance } from 'fastify';
import { registerHealthCheck } from '@/lib/core/health';
import { getDatabase } from '@/lib/database';
import { recordAuthorizationUnavailable, resetEnforceStatsForTests } from '@/lib/iam/enforce';
import { engineHealth } from '@/lib/iam/selfTest';
import { healthApiPlugin } from '@/server/api/plugins/health';
import { createMockDb } from '../helpers/db.mock';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

interface Report {
  status: string;
  checks: Record<string, { status: string; message?: string; details?: Record<string, unknown> }>;
}

let app: FastifyInstance;

beforeAll(() => {
  // exactly what bootstrap registers after the self-test
  registerHealthCheck('authorization-engine', async () => engineHealth());
});

beforeEach(async () => {
  (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(createMockDb());
  flags.managedSetFails = false;
  resetEnforceStatsForTests();
  app = await createFastifyApiTestApp(healthApiPlugin);
});

afterEach(async () => {
  await app.close();
});

const ready = async () => {
  const res = await app.inject({ method: 'GET', url: '/api/health/ready' });
  return { status: res.statusCode, body: parseJsonBody<Report>(res.body) };
};

describe('GET /api/health/ready: authorization-engine', () => {
  it('is ok on a working engine, with facts about the process only', async () => {
    const { status, body } = await ready();
    expect(status).toBe(200);
    expect(body.checks['authorization-engine']).toMatchObject({ status: 'ok' });
    expect(Object.keys(body.checks['authorization-engine'].details ?? {}).sort()).toEqual(['cedar', 'skippedStatements', 'unavailableRecently']);
    expect(body.checks['authorization-engine'].details).toMatchObject({ unavailableRecently: false, skippedStatements: 0 });
  });

  it('is degraded (still ready) while requests were refused recently because authorization was unavailable', async () => {
    recordAuthorizationUnavailable('tenant_health', 'engine_unavailable', new Error('connect ECONNREFUSED 10.1.2.3:27017'), { route: '/api/agents' });
    const { status, body } = await ready();
    expect(status).toBe(200);
    expect(body.status).toBe('degraded');
    expect(body.checks['authorization-engine']).toMatchObject({ status: 'degraded', details: { unavailableRecently: true } });
    // no tenant name, no counter, no error detail on a public endpoint
    const text = JSON.stringify(body.checks['authorization-engine']);
    for (const leaked of ['tenant_health', 'ECONNREFUSED', '10.1.2.3', 'engine_unavailable', 'lastUnavailable']) expect(text).not.toContain(leaked);
  });

  it('is down, and the server not ready (503), when the managed rules no longer evaluate', async () => {
    flags.managedSetFails = true;
    const { status, body } = await ready();
    expect(status).toBe(503);
    expect(body.status).toBe('down');
    expect(body.checks['authorization-engine']).toMatchObject({ status: 'down', message: 'the managed policy set failed to load' });
  });
});
