/** Unit tests — retry.ts: what is retryable, Retry-After, backoff and timeout. */

import { describe, it, expect, vi } from 'vitest';
import { callWithPolicy, EvaluationTimeoutError, isRetryableError, retryAfterMs, withTimeout } from '@/lib/services/evaluation/retry';

describe('isRetryableError', () => {
  it.each([
    [Object.assign(new Error('x'), { status: 429 })],
    [Object.assign(new Error('x'), { status: 503 })],
    [Object.assign(new Error('x'), { status: 408 })],
    [Object.assign(new Error('x'), { code: 'ECONNRESET' })],
    [new Error('socket hang up')],
    [new Error('The model is overloaded')],
    [new Error('rate limit exceeded')],
    [new EvaluationTimeoutError('Call', 1000)],
  ])('retries %#', (error) => {
    expect(isRetryableError(error)).toBe(true);
  });

  it.each([
    [Object.assign(new Error('x'), { status: 400 })],
    [Object.assign(new Error('x'), { status: 401 })],
    [new Error('Model not found')],
  ])('does not retry %#', (error) => {
    expect(isRetryableError(error)).toBe(false);
  });
});

describe('retryAfterMs', () => {
  it('reads seconds from a header and caps the wait', () => {
    expect(retryAfterMs({ headers: { 'Retry-After': '2' } })).toBe(2000);
    expect(retryAfterMs({ retryAfter: 9999 })).toBe(30_000);
    expect(retryAfterMs(new Error('x'))).toBeUndefined();
  });
});

describe('callWithPolicy', () => {
  it('retries with backoff 1s then 3s and gives up after the retries', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error('x'), { status: 500 }));
    await expect(callWithPolicy(fn, { timeoutMs: 1000, retries: 2, backoffMs: [1000, 3000], sleep })).rejects.toThrow('x');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 3000]);
  });

  it('never retries when retries is 0', async () => {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error('x'), { status: 500 }));
    await expect(callWithPolicy(fn, { timeoutMs: 1000, retries: 0 })).rejects.toThrow('x');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('aborts the signal and rejects at the deadline', async () => {
    let seen: AbortSignal | undefined;
    const promise = withTimeout((signal) => { seen = signal; return new Promise<never>(() => undefined); }, 20, 'Agent target call');
    await expect(promise).rejects.toThrow(/Agent target call timed out/);
    expect(seen?.aborted).toBe(true);
  });
});
