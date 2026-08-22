/**
 * Unit tests — RuntimePool connection disposal
 *
 * Evicting a cached runtime used to be a bare `delete`, which dropped the
 * reference while its pg pool / Elasticsearch client kept every socket open —
 * an unbounded FD leak across tenant×provider combinations. These cover the
 * deferred close, and the grace period that keeps it from cutting a request
 * that is still holding the runtime.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const providerRuntime = {
  cacheTtlSeconds: 300,
  disposeGraceSeconds: 0,
};

vi.mock('@/lib/core/config', () => ({
  getConfig: () => ({ providerRuntime }),
}));

vi.mock('@/lib/core/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

import { runtimePool } from '@/lib/core/runtimePool';

interface Closable {
  id: string;
  closed: boolean;
  close: () => Promise<void>;
}

function makeClosable(id: string): Closable {
  const runtime: Closable = {
    id,
    closed: false,
    close: async () => { runtime.closed = true; },
  };
  return runtime;
}

/** Let the queued close microtasks settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('RuntimePool disposal', () => {
  beforeEach(() => {
    providerRuntime.cacheTtlSeconds = 300;
    providerRuntime.disposeGraceSeconds = 0;
    runtimePool.invalidateByPrefix('test:');
  });

  it('closes a runtime dropped by an explicit invalidate', async () => {
    const runtime = makeClosable('a');
    await runtimePool.getOrCreate('test:a', 'hash-1', async () => runtime);

    runtimePool.invalidate('test:a');
    await flush();

    expect(runtime.closed).toBe(true);
  });

  it('closes the old runtime when credentials change', async () => {
    const first = makeClosable('first');
    const second = makeClosable('second');

    await runtimePool.getOrCreate('test:b', 'hash-1', async () => first);
    await runtimePool.getOrCreate('test:b', 'hash-2', async () => second);
    await flush();

    expect(first.closed).toBe(true);
    expect(second.closed).toBe(false);
  });

  it('holds the close until the grace period elapses', async () => {
    providerRuntime.disposeGraceSeconds = 60;
    const runtime = makeClosable('c');
    await runtimePool.getOrCreate('test:c', 'hash-1', async () => runtime);

    runtimePool.invalidate('test:c');
    await flush();

    // A request that already holds this runtime must be allowed to finish.
    expect(runtime.closed).toBe(false);
  });

  it('leaves a runtime that is still cached open', async () => {
    const runtime = makeClosable('d');
    await runtimePool.getOrCreate('test:d', 'hash-1', async () => runtime);
    await runtimePool.getOrCreate('test:d', 'hash-1', async () => makeClosable('unused'));
    await flush();

    expect(runtime.closed).toBe(false);
  });

  it('closes every runtime dropped by a prefix invalidate', async () => {
    const one = makeClosable('one');
    const two = makeClosable('two');
    await runtimePool.getOrCreate('test:tenant:one', 'hash-1', async () => one);
    await runtimePool.getOrCreate('test:tenant:two', 'hash-1', async () => two);

    runtimePool.invalidateByPrefix('test:tenant:');
    await flush();

    expect(one.closed).toBe(true);
    expect(two.closed).toBe(true);
  });

  it('ignores a runtime that exposes no close()', async () => {
    const plain = { id: 'plain' };
    await runtimePool.getOrCreate('test:plain', 'hash-1', async () => plain);

    expect(() => runtimePool.invalidate('test:plain')).not.toThrow();
  });

  it('survives a close() that throws', async () => {
    const runtime = {
      close: async () => { throw new Error('connection already gone'); },
    };
    await runtimePool.getOrCreate('test:throws', 'hash-1', async () => runtime);

    runtimePool.invalidate('test:throws');
    await expect(flush()).resolves.toBeUndefined();
  });
});
