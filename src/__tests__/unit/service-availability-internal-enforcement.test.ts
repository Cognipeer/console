/**
 * Unit tests — a switched-off service stops on the paths that are not an HTTP
 * request of that service: internal callers, queue consumers, schedulers,
 * outgoing webhooks, and the fail-open guardrail / PII checks.
 *
 * The availability module is mocked at its three decision functions so each
 * test can name the services that are off; the error class stays the real one.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const off = vi.hoisted(() => ({ services: new Map<string, 'env' | 'license'>() }));

vi.mock('@/lib/services/availability/serviceAvailability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/availability/serviceAvailability')>();
  const reason = async (_scope: unknown, service: string) => {
    const source = off.services.get(service);
    return source ? { service, source } : null;
  };
  return {
    ...actual,
    serviceOffReason: reason,
    isServiceEnabled: async (scope: unknown, service: string) => (await reason(scope, service)) === null,
    assertServiceEnabled: async (scope: unknown, service: string) => {
      const found = await reason(scope, service);
      if (found) throw new actual.ServiceDisabledError(found);
    },
    resolveTenantId: async (scope: { tenantId?: string }) => scope.tenantId ?? 't1',
  };
});

const databaseMock = vi.hoisted(() => ({
  db: {
    runWithTenant: undefined as unknown,
    switchToTenant: vi.fn(),
    listTenants: vi.fn(),
    claimWebhookDelivery: vi.fn(),
    updateWebhookDelivery: vi.fn(),
    listWebhookEndpoints: vi.fn(),
  },
}));

vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return {
    ...actual,
    getDatabase: vi.fn(async () => databaseMock.db),
    runWithTenantScope: vi.fn(async (_name: string, fn: (db: unknown) => unknown) => fn(databaseMock.db)),
  };
});

const auditMock = vi.hoisted(() => ({ recordAuditLog: vi.fn(async () => undefined) }));
vi.mock('@/lib/services/audit', () => auditMock);

import { ServiceDisabledError, resetReportedSafetyCheckSkipsForTests } from '@/lib/services/availability/serviceAvailability';
import { buildModelRuntime } from '@/lib/services/models/runtimeService';
import { normalizeInferenceError } from '@/lib/services/models/openaiErrors';
import { MemoryQueueProvider } from '@/lib/core/queue/memoryQueueProvider';
import { deliverWebhookJob, publishWebhookEvent } from '@/lib/services/webhooks/webhookService';
import { runHook } from '@/lib/services/guardrail/hooks/engine';
import { runPiiPolicy } from '@/lib/services/guardrail/families/pii';
import { startAnalysisScheduler, stopAnalysisScheduler } from '@/lib/services/analysis/analysisScheduler';
import { GUARDRAIL_CONTRACT_VERSION } from '@/lib/services/guardrail/hooks/contract';

const cacheMock = vi.hoisted(() => ({
  acquireLock: vi.fn(async () => 'token'),
  releaseLock: vi.fn(async () => undefined),
}));
vi.mock('@/lib/core/cache', () => ({ getCache: vi.fn(async () => ({ name: 'memory', ...cacheMock })) }));

const analysisMock = vi.hoisted(() => ({ runScheduledAnalyses: vi.fn(async () => ({ fired: [] as string[], errors: [] as string[] })) }));
vi.mock('@/lib/services/analysis/service', () => analysisMock);

beforeEach(() => {
  off.services.clear();
  resetReportedSafetyCheckSkipsForTests();
  vi.clearAllMocks();
  databaseMock.db.runWithTenant = (_name: string, fn: () => unknown) => fn();
});

describe('service entry functions', () => {
  it('buildModelRuntime refuses before touching the provider when models is off', async () => {
    off.services.set('models', 'env');
    await expect(buildModelRuntime('tenant_db', 't1', 'openai')).rejects.toMatchObject({
      name: 'ServiceDisabledError', status: 403, code: 'service_disabled', service: 'models',
    });
  });

  it('renders a service refusal with its own status and code, not a 500', () => {
    const licensed = normalizeInferenceError(new ServiceDisabledError({ service: 'models', source: 'license' }));
    expect(licensed.status).toBe(402);
    expect(licensed.error.code).toBe('service_not_licensed');
    const env = normalizeInferenceError(new ServiceDisabledError({ service: 'models', source: 'env' }));
    expect(env.status).toBe(403);
    expect(env.error.code).toBe('service_disabled');
  });
});

describe('queue consumers', () => {
  it('does not run a refused job again', async () => {
    const queue = new MemoryQueueProvider({ attempts: 3, backoffMs: 1 });
    const handler = vi.fn(async () => {
      throw new ServiceDisabledError({ service: 'mcp', source: 'env' });
    });
    await queue.init();
    queue.consume('q', handler, { concurrency: 1 });
    await expect(queue.invoke('q', 'job', {})).rejects.toThrow(/switched off/);
    expect(handler).toHaveBeenCalledTimes(1);
    await queue.destroy();
  });

  it('fails a queued webhook delivery as service_disabled and acknowledges the job', async () => {
    off.services.set('webhooks', 'env');
    databaseMock.db.claimWebhookDelivery.mockResolvedValue({ _id: 'd1', tenantId: 't1' });
    await expect(deliverWebhookJob({ deliveryId: 'd1', tenantDbName: 'tenant_db' })).resolves.toBeUndefined();
    expect(databaseMock.db.updateWebhookDelivery).toHaveBeenCalledWith('d1', expect.objectContaining({
      status: 'failed',
      nextAttemptAt: null,
      lastError: expect.stringContaining('service_disabled'),
    }));
  });
});

describe('outgoing webhooks', () => {
  it('publishes nothing when webhooks is off for the tenant', async () => {
    off.services.set('webhooks', 'license');
    const result = await publishWebhookEvent({ tenantDbName: 'tenant_db', tenantId: 't1', type: 'run.completed' });
    expect(result).toEqual({ eventId: null, deliveries: 0 });
    expect(databaseMock.db.listWebhookEndpoints).not.toHaveBeenCalled();
  });
});

describe('schedulers', () => {
  it('skips a tenant whose service is off without running or advancing anything', async () => {
    vi.useFakeTimers();
    try {
      off.services.set('analysis', 'license');
      databaseMock.db.listTenants.mockResolvedValue([{ _id: 't1', dbName: 'tenant_db', slug: 'acme' }]);
      startAnalysisScheduler();
      await vi.advanceTimersByTimeAsync(7_500);
      expect(databaseMock.db.listTenants).toHaveBeenCalled();
      expect(analysisMock.runScheduledAnalyses).not.toHaveBeenCalled();

      // Back on: the next tick runs it.
      off.services.clear();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(analysisMock.runScheduledAnalyses).toHaveBeenCalledTimes(1);
    } finally {
      stopAnalysisScheduler();
      vi.useRealTimers();
    }
  });
});

describe('guardrails and PII fail open', () => {
  const scope = {
    tenantId: 't1',
    tenantDbName: 'tenant_db',
    actor: { id: 'u1', kind: 'user' as const, roles: [] },
    surface: 'gateway' as const,
    source: 'test',
    traceId: 'trace-1',
  };

  it('lets the call through when guardrails is off and audits the skip once', async () => {
    off.services.set('guardrails', 'env');
    const call = {
      contractVersion: GUARDRAIL_CONTRACT_VERSION,
      hook: 'input.pre',
      subject: { kind: 'text', text: 'hello' },
      scope,
      guardrailKeys: ['g1'],
    } as unknown as Parameters<typeof runHook>[0];

    const first = await runHook(call);
    const second = await runHook(call);
    expect(first.decision).toBe('allow');
    expect(second.decision).toBe('allow');
    await vi.waitFor(() => expect(auditMock.recordAuditLog).toHaveBeenCalledTimes(1));
    expect(auditMock.recordAuditLog).toHaveBeenCalledWith(
      { tenantDbName: 'tenant_db', tenantId: 't1' },
      expect.objectContaining({ event: 'service.safety_check_skipped', service: 'guardrails', actorType: 'system' }),
    );
  });

  it('passes text through unchanged when pii is off', async () => {
    off.services.set('pii', 'license');
    const result = await runPiiPolicy({
      policy: { id: 'p1', family: 'pii', piiPolicyKey: 'default' },
      subject: { kind: 'text', text: 'mail me at a@b.com' },
      hook: 'input.pre',
      scope,
      action: 'redact',
    } as unknown as Parameters<typeof runPiiPolicy>[0]);
    expect(result.findings).toEqual([]);
    expect(result.mutations).toEqual([]);
    await vi.waitFor(() => expect(auditMock.recordAuditLog).toHaveBeenCalledTimes(1));
  });
});
