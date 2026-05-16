import { describe, expect, it } from 'vitest';
import { MemoryCacheProvider } from '@/lib/core/cache/memoryCacheProvider';

describe('MemoryCacheProvider counters', () => {
  it('increments counters within the active TTL window', async () => {
    const cache = new MemoryCacheProvider(30);

    const first = await cache.incrementCounter('quota:test', 60, 2);
    const second = await cache.incrementCounter('quota:test', 60, 3);

    expect(first.count).toBe(2);
    expect(second.count).toBe(5);
    expect(second.resetAt.getTime()).toBe(first.resetAt.getTime());

    await cache.destroy();
  });
});

describe('MemoryCacheProvider locks', () => {
  it('only grants a lock to one owner at a time', async () => {
    const cache = new MemoryCacheProvider(30);

    const firstToken = await cache.acquireLock('scheduler:test', 60);
    const secondToken = await cache.acquireLock('scheduler:test', 60);

    expect(firstToken).toBeTypeOf('string');
    expect(secondToken).toBeUndefined();

    await cache.releaseLock('scheduler:test', firstToken as string);

    const thirdToken = await cache.acquireLock('scheduler:test', 60);
    expect(thirdToken).toBeTypeOf('string');

    await cache.destroy();
  });
});
