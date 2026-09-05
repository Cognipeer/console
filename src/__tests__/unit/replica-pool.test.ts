import { describe, expect, it, beforeEach } from 'vitest';
import type { IModel } from '@/lib/database';
import { resetAllCircuits } from '@/lib/core/resilience';
import {
  listReplicas,
  modelForReplica,
  replicaOrder,
  shouldTryNextReplica,
} from '@/lib/services/models/replicaPool';
import { UpstreamRequestError } from '@/lib/providers/contracts/upstreamError';

const model = (overrides: Partial<IModel> = {}) => ({
  _id: 'm1',
  tenantId: 't1',
  projectId: 'p1',
  name: 'GPT-4o',
  key: 'gpt-4o',
  providerKey: 'azure-west',
  providerDriver: 'azure',
  category: 'llm' as const,
  modelId: 'gpt-4o',
  settings: { temperature: 0.2 },
  pricing: { inputTokenPer1M: 1, outputTokenPer1M: 2 },
  ...overrides,
}) as unknown as IModel;

beforeEach(() => resetAllCircuits());

describe('listReplicas', () => {
  it('treats an unpooled model as a pool of one built from its own provider', () => {
    expect(listReplicas(model())).toEqual([
      { index: 0, providerKey: 'azure-west', modelId: 'gpt-4o', weight: 1 },
    ]);
  });

  it('falls back to the model id for a replica that only names a provider', () => {
    const pooled = model({ replicas: [{ providerKey: 'azure-north', modelId: '' }] });
    expect(listReplicas(pooled)[0]).toMatchObject({ providerKey: 'azure-north', modelId: 'gpt-4o' });
  });

  it('drains a disabled replica without deleting it', () => {
    const pooled = model({
      replicas: [
        { providerKey: 'a', modelId: 'x' },
        { providerKey: 'b', modelId: 'y', enabled: false },
      ],
    });
    expect(listReplicas(pooled).map((r) => r.providerKey)).toEqual(['a']);
  });

  it('falls back to the model itself when every replica is disabled', () => {
    const pooled = model({ replicas: [{ providerKey: 'a', modelId: 'x', enabled: false }] });
    expect(listReplicas(pooled)).toHaveLength(1);
    expect(listReplicas(pooled)[0].providerKey).toBe('azure-west');
  });
});

describe('replicaOrder', () => {
  const pooled = model({
    replicas: [
      { providerKey: 'a', modelId: 'x', weight: 3 },
      { providerKey: 'b', modelId: 'y', weight: 1 },
    ],
  });

  it('returns every replica, so the pool doubles as a fallback chain', () => {
    const order = replicaOrder(pooled, 'chat', () => 0.99);
    expect(order.map((r) => r.providerKey).sort()).toEqual(['a', 'b']);
  });

  it('respects weight when picking the first attempt', () => {
    // Draws at the low end of the ticket range land on the heaviest replica.
    expect(replicaOrder(pooled, 'chat', () => 0.01)[0].providerKey).toBe('a');
  });

  it('is a no-op for a single replica', () => {
    expect(replicaOrder(model(), 'chat')).toHaveLength(1);
  });
});

describe('modelForReplica', () => {
  it('swaps provider and model id, and merges the replica settings over the model', () => {
    const swapped = modelForReplica(model(), {
      index: 1,
      providerKey: 'bedrock-eu',
      modelId: 'openai.gpt-oss-120b-1:0',
      weight: 1,
      settings: { azureApiVersion: '2025-04-01-preview' },
    });

    expect(swapped.providerKey).toBe('bedrock-eu');
    expect(swapped.modelId).toBe('openai.gpt-oss-120b-1:0');
    expect(swapped.settings).toEqual({ temperature: 0.2, azureApiVersion: '2025-04-01-preview' });
    // Identity, pricing and category are the MODEL's and must not vary by replica.
    expect(swapped.key).toBe('gpt-4o');
    expect(swapped.pricing).toEqual(model().pricing);
  });

  it('returns the same object when the replica is the model itself', () => {
    const base = model();
    expect(modelForReplica(base, { index: 0, providerKey: 'azure-west', modelId: 'gpt-4o', weight: 1 }))
      .toBe(base);
  });
});

describe('shouldTryNextReplica', () => {
  it('moves on for capacity and availability faults', () => {
    expect(shouldTryNextReplica(new UpstreamRequestError('rate limited', 429))).toBe(true);
    expect(shouldTryNextReplica(new UpstreamRequestError('bad gateway', 502))).toBe(true);
    expect(shouldTryNextReplica(new Error('Circuit breaker is open for "chat:a:b"'))).toBe(true);
    expect(shouldTryNextReplica(new Error('fetch failed'))).toBe(true);
  });

  it('does NOT move on for the caller\'s own mistakes', () => {
    // A 400 fails identically on every replica; retrying multiplies the bill,
    // and a 401 would walk through several sets of provider credentials.
    expect(shouldTryNextReplica(new UpstreamRequestError('bad request', 400))).toBe(false);
    expect(shouldTryNextReplica(new UpstreamRequestError('unauthorized', 401))).toBe(false);
    expect(shouldTryNextReplica(new UpstreamRequestError('not found', 404))).toBe(false);
  });

  it('reads a status nested under error / response / cause', () => {
    expect(shouldTryNextReplica({ response: { status: 503 } })).toBe(true);
    expect(shouldTryNextReplica({ cause: { error: { status: 400 } } })).toBe(false);
  });
});
