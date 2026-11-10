import { describe, expect, it } from 'vitest';
import { NullCacheProvider } from '@/lib/core/cache/nullCacheProvider';

describe('NullCacheProvider', () => {
  it('does not store values', async () => {
    const cache = new NullCacheProvider();
    await cache.set('k', 1);
    expect(await cache.get('k')).toBeUndefined();
    await cache.destroy();
  });

  it('accumulates counters within a window', async () => {
    const cache = new NullCacheProvider();
    await cache.incrementCounter('rl:a', 60);
    const second = await cache.incrementCounter('rl:a', 60, 2);
    expect(second.count).toBe(3);
    await cache.destroy();
  });

  it('grants a lock to one holder at a time', async () => {
    const cache = new NullCacheProvider();
    const token = await cache.acquireLock('sweep', 60);
    expect(token).toBeTypeOf('string');
    expect(await cache.acquireLock('sweep', 60)).toBeUndefined();
    await cache.releaseLock('sweep', token as string);
    expect(await cache.acquireLock('sweep', 60)).toBeTypeOf('string');
    await cache.destroy();
  });
});
