/**
 * The authorization engine decides every request of every workspace, so a server
 * that cannot run it must not serve: bootstrap runs the engine's self-test before
 * anything else starts (src/server/bootstrap.ts verifyAuthorizationEngine).
 *
 *   - a failing self-test stops the boot with a message that says why, ends the
 *     process (non-zero, after a short delay so the message is flushed) and does
 *     not register the engine in the readiness report;
 *   - a passing one registers the `authorization-engine` health check and lets the
 *     boot carry on.
 *
 * Everything bootstrap would do after the self-test is cut off at `initLifecycle`,
 * the first step after it, which these tests make throw.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const IMPORT_TIMEOUT_MS = 120_000;

const spies = vi.hoisted(() => ({
  initLifecycle: vi.fn(),
  registerHealthCheck: vi.fn(),
}));

const BOOT_CONTINUED = 'boot continued past the engine self-test';

/** Load a fresh copy of bootstrap (it keeps a module-level singleton) with the pieces below stubbed. */
async function freshBootstrap(selfTest?: () => unknown) {
  vi.resetModules();
  vi.doMock('@/server/env', () => ({ ensureServerEnvLoaded: () => undefined }));
  vi.doMock('@/lib/core/lifecycle', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/core/lifecycle')>();
    return { ...actual, initLifecycle: spies.initLifecycle };
  });
  vi.doMock('@/lib/core/health', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/core/health')>();
    return {
      ...actual,
      registerHealthCheck: (name: string, check: Parameters<typeof actual.registerHealthCheck>[1]) => {
        spies.registerHealthCheck(name, check);
        actual.registerHealthCheck(name, check);
      },
    };
  });
  if (selfTest) {
    vi.doMock('@/lib/iam/selfTest', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/lib/iam/selfTest')>();
      return { ...actual, engineSelfTest: selfTest };
    });
  }
  return import('@/server/bootstrap');
}

let exit: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  spies.initLifecycle.mockReset().mockImplementation(() => { throw new Error(BOOT_CONTINUED); });
  spies.registerHealthCheck.mockReset();
  exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
  exit.mockRestore();
  vi.doUnmock('@/lib/iam/selfTest');
  vi.doUnmock('@/lib/core/health');
  vi.doUnmock('@/lib/core/lifecycle');
  vi.doUnmock('@/server/env');
  vi.resetModules();
});

describe('a server whose authorization engine fails its self-test', () => {
  it('stops the boot, says why, ends the process and registers nothing', async () => {
    const { bootstrapApplication } = await freshBootstrap(() => ({ ok: false, error: 'the schema does not load: unexpected token' }));

    const booted = bootstrapApplication();
    await expect(booted).rejects.toThrow(/Authorization engine self-test failed: the schema does not load: unexpected token/);
    await expect(booted).rejects.toThrow(/Refusing to start/);

    // nothing after the self-test ran, and the engine is not reported as healthy
    expect(spies.initLifecycle).not.toHaveBeenCalled();
    expect(spies.registerHealthCheck.mock.calls.map(([name]) => name)).not.toContain('authorization-engine');

    // the process ends non-zero, but not in the same tick: the log line that explains it has to be flushed first
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1500);
    expect(exit).toHaveBeenCalledWith(1);
  }, IMPORT_TIMEOUT_MS);

  it('treats a self-test that throws the same way', async () => {
    const { bootstrapApplication } = await freshBootstrap(() => { throw new Error('the Cedar WASM module is missing'); });
    await expect(bootstrapApplication()).rejects.toThrow(/Authorization engine self-test failed: the Cedar WASM module is missing/);
    expect(spies.initLifecycle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1500);
    expect(exit).toHaveBeenCalledWith(1);
  }, IMPORT_TIMEOUT_MS);
});

describe('a server whose authorization engine passes its self-test', () => {
  it('registers the engine in the readiness report and lets the boot carry on', async () => {
    const { bootstrapApplication } = await freshBootstrap();

    // (cut off at the first step after the self-test)
    await expect(bootstrapApplication()).rejects.toThrow(BOOT_CONTINUED);
    expect(spies.initLifecycle).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5000);
    expect(exit).not.toHaveBeenCalled();

    const registered = spies.registerHealthCheck.mock.calls.find(([name]) => name === 'authorization-engine');
    expect(registered, 'the authorization-engine health check').toBeDefined();
    const report = await (registered![1] as () => Promise<{ status: string; details?: Record<string, unknown> }>)();
    expect(report.status).toBe('ok');
    // the readiness endpoint is public: facts about the process, no counters
    expect(Object.keys(report.details ?? {}).sort()).toEqual(['cedar', 'skippedStatements', 'unavailableRecently']);
  }, IMPORT_TIMEOUT_MS);
});
