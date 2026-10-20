import { describe, expect, it } from 'vitest';
import { mapLimit } from '@/lib/services/files/concurrency';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('mapLimit', () => {
  it('returns the results in the order of the items, not the order they finish in', async () => {
    const result = await mapLimit([30, 5, 15, 1], 4, async (ms, index) => {
      await sleep(ms);
      return `${index}:${ms}`;
    });
    expect(result).toEqual(['0:30', '1:5', '2:15', '3:1']);
  });

  it('never has more calls in flight than the limit', async () => {
    let active = 0;
    let peak = 0;
    await mapLimit(Array.from({ length: 12 }, (_, index) => index), 3, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await sleep(3);
      active -= 1;
    });
    expect(peak).toBe(3);
  });

  it('handles no items, and a limit that is not sensible', async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
    expect(await mapLimit([1, 2], 0, async (n) => n * 2)).toEqual([2, 4]);
    expect(await mapLimit([1, 2, 3], 99, async (n) => n)).toEqual([1, 2, 3]);
  });

  it('stops starting calls after one throws and rejects with its error once the others are done', async () => {
    const started: number[] = [];
    await expect(mapLimit([0, 1, 2, 3, 4, 5], 2, async (n) => {
      started.push(n);
      await sleep(2);
      if (n === 1) throw new Error('boom');
      return n;
    })).rejects.toThrow('boom');
    expect(started.length).toBeLessThan(6);
  });
});
