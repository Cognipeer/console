/**
 * The memory queue driver's `schedule()`: a repeating publish, replaced when
 * the same id is scheduled again, stopped by `destroy()`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryQueueProvider } from '@/lib/core/queue/memoryQueueProvider';

let queue: MemoryQueueProvider;

beforeEach(async () => {
  vi.useFakeTimers();
  queue = new MemoryQueueProvider({ attempts: 1, backoffMs: 10 });
  await queue.init();
});

afterEach(async () => {
  await queue.destroy();
  vi.useRealTimers();
});

describe('MemoryQueueProvider.schedule', () => {
  it('publishes the job every interval to the consumer', async () => {
    const seen: string[] = [];
    queue.consume('retention', async (ctx) => { seen.push(ctx.name); });
    await queue.schedule('tick', 'retention', 'tick', {}, { everyMs: 5_000 });

    await vi.advanceTimersByTimeAsync(4_000);
    expect(seen).toEqual([]);
    await vi.advanceTimersByTimeAsync(11_100);
    expect(seen).toEqual(['tick', 'tick', 'tick']);
  });

  it('replaces a schedule registered under the same id', async () => {
    const seen: unknown[] = [];
    queue.consume('retention', async (ctx) => { seen.push(ctx.data.v); });
    await queue.schedule('tick', 'retention', 'tick', { v: 1 }, { everyMs: 5_000 });
    await queue.schedule('tick', 'retention', 'tick', { v: 2 }, { everyMs: 5_000 });

    await vi.advanceTimersByTimeAsync(5_100);
    expect(seen).toEqual([2]);
  });

  it('stops on destroy', async () => {
    const handler = vi.fn(async () => undefined);
    queue.consume('retention', handler);
    await queue.schedule('tick', 'retention', 'tick', {}, { everyMs: 5_000 });
    await queue.destroy();

    await vi.advanceTimersByTimeAsync(20_000);
    expect(handler).not.toHaveBeenCalled();
  });
});
