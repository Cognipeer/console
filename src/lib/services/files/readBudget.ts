/**
 * How much stored data this process reads into memory at once.
 *
 * A storage driver hands an object back as one Buffer, and while it collects a body it holds the object twice: the
 * chunks, and the Buffer they are joined into (a body that has no length is only known to be too large after it was
 * collected). The ceiling of one object (`maxStorageDownloadBytes`) bounds a single read; this bounds the reads that
 * run together, so a burst of downloads of large files waits for the earlier ones instead of adding up to more
 * memory than the process has.
 *
 * The budget is counted in bytes, not in reads: a hundred downloads of small files go on at once, while two reads of
 * the largest files a deployment takes already fill it. A read waits in the order it came. A read that is larger than
 * the whole budget still runs - alone, once the earlier ones have finished - so no file is unreadable.
 *
 * This is the memory of one process. Several replicas each have their own budget.
 */

const MIB = 1024 * 1024;

/** What the reads running together may hold at their peak, in bytes. */
export const READ_BUDGET_BYTES = 512 * MIB;

/** What one read of an object holds at its peak, as a multiple of the object: the chunks and the joined Buffer. */
export const READ_PEAK_FACTOR = 2;

/** What a read counts for at least (the object's size is not always known, and a read is never free). */
export const READ_MIN_WEIGHT_BYTES = MIB;

/** What a read of an object of `size` bytes counts for against the budget. */
export function readWeight(size: number | null | undefined): number {
  const bytes = typeof size === 'number' && Number.isFinite(size) && size > 0 ? size : 0;
  return Math.max(READ_MIN_WEIGHT_BYTES, Math.ceil(bytes * READ_PEAK_FACTOR));
}

export interface ReadBudget {
  /**
   * Runs `read` once the weight of an object of `size` bytes is free in the budget (or nothing else is reading), and
   * gives it back when `read` ends, whether it returns or throws. Resolves with what `read` resolves with.
   */
  run<T>(size: number | null | undefined, read: () => Promise<T>): Promise<T>;
  /** What is held right now: for tests and diagnostics. */
  snapshot(): { heldBytes: number; reading: number; waiting: number };
}

interface Waiter {
  weight: number;
  start: () => void;
}

export function createReadBudget(budgetBytes: number): ReadBudget {
  let held = 0;
  let reading = 0;
  const waiting: Waiter[] = [];

  /** Nothing is ever refused for being large: a read that is alone has the whole budget, whatever it weighs. */
  const fits = (weight: number): boolean => reading === 0 || held + weight <= budgetBytes;

  function take(weight: number): void {
    held += weight;
    reading += 1;
  }

  function admitWaiting(): void {
    // In order: a large read at the head is not overtaken by the small ones behind it, or it could wait forever.
    while (waiting.length > 0 && fits(waiting[0].weight)) {
      const next = waiting.shift() as Waiter;
      take(next.weight);
      next.start();
    }
  }

  return {
    async run(size, read) {
      const weight = readWeight(size);
      if (waiting.length > 0 || !fits(weight)) {
        // Taken for this read by `admitWaiting` before it is started, so no other read can slip in between.
        await new Promise<void>((resolve) => {
          waiting.push({ weight, start: resolve });
        });
      } else {
        take(weight);
      }
      try {
        return await read();
      } finally {
        held -= weight;
        reading -= 1;
        admitWaiting();
      }
    },
    snapshot: () => ({ heldBytes: held, reading, waiting: waiting.length }),
  };
}

/** The reads of stored objects in this process: the file service, the archive and the conversion job all go through it. */
export const storedObjectReads: ReadBudget = createReadBudget(READ_BUDGET_BYTES);
