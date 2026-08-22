/**
 * Unit tests — bounded background task queue
 *
 * Background work used to start the moment it was handed over, so the backlog
 * grew with the request rate. These cover the concurrency ceiling, the shedding
 * that protects it, and the guarantee that usage-class work is never shed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/core/logger', () => ({
  createLogger: () => ({
    debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  }),
}));

vi.mock('@/lib/core/requestContext', () => ({
  captureRequestContext: () => undefined,
  runWithRequestContext: (_snapshot: unknown, fn: () => Promise<void>) => fn(),
}));

const MAX_CONCURRENT = 4;
process.env.ASYNC_TASK_MAX_CONCURRENT = String(MAX_CONCURRENT);
process.env.ASYNC_TASK_MAX_QUEUED = '5';

const { fireAndForget, drainPendingTasks, pendingTaskCount, backgroundTaskStats } =
  await import('@/lib/core/asyncTask');

/** A task that only settles when its resolver is called. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = () => r(); });
  return { promise, resolve };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('bounded background queue', () => {
  beforeEach(async () => {
    await drainPendingTasks(1000);
  });

  it('runs a task and drains it', async () => {
    const ran = vi.fn();
    fireAndForget('unit', async () => { ran(); });

    await drainPendingTasks(1000);
    expect(ran).toHaveBeenCalledTimes(1);
    expect(pendingTaskCount()).toBe(0);
  });

  it('never exceeds the concurrency ceiling', async () => {
    const gates = Array.from({ length: MAX_CONCURRENT + 3 }, () => deferred());
    let peak = 0;
    let active = 0;

    gates.forEach((gate, i) => {
      fireAndForget(`task-${i}`, async () => {
        active += 1;
        peak = Math.max(peak, active);
        await gate.promise;
        active -= 1;
      });
    });

    await flush();
    expect(backgroundTaskStats().inFlight).toBe(MAX_CONCURRENT);
    expect(backgroundTaskStats().queued).toBe(3);

    gates.forEach((gate) => gate.resolve());
    await drainPendingTasks(1000);

    expect(peak).toBe(MAX_CONCURRENT);
    expect(active).toBe(0);
  });

  it('sheds droppable work once the queue is saturated', async () => {
    const gates = Array.from({ length: MAX_CONCURRENT }, () => deferred());
    gates.forEach((gate, i) => fireAndForget(`block-${i}`, () => gate.promise));
    await flush();

    const ran: number[] = [];
    // Two more than the queue holds; the oldest droppable entries give way.
    for (let i = 0; i < 7; i++) {
      fireAndForget(`telemetry-${i}`, async () => { ran.push(i); }, { droppable: true });
    }

    expect(backgroundTaskStats().queued).toBe(5);

    gates.forEach((gate) => gate.resolve());
    await drainPendingTasks(1000);

    expect(ran).toHaveLength(5);
    // The newest samples survive; the two oldest were shed.
    expect(ran).toEqual([2, 3, 4, 5, 6]);
  });

  it('keeps usage-class work even past the queue bound', async () => {
    const gates = Array.from({ length: MAX_CONCURRENT }, () => deferred());
    gates.forEach((gate, i) => fireAndForget(`block-${i}`, () => gate.promise));
    await flush();

    const ran: number[] = [];
    for (let i = 0; i < 12; i++) {
      fireAndForget(`usage-${i}`, async () => { ran.push(i); });
    }

    gates.forEach((gate) => gate.resolve());
    await drainPendingTasks(2000);

    expect(ran).toHaveLength(12);
  });

  it('keeps draining when a task throws', async () => {
    const ran = vi.fn();
    fireAndForget('boom', async () => { throw new Error('background failure'); });
    fireAndForget('after', async () => { ran(); });

    await drainPendingTasks(1000);
    expect(ran).toHaveBeenCalledTimes(1);
    expect(pendingTaskCount()).toBe(0);
  });
});
