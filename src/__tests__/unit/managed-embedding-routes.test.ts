/**
 * Managed embeddings through the operator's routes: the embedder is built from the route's connection and upstream
 * model id, while the reserve identity, the response `model` and the usage row keep the public model. The first
 * route's capacity fault moves to the next one under a single reservation, and a managed failure reaches the caller
 * as a generic message that keeps only the status.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleEmbeddingRequest } from '@/lib/services/models/inferenceService';
import { PlanLimitError } from '@/lib/limits/errors';
import {
  registerManagedCreditsHost,
  resetManagedCreditsHostForTests,
  type ManagedCallInfo,
  type ManagedCreditLease,
  type ManagedRoute,
} from '@/enterprise/managed-credits';
import { flush } from '../helpers/nativeGateway';

vi.mock('@/lib/services/models/modelService', () => ({ getModelByKey: vi.fn() }));
vi.mock('@/lib/services/models/runtimeService', () => ({ buildModelRuntime: vi.fn() }));
vi.mock('@/lib/services/models/usageLogger', () => ({
  logModelUsage: vi.fn().mockResolvedValue(undefined),
  calculateCost: () => ({ currency: 'USD', inputCost: 0, outputCost: 0, cachedCost: 0, cacheWriteCost: 0, totalCost: 0 }),
}));

import { getModelByKey } from '@/lib/services/models/modelService';
import { buildModelRuntime } from '@/lib/services/models/runtimeService';
import { logModelUsage } from '@/lib/services/models/usageLogger';

const poolModel = () => ({
  _id: 'm1',
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  name: 'Embed',
  key: 'managed.embed',
  providerKey: 'managed',
  providerDriver: 'virtual',
  category: 'embedding' as const,
  modelId: 'embed-public',
  settings: {},
});

const ROUTE_A: ManagedRoute = { id: 'route-a', connectionId: 'conn-a', driver: 'up-a', modelId: 'upstream-a' };
const ROUTE_B: ManagedRoute = { id: 'route-b', connectionId: 'conn-b', driver: 'up-b', modelId: 'upstream-b', settings: { dimensions: 64 } };

let routes: ManagedRoute[] = [];
let reserveCalls: ManagedCallInfo[] = [];
let lease: ManagedCreditLease & { settle: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };

function installHost(options: { refuse?: Error } = {}) {
  const reserve = vi.fn(async (call: ManagedCallInfo) => {
    reserveCalls.push(call);
    if (options.refuse) throw options.refuse;
    return lease;
  });
  registerManagedCreditsHost({
    isManagedProvider: (ref) => ref.key === 'managed',
    reserve,
    listRoutes: () => routes,
  });
  return reserve;
}

/** One embedder per connection, so a test can see which route a call went through. */
function wireEmbedders(embeds: Record<string, ReturnType<typeof vi.fn>>) {
  const built: Array<{ connectionId?: string; modelId: string; settings: unknown }> = [];
  (buildModelRuntime as ReturnType<typeof vi.fn>).mockImplementation(
    async (_db: string, _tenant: string, _key: string, _project: string, options?: { managedConnectionId?: string }) => ({
      record: { key: 'managed', driver: 'virtual', type: 'embedding' },
      runtime: {
        createNativeEmbedder: vi.fn(async (config: { modelId: string; modelSettings: unknown }) => {
          built.push({ connectionId: options?.managedConnectionId, modelId: config.modelId, settings: config.modelSettings });
          return { embed: embeds[options?.managedConnectionId ?? ''] };
        }),
      },
    }),
  );
  return built;
}

const call = () => handleEmbeddingRequest({
  tenantDbName: 'tenant_acme', modelKey: 'managed.embed', projectId: 'proj-1', body: { input: 'abcdefgh' },
});
const ok = (tokens = 5) => vi.fn().mockResolvedValue({ vectors: [[0.1, 0.2]], usage: { inputTokens: tokens } });
const fail = (status: number, message: string) => vi.fn().mockRejectedValue(Object.assign(new Error(message), { status }));

beforeEach(() => {
  vi.clearAllMocks();
  routes = [ROUTE_A];
  reserveCalls = [];
  lease = { id: 'l1', settle: vi.fn(async () => {}), release: vi.fn(async () => {}) };
  (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(poolModel());
});
afterEach(() => resetManagedCreditsHostForTests());

describe('managed embeddings through routes', () => {
  it('builds the embedder from the route; response model, reserve and usage row keep the public model', async () => {
    const reserve = installHost();
    const built = wireEmbedders({ 'conn-a': ok(7) });

    const result = await call();
    await flush();

    expect(built).toEqual([{ connectionId: 'conn-a', modelId: 'upstream-a', settings: {} }]);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(reserveCalls[0]).toMatchObject({
      kind: 'embedding', providerKey: 'managed', driver: 'virtual', modelId: 'embed-public', modelKey: 'managed.embed', routeId: 'route-a',
    });
    expect(result.response.model).toBe('embed-public');

    const usageModel = (logModelUsage as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<string, unknown>;
    expect(usageModel).toMatchObject({ providerKey: 'managed', providerDriver: 'virtual', modelId: 'embed-public' });
    expect(JSON.stringify([result.response, (logModelUsage as ReturnType<typeof vi.fn>).mock.calls[0][2]]))
      .not.toMatch(/upstream-a|conn-a|route-a|up-a/);
    expect(lease.settle).toHaveBeenCalledWith({ inputTokens: 7, outputTokens: 0 });
  });

  it('moves to the second route when the first answers 503; one reservation, one settle', async () => {
    const reserve = installHost();
    routes = [ROUTE_A, ROUTE_B];
    const built = wireEmbedders({ 'conn-a': fail(503, 'upstream a down'), 'conn-b': ok(9) });

    const result = await call();
    await flush();

    expect(built.map((entry) => [entry.connectionId, entry.modelId])).toEqual([['conn-a', 'upstream-a'], ['conn-b', 'upstream-b']]);
    expect(built[1].settings).toMatchObject({ dimensions: 64 });
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(reserveCalls[0].routeId).toBe('route-a');
    expect(lease.settle).toHaveBeenCalledTimes(1);
    expect(lease.release).not.toHaveBeenCalled();
    expect(result.response.model).toBe('embed-public');
  });

  it('does not move on a caller-side 4xx', async () => {
    installHost();
    routes = [ROUTE_A, ROUTE_B];
    const second = ok();
    const built = wireEmbedders({ 'conn-a': fail(400, 'bad input for upstream-a'), 'conn-b': second });
    await expect(call()).rejects.toMatchObject({ status: 400 });
    await flush();
    expect(built).toHaveLength(1);
    expect(second).not.toHaveBeenCalled();
    expect(lease.release).toHaveBeenCalledWith('error');
  });

  it('never lets the raw upstream error text reach the caller; keeps the status', async () => {
    installHost();
    routes = [ROUTE_A, ROUTE_B];
    wireEmbedders({
      'conn-a': fail(503, 'deployment upstream-a at https://host-a.example failed'),
      'conn-b': fail(429, 'org acct_123 rate limited on upstream-b'),
    });
    const failure = await call().catch((error: Error) => error);
    await flush();
    expect(failure).toMatchObject({ message: 'Managed model provider request failed.', status: 429 });
    expect(JSON.stringify({ message: (failure as Error).message, ...(failure as object) })).not.toMatch(/upstream|acct_123|host-a/);
    expect(lease.release).toHaveBeenCalledTimes(1);
    expect(lease.settle).not.toHaveBeenCalled();
  });

  it('a runtime that cannot be built for a managed route is generic too', async () => {
    installHost();
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('connection conn-a refused: secret detail'));
    const failure = await call().catch((error: Error) => error);
    expect((failure as Error).message).toBe('Managed model provider request failed.');
    await flush();
    expect(lease.release).toHaveBeenCalledWith('error');
  });

  it('with no live route: 503, nothing reserved, no runtime built', async () => {
    const reserve = installHost();
    routes = [];
    wireEmbedders({});
    await expect(call()).rejects.toMatchObject({ message: 'This model is not available right now.', status: 503 });
    expect(reserve).not.toHaveBeenCalled();
    expect(buildModelRuntime).not.toHaveBeenCalled();
  });

  it('a refused reserve (plan limit) reaches the caller untouched with no upstream call', async () => {
    installHost({ refuse: new PlanLimitError({ code: 'credits_unavailable', message: 'Credits unavailable.', kind: 'credits' as never }) });
    const embed = ok();
    wireEmbedders({ 'conn-a': embed });
    await expect(call()).rejects.toMatchObject({ code: 'credits_unavailable', status: 503 });
    expect(embed).not.toHaveBeenCalled();
  });
});
