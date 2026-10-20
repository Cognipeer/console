/**
 * The memory budget for reading stored objects: reads that fit run together, the ones that do not wait their turn,
 * and no object is unreadable for being large.
 */
import { describe, expect, it } from 'vitest';
import {
  createReadBudget,
  READ_BUDGET_BYTES,
  READ_MIN_WEIGHT_BYTES,
  READ_PEAK_FACTOR,
  readWeight,
  storedObjectReads,
} from '@/lib/services/files/readBudget';

const MIB = 1024 * 1024;

/** A read that ends when `finish()` is called, and that says when it began. */
function gatedRead(label: string, started: string[]) {
  let finish!: (value?: string) => void;
  let fail!: (error: Error) => void;
  const gate = new Promise<string>((resolve, reject) => {
    finish = (value = label) => resolve(value);
    fail = reject;
  });
  return {
    read: () => {
      started.push(label);
      return gate;
    },
    finish,
    fail,
  };
}

/** Lets every promise that can settle without a timer settle. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('readWeight', () => {
  it('counts the peak of a read: the object twice', () => {
    expect(READ_PEAK_FACTOR).toBe(2);
    expect(readWeight(10 * MIB)).toBe(20 * MIB);
    expect(readWeight(100 * MIB)).toBe(200 * MIB);
  });

  it('never counts a read as free, and does not trust a size that is not a number', () => {
    expect(readWeight(0)).toBe(READ_MIN_WEIGHT_BYTES);
    expect(readWeight(1)).toBe(READ_MIN_WEIGHT_BYTES);
    for (const size of [undefined, null, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(readWeight(size as number), String(size)).toBe(READ_MIN_WEIGHT_BYTES);
    }
  });
});

describe('createReadBudget', () => {
  it('runs reads together while they fit', async () => {
    const budget = createReadBudget(100 * MIB);
    const started: string[] = [];
    const reads = ['a', 'b', 'c', 'd', 'e'].map((label) => gatedRead(label, started));

    const results = reads.map((gated) => budget.run(10 * MIB, gated.read)); // 5 x 20 MiB = 100 MiB
    await settle();

    expect(started).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(budget.snapshot()).toEqual({ heldBytes: 100 * MIB, reading: 5, waiting: 0 });
    reads.forEach((gated) => gated.finish());
    expect(await Promise.all(results)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(budget.snapshot()).toEqual({ heldBytes: 0, reading: 0, waiting: 0 });
  });

  it('makes a read that does not fit wait, and starts it as soon as enough is given back', async () => {
    const budget = createReadBudget(100 * MIB);
    const started: string[] = [];
    const first = gatedRead('first', started);
    const second = gatedRead('second', started);
    const third = gatedRead('third', started);

    const results = [
      budget.run(30 * MIB, first.read), // 60
      budget.run(15 * MIB, second.read), // 30: 90 held
      budget.run(10 * MIB, third.read), // 20: would be 110
    ];
    await settle();
    expect(started).toEqual(['first', 'second']);
    expect(budget.snapshot()).toEqual({ heldBytes: 90 * MIB, reading: 2, waiting: 1 });

    second.finish(); // 60 held: the third (20) fits
    await settle();
    expect(started).toEqual(['first', 'second', 'third']);
    expect(budget.snapshot()).toEqual({ heldBytes: 80 * MIB, reading: 2, waiting: 0 });

    first.finish();
    third.finish();
    expect(await Promise.all(results)).toEqual(['first', 'second', 'third']);
  });

  it('serves the reads in the order they came: a large read is not overtaken by the small ones behind it', async () => {
    const budget = createReadBudget(100 * MIB);
    const started: string[] = [];
    const running = gatedRead('running', started);
    const large = gatedRead('large', started);
    const small = gatedRead('small', started);

    const results = [
      budget.run(30 * MIB, running.read), // 60 held
      budget.run(25 * MIB, large.read), // 50: does not fit (110)
      budget.run(1 * MIB, small.read), // 2: would fit (62) but the large one came first
    ];
    await settle();
    expect(started).toEqual(['running']);
    expect(budget.snapshot().waiting).toBe(2);

    running.finish();
    await settle();
    expect(started).toEqual(['running', 'large', 'small']);
    large.finish();
    small.finish();
    await Promise.all(results);
  });

  it('runs a read that is larger than the whole budget - alone, after the earlier ones, before the later ones', async () => {
    const budget = createReadBudget(100 * MIB);
    const started: string[] = [];
    const before = gatedRead('before', started);
    const huge = gatedRead('huge', started);
    const after = gatedRead('after', started);

    const results = [
      budget.run(5 * MIB, before.read),
      budget.run(400 * MIB, huge.read), // 800 MiB against a budget of 100
      budget.run(1 * MIB, after.read),
    ];
    await settle();
    expect(started).toEqual(['before']);

    before.finish();
    await settle();
    expect(started).toEqual(['before', 'huge']);
    expect(budget.snapshot()).toMatchObject({ reading: 1, waiting: 1 });

    huge.finish();
    await settle();
    expect(started).toEqual(['before', 'huge', 'after']);
    after.finish();
    await Promise.all(results);
    expect(budget.snapshot()).toEqual({ heldBytes: 0, reading: 0, waiting: 0 });
  });

  it('runs a read larger than the budget at once when nothing else is reading', async () => {
    const budget = createReadBudget(10 * MIB);
    await expect(budget.run(500 * MIB, async () => 'read')).resolves.toBe('read');
  });

  it('gives its share back when a read fails, and the next one goes on', async () => {
    const budget = createReadBudget(40 * MIB);
    const started: string[] = [];
    const failing = gatedRead('failing', started);
    const next = gatedRead('next', started);

    const failed = budget.run(15 * MIB, failing.read);
    const waited = budget.run(15 * MIB, next.read); // 30 + 30 > 40
    await settle();
    expect(started).toEqual(['failing']);

    failing.fail(new Error('the store refused'));
    await expect(failed).rejects.toThrow('the store refused');
    await settle();
    expect(started).toEqual(['failing', 'next']);

    next.finish();
    await expect(waited).resolves.toBe('next');
    expect(budget.snapshot()).toEqual({ heldBytes: 0, reading: 0, waiting: 0 });
  });

  it('gives its share back when the read throws before it returns a promise', async () => {
    const budget = createReadBudget(40 * MIB);
    const crashed = budget.run(5 * MIB, () => {
      throw new Error('synchronous failure');
    });
    await expect(crashed).rejects.toThrow('synchronous failure');
    expect(budget.snapshot()).toEqual({ heldBytes: 0, reading: 0, waiting: 0 });
  });

  it('bounds what runs together however many reads come', async () => {
    const budget = createReadBudget(100 * MIB);
    let running = 0;
    let peak = 0;
    const reads = Array.from({ length: 40 }, (_, index) => budget.run(10 * MIB, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 1 + (index % 3)));
      running -= 1;
      return index;
    }));

    expect(await Promise.all(reads)).toEqual(Array.from({ length: 40 }, (_, index) => index));
    expect(peak).toBe(5); // 5 x 20 MiB fill 100 MiB
    expect(budget.snapshot()).toEqual({ heldBytes: 0, reading: 0, waiting: 0 });
  });
});

describe('storedObjectReads', () => {
  it('holds a read of any size to the process-wide budget, and is idle when nothing reads', () => {
    expect(READ_BUDGET_BYTES).toBe(512 * MIB);
    expect(storedObjectReads.snapshot()).toEqual({ heldBytes: 0, reading: 0, waiting: 0 });
  });
});
