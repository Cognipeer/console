/**
 * The polling helper (`pollWhile`, `pollingOptions`) and the retry rule of the query hooks.
 */

import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api/client';
import { isClientError, retryUnlessClientError } from '@/lib/api/queries/errors';
import { pollingOptions, pollWhile } from '@/lib/api/queries/polling';

type Run = { status: 'queued' | 'running' | 'done' };
const running = (run: Run | undefined) => run?.status === 'queued' || run?.status === 'running';

describe('pollWhile', () => {
  const interval = pollWhile<Run>(running, 2000);

  it('asks again after ms while the data is unsettled', () => {
    expect(interval({ state: { data: { status: 'running' }, error: null } })).toBe(2000);
    expect(interval({ state: { data: { status: 'queued' }, error: null } })).toBe(2000);
  });

  it('stops once the data is settled, or when there is none yet', () => {
    expect(interval({ state: { data: { status: 'done' }, error: null } })).toBe(false);
    expect(interval({ state: { data: undefined, error: null } })).toBe(false);
  });

  it('stops after a refusal, keeps going after a failure that may pass', () => {
    const data = { status: 'running' } as const;
    expect(interval({ state: { data, error: new ApiError('gone', 404) } })).toBe(false);
    expect(interval({ state: { data, error: new ApiError('denied', 403) } })).toBe(false);
    expect(interval({ state: { data, error: new ApiError('down', 503) } })).toBe(2000);
    expect(interval({ state: { data, error: new Error('offline') } })).toBe(2000);
  });
});

describe('pollingOptions', () => {
  it('pairs the interval with no polling in a hidden tab', () => {
    const options = pollingOptions<Run>(running, 5000);
    expect(options.refetchIntervalInBackground).toBe(false);
    expect(options.refetchInterval({ state: { data: { status: 'running' }, error: null } })).toBe(5000);
  });
});

describe('retryUnlessClientError', () => {
  it('never retries a 4xx, retries anything else once', () => {
    expect(isClientError(new ApiError('x', 404))).toBe(true);
    expect(isClientError(new ApiError('x', 500))).toBe(false);
    expect(isClientError(new Error('x'))).toBe(false);
    expect(retryUnlessClientError(0, new ApiError('x', 404))).toBe(false);
    expect(retryUnlessClientError(0, new ApiError('x', 500))).toBe(true);
    expect(retryUnlessClientError(1, new ApiError('x', 500))).toBe(false);
    expect(retryUnlessClientError(0, new Error('offline'))).toBe(true);
  });
});
