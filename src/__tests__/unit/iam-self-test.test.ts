/**
 * The self-test of the authorization engine (src/lib/iam/selfTest.ts).
 *
 * The engine decides every request of every workspace, so a process that cannot
 * run it must not serve: the server runs `engineSelfTest()` while it boots and
 * exits when it fails, and the readiness report carries `engineHealth()`. The
 * test needs no database - it proves Cedar loads, the schema and the managed set
 * load and type-check, and a few canned decisions come out right.
 *
 * Failures are injected by wrapping the pieces the test reaches into.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The first decision of a file loads the Cedar WASM module and builds the schema; on a busy machine the default 5 s is too tight.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const flags = vi.hoisted(() => ({
  cedarThrows: false,
  schemaFails: false,
  managedInvalid: false,
  managedSetFails: false,
  /** Flip the answer of every canned decision, or of the ones for this action only. */
  flipAll: false,
  flipAction: null as string | null,
  databaseTouched: 0,
}));

vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  const touched = () => {
    flags.databaseTouched++;
    throw new Error('the self-test must not use the database');
  };
  return { ...actual, getDatabase: touched, runWithTenantScope: touched };
});
vi.mock('@/lib/iam/cedar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/iam/cedar')>();
  return {
    ...actual,
    getCedarVersion: () => {
      if (flags.cedarThrows) throw new Error('the Cedar WASM module is missing');
      return actual.getCedarVersion();
    },
    statefulIsAuthorized: (input: Parameters<typeof actual.statefulIsAuthorized>[0]) => {
      const decision = actual.statefulIsAuthorized(input);
      if (decision.ok && (flags.flipAll || (flags.flipAction && input.action.id === flags.flipAction))) {
        return { ...decision, allowed: !decision.allowed };
      }
      return decision;
    },
  };
});
vi.mock('@/lib/iam/schemaState', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/iam/schemaState')>();
  return {
    ...actual,
    ensureSchemaPreparsed: () => (flags.schemaFails ? { ok: false as const, errors: ['unexpected token'] } : actual.ensureSchemaPreparsed()),
    validateAgainstSchema: (policies: Record<string, string>) =>
      flags.managedInvalid ? { valid: false, errors: [{ message: 'attribute `readSvcs` not found' }] } : actual.validateAgainstSchema(policies),
  };
});
vi.mock('@/lib/iam/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/iam/engine')>();
  return {
    ...actual,
    ensureManagedPolicySet: () => (flags.managedSetFails ? { ok: false as const, error: 'the managed policy set failed to load' } : actual.ensureManagedPolicySet()),
  };
});

import { recordAuthorizationUnavailable, resetEnforceStatsForTests } from '@/lib/iam/enforce';
import { engineHealth, engineProbe, engineSelfTest } from '@/lib/iam/selfTest';

beforeEach(() => {
  Object.assign(flags, { cedarThrows: false, schemaFails: false, managedInvalid: false, managedSetFails: false, flipAll: false, flipAction: null, databaseTouched: 0 });
  resetEnforceStatsForTests();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('engineSelfTest', () => {
  it('passes on a working engine, reporting what it checked', () => {
    const result = engineSelfTest();
    expect(result).toMatchObject({ ok: true, checks: 13, cedar: { sdk: expect.any(String), language: expect.any(String) } });
    if (result.ok) {
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.durationMs).toBeLessThan(5_000);
    }
  });

  it('is synchronous and needs no database', () => {
    const result = engineSelfTest();
    expect(result).not.toBeInstanceOf(Promise);
    expect(flags.databaseTouched).toBe(0);
  });

  it('fails when Cedar cannot be loaded - and says so instead of throwing', () => {
    flags.cedarThrows = true;
    expect(engineSelfTest()).toEqual({ ok: false, error: 'the Cedar WASM module is missing' });
  });

  it('fails when the schema does not load', () => {
    flags.schemaFails = true;
    expect(engineSelfTest()).toEqual({ ok: false, error: 'the schema does not load: unexpected token' });
  });

  it('fails when the managed policies do not match the schema', () => {
    flags.managedInvalid = true;
    expect(engineSelfTest()).toEqual({ ok: false, error: 'the managed policies do not match the schema: attribute `readSvcs` not found' });
  });

  it('fails when the managed policy set cannot be loaded', () => {
    flags.managedSetFails = true;
    expect(engineSelfTest()).toEqual({ ok: false, error: 'the managed policy set failed to load' });
  });

  it('fails when a canned decision comes out wrong, naming it', () => {
    flags.flipAll = true;
    const result = engineSelfTest();
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBe('a canned decision is wrong - admin reads models: expected allow, got deny');
  });

  it.each([
    ['models.read', 'admin reads models', 'allow', 'deny'],
    ['agents.write', 'member writes agents', 'allow', 'deny'],
    ['members.write', 'member cannot change members', 'deny', 'allow'],
    ['models.write', 'unscoped token acts as its owner', 'allow', 'deny'],
    ['agents.read', 'scoped token stops at its scope', 'deny', 'allow'],
    ['portal.use', 'a listed person opens a portal', 'allow', 'deny'],
    ['agent.invoke', 'a listed person runs an agent in a portal', 'allow', 'deny'],
  ])('notices when %s is decided the wrong way (%s)', (action, name, expected, got) => {
    flags.flipAction = action;
    const result = engineSelfTest();
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(`${name}: expected ${expected}, got ${got}`);
  });
});

describe('the portal rules in the self-test', () => {
  it('proves the access list decides: the listed and the grouped in, an unlisted admin and a token out - with no rule erroring', () => {
    // runCanned fails the test on ANY evaluation error, so a managed portal rule that cannot be evaluated is caught at boot
    expect(engineSelfTest()).toMatchObject({ ok: true });
    expect(engineProbe()).toEqual({ ok: true });
  });
});

describe('engineProbe', () => {
  it('re-runs the canned decisions only', () => {
    expect(engineProbe()).toEqual({ ok: true });
    expect(flags.databaseTouched).toBe(0);
  });

  it('reports a wrong decision or an unloadable set, without throwing', () => {
    flags.flipAll = true;
    expect(engineProbe()).toEqual({ ok: false, error: 'a canned decision is wrong - admin reads models: expected allow, got deny' });
    flags.flipAll = false;
    flags.managedSetFails = true;
    expect(engineProbe()).toEqual({ ok: false, error: 'the managed policy set failed to load' });
  });
});

describe('engineHealth (the engine\'s entry in GET /api/health/ready)', () => {
  it('is ok when the probe passes and nothing was refused lately', () => {
    const health = engineHealth();
    expect(health.status).toBe('ok');
    expect(health.message).toBeUndefined();
    expect(health.details).toEqual({ cedar: expect.objectContaining({ loaded: true }), unavailableRecently: false, skippedStatements: 0 });
  });

  it('is down when the probe fails', () => {
    flags.flipAll = true;
    expect(engineHealth()).toMatchObject({ status: 'down', message: expect.stringContaining('a canned decision is wrong') });
  });

  it('is degraded for a minute after a request was refused because authorization was unavailable', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-10T10:00:00.000Z'));
    expect(engineHealth().status).toBe('ok');

    recordAuthorizationUnavailable('tenant_a', 'engine_unavailable', new Error('boom'), {});
    expect(engineHealth()).toMatchObject({
      status: 'degraded',
      message: 'Requests were refused recently because authorization was unavailable',
      details: { unavailableRecently: true },
    });

    vi.setSystemTime(new Date('2026-10-10T10:00:59.000Z'));
    expect(engineHealth().status).toBe('degraded');
    vi.setSystemTime(new Date('2026-10-10T10:01:01.000Z'));
    expect(engineHealth()).toMatchObject({ status: 'ok', details: { unavailableRecently: false } });
  });

  it('a failing probe wins over a recent refusal', () => {
    recordAuthorizationUnavailable('tenant_a', 'engine_unavailable', new Error('boom'), {});
    flags.managedSetFails = true;
    expect(engineHealth().status).toBe('down');
  });

  it('is a public report: the status and a few facts about the process - no counters, no workspace data', () => {
    recordAuthorizationUnavailable('tenant_secret_name', 'principal_unavailable', new Error('connect ECONNREFUSED 10.1.2.3:27017'), { route: '/api/x' });
    const health = engineHealth();
    expect(Object.keys(health.details).sort()).toEqual(['cedar', 'skippedStatements', 'unavailableRecently']);
    const text = JSON.stringify(health);
    expect(text).not.toContain('tenant_secret_name');
    expect(text).not.toContain('10.1.2.3');
    expect(text).not.toContain('principal_unavailable');
  });
});
