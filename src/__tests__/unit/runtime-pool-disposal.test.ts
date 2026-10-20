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

/** A promise the test settles by hand, so it decides when a runtime "finishes building". */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('RuntimePool concurrent first use', () => {
  beforeEach(() => {
    providerRuntime.cacheTtlSeconds = 300;
    providerRuntime.disposeGraceSeconds = 0;
    runtimePool.invalidateByPrefix('test:');
  });

  it('builds ONE runtime for callers that ask for the same key and config at once, and they all get it', async () => {
    const gate = deferred<void>();
    const built: Closable[] = [];
    const factory = vi.fn(async () => {
      await gate.promise;
      const runtime = makeClosable(`r${built.length + 1}`);
      built.push(runtime);
      return runtime;
    });

    const calls = [1, 2, 3].map(() => runtimePool.getOrCreate('test:cc-same', 'hash-1', factory));
    await flush();
    gate.resolve();
    const [a, b, c] = await Promise.all(calls);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(runtimePool.stats().keys).toContain('test:cc-same');

    // It is the pooled one: a later call reuses it instead of building again.
    expect(await runtimePool.getOrCreate('test:cc-same', 'hash-1', factory)).toBe(a);
    expect(factory).toHaveBeenCalledTimes(1);

    // Nothing is left unreleased: the one runtime built is the one that gets closed.
    runtimePool.invalidate('test:cc-same');
    await flush();
    expect(built.map((runtime) => runtime.closed)).toEqual([true]);
  });

  it('builds a runtime per key when different keys are asked for at once', async () => {
    const factory = vi.fn(async () => makeClosable('x'));
    const [a, b] = await Promise.all([
      runtimePool.getOrCreate('test:cc-k1', 'hash-1', factory),
      runtimePool.getOrCreate('test:cc-k2', 'hash-1', factory),
    ]);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(a).not.toBe(b);
  });

  it('shares a failed build with the callers waiting on it, and does not cache the failure', async () => {
    const gate = deferred<void>();
    const failing = vi.fn(async () => {
      await gate.promise;
      throw new Error('storage unreachable');
    });

    const calls = [1, 2].map(() => runtimePool.getOrCreate('test:cc-fail', 'hash-1', failing));
    const settled = Promise.allSettled(calls);
    await flush();
    gate.resolve();
    const results = await settled;

    expect(failing).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(runtimePool.stats().keys).not.toContain('test:cc-fail');

    // The next call tries again instead of replaying the failure.
    const recovered = makeClosable('recovered');
    await expect(runtimePool.getOrCreate('test:cc-fail', 'hash-1', async () => recovered)).resolves.toBe(recovered);
  });

  it('lets a build for another config go its own way; the newer one is pooled and the superseded one is released', async () => {
    for (const finishOrder of [['old', 'new'], ['new', 'old']] as const) {
      const key = `test:cc-edit-${finishOrder.join('-')}`;
      const gates = { old: deferred<Closable>(), new: deferred<Closable>() };
      const runtimes = { old: makeClosable('old'), new: makeClosable('new') };

      const oldCall = runtimePool.getOrCreate(key, 'hash-old', () => gates.old.promise);
      const newCall = runtimePool.getOrCreate(key, 'hash-new', () => gates.new.promise);
      for (const which of finishOrder) {
        gates[which].resolve(runtimes[which]);
        await flush();
      }

      // Both callers get the runtime they asked for, for the call in hand...
      expect(await oldCall).toBe(runtimes.old);
      expect(await newCall).toBe(runtimes.new);
      // ...but only the one for the current config is pooled, and the other is not left open.
      expect(await runtimePool.getOrCreate(key, 'hash-new', async () => makeClosable('unused'))).toBe(runtimes.new);
      await flush();
      expect(runtimes.old.closed, finishOrder.join(' then ')).toBe(true);
      expect(runtimes.new.closed, finishOrder.join(' then ')).toBe(false);
    }
  });

  it('does not pool a runtime whose key was invalidated while it was being built, and releases it', async () => {
    const gate = deferred<Closable>();
    const stale = makeClosable('stale');

    const call = runtimePool.getOrCreate('test:cc-invalidated', 'hash-1', () => gate.promise);
    runtimePool.invalidate('test:cc-invalidated');
    gate.resolve(stale);

    // The caller still gets the runtime it waited for.
    expect(await call).toBe(stale);
    await flush();
    expect(stale.closed).toBe(true);
    expect(runtimePool.stats().keys).not.toContain('test:cc-invalidated');

    // The next call builds afresh.
    const fresh = makeClosable('fresh');
    await expect(runtimePool.getOrCreate('test:cc-invalidated', 'hash-1', async () => fresh)).resolves.toBe(fresh);
  });

  it('a prefix invalidate drops builds in flight as well', async () => {
    const gate = deferred<Closable>();
    const stale = makeClosable('stale');
    const call = runtimePool.getOrCreate('test:cc-prefix:one', 'hash-1', () => gate.promise);

    runtimePool.invalidateByPrefix('test:cc-prefix:');
    gate.resolve(stale);

    expect(await call).toBe(stale);
    await flush();
    expect(stale.closed).toBe(true);
    expect(runtimePool.stats().keys).not.toContain('test:cc-prefix:one');
  });

  it('a runtime that arrives after the pool was destroyed is released at once, even within the grace period', async () => {
    // A pool of its own: destroying the shared one would stop its sweep for the other tests.
    const { runtimePool: shared } = await import('@/lib/core/runtimePool');
    const PoolClass = shared.constructor as new () => typeof shared;
    const pool = new PoolClass();
    providerRuntime.disposeGraceSeconds = 60;

    const gate = deferred<Closable>();
    const late = makeClosable('late');
    const call = pool.getOrCreate('test:cc-destroyed', 'hash-1', () => gate.promise);
    pool.destroy();
    gate.resolve(late);

    expect(await call).toBe(late);
    await flush();
    expect(late.closed).toBe(true);
  });
});
