/**
 * An open session event stream is checked again while it is open: the check that let the viewer in ran once, when
 * the stream opened, and a stream can stay open for an hour. `followSessionEvents({ recheck })` asks every
 * `recheckIntervalMs`; a "no" - or a check that fails, because not knowing is not an allow - ends the stream.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSessionEventBus,
  followSessionEvents,
  type FollowedFrame,
  type SessionEventFrame,
} from '@/lib/services/agents/sessionEvents';

const db = { listAgentSessionEvents: vi.fn(async () => []) };
const frame = (seq: number): SessionEventFrame => ({ seq, type: 'agent.tool_use', data: { seq }, createdAt: new Date().toISOString() });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function start(options: { recheck?: () => Promise<boolean>; recheckIntervalMs?: number; onRevoked?: () => void }) {
  const bus = createSessionEventBus(() => null);
  const controller = new AbortController();
  const written: FollowedFrame[] = [];
  let ended = false;
  const done = followSessionEvents({
    db: db as never,
    conversationId: 'c1',
    afterSeq: 0,
    bus,
    signal: controller.signal,
    write: (f) => written.push(f),
    writePing: () => undefined,
    ...options,
  }).then(() => { ended = true; });
  return { bus, controller, written, done, hasEnded: () => ended };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('followSessionEvents: access is checked again while the stream is open', () => {
  it('ends the stream when the check says no, tells the client first, and writes nothing after', async () => {
    let allowed = true;
    const onRevoked = vi.fn();
    const recheck = vi.fn(async () => allowed);
    const run = start({ recheck, recheckIntervalMs: 15, onRevoked });
    await wait(5);
    run.bus.publish('c1', frame(1));
    await wait(30);
    expect(run.hasEnded()).toBe(false);
    expect(run.written.map((f) => f.id)).toEqual([1]);

    allowed = false;
    await run.done;
    expect(onRevoked).toHaveBeenCalledTimes(1);
    expect(run.hasEnded()).toBe(true);
    run.bus.publish('c1', frame(2));
    expect(run.written.map((f) => f.id)).toEqual([1]);
  });

  it('keeps following for as long as the answer is yes', async () => {
    const recheck = vi.fn(async () => true);
    const run = start({ recheck, recheckIntervalMs: 10 });
    await wait(60);
    expect(recheck.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(run.hasEnded()).toBe(false);
    run.bus.publish('c1', frame(1));
    expect(run.written.map((f) => f.id)).toEqual([1]);
    run.controller.abort();
    await run.done;
  });

  it('a check that fails ends the stream too: not knowing is not an allow', async () => {
    const onRevoked = vi.fn();
    const run = start({ recheck: async () => { throw new Error('the store is down'); }, recheckIntervalMs: 10, onRevoked });
    await run.done;
    expect(onRevoked).toHaveBeenCalledTimes(1);
  });

  it('does not ask again while the previous question is still out', async () => {
    let release: (value: boolean) => void = () => undefined;
    const recheck = vi.fn(() => new Promise<boolean>((resolve) => { release = resolve; }));
    const run = start({ recheck, recheckIntervalMs: 10 });
    await wait(60);
    expect(recheck).toHaveBeenCalledTimes(1);
    release(true);
    await wait(30);
    expect(recheck.mock.calls.length).toBeGreaterThanOrEqual(2);
    run.controller.abort();
    release(true);
    await run.done;
  });

  it('a stream without a check is unchanged', async () => {
    const run = start({});
    await wait(20);
    run.bus.publish('c1', frame(1));
    run.controller.abort();
    await run.done;
    expect(run.written.map((f) => f.id)).toEqual([1]);
  });
});
