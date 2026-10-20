/**
 * "Test connection" of a file provider: the driver's own `checkConnection` is used when it has one (a bare
 * `listFiles` otherwise); the runtime is ALWAYS closed afterwards; the time limit aborts the check's signal; and the
 * driver's `validateSettings` runs first - a refusal is a `ProviderSettingsError` (HTTP 400 for the caller), not a
 * failed connection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';
import { providerRegistry } from '@/lib/providers';
import { ProviderSettingsError } from '@/lib/providers/errors';
import {
  testProviderConnection,
  type ProviderTestInput,
} from '@/lib/services/providers/providerConnectionTest';
import { ProviderEndpointError } from '@/lib/services/providers/providerEndpointGuard';

const validateSettings = vi.fn();
providerRegistry.register({
  id: 'test-checked-files',
  version: '1.0.0',
  domains: ['file'],
  display: { label: 'Test files (with a check)' },
  form: { sections: [] },
  createRuntime: () => ({}),
  validateSettings,
} as never);
providerRegistry.register({
  id: 'test-unchecked-files',
  version: '1.0.0',
  domains: ['file'],
  display: { label: 'Test files (no check)' },
  form: { sections: [] },
  createRuntime: () => ({}),
} as never);

const original = getConfigSource();
function deployment(mode: 'saas' | 'onprem') {
  setConfigSource({ get: (k: string) => (k === 'DEPLOYMENT_MODE' ? mode : process.env[k]) } as ConfigSource);
}

const SECRET = 'file-secret-key-98765';
const input = (overrides: Partial<ProviderTestInput> = {}): ProviderTestInput => ({
  type: 'file',
  driver: 'test-unchecked-files',
  credentials: { accessKeyId: 'AKIA-TEST-0001', secretAccessKey: SECRET },
  settings: { bucket: 'files' },
  tenantId: 'tenant-1',
  ...overrides,
});

type Spy = ReturnType<typeof vi.fn>;

/** A file runtime that records what happened to it, in order. */
function fakeRuntime(overrides: Record<string, Spy> = {}) {
  const events: string[] = [];
  const runtime: Record<string, Spy> = {
    listFiles: vi.fn(async () => { events.push('list'); return { items: [] }; }),
    close: vi.fn(() => { events.push('close'); }),
    ...overrides,
  };
  return { runtime, events };
}
const creating = (runtime: unknown) => vi.fn(async () => runtime);

beforeEach(() => {
  validateSettings.mockReset();
  validateSettings.mockResolvedValue(undefined);
  deployment('saas');
});

afterEach(() => setConfigSource(original));

describe('a file driver with its own check', () => {
  it('uses it - with a signal and the write step on - instead of a bare listing, and reports its steps', async () => {
    const steps = [
      { step: 'list', ok: true },
      { step: 'write', ok: true },
      { step: 'read', ok: true },
      { step: 'delete', ok: true },
    ];
    const { runtime, events } = fakeRuntime({
      checkConnection: vi.fn(async () => { events.push('check'); return { ok: true, message: 'Connected. Listed, wrote, read and deleted a test object.', steps }; }),
    });
    const result = await testProviderConnection(input(), { createRuntime: creating(runtime) as never });

    expect(result).toMatchObject({
      ok: true,
      message: 'Connected. Listed, wrote, read and deleted a test object.',
      details: { steps },
    });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(runtime.checkConnection).toHaveBeenCalledTimes(1);
    const options = (runtime.checkConnection as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { signal: AbortSignal; write: boolean };
    expect(options.write).toBe(true);
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.signal.aborted).toBe(false);
    expect(runtime.listFiles).not.toHaveBeenCalled();
    expect(runtime.close).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['check', 'close']);
  });

  it('a failed check is ok:false with the steps that ran, and still closes the runtime', async () => {
    const steps = [{ step: 'list', ok: true }, { step: 'write', ok: false, message: 'Access denied' }];
    const { runtime } = fakeRuntime({
      checkConnection: vi.fn(async () => ({ ok: false, message: 'Could list the bucket but not write to it.', steps })),
    });
    const result = await testProviderConnection(input(), { createRuntime: creating(runtime) as never });
    expect(result).toMatchObject({ ok: false, message: 'Could list the bucket but not write to it.', details: { steps } });
    expect(runtime.close).toHaveBeenCalledTimes(1);
  });

  it('a check that throws is ok:false, with the credentials cleaned out of the message, and the runtime is closed', async () => {
    const { runtime } = fakeRuntime({
      checkConnection: vi.fn(async () => { throw new Error(`SignatureDoesNotMatch for ${SECRET}`); }),
    });
    const result = await testProviderConnection(input(), { createRuntime: creating(runtime) as never });
    expect(result.ok).toBe(false);
    expect(result.message).toBe('SignatureDoesNotMatch for ***');
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(runtime.close).toHaveBeenCalledTimes(1);
  });

  it('cleans the credentials out of a message the check itself returned, and out of its steps', async () => {
    const { runtime } = fakeRuntime({
      checkConnection: vi.fn(async () => ({
        ok: false,
        message: `Denied for ${SECRET}\nline two`,
        steps: [{ step: 'list', ok: false, message: `key ${SECRET} is not allowed` }, { step: 'write', ok: true }],
      })),
    });
    const result = await testProviderConnection(input(), { createRuntime: creating(runtime) as never });
    expect(result.message).toBe('Denied for *** line two');
    expect(result.details?.steps).toEqual([
      { step: 'list', ok: false, message: 'key *** is not allowed' },
      { step: 'write', ok: true },
    ]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('a check without a message, or without steps, still answers something sensible', async () => {
    const ok = fakeRuntime({ checkConnection: vi.fn(async () => ({ ok: true, message: '', steps: [] })) });
    const passed = await testProviderConnection(input(), { createRuntime: creating(ok.runtime) as never });
    expect(passed).toMatchObject({ ok: true, message: 'Connected.' });
    expect(passed).not.toHaveProperty('details');

    const failed = fakeRuntime({ checkConnection: vi.fn(async () => ({ ok: false, message: '' })) });
    expect(await testProviderConnection(input(), { createRuntime: creating(failed.runtime) as never }))
      .toMatchObject({ ok: false, message: 'The connection failed.' });
  });
});

describe('a file driver without its own check', () => {
  it('lists one object and closes the runtime', async () => {
    const { runtime, events } = fakeRuntime();
    const result = await testProviderConnection(input(), { createRuntime: creating(runtime) as never });
    expect(result).toMatchObject({ ok: true, message: 'Connected.' });
    expect(result).not.toHaveProperty('details');
    expect(runtime.listFiles).toHaveBeenCalledWith({ limit: 1 });
    expect(events).toEqual(['list', 'close']);
  });

  it('a listing that fails is ok:false (credentials cleaned out) and the runtime is still closed', async () => {
    const { runtime } = fakeRuntime({ listFiles: vi.fn(async () => { throw new Error(`AccessDenied ${SECRET}`); }) });
    const result = await testProviderConnection(input(), { createRuntime: creating(runtime) as never });
    expect(result).toMatchObject({ ok: false, message: 'AccessDenied ***' });
    expect(runtime.close).toHaveBeenCalledTimes(1);
  });

  it('a runtime without close() is fine', async () => {
    const result = await testProviderConnection(input(), {
      createRuntime: creating({ listFiles: async () => ({ items: [] }) }) as never,
    });
    expect(result.ok).toBe(true);
  });
});

describe('closing the runtime never changes the answer', () => {
  it('a close that throws, synchronously or not, is ignored', async () => {
    for (const close of [
      vi.fn(() => { throw new Error('socket already gone'); }),
      vi.fn(async () => { throw new Error('socket already gone'); }),
    ]) {
      const { runtime } = fakeRuntime({ close });
      const result = await testProviderConnection(input(), { createRuntime: creating(runtime) as never });
      expect(result).toMatchObject({ ok: true, message: 'Connected.' });
      expect(close).toHaveBeenCalledTimes(1);
    }
  });

  it('a vector runtime is closed after a listing and after a failure', async () => {
    const vectorInput = input({ type: 'vector', driver: 'test-unchecked-files', credentials: { apiKey: SECRET }, settings: {} });
    const passing = fakeRuntime({ listIndexes: vi.fn(async () => [{ name: 'docs' }]) });
    expect(await testProviderConnection(vectorInput, { createRuntime: creating(passing.runtime) as never }))
      .toMatchObject({ ok: true, details: { deployments: ['docs'] } });
    expect(passing.runtime.close).toHaveBeenCalledTimes(1);

    const failing = fakeRuntime({ listIndexes: vi.fn(async () => { throw new Error('boom'); }) });
    expect(await testProviderConnection(vectorInput, { createRuntime: creating(failing.runtime) as never }))
      .toMatchObject({ ok: false, message: 'boom' });
    expect(failing.runtime.close).toHaveBeenCalledTimes(1);
  });
});

describe('the time limit', () => {
  it('aborts the signal of a check that is still running, and closes the runtime once the check lets go', async () => {
    const events: string[] = [];
    let signal: AbortSignal | undefined;
    const { runtime } = fakeRuntime({
      checkConnection: vi.fn((options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
        signal = options.signal;
        options.signal.addEventListener('abort', () => { events.push('aborted'); reject(new Error('stopped')); });
      })),
      close: vi.fn(() => { events.push('close'); }),
    });
    const result = await testProviderConnection(input(), { createRuntime: creating(runtime) as never, timeoutMs: 20 });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Timed out/);
    expect(signal?.aborted).toBe(true);
    await vi.waitFor(() => expect(runtime.close).toHaveBeenCalledTimes(1));
    expect(events).toEqual(['aborted', 'close']);
  });

  it('a check that ignores the signal is closed when it finishes, not before', async () => {
    let finish!: () => void;
    const { runtime, events } = fakeRuntime({
      checkConnection: vi.fn(() => new Promise((resolve) => {
        finish = () => { events.push('check finished'); resolve({ ok: true, message: 'late' }); };
      })),
    });
    const result = await testProviderConnection(input(), { createRuntime: creating(runtime) as never, timeoutMs: 15 });
    expect(result.message).toMatch(/Timed out/);
    expect(runtime.close).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(runtime.close).toHaveBeenCalledTimes(1));
    expect(events).toEqual(['check finished', 'close']);
  });

  it('a runtime that only arrives after the limit is closed without being used', async () => {
    const { runtime } = fakeRuntime({ checkConnection: vi.fn(async () => ({ ok: true, message: 'never asked' })) });
    let arrive!: (value: unknown) => void;
    const createRuntime = vi.fn(() => new Promise((resolve) => { arrive = resolve; }));
    const result = await testProviderConnection(input(), { createRuntime: createRuntime as never, timeoutMs: 15 });
    expect(result.message).toMatch(/Timed out/);

    arrive(runtime);
    await vi.waitFor(() => expect(runtime.close).toHaveBeenCalledTimes(1));
    expect(runtime.checkConnection).not.toHaveBeenCalled();
    expect(runtime.listFiles).not.toHaveBeenCalled();
  });

  it('is not triggered by a check that finishes in time', async () => {
    let signal: AbortSignal | undefined;
    const { runtime } = fakeRuntime({
      checkConnection: vi.fn(async (options: { signal: AbortSignal }) => { signal = options.signal; return { ok: true, message: 'Connected.' }; }),
    });
    await testProviderConnection(input(), { createRuntime: creating(runtime) as never, timeoutMs: 5_000 });
    expect(signal?.aborted).toBe(false);
  });
});

describe("the driver's validateSettings", () => {
  const checked = (overrides: Partial<ProviderTestInput> = {}) => input({ driver: 'test-checked-files', ...overrides });

  it('runs before the runtime exists, on the credentials and settings being tested', async () => {
    const { runtime } = fakeRuntime();
    const createRuntime = creating(runtime);
    const probe = checked({ settings: { endpoint: 'https://93.184.216.34:9000', bucket: 'files' } });
    const result = await testProviderConnection(probe, { createRuntime: createRuntime as never });
    expect(result.ok).toBe(true);
    expect(validateSettings).toHaveBeenCalledTimes(1);
    expect(validateSettings).toHaveBeenCalledWith({ credentials: probe.credentials, settings: probe.settings, isOnPrem: false, tenantId: 'tenant-1' });
    expect(validateSettings.mock.invocationCallOrder[0]).toBeLessThan(createRuntime.mock.invocationCallOrder[0]!);
  });

  it('settings that were left out are an empty object, and a self-hosted install is told so', async () => {
    deployment('onprem');
    const { runtime } = fakeRuntime();
    await testProviderConnection(checked({ settings: undefined }), { createRuntime: creating(runtime) as never });
    expect(validateSettings).toHaveBeenCalledWith(expect.objectContaining({ settings: {}, isOnPrem: true }));
  });

  it('a refusal reaches the caller unchanged - an answer to fix, not a failed connection - and nothing is dialled', async () => {
    const error = new ProviderSettingsError('endpoint', 'Endpoint must start with http:// or https://.');
    validateSettings.mockRejectedValueOnce(error);
    const createRuntime = vi.fn();
    const fetchImpl = vi.fn();
    await expect(testProviderConnection(checked(), { createRuntime: createRuntime as never, fetchImpl: fetchImpl as never }))
      .rejects.toBe(error);
    expect(createRuntime).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a synchronous refusal is the same', async () => {
    const error = new ProviderSettingsError('caCertificate', 'Certificate bundle is not valid PEM.');
    validateSettings.mockImplementationOnce(() => { throw error; });
    await expect(testProviderConnection(checked(), { createRuntime: vi.fn() as never })).rejects.toBe(error);
  });

  it('is asked before the outbound guard: a settings problem is reported even when the endpoint would be refused too', async () => {
    const privateEndpoint = checked({ settings: { endpoint: 'http://10.0.0.5:9000' } });
    const error = new ProviderSettingsError('allowInsecureTls', 'Not available on this deployment.');
    validateSettings.mockRejectedValueOnce(error);
    await expect(testProviderConnection(privateEndpoint, { createRuntime: vi.fn() as never })).rejects.toBe(error);

    // ...and when the settings are fine the guard still has its say
    await expect(testProviderConnection(privateEndpoint, { createRuntime: vi.fn() as never }))
      .rejects.toBeInstanceOf(ProviderEndpointError);
  });

  it('is not asked for a provider that runs inside the console, nor of a driver that has no check', async () => {
    const local = await testProviderConnection(checked({ driver: 'local-filesystem' }), { createRuntime: vi.fn() as never });
    expect(local.ok).toBeNull();
    const { runtime } = fakeRuntime();
    await testProviderConnection(input({ driver: 'test-unchecked-files' }), { createRuntime: creating(runtime) as never });
    await testProviderConnection(input({ driver: 'a-driver-nobody-registered' }), { createRuntime: creating(runtime) as never });
    expect(validateSettings).not.toHaveBeenCalled();
  });
});
