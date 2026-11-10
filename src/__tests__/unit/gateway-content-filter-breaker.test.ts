/**
 * A safety-filter refusal is a verdict on the content, not on the provider's health:
 * it does not count against a replica's circuit and is not retried on another replica.
 * REAL provider contracts, scripted network; the breaker is switched on with a small threshold.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeModelCall } from '@/lib/services/models/inferenceService';
import { getAllCircuitStates, resetAllCircuits } from '@/lib/core/resilience';
import type { GatewayChatRequest } from '@/lib/services/models/gatewayTypes';
import { completion, flush, json, openAiRuntime, stubUpstream } from '../helpers/nativeGateway';

vi.mock('@/lib/core/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/core/config')>();
  return {
    ...actual,
    getConfig: () => {
      const config = actual.getConfig();
      return {
        ...config,
        gateway: {
          ...config.gateway,
          retryEnabled: true,
          retryMaxAttempts: 2,
          retryInitialDelayMs: 1,
          circuitBreakerEnabled: true,
          circuitBreakerThreshold: 2,
          circuitBreakerResetMs: 60000,
        },
      };
    },
  };
});
vi.mock('@/lib/services/models/modelService', () => ({ getModelByKey: vi.fn() }));
vi.mock('@/lib/services/models/runtimeService', () => ({ buildModelRuntime: vi.fn() }));
vi.mock('@/lib/services/models/semanticCacheService', () => ({
  buildCacheVariantKey: vi.fn().mockReturnValue('variant-key'),
  isSemanticCacheEnabled: vi.fn().mockReturnValue(false),
  lookupCache: vi.fn().mockResolvedValue({ hit: false, response: null }),
  storeInCache: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/services/models/usageLogger', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/services/models/usageLogger')>();
  return { ...original, logModelUsage: vi.fn().mockResolvedValue(undefined) };
});
vi.mock('@/lib/services/models/dynamicRoutingState', () => ({
  getConversationState: vi.fn().mockResolvedValue({}),
  getConversationCostUsd: vi.fn().mockResolvedValue(0),
  getRouterSpendUsd: vi.fn().mockResolvedValue(0),
  getSegmentIoRatio: vi.fn().mockReturnValue(undefined),
  getModelProfiles: vi.fn().mockResolvedValue(new Map()),
  recordRoutedUsage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/services/guardrail/hooks/recordCache', () => ({ getCachedGuardrail: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/services/guardrail', () => ({
  evaluateGuardrail: vi.fn().mockResolvedValue({
    passed: true, blocked: false, action: 'allow', findings: [], guardrailKey: 'g', guardrailName: 'g',
  }),
  createStreamGate: vi.fn(),
}));

import { getModelByKey } from '@/lib/services/models/modelService';
import { buildModelRuntime } from '@/lib/services/models/runtimeService';


const model = (overrides: object = {}) => ({
  _id: 'm1', tenantId: 'tenant-1', projectId: 'proj-1', name: 'M', key: 'm', providerKey: 'a',
  providerDriver: 'openai', category: 'llm' as const, modelId: 'gpt-4o', settings: {},
  pricing: { inputTokenPer1M: 10, outputTokenPer1M: 30 }, ...overrides,
});
const BASE = { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', projectId: 'proj-1', modelKey: 'm' };
const ASK: GatewayChatRequest = { messages: [{ role: 'user', content: 'hello' }] };
const apiKeyOf = (call: { headers: Record<string, string> }) => call.headers.authorization?.replace('Bearer ', '');
const runtimes = new Map<string, unknown>();

const FILTERED = () => json({
  error: { message: 'The prompt was filtered by the safety policy.', type: 'invalid_request_error', code: 'content_filter' },
}, 400);

const chatCircuits = () => [...getAllCircuitStates().entries()].filter(([key]) => key.startsWith('chat:'));

beforeEach(() => {
  resetAllCircuits();
  runtimes.clear();
  (buildModelRuntime as ReturnType<typeof vi.fn>).mockImplementation(
    async (_db: string, _t: string, providerKey: string) => {
      if (!runtimes.has(providerKey)) runtimes.set(providerKey, await openAiRuntime({}, providerKey));
      return { runtime: runtimes.get(providerKey) };
    },
  );
});
afterEach(() => { resetAllCircuits(); });

describe('a safety refusal and the replica circuit', () => {
  it('does not count against the circuit: the next call still reaches the provider', async () => {
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(model());
    let refuse = true;
    const upstream = stubUpstream(() => (refuse ? FILTERED() : json(completion({ content: 'fine' }))));

    for (let i = 0; i < 4; i += 1) {
      await expect(executeModelCall({ ...BASE, request: ASK })).rejects.toMatchObject({ statusCode: 400 });
    }
    await flush();
    expect(chatCircuits().every(([, state]) => state.state === 'closed' && state.failures === 0)).toBe(true);

    refuse = false;
    const outcome = await executeModelCall({ ...BASE, request: ASK });
    expect(outcome.result?.response.content).toBe('fine');
    expect(upstream.calls).toHaveLength(5);
  });

  it('control: the same number of 503s opens the circuit', async () => {
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(model());
    stubUpstream(() => json({ error: { message: 'overloaded' } }, 503));
    for (let i = 0; i < 2; i += 1) {
      await expect(executeModelCall({ ...BASE, request: ASK })).rejects.toBeTruthy();
    }
    expect(chatCircuits().some(([, state]) => state.state === 'open')).toBe(true);
  });

  it('is not tried on the next replica: the content is the cause, a second route would refuse too', async () => {
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(model({
      replicas: [{ providerKey: 'a', modelId: 'gpt-4o', weight: 1000 }, { providerKey: 'b', modelId: 'gpt-4o', weight: 1 }],
    }));
    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
      const upstream = stubUpstream(() => FILTERED());
      await expect(executeModelCall({ ...BASE, request: ASK })).rejects.toMatchObject({ statusCode: 400 });
      expect(new Set(upstream.calls.map(apiKeyOf))).toEqual(new Set(['a']));
    } finally {
      Math.random = originalRandom;
    }
  });
});
