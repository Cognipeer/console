/**
 * Unit tests — the pooled model runtime follows the provider's settings
 *
 * `buildModelRuntime` pooled a runtime under a hash of the provider's credentials only, so editing a setting that
 * shapes the runtime (a base URL, an AWS region, an Azure instance or API version) kept using the old runtime until its
 * cache entry expired. The key now covers driver, credentials and settings and ignores key order, as the file service's
 * does.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadProviderRuntimeData: vi.fn(),
  createRuntime: vi.fn(),
}));

vi.mock('@/lib/providers', () => ({
  providerRegistry: { createRuntime: mocks.createRuntime },
}));
vi.mock('@/lib/services/providers/providerService', () => ({
  assertProviderEnabled: vi.fn(),
  loadProviderRuntimeData: mocks.loadProviderRuntimeData,
}));
vi.mock('@/lib/services/availability/serviceAvailability', () => ({
  assertServiceEnabled: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/core/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

import { getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';
import { runtimePool } from '@/lib/core/runtimePool';
import { buildModelRuntime } from '@/lib/services/models/runtimeService';

interface FakeRuntime {
  id: number;
  driver: string;
  settings: Record<string, unknown>;
  credentials: Record<string, unknown>;
  close: ReturnType<typeof vi.fn>;
}

interface StoredProvider {
  driver: string;
  settings: Record<string, unknown> | undefined;
  credentials: Record<string, unknown>;
}

const ORIGINAL_SOURCE = getConfigSource();
const TENANT_DB = 'tenant_db';

/** The provider each tenant currently has stored under the key `main`. */
const stored = new Map<string, StoredProvider>();
let created: FakeRuntime[] = [];

function setProvider(tenantId: string, provider: Partial<StoredProvider> = {}) {
  stored.set(tenantId, {
    driver: 'openai-compatible',
    settings: { baseUrl: 'https://llm.internal/v1' },
    credentials: { apiKey: 'sk-1' },
    ...provider,
  });
}

/** One model call's trip through `buildModelRuntime`: builds the tenant's runtime or reuses the pooled one. */
const touch = (tenantId: string) => buildModelRuntime(TENANT_DB, tenantId, 'main', 'p1');

/** Let the pool's queued close() calls run. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  stored.clear();
  created = [];
  // Close an evicted runtime at once instead of after the production grace period.
  const source: ConfigSource = {
    name: 'test',
    get: (key) => (key === 'PROVIDER_RUNTIME_DISPOSE_GRACE_SECONDS' ? '0' : process.env[key]),
  };
  setConfigSource(source);

  mocks.loadProviderRuntimeData.mockReset();
  mocks.loadProviderRuntimeData.mockImplementation(async (_tenantDb: string, ref: { tenantId: string; key: string }) => {
    const provider = stored.get(ref.tenantId);
    if (!provider) throw new Error(`no provider for ${ref.tenantId}`);
    return {
      record: { key: ref.key, type: 'model', status: 'active', driver: provider.driver, settings: provider.settings, metadata: {} },
      credentials: provider.credentials,
    };
  });
  mocks.createRuntime.mockReset();
  mocks.createRuntime.mockImplementation(async (driver: string, context: { settings: Record<string, unknown>; credentials: Record<string, unknown> }) => {
    const runtime: FakeRuntime = {
      id: created.length + 1,
      driver,
      settings: context.settings,
      credentials: context.credentials,
      close: vi.fn(),
    };
    created.push(runtime);
    return runtime;
  });
});

afterEach(async () => {
  runtimePool.invalidateByPrefix('model:');
  await flush();
  setConfigSource(ORIGINAL_SOURCE);
});

describe('the pooled model runtime', () => {
  it('is reused while neither the credentials nor the settings change', async () => {
    setProvider('t-reuse');
    const first = await touch('t-reuse');
    const second = await touch('t-reuse');
    const third = await touch('t-reuse');

    expect(mocks.createRuntime).toHaveBeenCalledTimes(1);
    expect(second.runtime).toBe(first.runtime);
    expect(third.runtime).toBe(first.runtime);
    expect(created[0].close).not.toHaveBeenCalled();
  });

  it('is rebuilt when a setting is edited, with the edited settings, and the old one is released', async () => {
    setProvider('t-edit', { settings: { baseUrl: 'https://old.example.com/v1' } });
    await touch('t-edit');

    setProvider('t-edit', { settings: { baseUrl: 'https://new.example.com/v1' } });
    const edited = await touch('t-edit');
    await touch('t-edit');
    await flush();

    expect(mocks.createRuntime).toHaveBeenCalledTimes(2);
    expect(created[1].settings).toEqual({ baseUrl: 'https://new.example.com/v1' });
    expect(edited.runtime).toBe(created[1]);
    expect(created[0].close).toHaveBeenCalledTimes(1);
    expect(created[1].close).not.toHaveBeenCalled();
  });

  it('is rebuilt when an AWS region or an Azure API version is edited (the settings only the driver reads)', async () => {
    setProvider('t-region', { driver: 'bedrock', settings: { region: 'us-east-1' }, credentials: { accessKeyId: 'AKIA', secretAccessKey: 's' } });
    await touch('t-region');
    setProvider('t-region', { driver: 'bedrock', settings: { region: 'eu-west-1' }, credentials: { accessKeyId: 'AKIA', secretAccessKey: 's' } });
    await touch('t-region');
    expect(created.map((runtime) => runtime.settings.region)).toEqual(['us-east-1', 'eu-west-1']);

    const azure = { instanceName: 'res', deploymentName: 'dep' };
    setProvider('t-azure', { driver: 'azure', settings: { ...azure, apiVersion: '2024-10-21' } });
    await touch('t-azure');
    setProvider('t-azure', { driver: 'azure', settings: { ...azure, apiVersion: '2025-04-01-preview' } });
    await touch('t-azure');
    expect(created.slice(2).map((runtime) => runtime.settings.apiVersion)).toEqual(['2024-10-21', '2025-04-01-preview']);
  });

  it('is rebuilt when a setting is added or removed', async () => {
    setProvider('t-shape', { settings: { baseUrl: 'https://llm.internal/v1' } });
    await touch('t-shape');
    setProvider('t-shape', { settings: { baseUrl: 'https://llm.internal/v1', organization: 'team-9' } });
    await touch('t-shape');
    setProvider('t-shape', { settings: { baseUrl: 'https://llm.internal/v1' } });
    await touch('t-shape');

    expect(mocks.createRuntime).toHaveBeenCalledTimes(3);
  });

  it('is not rebuilt when the same settings and credentials arrive in a different key order', async () => {
    setProvider('t-order', {
      settings: { baseUrl: 'https://llm.internal/v1', headers: { a: '1', b: '2' }, organization: 'team-9' },
      credentials: { apiKey: 'sk-1', extra: 'x' },
    });
    await touch('t-order');

    setProvider('t-order', {
      settings: { organization: 'team-9', headers: { b: '2', a: '1' }, baseUrl: 'https://llm.internal/v1' },
      credentials: { extra: 'x', apiKey: 'sk-1' },
    });
    await touch('t-order');
    await flush();

    expect(mocks.createRuntime).toHaveBeenCalledTimes(1);
    expect(created[0].close).not.toHaveBeenCalled();
  });

  it('is rebuilt when the credentials change, as before', async () => {
    setProvider('t-cred');
    await touch('t-cred');
    setProvider('t-cred', { credentials: { apiKey: 'sk-2' } });
    await touch('t-cred');
    await flush();

    expect(mocks.createRuntime).toHaveBeenCalledTimes(2);
    expect(created[1].credentials).toEqual({ apiKey: 'sk-2' });
    expect(created[0].close).toHaveBeenCalledTimes(1);
  });

  it('is rebuilt when the driver behind the same provider key changes', async () => {
    setProvider('t-driver', { driver: 'openai-compatible', settings: { baseUrl: 'https://llm.internal/v1' } });
    await touch('t-driver');
    setProvider('t-driver', { driver: 'together', settings: { baseUrl: 'https://llm.internal/v1' } });
    await touch('t-driver');

    expect(created.map((runtime) => runtime.driver)).toEqual(['openai-compatible', 'together']);
  });

  it('reads a provider record without settings as an empty settings object', async () => {
    setProvider('t-bare', { driver: 'openai', settings: undefined, credentials: { apiKey: 'sk-1' } });
    await touch('t-bare');
    setProvider('t-bare', { driver: 'openai', settings: {}, credentials: { apiKey: 'sk-1' } });
    await touch('t-bare');

    expect(mocks.createRuntime).toHaveBeenCalledTimes(1);
    expect(created[0].settings).toEqual({});
  });

  it('is kept per tenant: the same provider key in two tenants is two runtimes, and editing one leaves the other', async () => {
    setProvider('t-one');
    setProvider('t-two');
    await touch('t-one');
    await touch('t-two');
    expect(mocks.createRuntime).toHaveBeenCalledTimes(2);

    setProvider('t-one', { settings: { baseUrl: 'https://other.example.com/v1' } });
    await touch('t-one');
    await touch('t-two');
    await flush();

    expect(mocks.createRuntime).toHaveBeenCalledTimes(3);
    const [first, second] = created;
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).not.toHaveBeenCalled();
  });
});
