import { afterEach, describe, expect, it, beforeEach, vi } from 'vitest';
import type { IModel } from '@/lib/database';
import { resetAllCircuits, withResilience } from '@/lib/core/resilience';
import {
  registerManagedCreditsHost,
  resetManagedCreditsHostForTests,
  type ManagedRoute,
  type ManagedRouteQuery,
} from '@/enterprise/managed-credits';
import {
  listReplicas,
  modelForReplica,
  primaryReplicaModel,
  replicaBreakerKey,
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
afterEach(() => resetManagedCreditsHostForTests());

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

describe('primaryReplicaModel', () => {
  it('returns an unpooled model unchanged', () => {
    const plain = model();
    expect(primaryReplicaModel(plain)).toBe(plain);
  });

  it('serves from the first enabled replica in stored order', () => {
    const pooled = model({
      replicas: [
        { providerKey: 'a', modelId: 'x', enabled: false },
        { providerKey: 'b', modelId: 'y' },
        { providerKey: 'c', modelId: 'z' },
      ],
    });
    expect(primaryReplicaModel(pooled)).toMatchObject({ providerKey: 'b', modelId: 'y' });
  });
});

describe('a managed model', () => {
  const managedModel = (overrides: Partial<IModel> = {}) => model({
    key: 'managed.m',
    providerKey: 'managed',
    providerDriver: 'managed-driver',
    modelId: 'public-id',
    ...overrides,
  });
  const routeA: ManagedRoute = { id: 'route-a', connectionId: 'conn-a', driver: 'driver-a' };
  const routeB: ManagedRoute = { id: 'route-b', connectionId: 'conn-b', driver: 'driver-b', modelId: 'upstream-b', settings: { mode: 'x' }, weight: 3 };

  const installHost = (routes: ManagedRoute[] | (() => ManagedRoute[])) => {
    const listRoutes = vi.fn((_query: ManagedRouteQuery) => (typeof routes === 'function' ? routes() : routes));
    registerManagedCreditsHost({ isManagedProvider: (ref) => ref.key === 'managed', reserve: vi.fn(), listRoutes });
    return listRoutes;
  };

  it('takes its replicas from the host routes, with driver, route id and connection id', () => {
    const listRoutes = installHost([routeA, routeB]);

    expect(listReplicas(managedModel())).toEqual([
      { index: 0, providerKey: 'managed', modelId: 'public-id', weight: 1, driver: 'driver-a', routeId: 'route-a', connectionId: 'conn-a' },
      {
        index: 1, providerKey: 'managed', modelId: 'upstream-b', weight: 3, settings: { mode: 'x' },
        driver: 'driver-b', routeId: 'route-b', connectionId: 'conn-b',
      },
    ]);
    expect(listRoutes).toHaveBeenCalledWith({ providerKey: 'managed', modelKey: 'managed.m', modelId: 'public-id', kind: 'chat' });
  });

  it('asks for an embedding route for an embedding model', () => {
    const listRoutes = installHost([routeA]);
    listReplicas(managedModel({ category: 'embedding' }));
    expect(listRoutes).toHaveBeenCalledWith(expect.objectContaining({ kind: 'embedding' }));
  });

  it('ignores stored replicas', () => {
    installHost([routeA]);
    const replicas = listReplicas(managedModel({ replicas: [{ providerKey: 'other', modelId: 'x', weight: 1 }] }));
    expect(replicas.map((r) => r.routeId)).toEqual(['route-a']);
  });

  it('has an empty pool when the host has no live route, no listRoutes or throws', () => {
    installHost([]);
    expect(listReplicas(managedModel())).toEqual([]);
    expect(replicaOrder(managedModel(), 'chat', Math.random, 'db')).toEqual([]);

    registerManagedCreditsHost({ isManagedProvider: () => true, reserve: vi.fn() });
    expect(listReplicas(managedModel())).toEqual([]);

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    installHost(() => { throw new Error('boom'); });
    expect(listReplicas(managedModel())).toEqual([]);
    spy.mockRestore();
  });

  it('is served by its own record when the pool is empty (primaryReplicaModel is unchanged)', () => {
    installHost([]);
    const plain = managedModel();
    expect(primaryReplicaModel(plain)).toBe(plain);
  });

  it('modelForReplica swaps the driver, the upstream model id and the settings of a route', () => {
    installHost([routeB]);
    const base = managedModel();
    const swapped = modelForReplica(base, listReplicas(base)[0]);
    expect(swapped).toMatchObject({
      providerKey: 'managed', providerDriver: 'driver-b', modelId: 'upstream-b', key: 'managed.m',
      settings: { temperature: 0.2, mode: 'x' },
    });
    // A route is never short-circuited, even when it names the model's own provider and id.
    const same = modelForReplica(base, { index: 0, providerKey: 'managed', modelId: 'public-id', weight: 1, routeId: 'route-a', driver: 'driver-a', connectionId: 'conn-a' });
    expect(same).not.toBe(base);
    expect(same.providerDriver).toBe('driver-a');
    expect(primaryReplicaModel(base).providerDriver).toBe('driver-b');
  });
});

describe('replicaBreakerKey', () => {
  it('keys an ordinary replica by tenant, provider and model, and a route by its route id', () => {
    expect(replicaBreakerKey('chat', 'db1', { providerKey: 'a', modelId: 'x' })).toBe('chat:db1:a:x');
    expect(replicaBreakerKey('chat-stream', 'db1', { providerKey: 'managed', modelId: 'public', routeId: 'route-a' }))
      .toBe('chat-stream:db1:managed:route-a');
  });

  it('is the key the cooling order reads: a tripped route goes to the back, a tripped other tenant does not', async () => {
    registerManagedCreditsHost({
      isManagedProvider: (ref) => ref.key === 'managed',
      reserve: vi.fn(),
      listRoutes: () => [
        { id: 'route-a', connectionId: 'conn-a', driver: 'driver-a' },
        { id: 'route-b', connectionId: 'conn-b', driver: 'driver-b' },
      ],
    });
    const base = model({ key: 'managed.m', providerKey: 'managed', providerDriver: 'managed-driver', modelId: 'public-id' });
    const [routeA] = listReplicas(base);

    // The gateway trips the breaker with exactly this key.
    await expect(withResilience(
      async () => { throw Object.assign(new Error('down'), { status: 503 }); },
      {
        key: replicaBreakerKey('chat', 'tenant_db', routeA),
        retry: { enabled: false },
        circuitBreaker: { enabled: true, threshold: 1, resetMs: 60_000 },
      },
    )).rejects.toThrow('down');

    expect(replicaOrder(base, 'chat', () => 0, 'tenant_db').map((r) => r.routeId)).toEqual(['route-b', 'route-a']);
    // Another tenant's pool, or the other prefix, is unaffected.
    expect(replicaOrder(base, 'chat', () => 0, 'other_db').map((r) => r.routeId)).toEqual(['route-a', 'route-b']);
    expect(replicaOrder(base, 'chat-stream', () => 0, 'tenant_db').map((r) => r.routeId)).toEqual(['route-a', 'route-b']);
  });
});
