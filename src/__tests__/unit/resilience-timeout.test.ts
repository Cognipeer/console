/**
 * Unit tests — withResilience per-attempt timeout
 *
 * GATEWAY_REQUEST_TIMEOUT_MS was configured but never read, so a provider that
 * stopped responding held its socket and its request context indefinitely.
 * These cover the timeout firing, the signal it aborts with, and the cases
 * where it must stay out of the way.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const gateway = {
  requestTimeoutMs: 50,
  retryEnabled: false,
  retryMaxAttempts: 3,
  retryInitialDelayMs: 1,
  circuitBreakerEnabled: false,
  circuitBreakerThreshold: 5,
  circuitBreakerResetMs: 30_000,
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

import { withResilience, RequestTimeoutError } from '@/lib/core/resilience';

/** A call that never settles — the hung upstream this guard exists for. */
function neverSettles(): Promise<never> {
  return new Promise<never>(() => {});
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('withResilience timeout', () => {
  beforeEach(() => {
    gateway.requestTimeoutMs = 50;
    gateway.retryEnabled = false;
    gateway.circuitBreakerEnabled = false;
  });

  it('rejects a hung operation with RequestTimeoutError', async () => {
    await expect(
      withResilience(() => neverSettles(), { key: 'chat:test' }),
    ).rejects.toBeInstanceOf(RequestTimeoutError);
  });

  it('aborts the signal it handed the operation, so the socket is released', async () => {
    let observed: AbortSignal | undefined;

    await expect(
      withResilience((signal) => {
        observed = signal;
        return neverSettles();
      }, { key: 'chat:test' }),
    ).rejects.toBeInstanceOf(RequestTimeoutError);

    expect(observed?.aborted).toBe(true);
    expect(observed?.reason).toBeInstanceOf(RequestTimeoutError);
  });

  it('leaves an operation that finishes in time untouched', async () => {
    const result = await withResilience(async () => {
      await sleep(5);
      return 'ok';
    }, { key: 'chat:test' });

    expect(result).toBe('ok');
  });

  it('does not abort the signal after a successful call', async () => {
    let observed: AbortSignal | undefined;

    await withResilience(async (signal) => {
      observed = signal;
      return 'ok';
    }, { key: 'chat:test' });

    await sleep(80); // past the configured timeout
    expect(observed?.aborted).toBe(false);
  });

  it('honours a per-call override', async () => {
    gateway.requestTimeoutMs = 10_000;

    await expect(
      withResilience(() => neverSettles(), { key: 'chat:test', timeoutMs: 20 }),
    ).rejects.toBeInstanceOf(RequestTimeoutError);
  });

  it('treats timeoutMs 0 as no timeout', async () => {
    const result = await withResilience(async () => {
      await sleep(80); // longer than the configured 50ms
      return 'ok';
    }, { key: 'chat:test', timeoutMs: 0 });

    expect(result).toBe('ok');
  });

  it('applies the budget per attempt, not per call', async () => {
    gateway.retryEnabled = true;
    gateway.retryMaxAttempts = 2;
    let attempts = 0;

    const result = await withResilience(async () => {
      attempts += 1;
      if (attempts === 1) await sleep(80); // first attempt times out
      return 'ok';
    }, { key: 'chat:test' });

    expect(attempts).toBe(2);
    expect(result).toBe('ok');
  });
});
