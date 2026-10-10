/**
 * The bodies of the gates' refusals. A 403 keeps the contract SDKs and the
 * dashboard rely on - `error` carries the human-readable reason (they surface
 * `body.error`) - and the structured fields are additive. The 503 of an engine
 * that could not decide has a fixed shape of its own and names no detail.
 *
 * The HTTP-level behaviour (the same refusals answered by the real gates, in the
 * dialect of each API) is in api/iam-enforce-gate.test.ts; this pins the builders
 * and the counting of the unavailable refusals.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logger = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/core/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/core/logger')>();
  return { ...actual, createLogger: () => logger };
});

import { serviceDenialReason } from '@/lib/iam/denialReason';
import {
  AUTHORIZATION_UNAVAILABLE_MESSAGE,
  forbiddenBody,
  getEnforceStats,
  getTenantEnforceStats,
  recordAuthorizationUnavailable,
  recordUndeclaredDenial,
  resetEnforceStatsForTests,
  undeclaredRouteBody,
  unavailableBody,
  type EnforceDecision,
} from '@/lib/iam/enforce';
import { RBAC_SERVICE_DEFINITIONS, SERVICE_PERMISSION_LEVELS } from '@/lib/security/rbac';

type Denial = Extract<EnforceDecision, { allowed: false; source: 'engine' }>;

const denial = (service: Denial['service'], required: Denial['required']): Denial => ({
  allowed: false,
  source: 'engine',
  service,
  required,
  decisionId: 'dec-0001',
});

describe('serviceDenialReason', () => {
  it('is the sentence the API has always answered a service refusal with', () => {
    expect(serviceDenialReason('mcp', 'write')).toBe('Forbidden: mcp requires write permission');
    expect(serviceDenialReason('ldap', 'admin')).toBe('Forbidden: ldap requires admin permission');
  });
});

describe('forbiddenBody (engine denial)', () => {
  it('error and message are the reason sentence; code, service, required and decisionId are additive', () => {
    expect(forbiddenBody(denial('mcp', 'write'))).toEqual({
      error: 'Forbidden: mcp requires write permission',
      code: 'forbidden',
      message: 'Forbidden: mcp requires write permission',
      service: 'mcp',
      required: 'write',
      decisionId: 'dec-0001',
    });
  });

  it('never leaks the audit-only detail of the decision (action, project, reasons, policy ids)', () => {
    const withDetail: Denial = {
      ...denial('agents', 'admin'),
      action: 'agents.admin',
      projectId: 'p1',
      reasons: ['custom:secret-policy'],
      policyIds: ['secret-policy'],
    };
    const body = forbiddenBody(withDetail);
    expect(Object.keys(body).sort()).toEqual(['code', 'decisionId', 'error', 'message', 'required', 'service']);
    expect(JSON.stringify(body)).not.toContain('secret-policy');
  });

  it('for every service and level, `error` is the one sentence denialReason.ts builds', () => {
    for (const { id } of RBAC_SERVICE_DEFINITIONS) {
      for (const level of SERVICE_PERMISSION_LEVELS) {
        const body = forbiddenBody(denial(id, level));
        expect(body.error).toBe(serviceDenialReason(id, level));
        expect(body.message).toBe(body.error);
        expect(body.error).toBe(`Forbidden: ${id} requires ${level} permission`);
      }
    }
  });
});

describe('a denial on the `license` service is not a licence problem', () => {
  // The dashboard turns a 403 into a "License required" notice when `error === 'Forbidden'` and `message` mentions the
  // licence (components/providers/LicenseErrorHandler.tsx). The permission service named `license` must not trip it.
  const looksLikeLicenseError = (body: Record<string, unknown>) =>
    body.error === 'Forbidden' && typeof body.message === 'string' && body.message.toLowerCase().includes('license');

  it('the matcher reads a real licence refusal as one (the check is the one the dashboard makes)', () => {
    expect(looksLikeLicenseError({ error: 'Forbidden', message: 'This feature needs an Enterprise license' })).toBe(true);
  });

  it('the denial of the license service carries the whole sentence in `error`, so it does not match', () => {
    for (const required of ['read', 'write', 'admin'] as const) {
      const body = forbiddenBody(denial('license', required));
      expect(body.error).toBe(`Forbidden: license requires ${required} permission`);
      expect(looksLikeLicenseError(body), required).toBe(false);
    }
  });

  it('neither does the refusal of an undeclared route or an unavailable engine', () => {
    expect(looksLikeLicenseError(undeclaredRouteBody())).toBe(false);
    expect(looksLikeLicenseError(unavailableBody('dec-0003'))).toBe(false);
  });
});

describe('undeclaredRouteBody (route_not_declared)', () => {
  it('error carries the reason itself, the same sentence as message', () => {
    expect(undeclaredRouteBody()).toEqual({
      error: 'Forbidden: this route has no authorization declaration',
      code: 'route_not_declared',
      message: 'Forbidden: this route has no authorization declaration',
    });
  });
});

describe('unavailableBody (authorization_unavailable)', () => {
  it('is exactly { error, code, decisionId } with a fixed message - nothing about what failed', () => {
    expect(AUTHORIZATION_UNAVAILABLE_MESSAGE).toBe('Authorization is temporarily unavailable');
    expect(unavailableBody('dec-0002')).toEqual({
      error: 'Authorization is temporarily unavailable',
      code: 'authorization_unavailable',
      decisionId: 'dec-0002',
    });
    expect(Object.keys(unavailableBody('x')).sort()).toEqual(['code', 'decisionId', 'error']);
  });
});

describe('recordAuthorizationUnavailable', () => {
  beforeEach(() => {
    resetEnforceStatsForTests();
    logger.error.mockClear();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-10T10:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('mints a fresh decision id every time', () => {
    const ids = new Set(Array.from({ length: 50 }, () => recordAuthorizationUnavailable('t', 'engine_unavailable', new Error('x'), {})));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('counts per process and per workspace and keeps the last coarse reason and time - never the error', () => {
    recordAuthorizationUnavailable('tenant_a', 'engine_unavailable', new Error('connect ECONNREFUSED 10.1.2.3:27017'), { route: '/api/x' });
    vi.setSystemTime(new Date('2026-10-10T10:00:05.000Z'));
    recordAuthorizationUnavailable('tenant_a', 'principal_unavailable', 'a string error', {});
    recordAuthorizationUnavailable('tenant_b', 'evaluation_error', undefined, {});

    expect(getEnforceStats()).toMatchObject({
      unavailable: 3, engineDecisions: 0, lastUnavailableReason: 'evaluation_error', lastUnavailableAt: '2026-10-10T10:00:05.000Z',
    });
    expect(getTenantEnforceStats('tenant_a')).toMatchObject({ unavailable: 2, lastUnavailableReason: 'principal_unavailable' });
    expect(getTenantEnforceStats('tenant_b')).toMatchObject({ unavailable: 1, lastUnavailableReason: 'evaluation_error' });
    expect(getTenantEnforceStats('tenant_c').unavailable).toBe(0);
    expect(JSON.stringify([getEnforceStats(), getTenantEnforceStats('tenant_a')])).not.toContain('10.1.2.3');
  });

  it('logs the first refusal with the decision id and the error, then at most once per 10 seconds - every refusal is still counted', () => {
    const first = recordAuthorizationUnavailable('t', 'engine_unavailable', new Error('boom'), { route: '/api/x', requestId: 'r1' });
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][1]).toMatchObject({ tenantDbName: 't', decisionId: first, reason: 'engine_unavailable', error: 'boom', route: '/api/x', requestId: 'r1' });

    for (let i = 0; i < 20; i++) recordAuthorizationUnavailable('t', 'engine_unavailable', new Error('boom'), {});
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(getEnforceStats().unavailable).toBe(21);

    vi.setSystemTime(new Date('2026-10-10T10:00:10.001Z'));
    recordAuthorizationUnavailable('t', 'engine_unavailable', new Error('boom'), {});
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it('bounds what a log line carries of the error', () => {
    recordAuthorizationUnavailable('t', 'engine_unavailable', new Error('x'.repeat(5000)), {});
    expect((logger.error.mock.calls[0][1] as { error: string }).error).toHaveLength(500);
  });
});

describe('recordUndeclaredDenial', () => {
  beforeEach(() => resetEnforceStatsForTests());

  it('counts the refusal of an undeclared route, per workspace too', () => {
    recordUndeclaredDenial('tenant_a', { route: '/api/new' });
    recordUndeclaredDenial('tenant_a', { route: '/api/new' });
    expect(getEnforceStats().undeclaredDenies).toBe(2);
    expect(getTenantEnforceStats('tenant_a').undeclaredDenies).toBe(2);
    expect(getTenantEnforceStats('tenant_b').undeclaredDenies).toBe(0);
  });
});
