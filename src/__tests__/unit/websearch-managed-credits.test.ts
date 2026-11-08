/**
 * Web search with managed providers: the tenant's own instances win the default pick, a managed one is the fallback,
 * and a managed call reserves before the provider call (units 1 basic / 2 advanced), settles on success, releases on
 * failure, and is free on a cache hit. Without a host nothing changes.
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

const install = () => {
  reserve = vi.fn(async () => lease);
  const host: ManagedCreditsHost = { isManagedProvider: (ref) => ref.settings?.managed === true, reserve: reserve as unknown as ManagedCreditsHost["reserve"] };
  registerManagedCreditsHost(host);
};
const useRecord = (record: ReturnType<typeof view>) =>
  (loadProviderRuntimeData as ReturnType<typeof vi.fn>).mockResolvedValue({ record, credentials: { apiKey: 'k' } });
const list = (...records: ReturnType<typeof view>[]) =>
  (listProviderConfigs as ReturnType<typeof vi.fn>).mockResolvedValue(records);
const run = (opts: Record<string, unknown> = {}) =>
  runWebSearch('tenant_acme', 'tenant-1', 'proj-1', { query: 'q', ...opts });

beforeEach(() => {
  vi.clearAllMocks();
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

  it('reserves 2 units for an advanced search', async () => {
    install();
    useRecord(view('m', true, { searchDepth: 'advanced' }));
    await run({ providerKey: 'm' });
    expect(reserve).toHaveBeenCalledWith(expect.objectContaining({ estimate: { units: 2 } }));
    expect(lease.settle).toHaveBeenCalledWith({ units: 2 });
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
