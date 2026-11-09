/**
 * The judge's own circuit breaker with the REAL resilience layer: a safety refusal
 * by the judge model's provider is a verdict on the content, so it never counts
 * toward opening the circuit (otherwise a few refused messages would take the
 * judge down for everyone). A genuine outage still does.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const gateway = {
  requestTimeoutMs: 1_000,
  retryEnabled: false,
  retryMaxAttempts: 1,
  retryInitialDelayMs: 1,
  circuitBreakerEnabled: true,
  circuitBreakerThreshold: 3,
  circuitBreakerResetMs: 60_000,
};
vi.mock('@/lib/core/config', () => ({ getConfig: () => ({ gateway }) }));
vi.mock('@/lib/core/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));
vi.mock('@/lib/services/models/gatewayCore', () => ({ executeModelCall: vi.fn() }));
vi.mock('@/enterprise/managed-credits', () => ({ isManagedModel: () => false }));
vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/services/models/runtimeService', () => ({ buildModelRuntime: vi.fn() }));
vi.mock('@/lib/core/asyncTask', () => ({ fireAndForget: vi.fn() }));
vi.mock('@/lib/services/models/usageLogger', () => ({ logModelUsage: vi.fn() }));

import { getDatabase } from '@/lib/database';
import { buildModelRuntime } from '@/lib/services/models/runtimeService';
import { getAllCircuitStates, resetAllCircuits } from '@/lib/core/resilience';
import { runCustomPromptPolicy } from '@/lib/services/guardrail/llmEvaluator';

const CTX = { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', projectId: 'proj-1', modelKey: 'judge-model', failMode: 'closed' as const };

function prime(complete: ReturnType<typeof vi.fn>) {
  (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue({
    switchToTenant: vi.fn(),
    findModelByKey: vi.fn().mockResolvedValue({ category: 'llm', tenantId: 'tenant-1', providerKey: 'p', modelId: 'm', settings: {} }),
  });
  (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({
    runtime: { createNativeChatClient: vi.fn().mockResolvedValue({ complete }) },
  });
}

const judgeCircuits = () => [...getAllCircuitStates().entries()].filter(([key]) => key.startsWith('guardrail:'));

beforeEach(() => {
  vi.clearAllMocks();
  resetAllCircuits();
});

describe('judge circuit breaker', () => {
  it('threshold + 1 refusals leave the circuit closed: the next call still reaches the model', async () => {
    const refusal = Object.assign(new Error('filtered'), { status: 400, code: 'content_filter' });
    const complete = vi.fn().mockRejectedValue(refusal);
    prime(complete);

    for (let i = 0; i < gateway.circuitBreakerThreshold + 1; i += 1) {
      const findings = await runCustomPromptPolicy('hello', 'rule', CTX, 'block');
      expect(findings[0].message).toContain('safety filter refused to evaluate');
    }
    expect(judgeCircuits().every(([, state]) => state.state === 'closed' && state.failures === 0)).toBe(true);

    complete.mockResolvedValue({ content: '{"passed": true, "reason": "ok"}', usage: {} });
    expect(await runCustomPromptPolicy('hello', 'rule', CTX, 'block')).toEqual([]);
    expect(complete).toHaveBeenCalledTimes(gateway.circuitBreakerThreshold + 2);
  });

  it('control: the same number of 503s opens it, and the judge stops calling the model', async () => {
    const complete = vi.fn().mockRejectedValue(Object.assign(new Error('overloaded'), { status: 503 }));
    prime(complete);

    for (let i = 0; i < gateway.circuitBreakerThreshold; i += 1) {
      await runCustomPromptPolicy('hello', 'rule', CTX, 'block');
    }
    expect(judgeCircuits().some(([, state]) => state.state === 'open')).toBe(true);
    await runCustomPromptPolicy('hello', 'rule', CTX, 'block');
    expect(complete).toHaveBeenCalledTimes(gateway.circuitBreakerThreshold);
  });
});
