import { describe, expect, it } from 'vitest';

import { raceWithSignal } from '@/lib/services/browser/agentTools';

describe('raceWithSignal (browser tools)', () => {
  it('passes the result through without a signal', async () => {
    await expect(raceWithSignal(Promise.resolve(7), undefined)).resolves.toBe(7);
  });

  it('rejects at once when the signal fires while the action is pending', async () => {
    const ac = new AbortController();
    const pending = raceWithSignal(new Promise(() => undefined), ac.signal);
    ac.abort();
    await expect(pending).rejects.toBeTruthy();
  });

  it('rejects without waiting when already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(raceWithSignal(Promise.resolve(1), ac.signal)).rejects.toBeTruthy();
  });

  it('resolves normally when the signal never fires', async () => {
    const ac = new AbortController();
    await expect(raceWithSignal(Promise.resolve('ok'), ac.signal)).resolves.toBe('ok');
  });
});
