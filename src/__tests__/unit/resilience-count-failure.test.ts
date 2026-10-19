/**
 * Unit tests — withResilience `countFailure`
 *
 * A circuit breaker should open for an unwell provider, not because a caller keeps
 * sending a request that can never succeed (a rejected credential, a missing
 * bucket). `countFailure` lets a caller say which failures are evidence of an
 * outage. An uncounted failure is neutral: no count, no re-opening, no recovery.
 *
 * The second half pins the default. Without the option every failure is counted
 * exactly as before, and no caller other than the file service passes it, so the
 * gateway, model, vector and search callers are untouched.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const gateway = {
  requestTimeoutMs: 1_000,
  retryEnabled: false,
  retryMaxAttempts: 3,
  retryInitialDelayMs: 1,
  circuitBreakerEnabled: true,
  circuitBreakerThreshold: 3,
  circuitBreakerResetMs: 80,
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
  CircuitOpenError,
  getAllCircuitStates,
  getCircuitState,
  resetAllCircuits,
  withResilience,
  type ResilienceOptions,
} from '@/lib/core/resilience';

const KEY = 'file-upload:tenant-1:store';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A request the provider refused for good (not retryable): one attempt, one call-level failure. */
const forbidden = () => Object.assign(new Error('Access denied'), { status: 403 });
/** An outage (retried when retrying is on). */
const unavailable = () => Object.assign(new Error('Service unavailable'), { status: 503 });

/** Fail one call with `error`, counting it unless `countFailure` says otherwise. */
async function failCall(error: Error, options: Partial<ResilienceOptions> = {}) {
  await expect(withResilience(async () => { throw error; }, { key: KEY, ...options })).rejects.toBe(error);
}

async function failTimes(times: number, makeError: () => Error, options: Partial<ResilienceOptions> = {}) {
  for (let i = 0; i < times; i += 1) await failCall(makeError(), options);
}

/** Count only outages: the 5xx family, never a 4xx. */
const onlyOutages = (error: unknown) => (error as { status?: number }).status !== 403;

beforeEach(() => {
  resetAllCircuits();
  gateway.retryEnabled = false;
  gateway.retryMaxAttempts = 3;
  gateway.circuitBreakerEnabled = true;
  gateway.circuitBreakerThreshold = 3;
  gateway.circuitBreakerResetMs = 80;
});

describe('countFailure returning false', () => {
  it('keeps the circuit closed however many such failures arrive', async () => {
    await failTimes(10, forbidden, { countFailure: onlyOutages });

    expect(getCircuitState(KEY)).toMatchObject({ state: 'closed', failures: 0 });
    // The next call still reaches the provider; it is not turned away by an open circuit.
    const operation = vi.fn(async () => 'stored');
    await expect(withResilience(operation, { key: KEY, countFailure: onlyOutages })).resolves.toBe('stored');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('still hands the caller the provider\'s own error', async () => {
    const error = forbidden();
    await expect(
      withResilience(async () => { throw error; }, { key: KEY, countFailure: () => false }),
    ).rejects.toBe(error);
  });

  it('is neutral: it neither raises the count nor resets it', async () => {
    await failTimes(2, unavailable, { countFailure: onlyOutages });
    expect(getCircuitState(KEY)).toMatchObject({ state: 'closed', failures: 2 });

    await failTimes(4, forbidden, { countFailure: onlyOutages });
    expect(getCircuitState(KEY)).toMatchObject({ state: 'closed', failures: 2 });

    // One more real outage is still the third.
    await failCall(unavailable(), { countFailure: onlyOutages });
    expect(getCircuitState(KEY)?.state).toBe('open');
  });

  it('does not re-open a half-open circuit, and leaves it half-open for the next call to probe', async () => {
    await failTimes(3, unavailable, { countFailure: onlyOutages });
    expect(getCircuitState(KEY)?.state).toBe('open');
    await expect(withResilience(async () => 'x', { key: KEY })).rejects.toBeInstanceOf(CircuitOpenError);
    await sleep(110); // past circuitBreakerResetMs

    // The probe is answered with a refusal that says nothing about availability.
    await failCall(forbidden(), { countFailure: onlyOutages });
    expect(getCircuitState(KEY)).toMatchObject({ state: 'half-open', failures: 3 });

    // Nothing claimed the probe slot: the next call is let through, and a real answer closes the circuit.
    const operation = vi.fn(async () => 'stored');
    await expect(withResilience(operation, { key: KEY, countFailure: onlyOutages })).resolves.toBe('stored');
    expect(operation).toHaveBeenCalledTimes(1);
    expect(getCircuitState(KEY)).toMatchObject({ state: 'closed', failures: 0 });
  });

  it('while a counted failure still re-opens a half-open circuit', async () => {
    await failTimes(3, unavailable, { countFailure: onlyOutages });
    await sleep(110);

    await failCall(unavailable(), { countFailure: onlyOutages });
    expect(getCircuitState(KEY)?.state).toBe('open');
    await expect(withResilience(async () => 'x', { key: KEY })).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it('does not change whether the call is retried', async () => {
    gateway.retryEnabled = true;
    const retried = vi.fn(async () => { throw unavailable(); });
    await expect(withResilience(retried, { key: KEY, countFailure: () => false })).rejects.toMatchObject({ status: 503 });
    expect(retried).toHaveBeenCalledTimes(3);

    const refused = vi.fn(async () => { throw forbidden(); });
    await expect(withResilience(refused, { key: KEY, countFailure: () => true })).rejects.toMatchObject({ status: 403 });
    expect(refused).toHaveBeenCalledTimes(1);
  });

  it('is scoped to the call: another key keeps counting normally', async () => {
    await failTimes(5, forbidden, { countFailure: () => false });
    await failTimes(3, forbidden, { key: 'file-upload:tenant-2:store' });

    expect(getCircuitState(KEY)).toMatchObject({ state: 'closed', failures: 0 });
    expect(getCircuitState('file-upload:tenant-2:store')?.state).toBe('open');
  });
});

describe('what the predicate is asked', () => {
  it('is asked once per call, with the error the call ended on', async () => {
    gateway.retryEnabled = true;
    const countFailure = vi.fn(() => true);
    const errors = [unavailable(), unavailable(), Object.assign(new Error('Service unavailable (last)'), { status: 503 })];
    let attempt = 0;
    await expect(
      withResilience(async () => { throw errors[attempt++]; }, { key: KEY, countFailure }),
    ).rejects.toBe(errors[2]);

    expect(countFailure).toHaveBeenCalledTimes(1);
    expect(countFailure).toHaveBeenCalledWith(errors[2]);
    expect(getCircuitState(KEY)).toMatchObject({ failures: 1 });
  });

  it('is asked about the non-retryable error that cut a retried call short', async () => {
    gateway.retryEnabled = true;
    const countFailure = vi.fn(() => false);
    const refusal = forbidden();
    let attempt = 0;
    await expect(
      withResilience(async () => {
        attempt += 1;
        throw attempt === 1 ? unavailable() : refusal;
      }, { key: KEY, countFailure }),
    ).rejects.toBe(refusal);

    expect(attempt).toBe(2);
    expect(countFailure).toHaveBeenCalledTimes(1);
    expect(countFailure).toHaveBeenCalledWith(refusal);
    expect(getCircuitState(KEY)).toMatchObject({ state: 'closed', failures: 0 });
  });

  it('is asked about a timeout like any other failure', async () => {
    const countFailure = vi.fn(() => true);
    await expect(
      withResilience(() => new Promise<never>(() => {}), { key: KEY, timeoutMs: 20, countFailure }),
    ).rejects.toMatchObject({ name: 'RequestTimeoutError' });

    expect(countFailure).toHaveBeenCalledTimes(1);
    expect(getCircuitState(KEY)).toMatchObject({ failures: 1 });
  });

  it('is not asked about a success, a caller\'s cancellation or an open circuit', async () => {
    const countFailure = vi.fn(() => true);
    await withResilience(async () => 'ok', { key: KEY, countFailure });

    const controller = new AbortController();
    const pending = withResilience(
      (signal) => new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Error('closed')), { once: true })),
      { key: KEY, countFailure, signal: controller.signal },
    );
    await sleep(5);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });

    await failTimes(3, unavailable);
    await expect(withResilience(async () => 'x', { key: KEY, countFailure })).rejects.toBeInstanceOf(CircuitOpenError);

    expect(countFailure).not.toHaveBeenCalled();
  });

  it('is not asked when the circuit breaker is switched off', async () => {
    gateway.circuitBreakerEnabled = false;
    const countFailure = vi.fn(() => true);
    await failTimes(2, unavailable, { countFailure });

    expect(countFailure).not.toHaveBeenCalled();
    expect(getCircuitState(KEY)).toBeUndefined();
  });
});

describe('a predicate that misbehaves', () => {
  it('counts the failure when it throws, and the caller still gets the provider\'s error', async () => {
    const countFailure = () => { throw new Error('predicate bug'); };
    await failTimes(3, forbidden, { countFailure });

    expect(getCircuitState(KEY)?.state).toBe('open');
  });

  it('only an explicit false ignores a failure', async () => {
    const countFailure = (() => undefined) as unknown as ResilienceOptions['countFailure'];
    await failTimes(3, forbidden, { countFailure });

    expect(getCircuitState(KEY)?.state).toBe('open');
  });
});

describe('without countFailure nothing changed', () => {
  it('counts a call that ran out of retries once, not once per attempt', async () => {
    gateway.retryEnabled = true;
    await failCall(unavailable());
    expect(getCircuitState(KEY)).toMatchObject({ state: 'closed', failures: 1 });
  });

  it('counts a non-retryable failure, a 4xx included', async () => {
    await failTimes(2, forbidden);
    expect(getCircuitState(KEY)).toMatchObject({ state: 'closed', failures: 2 });
    await failCall(forbidden());
    expect(getCircuitState(KEY)).toMatchObject({ state: 'open', failures: 3 });
    await expect(withResilience(async () => 'x', { key: KEY })).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it('resets the count on a success', async () => {
    gateway.retryEnabled = true;
    gateway.retryMaxAttempts = 2;
    await failTimes(2, unavailable);
    let calls = 0;
    await withResilience(async () => {
      calls += 1;
      if (calls === 1) throw unavailable();
      return 'ok';
    }, { key: KEY });
    expect(getCircuitState(KEY)).toMatchObject({ state: 'closed', failures: 0 });
  });

  it('re-opens a half-open circuit on any failure', async () => {
    await failTimes(3, unavailable);
    await sleep(110);
    await failCall(forbidden());
    expect(getCircuitState(KEY)?.state).toBe('open');
  });

  it('closes a half-open circuit on a success', async () => {
    await failTimes(3, unavailable);
    await sleep(110);
    await expect(withResilience(async () => 'ok', { key: KEY })).resolves.toBe('ok');
    expect(getCircuitState(KEY)).toMatchObject({ state: 'closed', failures: 0 });
  });

  it('leaves every circuit alone when the breaker is switched off', async () => {
    gateway.circuitBreakerEnabled = false;
    await failTimes(5, unavailable);
    expect(getAllCircuitStates().size).toBe(0);
  });
});

describe('who passes countFailure', () => {
  const SRC = path.join(process.cwd(), 'src');

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (name === '__tests__' || name === 'node_modules') return [];
      if (statSync(full).isDirectory()) return sourceFiles(full);
      return /\.(ts|tsx)$/.test(name) ? [full] : [];
    });
  }

  it('only the file service opts in: the gateway, model, vector and search callers keep counting every failure', () => {
    const users = sourceFiles(SRC)
      .filter((file) => /\bcountFailure\s*\??:/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(SRC, file).split(path.sep).join('/'))
      .sort();

    expect(users).toEqual(['lib/core/resilience.ts', 'lib/services/files/fileService.ts']);
  });
});
