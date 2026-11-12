/** The helpers a turn uses to start independent reads together and still behave like the serial code (concurrentBuild.ts). */

import { describe, expect, it, vi } from 'vitest';

import { allInOrder, deferredWarnings, settleInOrder, started } from '@/lib/services/agents/concurrentBuild';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('settleInOrder', () => {
  it('answers the values in list order', async () => {
    const result = await settleInOrder([sleep(10).then(() => 'a'), Promise.resolve(2), 'plain']);
    expect(result).toEqual({ ok: true, values: ['a', 2, 'plain'] });
  });

  it('reports the first failure in list order, not in time', async () => {
    const early = new Error('first in the list, fails late');
    const result = await settleInOrder([
      sleep(20).then(() => { throw early; }),
      Promise.reject(new Error('second in the list, fails at once')),
    ]);
    expect(result).toEqual({ ok: false, reason: early });
  });

  it('waits for every promise before it answers', async () => {
    let slowDone = false;
    const result = await settleInOrder([
      Promise.reject(new Error('fails at once')),
      sleep(25).then(() => { slowDone = true; }),
    ]);
    expect(result.ok).toBe(false);
    expect(slowDone).toBe(true);
  });
});

describe('allInOrder', () => {
  it('answers the values, and throws the first failure in list order', async () => {
    await expect(allInOrder([Promise.resolve(1), sleep(5).then(() => 2)])).resolves.toEqual([1, 2]);
    await expect(allInOrder([
      sleep(15).then(() => { throw new Error('list-first'); }),
      Promise.reject(new Error('list-second')),
    ])).rejects.toThrow('list-first');
  });
});

describe('started', () => {
  it('keeps a read nobody awaits from becoming an unhandled rejection, and still throws for one who does', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      started(Promise.reject(new Error('never awaited')));
      const awaited = started(Promise.reject(new Error('awaited')));
      await sleep(20);
      expect(unhandled).not.toHaveBeenCalled();
      await expect(awaited).rejects.toThrow('awaited');
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('deferredWarnings', () => {
  it('holds warnings back until released, in the order they came, then passes later ones straight through', () => {
    const sink = new Set<string>();
    const held = deferredWarnings(sink);
    held.add('one');
    held.add('two');
    expect([...sink]).toEqual([]);

    sink.add('between');
    held.release();
    expect([...sink]).toEqual(['between', 'one', 'two']);

    held.add('three');
    expect([...sink]).toEqual(['between', 'one', 'two', 'three']);
    held.release();
    expect([...sink]).toEqual(['between', 'one', 'two', 'three']);
  });
});
