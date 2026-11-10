/**
 * Web search with managed providers: the tenant's own instances win the default pick, a managed one is the fallback,
 * and a managed call reserves once before the provider call (units come from the request: 1 basic / 2 advanced),
 * settles on success, releases on failure, and is free on a cache hit. The adapter is called through the operator's
 * route connection while everything tenant-visible keeps the public record. Without a host nothing changes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn().mockResolvedValue({
    switchToTenant: vi.fn().mockResolvedValue(undefined),
    createWebSearchRunLog: vi.fn(),
    listWebSearchRunLogs: vi.fn(),
  }),
}));
vi.mock('@/lib/core/asyncTask', () => ({ fireAndForget: vi.fn() }));
vi.mock('@/lib/services/providers/providerService', () => ({
  listProviderConfigs: vi.fn(),
  loadProviderRuntimeData: vi.fn(),
}));
vi.mock('@/lib/services/webSearch/webSearchAdapter', () => ({ callWebSearchProvider: vi.fn() }));
// These tests keep to the legacy provider path: no instance exists.
vi.mock('@/lib/services/webSearch/webSearchInstanceService', () => ({
  getWebSearchInstance: vi.fn().mockResolvedValue(null),
  listWebSearchInstances: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/lib/services/models/inferenceService', () => ({ handleChatCompletion: vi.fn() }));
vi.mock('@/lib/quota/serviceQuota', () => ({ enforceServiceQuota: vi.fn() }));
vi.mock('@/lib/services/availability/serviceAvailability', () => ({ assertServiceEnabled: vi.fn() }));
const cacheHolder = vi.hoisted(() => ({ session: undefined as unknown }));
vi.mock('@/lib/services/webSearch/cacheSettings', () => ({
  resolveWebSearchCacheSettings: vi.fn(() => cacheHolder.session),
}));
vi.mock('@/lib/services/webSearch/webSearchCache', () => ({
  lookupWebSearchCache: vi.fn(async () => ({
    status: 'hit',
    similarity: 0.99,
    results: [{ title: 'c', url: 'https://c', snippet: '', position: 1 }],
  })),
  describeCacheFailure: vi.fn(() => 'cache failed'),
  storeWebSearchCache: vi.fn(),
}));

import {
  registerManagedCreditsHost,
  resetManagedCreditsHostForTests,
  type ManagedCreditsHost,
} from '@/enterprise/managed-credits';
import { runWebSearch } from '@/lib/services/webSearch/webSearchService';
import { listProviderConfigs, loadProviderRuntimeData } from '@/lib/services/providers/providerService';
import { callWebSearchProvider } from '@/lib/services/webSearch/webSearchAdapter';
import { fireAndForget } from '@/lib/core/asyncTask';
import { getDatabase } from '@/lib/database';

const view = (key: string, managed: boolean, extra: Record<string, unknown> = {}) => ({
  tenantId: 'tenant-1',
  key,
  type: 'websearch',
  driver: 'tavily',
  status: 'active',
  settings: { ...(managed ? { managed: true } : {}), ...extra },
});

let lease: { id: string; settle: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
let reserve: ReturnType<typeof vi.fn>;

const MANAGED_KEYS = new Set(['m', 'm-a', 'm-b']);
const ROUTE_A = { id: 'route-a', connectionId: 'conn-a', driver: 'search-up' };
const ROUTE_B = { id: 'route-b', connectionId: 'conn-b', driver: 'search-up-b', settings: { region: 'r2' } };
let routes: Array<Record<string, unknown>> = [ROUTE_A];

const install = () => {
  reserve = vi.fn(async () => lease);
  const host: ManagedCreditsHost = {
    isManagedProvider: (ref) => ref.settings?.managed === true,
    reserve: reserve as unknown as ManagedCreditsHost['reserve'],
    listRoutes: (query) => (MANAGED_KEYS.has(query.providerKey) ? (routes as never) : []),
  };
  registerManagedCreditsHost(host);
};
const connectionOf = (id: string) => ({
  id,
  driver: id === 'conn-b' ? 'search-up-b' : 'search-up',
  settings: { baseUrl: `https://${id}.example`, searchDepth: 'advanced' },
});
/** The loader double: a managed record comes back with the connection asked for, an own one without. */
const useRecord = (record: ReturnType<typeof view>) =>
  (loadProviderRuntimeData as ReturnType<typeof vi.fn>).mockImplementation(
    async (_db: string, _ref: unknown, options?: { managedConnectionId?: string }) => (
      record.settings.managed === true && options?.managedConnectionId
        ? { record, credentials: { apiKey: `key-${options.managedConnectionId}` }, managedConnection: connectionOf(options.managedConnectionId) }
        : { record, credentials: { apiKey: 'k' } }
    ),
  );
const list = (...records: ReturnType<typeof view>[]) =>
  (listProviderConfigs as ReturnType<typeof vi.fn>).mockResolvedValue(records);
const run = (opts: Record<string, unknown> = {}) =>
  runWebSearch('tenant_acme', 'tenant-1', 'proj-1', { query: 'q', ...opts });

beforeEach(() => {
  vi.clearAllMocks();
  routes = [ROUTE_A];
  cacheHolder.session = undefined;
  lease = { id: 'l1', settle: vi.fn().mockResolvedValue(undefined), release: vi.fn().mockResolvedValue(undefined) };
  (callWebSearchProvider as ReturnType<typeof vi.fn>).mockResolvedValue({ results: [] });
});
afterEach(() => resetManagedCreditsHostForTests());

describe('default instance selection', () => {
  it('uses the single own instance even when managed ones exist', async () => {
    install();
    list(view('zz-managed', true), view('mine', false));
    useRecord(view('mine', false));
    const result = await run();
    expect(result.providerKey).toBe('mine');
    expect(loadProviderRuntimeData).toHaveBeenCalledWith(
      'tenant_acme',
      expect.objectContaining({ key: 'mine' }),
      { allowManaged: true },
    );
  });

  it('lists only the own instances in the "multiple" error', async () => {
    install();
    list(view('b-own', false), view('a-managed', true), view('a-own', false));
    const error = await run().catch((e: Error) => e);
    expect((error as Error).message).toMatch(/b-own, a-own|a-own, b-own/);
    expect((error as Error).message).not.toContain('a-managed');
  });

  it('falls back to the first managed instance by key when there is no own one', async () => {
    install();
    list(view('m-b', true), view('m-a', true));
    useRecord(view('m-a', true));
    expect((await run()).providerKey).toBe('m-a');
  });

  it('keeps the "none" error when nothing is active, and behaves as before without a host', async () => {
    list();
    await expect(run()).rejects.toThrow('No active web search instance');
    list(view('x', true), view('y', true));
    await expect(run()).rejects.toThrow('Multiple web search instances');
  });
});

describe('reserve / settle / release', () => {
  it('reserves 1 unit for a basic managed search, settles it, and never blocks on the lease', async () => {
    install();
    useRecord(view('m', true));
    await run({ providerKey: 'm' });
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenCalledWith(expect.objectContaining({ kind: 'search', providerKey: 'm', estimate: { units: 1 } }));
    expect(lease.settle).toHaveBeenCalledWith({ units: 1 });
    expect(lease.release).not.toHaveBeenCalled();
    expect(reserve.mock.invocationCallOrder[0]).toBeLessThan(
      (callWebSearchProvider as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0],
    );
  });

  it('reserves 2 units for an advanced search asked for by the request', async () => {
    install();
    useRecord(view('m', true));
    await run({ providerKey: 'm', searchDepth: 'advanced' });
    expect(reserve).toHaveBeenCalledWith(expect.objectContaining({ estimate: { units: 2 } }));
    expect(lease.settle).toHaveBeenCalledWith({ units: 2 });
    expect((callWebSearchProvider as ReturnType<typeof vi.fn>).mock.calls[0][0].settings.searchDepth).toBe('advanced');
  });

  it('never takes the units from record, connection or route settings', async () => {
    install();
    routes = [{ ...ROUTE_A, settings: { searchDepth: 'advanced' } }];
    useRecord(view('m', true, { searchDepth: 'advanced' }));
    await run({ providerKey: 'm' });
    expect(reserve).toHaveBeenCalledWith(expect.objectContaining({ estimate: { units: 1 } }));
    expect(lease.settle).toHaveBeenCalledWith({ units: 1 });
    expect((callWebSearchProvider as ReturnType<typeof vi.fn>).mock.calls[0][0].settings.searchDepth).toBe('basic');
  });

  it('an own instance still takes its units from its own settings', async () => {
    install();
    useRecord(view('mine', false, { searchDepth: 'advanced' }));
    await run({ providerKey: 'mine' });
    expect(callWebSearchProvider).toHaveBeenCalledTimes(1);
    expect(reserve).not.toHaveBeenCalled();
  });

  it('releases on a provider failure and throws a generic error without the upstream text', async () => {
    install();
    useRecord(view('m', true));
    (callWebSearchProvider as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('upstream 500 account acct_123'));
    const failure = await run({ providerKey: 'm' }).then(
      () => null,
      (error: unknown) => error as Error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toBe('Managed web search request failed.');
    expect(failure?.message).not.toContain('acct_123');
    expect(lease.release).toHaveBeenCalledWith('error');
    expect(lease.settle).not.toHaveBeenCalled();
  });

  it('keeps the upstream error text for an own instance', async () => {
    install();
    useRecord(view('own', false));
    (callWebSearchProvider as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('upstream 500'));
    await expect(run({ providerKey: 'own' })).rejects.toThrow('upstream 500');
  });

  it('a refused reserve (402) reaches the caller with no provider call', async () => {
    install();
    reserve.mockRejectedValue(Object.assign(new Error('no credits'), { status: 402, code: 'insufficient_credits' }));
    useRecord(view('m', true));
    await expect(run({ providerKey: 'm' })).rejects.toMatchObject({ status: 402, code: 'insufficient_credits' });
    expect(callWebSearchProvider).not.toHaveBeenCalled();
  });

  it('a cache hit is free: no reserve, no provider call', async () => {
    install();
    useRecord(view('m', true));
    cacheHolder.session = { enabled: true };
    const result = await run({ providerKey: 'm' });
    expect(result.cached).toBe(true);
    expect(reserve).not.toHaveBeenCalled();
    expect(callWebSearchProvider).not.toHaveBeenCalled();
  });

  it('does not reserve for an own instance, or without a host', async () => {
    install();
    useRecord(view('mine', false));
    await run({ providerKey: 'mine' });
    expect(reserve).not.toHaveBeenCalled();
    resetManagedCreditsHostForTests();
    useRecord(view('m', true));
    await run({ providerKey: 'm' });
    expect(callWebSearchProvider).toHaveBeenCalledTimes(2);
  });
});

describe('managed routes', () => {
  const adapter = () => callWebSearchProvider as ReturnType<typeof vi.fn>;
  const loggedRuns = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const db = await getDatabase() as unknown as { createWebSearchRunLog: ReturnType<typeof vi.fn> };
    return db.createWebSearchRunLog.mock.calls.map((c) => c[0] as Record<string, unknown>);
  };
  const runInline = () => (fireAndForget as ReturnType<typeof vi.fn>).mockImplementation(async (_name: string, fn: () => Promise<void>) => { await fn(); });

  it('calls the adapter through the route connection; result and run log keep the public record', async () => {
    install();
    runInline();
    routes = [{ ...ROUTE_A, settings: { region: 'r1' } }];
    useRecord(view('m', true));
    const result = await run({ providerKey: 'm' });

    const [synthetic, credentials] = adapter().mock.calls[0];
    expect(synthetic.driver).toBe('search-up');
    expect(synthetic.settings).toMatchObject({ baseUrl: 'https://conn-a.example', region: 'r1' });
    expect(credentials).toEqual({ apiKey: 'key-conn-a' });

    expect(result.driver).toBe('tavily');
    expect(result.providerKey).toBe('m');
    expect(reserve).toHaveBeenCalledWith(expect.objectContaining({ providerKey: 'm', driver: 'tavily', routeId: 'route-a' }));
    const [entry] = await loggedRuns();
    expect(entry.driver).toBe('tavily');
    expect(JSON.stringify([result, entry])).not.toMatch(/search-up|conn-a|route-a|example/);
  });

  it('returns one result shape whichever route served: no upstream-only fields', async () => {
    install();
    routes = [ROUTE_A];
    useRecord(view('m', true));
    adapter().mockResolvedValueOnce({
      results: [{ title: 't', url: 'https://u', snippet: 's', position: 1, publishedAt: '2026-01-01', score: 0.9, source: 'engine-x' }],
    });
    const result = await run({ providerKey: 'm' });
    expect(result.results).toEqual([{ title: 't', url: 'https://u', snippet: 's', position: 1, publishedAt: '2026-01-01' }]);
  });

  it('fails over to the next route on a 503; reserves once, settles once', async () => {
    install();
    routes = [ROUTE_A, ROUTE_B];
    useRecord(view('m', true));
    adapter()
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 503 }))
      .mockResolvedValueOnce({ results: [] });
    await run({ providerKey: 'm' });

    expect(adapter()).toHaveBeenCalledTimes(2);
    expect(adapter().mock.calls[1][0].driver).toBe('search-up-b');
    expect(adapter().mock.calls[1][0].settings).toMatchObject({ region: 'r2' });
    expect(adapter().mock.calls[1][1]).toEqual({ apiKey: 'key-conn-b' });
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenCalledWith(expect.objectContaining({ routeId: 'route-a' }));
    expect(lease.settle).toHaveBeenCalledTimes(1);
    expect(lease.release).not.toHaveBeenCalled();
  });

  it('fails over on a 429 and gives each route its own breaker scope', async () => {
    install();
    routes = [ROUTE_A, ROUTE_B];
    useRecord(view('m', true));
    adapter()
      .mockRejectedValueOnce(Object.assign(new Error('Tavily search failed (429): slow down'), { status: 429 }))
      .mockResolvedValueOnce({ results: [] });
    await run({ providerKey: 'm' });
    expect(adapter()).toHaveBeenCalledTimes(2);
    expect(adapter().mock.calls[0][3]).toEqual({ breakerScope: 'route-a' });
    expect(adapter().mock.calls[1][3]).toEqual({ breakerScope: 'route-b' });
  });

  it('does not fail over on a caller-side 4xx; the tenant gets the generic error', async () => {
    install();
    routes = [ROUTE_A, ROUTE_B];
    useRecord(view('m', true));
    adapter().mockRejectedValue(Object.assign(new Error('bad key at conn-a'), { status: 401 }));
    const failure = await run({ providerKey: 'm' }).catch((e: Error) => e);
    expect(adapter()).toHaveBeenCalledTimes(1);
    expect((failure as Error).message).toBe('Managed web search request failed.');
    expect(lease.release).toHaveBeenCalledWith('error');
  });

  it('every route failing releases the hold and returns the generic error', async () => {
    install();
    routes = [ROUTE_A, ROUTE_B];
    useRecord(view('m', true));
    adapter().mockRejectedValue(Object.assign(new Error('upstream down'), { status: 503 }));
    const failure = await run({ providerKey: 'm' }).catch((e: Error) => e);
    expect(adapter()).toHaveBeenCalledTimes(2);
    expect((failure as Error).message).toBe('Managed web search request failed.');
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(lease.release).toHaveBeenCalledTimes(1);
  });

  it('with no live route the call is refused before any reserve or upstream call', async () => {
    install();
    routes = [];
    useRecord(view('m', true));
    await expect(run({ providerKey: 'm' })).rejects.toThrow('This provider is not available right now.');
    expect(reserve).not.toHaveBeenCalled();
    expect(adapter()).not.toHaveBeenCalled();
  });
});
