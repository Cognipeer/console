/**
 * Unit tests — withResilience and the caller's own cancellation (`signal`)
 *
 * The realtime voice engine aborts speculative transcriptions and speech
 * streams all the time (the user kept talking, a barge-in). An abort is not the
 * provider's doing, so it must not touch the circuit breaker shared by every
 * caller of the same provider key: not as a failure, and not as a success
 * either. The latter is what an attempt that "resolves null on abort" used to
 * be — `recordSuccess` resets the failure count other callers are building and
 * closes a half-open circuit although no provider answered.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const gateway = {
  requestTimeoutMs: 1_000,
  retryEnabled: false,
  retryMaxAttempts: 3,
  retryInitialDelayMs: 1,
  circuitBreakerEnabled: true,
  circuitBreakerThreshold: 3,
  circuitBreakerResetMs: 40,
};

vi.mock('@/lib/core/config', () => ({
  getConfig: () => ({ gateway }),
}));

vi.mock('@/lib/core/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

import {
  abortErrorFrom,
  CircuitOpenError,
  getCircuitState,
  RequestTimeoutError,
  resetAllCircuits,
  withResilience,
} from '@/lib/core/resilience';

const KEY = 'stt:openai-test';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A provider call that only settles when its signal aborts (and then fails the way a socket does). */
const hangUntilAborted = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('socket closed')), { once: true });
  });

/** A provider failure that is not retryable: one attempt, one failure on the books. */
const refuse = () => Promise.reject(Object.assign(new Error('bad request'), { status: 400 }));

async function failTimes(key: string, times: number) {
  for (let i = 0; i < times; i += 1) {
    await expect(withResilience(refuse, { key })).rejects.toThrow('bad request');
  }
}

beforeEach(() => {
  resetAllCircuits();
  gateway.retryEnabled = false;
  gateway.retryInitialDelayMs = 1;
  gateway.requestTimeoutMs = 1_000;
});

describe('withResilience — caller signal', () => {
  it('an aborted call is neither a failure nor a success: the failures other callers built up stay', async () => {
    await failTimes(KEY, 2);
    expect(getCircuitState(KEY)).toMatchObject({ state: 'closed', failures: 2 });

    const controller = new AbortController();
    const pending = withResilience(hangUntilAborted, { key: KEY, signal: controller.signal });
    await sleep(5);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });

    // Resolving the attempt with `null` would have recorded a success here: failures back to 0.
    expect(getCircuitState(KEY)).toMatchObject({ state: 'closed', failures: 2 });
    // ...so the breaker still trips when the real failures keep coming.
    await failTimes(KEY, 1);
    expect(getCircuitState(KEY)?.state).toBe('open');
  });

  it('a probe aborted while the circuit is half-open does not declare the provider recovered', async () => {
    await failTimes(KEY, 3);
    expect(getCircuitState(KEY)?.state).toBe('open');
    await expect(withResilience(async () => 'x', { key: KEY })).rejects.toBeInstanceOf(CircuitOpenError);
    await sleep(60); // past circuitBreakerResetMs

    const controller = new AbortController();
    const probe = withResilience(hangUntilAborted, { key: KEY, signal: controller.signal });
    await sleep(5);
    expect(getCircuitState(KEY)?.state).toBe('half-open');
    controller.abort();
    await expect(probe).rejects.toMatchObject({ name: 'AbortError' });

    // No provider response was seen: still half-open, failures untouched.
    expect(getCircuitState(KEY)).toMatchObject({ state: 'half-open', failures: 3 });

    // A real answer is what closes it.
    await expect(withResilience(async () => 'ok', { key: KEY })).resolves.toBe('ok');
    expect(getCircuitState(KEY)).toMatchObject({ state: 'closed', failures: 0 });
  });

  it('is not retried: the operation runs once and the call rejects with an AbortError', async () => {
    gateway.retryEnabled = true;
    const controller = new AbortController();
    const operation = vi.fn(hangUntilAborted);
    const pending = withResilience(operation, { key: KEY, signal: controller.signal });
    await sleep(5);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await sleep(20);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('an abort during the back-off between attempts ends the call at once', async () => {
    gateway.retryEnabled = true;
    gateway.retryInitialDelayMs = 2_000;
    const controller = new AbortController();
    const operation = vi.fn(async () => {
      throw new Error('upstream hiccup');
    });
    const started = Date.now();
    const pending = withResilience(operation, { key: KEY, signal: controller.signal });
    await sleep(20); // first attempt failed, now waiting out the back-off
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - started).toBeLessThan(500);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(getCircuitState(KEY)).toMatchObject({ state: 'closed', failures: 0 });
  });

  it('an already-aborted signal never calls the operation or touches the circuit', async () => {
    const operation = vi.fn(async () => 'x');
    await expect(withResilience(operation, { key: KEY, signal: AbortSignal.abort() })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(operation).not.toHaveBeenCalled();
    expect(getCircuitState(KEY)).toBeUndefined();
  });

  it('aborts the signal the operation was handed, with the caller\'s reason', async () => {
    const reason = new Error('barge-in');
    const controller = new AbortController();
    let observed: AbortSignal | undefined;
    const pending = withResilience((signal) => {
      observed = signal;
      return hangUntilAborted(signal);
    }, { key: KEY, signal: controller.signal });
    await sleep(5);
    controller.abort(reason);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(observed?.aborted).toBe(true);
    expect(observed?.reason).toBe(reason);
  });

  it('releases the caller at once even when the operation ignores its signal', async () => {
    const controller = new AbortController();
    const pending = withResilience(() => new Promise<never>(() => {}), { key: KEY, signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    const started = Date.now();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('works without a per-attempt timeout (timeoutMs 0)', async () => {
    const controller = new AbortController();
    const pending = withResilience(hangUntilAborted, { key: KEY, signal: controller.signal, timeoutMs: 0 });
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('a timeout is still the provider\'s failure when a caller signal is present', async () => {
    const controller = new AbortController();
    await expect(
      withResilience(() => new Promise<never>(() => {}), { key: KEY, signal: controller.signal, timeoutMs: 20 }),
    ).rejects.toBeInstanceOf(RequestTimeoutError);
    expect(getCircuitState(KEY)).toMatchObject({ failures: 1 });
  });

  it('a call that completes is a success as before, and leaves no listener on the caller signal', async () => {
    await failTimes(KEY, 2);
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');
    await expect(withResilience(async () => 'answer', { key: KEY, signal: controller.signal })).resolves.toBe('answer');
    expect(getCircuitState(KEY)).toMatchObject({ state: 'closed', failures: 0 });
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
    // Aborting afterwards is inert.
    expect(() => controller.abort()).not.toThrow();
  });

  it('a provider failure while the signal is live is still retried and recorded', async () => {
    gateway.retryEnabled = true;
    gateway.retryMaxAttempts = 2;
    const controller = new AbortController();
    let calls = 0;
    const result = await withResilience(async () => {
      calls += 1;
      if (calls === 1) throw new Error('transient');
      return 'ok';
    }, { key: KEY, signal: controller.signal });
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });
});

describe('abortErrorFrom', () => {
  it('reuses the signal\'s own AbortError reason', () => {
    const controller = new AbortController();
    controller.abort();
    const error = abortErrorFrom(controller.signal);
    expect(error).toBe(controller.signal.reason);
    expect(error.name).toBe('AbortError');
  });

  it('wraps any other reason (and no signal at all) in an AbortError', () => {
    const controller = new AbortController();
    controller.abort(new Error('barge-in'));
    expect(abortErrorFrom(controller.signal)).toMatchObject({ name: 'AbortError', message: 'The operation was aborted' });
    expect(abortErrorFrom(undefined)).toMatchObject({ name: 'AbortError' });
  });
});
