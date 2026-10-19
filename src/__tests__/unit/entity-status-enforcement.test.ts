import { beforeEach, describe, expect, it, vi } from 'vitest';

const { loadProviderRuntimeData, getTenantDatabase } = vi.hoisted(() => ({
  loadProviderRuntimeData: vi.fn(),
  getTenantDatabase: vi.fn(),
}));

// buildModelRuntime asks whether the models service is on before it loads the provider.
vi.mock('@/lib/services/availability/serviceAvailability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/availability/serviceAvailability')>()),
  assertServiceEnabled: vi.fn(async () => undefined),
}));

vi.mock('@/lib/services/providers/providerService', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/services/providers/providerService')>();
  return { ...original, loadProviderRuntimeData };
});

vi.mock('@/lib/database', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/database')>();
  return { ...original, getTenantDatabase };
});

vi.mock('@/lib/services/inferenceMonitoring/vllmPoller', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/services/inferenceMonitoring/vllmPoller')>();
  return { ...original, pollVllmServer: vi.fn(), snapshotToMetrics: vi.fn().mockReturnValue({}) };
});

import {
  assertProviderEnabled,
  ProviderDisabledError,
} from '@/lib/services/providers/providerService';
import { buildModelRuntime } from '@/lib/services/models/runtimeService';
import { normalizeInferenceError } from '@/lib/services/models/openaiErrors';
import {
  InferenceMonitoringService,
  InferenceServerDisabledError,
} from '@/lib/services/inferenceMonitoring/inferenceMonitoringService';
import { pollVllmServer } from '@/lib/services/inferenceMonitoring/vllmPoller';

describe('provider enabled check', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses a disabled provider with a 403 provider_disabled error', () => {
    expect(() => assertProviderEnabled({ key: 'openai-main', status: 'disabled' })).toThrow(
      ProviderDisabledError,
    );
    try {
      assertProviderEnabled({ key: 'openai-main', status: 'disabled' });
    } catch (error) {
      expect(error).toMatchObject({
        status: 403,
        code: 'provider_disabled',
        providerKey: 'openai-main',
        message: 'Provider "openai-main" is disabled',
      });
    }
  });

  it('still allows active and errored providers', () => {
    expect(() => assertProviderEnabled({ key: 'k', status: 'active' })).not.toThrow();
    expect(() => assertProviderEnabled({ key: 'k', status: 'errored' })).not.toThrow();
  });

  it('does not build a runtime for a disabled provider', async () => {
    loadProviderRuntimeData.mockResolvedValue({
      record: { key: 'k', type: 'model', driver: 'openai', status: 'disabled' },
      credentials: {},
    });
    await expect(buildModelRuntime('db', 'tenant', 'k')).rejects.toBeInstanceOf(ProviderDisabledError);
  });

  it('is reported to clients as a 403 with the provider_disabled code', () => {
    const normalized = normalizeInferenceError(new ProviderDisabledError('k'));
    expect(normalized.status).toBe(403);
    expect(normalized.error?.code).toBe('provider_disabled');
  });
});

describe('inference server polling', () => {
  const makeDb = (statuses: string[]) => {
    const queue = [...statuses];
    return {
      findInferenceServerByKey: vi.fn(async () => ({
        _id: 's1',
        key: 'srv',
        type: 'vllm',
        status: queue.length > 1 ? queue.shift() : queue[0],
      })),
      createInferenceServerMetrics: vi.fn(async (data) => data),
      updateInferenceServer: vi.fn(async (_id: string, _patch: Record<string, unknown>) => null),
    };
  };

  beforeEach(() => vi.clearAllMocks());

  it('refuses a manual poll of a disabled server without calling it', async () => {
    const db = makeDb(['disabled']);
    getTenantDatabase.mockResolvedValue(db);

    const result = InferenceMonitoringService.pollServer('db', 't', 'srv');
    await expect(result).rejects.toBeInstanceOf(InferenceServerDisabledError);
    await expect(result).rejects.toMatchObject({ status: 409, code: 'inference_server_disabled' });
    expect(pollVllmServer).not.toHaveBeenCalled();
    expect(db.updateInferenceServer).not.toHaveBeenCalled();
  });

  it('marks an enabled server active after a successful poll', async () => {
    const db = makeDb(['active']);
    getTenantDatabase.mockResolvedValue(db);
    (pollVllmServer as ReturnType<typeof vi.fn>).mockResolvedValue({});

    await InferenceMonitoringService.pollServer('db', 't', 'srv');
    expect(db.updateInferenceServer).toHaveBeenCalledWith('s1', expect.objectContaining({ status: 'active' }));
  });

  it('keeps a server disabled when it is disabled while the poll is in flight', async () => {
    const db = makeDb(['active', 'disabled']);
    getTenantDatabase.mockResolvedValue(db);
    (pollVllmServer as ReturnType<typeof vi.fn>).mockResolvedValue({});

    await InferenceMonitoringService.pollServer('db', 't', 'srv');
    const update = (db.updateInferenceServer.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(update).not.toHaveProperty('status');
  });

  it('does not mark a server disabled mid-poll as errored when the poll fails', async () => {
    const db = makeDb(['active', 'disabled']);
    getTenantDatabase.mockResolvedValue(db);
    (pollVllmServer as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));

    await expect(InferenceMonitoringService.pollServer('db', 't', 'srv')).rejects.toThrow('boom');
    const update = (db.updateInferenceServer.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(update).not.toHaveProperty('status');
    expect(update.lastError).toBe('boom');
  });
});
