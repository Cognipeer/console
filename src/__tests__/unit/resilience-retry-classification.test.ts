/**
 * Unit tests — which failures withResilience retries
 *
 * A failure that can never succeed (a rejected credential, a missing bucket, an
 * oversized body, a header Node refuses to write) used to cost every attempt, and
 * an AWS SDK error hid its status in `$metadata`, where the check did not look.
 * The retry decision is private, so these observe it the way a caller does: how
 * many times the operation ran before the call gave up.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const gateway = {
  requestTimeoutMs: 1_000,
  retryEnabled: true,
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

import { errorStatusCodes, isRetryable, resetAllCircuits, withResilience } from '@/lib/core/resilience';
import { ProviderSettingsError } from '@/lib/providers/errors';
import { OutboundDnsError, OutboundNetworkError } from '@/lib/security/outboundFetch';
import { ProviderEndpointError } from '@/lib/services/providers/providerEndpointGuard';

const ATTEMPTS = 3;

/** How many times the operation ran before `withResilience` rejected with `error`. */
async function attemptsUntilRejected(error: unknown): Promise<number> {
  const operation = vi.fn(async () => {
    throw error;
  });
  await expect(withResilience(operation, { key: 'classify:test' })).rejects.toBe(error);
  return operation.mock.calls.length;
}

const withProps = (message: string, props: Record<string, unknown>) => Object.assign(new Error(message), props);

beforeEach(() => {
  resetAllCircuits();
  gateway.retryEnabled = true;
  gateway.retryMaxAttempts = ATTEMPTS;
});

describe('an error that declares retryable', () => {
  it('false is not retried, whatever else it says', async () => {
    expect(await attemptsUntilRejected(withProps('storage said no', { retryable: false }))).toBe(1);
    // ...even when its status or message would have made it retryable.
    expect(await attemptsUntilRejected(withProps('storage said no', { retryable: false, status: 503 }))).toBe(1);
  });

  it('true is retried, even when its status or message would have stopped it', async () => {
    expect(await attemptsUntilRejected(withProps('token expired', { retryable: true, status: 403 }))).toBe(ATTEMPTS);
    expect(await attemptsUntilRejected(withProps('Unauthorized, refreshing', { retryable: true }))).toBe(ATTEMPTS);
    expect(await attemptsUntilRejected(withProps('bad request', { retryable: true, $metadata: { httpStatusCode: 400 } }))).toBe(ATTEMPTS);
  });

  it('is only honoured as a boolean: any other value falls back to the usual rules', async () => {
    expect(await attemptsUntilRejected(withProps('flaky', { retryable: 'no' }))).toBe(ATTEMPTS);
    expect(await attemptsUntilRejected(withProps('flaky', { retryable: 0 }))).toBe(ATTEMPTS);
    expect(await attemptsUntilRejected(withProps('denied', { retryable: 'yes', status: 403 }))).toBe(1);
  });
});

describe('the status an error carries', () => {
  it.each([400, 401, 403, 404, 409, 413, 422])('is not retried for %i, wherever the SDK keeps it', async (status) => {
    expect(await attemptsUntilRejected(withProps('failed', { status }))).toBe(1);
    expect(await attemptsUntilRejected(withProps('failed', { statusCode: status }))).toBe(1);
    expect(await attemptsUntilRejected(withProps('failed', { $metadata: { httpStatusCode: status } }))).toBe(1);
  });

  it('is retried for 408, 429 and the 5xx family', async () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      expect(await attemptsUntilRejected(withProps('failed', { $metadata: { httpStatusCode: status } }))).toBe(ATTEMPTS);
      expect(await attemptsUntilRejected(withProps('failed', { status }))).toBe(ATTEMPTS);
    }
  });

  it('reads a status written into the message as before (413 included)', async () => {
    expect(await attemptsUntilRejected(new Error('upload rejected, status: 413'))).toBe(1);
    expect(await attemptsUntilRejected(new Error('request failed with status 404'))).toBe(1);
    expect(await attemptsUntilRejected(new Error('request failed with status 500'))).toBe(ATTEMPTS);
  });

  it('skips a value that is not a number and reads the next place', async () => {
    expect(await attemptsUntilRejected(withProps('failed', { status: 'failed', statusCode: 403 }))).toBe(1);
    expect(await attemptsUntilRejected(withProps('failed', { status: '403' }))).toBe(ATTEMPTS);
    expect(await attemptsUntilRejected(withProps('failed', { $metadata: null }))).toBe(ATTEMPTS);
  });
});

describe('a header Node refuses to write', () => {
  it.each(['ERR_INVALID_CHAR', 'ERR_INVALID_HTTP_TOKEN'])('%s is not retried: every attempt fails the same way', async (code) => {
    const error = Object.assign(new TypeError('Invalid character in header content ["x-amz-meta-name"]'), { code });
    expect(await attemptsUntilRejected(error)).toBe(1);
  });

  it('other error codes keep being retried', async () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ERR_INVALID_URL', 'EMFILE', 'EIO', 'ENOSPC']) {
      expect(await attemptsUntilRejected(withProps('network', { code }))).toBe(ATTEMPTS);
    }
    expect(await attemptsUntilRejected(withProps('numeric code', { code: 400 }))).toBe(ATTEMPTS);
  });
});

describe('a path that is not there', () => {
  it.each(['ENOENT', 'ENOTDIR', 'EISDIR'])('%s is not retried: the same path fails the same way', async (code) => {
    expect(await attemptsUntilRejected(withProps(`${code}: no such file or directory, open '/data/a.txt'`, { code }))).toBe(1);
  });
});

describe('a refusal made by the outbound guard or by a setting', () => {
  it('is not retried: the same target, endpoint or setting is refused again, so waiting only delays the answer', async () => {
    expect(await attemptsUntilRejected(new OutboundNetworkError('Refusing outbound request to private/loopback host: minio.internal'))).toBe(1);
    expect(await attemptsUntilRejected(new OutboundNetworkError('Invalid URL'))).toBe(1);
    expect(await attemptsUntilRejected(new OutboundNetworkError('Unsupported protocol for outbound request: ftp:'))).toBe(1);
    expect(await attemptsUntilRejected(new ProviderEndpointError('endpoint', 'private network targets are not allowed'))).toBe(1);
    expect(await attemptsUntilRejected(new ProviderSettingsError('allowInsecureTls', 'must be true or false.'))).toBe(1);
  });

  it('is not retried whatever its message says, because it declares so', async () => {
    // "forbidden" in a host name used to decide this by accident; "status: 503" in a message would have asked for retries.
    expect(await attemptsUntilRejected(new OutboundNetworkError('Refusing outbound request to private/loopback host: status: 503'))).toBe(1);
    expect(isRetryable(new OutboundNetworkError('x'))).toBe(false);
    expect(isRetryable(new ProviderEndpointError('endpoint', 'x'))).toBe(false);
    expect(isRetryable(new ProviderSettingsError('endpoint', 'x'))).toBe(false);
  });

  it('a resolver that fails is retried like any outage (even for a host name that contains a keyword)', async () => {
    expect(await attemptsUntilRejected(new OutboundDnsError('Could not resolve host: storage.example.com'))).toBe(ATTEMPTS);
    expect(await attemptsUntilRejected(new OutboundDnsError('Could not resolve host: forbidden.example.com'))).toBe(ATTEMPTS);
    expect(isRetryable(new OutboundDnsError('x'))).toBe(true);
  });
});

describe('everything else is classified as before', () => {
  it('retries an unclassified error', async () => {
    expect(await attemptsUntilRejected(new Error('socket hang up'))).toBe(ATTEMPTS);
  });

  it('does not retry authentication or authorization messages', async () => {
    expect(await attemptsUntilRejected(new Error('Unauthorized'))).toBe(1);
    expect(await attemptsUntilRejected(new Error('Access Forbidden'))).toBe(1);
    expect(await attemptsUntilRejected(new Error('Invalid API key provided'))).toBe(1);
  });

  it('retries a thrown value that is not an Error (its status is not read)', async () => {
    expect(await attemptsUntilRejected({ status: 403 })).toBe(ATTEMPTS);
    expect(await attemptsUntilRejected('boom')).toBe(ATTEMPTS);
  });

  it('retries nothing when retrying is switched off', async () => {
    gateway.retryEnabled = false;
    expect(await attemptsUntilRejected(new Error('socket hang up'))).toBe(1);
  });

  it('recovers when a retry succeeds', async () => {
    let calls = 0;
    const result = await withResilience(async () => {
      calls += 1;
      if (calls < 3) throw withProps('overloaded', { $metadata: { httpStatusCode: 503 } });
      return 'ok';
    }, { key: 'classify:test' });
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });
});

describe('errorStatusCodes', () => {
  it('collects every numeric status, from status, statusCode and $metadata.httpStatusCode', () => {
    expect(errorStatusCodes({ status: 404 })).toEqual([404]);
    expect(errorStatusCodes({ statusCode: 503 })).toEqual([503]);
    expect(errorStatusCodes({ $metadata: { httpStatusCode: 403, requestId: 'r1' } })).toEqual([403]);
    expect(errorStatusCodes({ status: 500, statusCode: 502, $metadata: { httpStatusCode: 503 } })).toEqual([500, 502, 503]);
  });

  it('skips values that are not numbers and inputs that are not objects', () => {
    expect(errorStatusCodes({ status: '404', statusCode: null, $metadata: {} })).toEqual([]);
    expect(errorStatusCodes({ $metadata: null })).toEqual([]);
    expect(errorStatusCodes(null)).toEqual([]);
    expect(errorStatusCodes(undefined)).toEqual([]);
    expect(errorStatusCodes('503')).toEqual([]);
    expect(errorStatusCodes(503)).toEqual([]);
  });
});
