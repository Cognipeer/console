/**
 * Regression tests for F-07 (finance-institution assessment, 2026-09-05):
 * `criticalFireAndForget` — the audit-log write path — must be visible and
 * trackable separately from routine fire-and-forget background work
 * (usage logging, tracing ingestion), so a failure reads as more than a
 * dropped cache write and a shutdown drain can report an audit backlog
 * distinctly from routine noise.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  criticalFireAndForget,
  drainPendingTasks,
  fireAndForget,
  pendingCriticalTaskCount,
  pendingTaskCount,
} from '@/lib/core/asyncTask';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('criticalFireAndForget', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(async () => {
    // Drain anything a test left pending so the next test starts clean —
    // module-level Sets persist across tests in the same file.
    await drainPendingTasks(50);
  });

  it('tracks pending critical tasks separately from routine ones', async () => {
    const critical = deferred<void>();
    const routine = deferred<void>();

    criticalFireAndForget('audit-write', () => critical.promise);
    fireAndForget('usage-log', () => routine.promise);

    expect(pendingCriticalTaskCount()).toBe(1);
    expect(pendingTaskCount()).toBe(1);

    critical.resolve();
    routine.resolve();
    await drainPendingTasks(50);

    expect(pendingCriticalTaskCount()).toBe(0);
    expect(pendingTaskCount()).toBe(0);
  });

  it('never lets a rejection escape to the caller', () => {
    expect(() => {
      criticalFireAndForget('audit-write', () => Promise.reject(new Error('db down')));
    }).not.toThrow();
  });

  it('drainPendingTasks waits for a critical task to actually finish', async () => {
    const critical = deferred<void>();
    let settled = false;
    criticalFireAndForget('audit-write', async () => {
      await critical.promise;
      settled = true;
    });

    const drain = drainPendingTasks(2000);
    // Give the drain a moment to start racing, then resolve the task —
    // the drain must not return before this happens.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    critical.resolve();
    await drain;

    expect(settled).toBe(true);
    expect(pendingCriticalTaskCount()).toBe(0);
  });
});
