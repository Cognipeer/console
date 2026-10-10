import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  SESSION_EVENT_MAX_DATA_BYTES,
  createSessionEventBus,
  createSessionEventWriter,
  followSessionEvents,
  parseResumeSeq,
  toSessionStopReason,
  truncateSessionEventData,
  type FollowedFrame,
  type SessionEventFrame,
} from '@/lib/services/agents/sessionEvents';
import { startSessionTurnEvents } from '@/lib/services/agents/sessionTurnEvents';
import { AgentSessionEventSeqConflictError } from '@/lib/database/provider/errors';
import { serializeAgentRun } from '@/lib/services/agents/agentRunService';

type Row = { _id?: string; seq: number; type: string; data: Record<string, unknown>; conversationId: string; runId?: string; createdAt: Date };

/** In-memory stand-in for the provider's event-log methods. */
function fakeDb(initial: Row[] = []) {
  const rows: Row[] = [...initial];
  return {
    rows,
    appendAgentSessionEvents: vi.fn(async (events: Row[]) => {
      for (const e of events) {
        if (rows.some((r) => r.conversationId === e.conversationId && r.seq === e.seq)) {
          throw new AgentSessionEventSeqConflictError(e.conversationId);
        }
      }
      rows.push(...events);
    }),
    getAgentSessionMaxSeq: vi.fn(async (conversationId: string) =>
      Math.max(0, ...rows.filter((r) => r.conversationId === conversationId).map((r) => r.seq))),
    listAgentSessionEvents: vi.fn(async (conversationId: string, o?: { afterSeq?: number; types?: string[]; limit?: number }) =>
      rows
        .filter((r) => r.conversationId === conversationId && r.seq > (o?.afterSeq ?? 0) && (!o?.types || o.types.includes(r.type)))
        .sort((a, b) => a.seq - b.seq)
        .slice(0, o?.limit ?? Infinity)),
    updateAgentConversationRuntime: vi.fn(async (_id: string, _patch: Record<string, unknown>) => undefined),
  };
}

const ids = { tenantId: 't1', projectId: 'p1', agentKey: 'a1', conversationId: 'c1' };

function recordingBus() {
  const frames: SessionEventFrame[] = [];
  const bus = createSessionEventBus(() => null);
  bus.subscribe('c1', (f) => frames.push(f));
  return { bus, frames };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('stop-reason mapping', () => {
  it('maps the runtime outcome onto the session stop reason', () => {
    expect(toSessionStopReason('completed')).toBe('end_turn');
    expect(toSessionStopReason('paused')).toBe('requires_action');
    expect(toSessionStopReason('limit')).toBe('limit');
    expect(toSessionStopReason('cancelled')).toBe('cancelled');
    expect(toSessionStopReason('error')).toBe('error');
    expect(toSessionStopReason(undefined)).toBe('end_turn');
  });

  it('serializes a run stop reason (null while unset)', () => {
    const base = { _id: 'r1', mode: 'background', tenantId: 't', tenantDbName: 'd', projectId: 'p', agentKey: 'a', conversationId: 'c', userMessage: 'm', status: 'succeeded' } as never;
    expect(serializeAgentRun({ ...(base as object), stopReason: 'limit' } as never).stop_reason).toBe('limit');
    expect(serializeAgentRun(base).stop_reason).toBeNull();
  });
});

describe('session event writer', () => {
  it('assigns dense seqs after the conversation max and writes one batch', async () => {
    vi.useFakeTimers();
    const db = fakeDb([{ ...ids, seq: 4, type: 'old', data: {}, createdAt: new Date() }]);
    const { bus, frames } = recordingBus();
    const writer = createSessionEventWriter({ db, ...ids, bus, retentionDays: 1 });

    writer.emit('agent.tool_use', { name: 'a' });
    writer.emit('agent.tool_result', { name: 'a', ok: true });
    await vi.advanceTimersByTimeAsync(250);

    expect(db.appendAgentSessionEvents).toHaveBeenCalledTimes(1);
    expect(db.rows.filter((r) => r.type !== 'old').map((r) => r.seq)).toEqual([5, 6]);
    expect(frames.map((f) => f.seq)).toEqual([5, 6]);
    expect(writer.lastSeq()).toBe(6);
    await writer.close();
  });

  it('batches: holds events up to 250 ms, and flushes at 20 events', async () => {
    vi.useFakeTimers();
    const db = fakeDb();
    const writer = createSessionEventWriter({ db, ...ids, bus: recordingBus().bus });

    writer.emit('agent.tool_use', {});
    await vi.advanceTimersByTimeAsync(100);
    expect(db.appendAgentSessionEvents).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(150);
    expect(db.appendAgentSessionEvents).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 20; i += 1) writer.emit('agent.tool_use', { i });
    await vi.advanceTimersByTimeAsync(0);
    expect(db.appendAgentSessionEvents).toHaveBeenCalledTimes(2);
    expect((db.appendAgentSessionEvents.mock.calls[1][0] as Row[]).length).toBe(20);
    await writer.close();
  });

  it('flushes urgent events on the next tick, sharing one insert within the tick', async () => {
    vi.useFakeTimers();
    const db = fakeDb();
    const writer = createSessionEventWriter({ db, ...ids, bus: recordingBus().bus });
    writer.emit('agent.tool_use', {});
    writer.emit('session.status_idle', { stopReason: 'end_turn' });
    await vi.advanceTimersByTimeAsync(0);
    expect(db.appendAgentSessionEvents).toHaveBeenCalledTimes(1);
    expect((db.appendAgentSessionEvents.mock.calls[0][0] as Row[]).map((e) => e.type)).toEqual(['agent.tool_use', 'session.status_idle']);
    await writer.close();
  });

  it('publishes to the bus only after the rows are persisted', async () => {
    const db = fakeDb();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = db.appendAgentSessionEvents.getMockImplementation()!;
    db.appendAgentSessionEvents.mockImplementation(async (events: Row[]) => {
      await gate;
      return original(events);
    });
    const { bus, frames } = recordingBus();
    const writer = createSessionEventWriter({ db, ...ids, bus });

    writer.emit('agent.message', { content: 'hi' });
    const flushed = writer.flush();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(frames).toEqual([]);
    expect(db.rows).toEqual([]);

    release();
    await flushed;
    expect(db.rows.length).toBe(1);
    expect(frames.map((f) => f.seq)).toEqual([1]);
    await writer.close();
  });

  it('never persists live events but publishes them at once', async () => {
    const db = fakeDb();
    const { bus, frames } = recordingBus();
    const writer = createSessionEventWriter({ db, ...ids, bus });
    writer.emitLive('agent.message.delta', { text: 'he' });
    expect(frames).toEqual([expect.objectContaining({ type: 'agent.message.delta', data: { text: 'he' } })]);
    expect(frames[0].seq).toBeUndefined();
    await writer.close();
    expect(db.appendAgentSessionEvents).not.toHaveBeenCalled();
  });

  it('re-reads the max seq and retries once on a unique-index conflict', async () => {
    const db = fakeDb();
    const { bus, frames } = recordingBus();
    const writer = createSessionEventWriter({ db, ...ids, bus });
    await writer.flush(); // seeds nextSeq = 1
    // Another producer writes seq 1..3 behind the writer's back.
    db.rows.push(
      ...[1, 2, 3].map((seq) => ({ ...ids, seq, type: 'x', data: {}, createdAt: new Date() })),
    );
    writer.emit('agent.message', { content: 'late' });
    await writer.flush();
    expect(db.rows.filter((r) => r.type === 'agent.message').map((r) => r.seq)).toEqual([4]);
    expect(frames.map((f) => f.seq)).toEqual([4]);
    await writer.close();
  });

  it('a batch that conflicts part-way keeps the events already stored where they are and continues with the rest', async () => {
    const db = fakeDb();
    // A MongoDB-style ordered insert: keeps what precedes the conflict, and says which.
    db.appendAgentSessionEvents.mockImplementation(async (events: Row[]) => {
      const written: string[] = [];
      for (const e of events) {
        if (db.rows.some((r) => r._id === e._id)) throw new Error('duplicate _id: an event was stored twice');
        if (db.rows.some((r) => r.conversationId === e.conversationId && r.seq === e.seq)) {
          throw new AgentSessionEventSeqConflictError(e.conversationId, written);
        }
        db.rows.push(e);
        written.push(e._id!);
      }
    });
    const { bus, frames } = recordingBus();
    const writer = createSessionEventWriter({ db, ...ids, bus });
    writer.emit('agent.tool_use', { n: 0 });
    await writer.flush(); // seq 1
    db.rows.push({ ...ids, seq: 3, type: 'foreign', data: {}, createdAt: new Date() }); // another producer takes seq 3

    for (const n of [1, 2, 3]) writer.emit('agent.tool_use', { n }); // would be seq 2, 3, 4
    await writer.close();

    const written = db.rows.filter((r) => r.type === 'agent.tool_use');
    // The first event of the batch was stored before the conflict: it stays at seq 2 — it is
    // not written again — and the other two continue after the log's end.
    expect(written.map((r) => [r.seq, r.data.n])).toEqual([[1, 0], [2, 1], [4, 2], [5, 3]]);
    expect(new Set(written.map((r) => r._id)).size).toBe(written.length);
    // Followers hear about each event once, at the seq it is stored under.
    expect(frames.filter((f) => f.type === 'agent.tool_use').map((f) => [f.seq, f.data.n])).toEqual([[1, 0], [2, 1], [4, 2], [5, 3]]);
    expect(writer.lastSeq()).toBe(5);
  });

  it('keeps an event across the retry under one id, and gives each event its own', async () => {
    const db = fakeDb();
    const writer = createSessionEventWriter({ db, ...ids, bus: recordingBus().bus });
    writer.emit('agent.tool_use', { n: 0 });
    await writer.flush();
    db.rows.push({ ...ids, seq: 2, type: 'foreign', data: {}, createdAt: new Date() });
    writer.emit('agent.tool_use', { n: 1 });
    writer.emit('agent.tool_use', { n: 2 });
    await writer.close();

    const attempts = db.appendAgentSessionEvents.mock.calls.slice(1) as Array<[Row[]]>;
    expect(attempts).toHaveLength(2); // the conflicting attempt and the retry
    const [first, retry] = attempts.map(([rows]) => rows.map((r) => r._id));
    expect(retry).toEqual(first); // same ids, new seqs
    expect(first.every((id) => typeof id === 'string' && id.startsWith('sevt_'))).toBe(true);
    expect(new Set(first).size).toBe(first.length);
  });

  it('drops a batch without publishing it when the write keeps failing, and never throws', async () => {
    const db = fakeDb();
    db.appendAgentSessionEvents.mockRejectedValue(new Error('db down'));
    const { bus, frames } = recordingBus();
    const writer = createSessionEventWriter({ db, ...ids, bus });
    writer.emit('agent.message', { content: 'x' });
    await expect(writer.close()).resolves.toBeUndefined();
    expect(frames).toEqual([]);
  });

  it('ignores emits after close', async () => {
    const db = fakeDb();
    const writer = createSessionEventWriter({ db, ...ids, bus: recordingBus().bus });
    await writer.close();
    writer.emit('agent.message', {});
    await writer.flush();
    expect(db.appendAgentSessionEvents).not.toHaveBeenCalled();
  });
});

describe('truncateSessionEventData', () => {
  it('passes small data through and marks oversized data _truncated', () => {
    const small = { a: 1 };
    expect(truncateSessionEventData(small)).toBe(small);

    const big = truncateSessionEventData({ toolCallId: 'tc1', args: { blob: 'x'.repeat(40_000) }, note: 'y'.repeat(10_000) });
    expect(big._truncated).toBe(true);
    expect(big.toolCallId).toBe('tc1');
    expect(Buffer.byteLength(JSON.stringify(big), 'utf8')).toBeLessThanOrEqual(SESSION_EVENT_MAX_DATA_BYTES);
  });
});

describe('parseResumeSeq', () => {
  it('prefers a valid Last-Event-ID, falls back to ?after=, else 0', () => {
    expect(parseResumeSeq('12', '3')).toBe(12);
    expect(parseResumeSeq(undefined, '3')).toBe(3);
    expect(parseResumeSeq('abc', '3')).toBe(3);
    expect(parseResumeSeq(['7'], undefined)).toBe(7);
    expect(parseResumeSeq(undefined, undefined)).toBe(0);
    expect(parseResumeSeq('-1', 'x')).toBe(0);
  });
});

describe('followSessionEvents (SSE replay de-dupe)', () => {
  const row = (seq: number, type = 'agent.tool_use'): Row => ({ ...ids, seq, type, data: { seq }, createdAt: new Date() });
  const frame = (seq: number, type = 'agent.tool_use'): SessionEventFrame => ({ seq, type, data: { seq }, createdAt: new Date().toISOString() });

  async function run(opts: {
    db: ReturnType<typeof fakeDb>;
    afterSeq: number;
    types?: string[];
    during?: (bus: ReturnType<typeof createSessionEventBus>) => void | Promise<void>;
    after?: (bus: ReturnType<typeof createSessionEventBus>) => void | Promise<void>;
    pageSize?: number;
  }) {
    const bus = createSessionEventBus(() => null);
    const controller = new AbortController();
    const written: FollowedFrame[] = [];
    // Frames published while the replay query is in flight, i.e. after the subscription.
    const listed = opts.db.listAgentSessionEvents.getMockImplementation()!;
    opts.db.listAgentSessionEvents.mockImplementation(async (...args: Parameters<typeof listed>) => {
      const result = await listed(...args);
      await opts.during?.(bus);
      return result;
    });
    const done = followSessionEvents({
      db: opts.db as never,
      conversationId: 'c1',
      afterSeq: opts.afterSeq,
      ...(opts.types ? { types: opts.types } : {}),
      bus,
      signal: controller.signal,
      write: (f) => written.push(f),
      writePing: () => undefined,
      replayPageSize: opts.pageSize,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await opts.after?.(bus);
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await done;
    return written;
  }

  it('resumes after Last-Event-ID, drops bus frames the replay already delivered, keeps the rest in order', async () => {
    const db = fakeDb([row(1), row(2), row(3), row(4)]);
    const written = await run({
      db,
      afterSeq: 1,
      // 3 and 4 are persisted AND published while the replay runs; 5 is only live.
      during: (bus) => { bus.publish('c1', frame(3)); bus.publish('c1', frame(4)); bus.publish('c1', frame(5)); },
    });
    expect(written.map((f) => f.id)).toEqual([2, 3, 4, 5]);
    expect(new Set(written.map((f) => f.id)).size).toBe(written.length);
  });

  it('follows live frames after the replay and gives live-only events no id', async () => {
    const db = fakeDb([row(1)]);
    const written = await run({
      db,
      afterSeq: 0,
      after: (bus) => {
        bus.publish('c1', { type: 'agent.message.delta', data: { text: 'a' }, createdAt: new Date().toISOString() });
        bus.publish('c1', frame(2, 'agent.message'));
        bus.publish('c1', frame(2, 'agent.message')); // duplicate delivery (e.g. a Redis echo)
      },
    });
    expect(written.map((f) => [f.id, f.event])).toEqual([[1, 'agent.tool_use'], [undefined, 'agent.message.delta'], [2, 'agent.message']]);
  });

  it('applies the type filter to the replay and to live frames', async () => {
    const db = fakeDb([row(1, 'user.message'), row(2, 'agent.tool_use'), row(3, 'agent.message')]);
    const written = await run({
      db,
      afterSeq: 0,
      types: ['agent.message'],
      after: (bus) => { bus.publish('c1', frame(4, 'agent.tool_use')); bus.publish('c1', frame(5, 'agent.message')); },
    });
    expect(written.map((f) => f.id)).toEqual([3, 5]);
  });

  it('pages through a long replay', async () => {
    const db = fakeDb(Array.from({ length: 7 }, (_, i) => row(i + 1)));
    const written = await run({ db, afterSeq: 0, pageSize: 3 });
    expect(written.map((f) => f.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('stops and unsubscribes when the client goes away', async () => {
    const db = fakeDb([row(1)]);
    const bus = createSessionEventBus(() => null);
    const controller = new AbortController();
    const written: FollowedFrame[] = [];
    const done = followSessionEvents({
      db: db as never, conversationId: 'c1', afterSeq: 0, bus, signal: controller.signal, write: (f) => written.push(f), writePing: () => undefined,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await done;
    bus.publish('c1', frame(2));
    expect(written.map((f) => f.id)).toEqual([1]);
  });
});

describe('session turn recorder', () => {
  it('writes the turn in order, holds the user message until the model call is out, and stamps the conversation', async () => {
    const db = fakeDb();
    const { bus, frames } = recordingBus();
    const turn = startSessionTurnEvents({
      db, ...ids, bus, trigger: 'message', userMessage: () => 'rewritten text',
    });
    turn.onSdkEvent({ type: 'tool_call', phase: 'start', name: 'search', id: 'tc1', args: { q: 'x' } } as never);
    turn.onSdkEvent({ type: 'tool_call', phase: 'success', name: 'search', id: 'tc1', durationMs: 12 } as never);
    await turn.finish({ stopReason: 'end_turn', content: 'answer', messageIndex: 1, usage: { totalTokens: 3 } });

    expect(db.rows.map((r) => r.type)).toEqual([
      'user.message', 'session.status_running', 'agent.tool_use', 'agent.tool_result',
      'agent.message', 'session.status_idle', 'session.work_done',
    ]);
    expect(db.rows[0].data).toEqual({ content: 'rewritten text' });
    expect(db.rows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(frames.map((f) => f.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const last = [0, Object.assign({}, ...db.updateAgentConversationRuntime.mock.calls.map((c) => c[1]))] as unknown as [number, Record<string, unknown>];
    expect(last[1]).toMatchObject({ runtimeStatus: 'idle', stopReason: 'end_turn', pendingActionIds: [], lastEventSeq: 7 });
    // The status is written before the idle frame is published, so a follower never reads 'running'.
    const statusCall = db.updateAgentConversationRuntime.mock.calls.findIndex((c) => (c[1] as Record<string, unknown>).runtimeStatus === 'idle');
    expect(statusCall).toBeGreaterThan(-1);
    expect(db.updateAgentConversationRuntime.mock.invocationCallOrder[statusCall]).toBeLessThan(db.appendAgentSessionEvents.mock.invocationCallOrder.at(-1)!);
  });

  it('records a thrown turn as session.error + idle(error) and no work_done', async () => {
    const db = fakeDb();
    const turn = startSessionTurnEvents({ db, ...ids, bus: recordingBus().bus, trigger: 'message', userMessage: 'hi' });
    await turn.fail(new Error('boom'));
    expect(db.rows.map((r) => r.type)).toEqual(['user.message', 'session.status_running', 'session.error', 'session.status_idle']);
    expect(db.rows[3].data).toMatchObject({ stopReason: 'error' });
    const last = [0, Object.assign({}, ...db.updateAgentConversationRuntime.mock.calls.map((c) => c[1]))] as unknown as [number, Record<string, unknown>];
    expect(last[1]).toMatchObject({ runtimeStatus: 'idle', stopReason: 'error' });
  });

  it('a paused turn leaves the conversation requires_action with its pending ids', async () => {
    const db = fakeDb();
    const turn = startSessionTurnEvents({ db, ...ids, bus: recordingBus().bus, trigger: 'message', userMessage: 'hi' });
    await turn.finish({ stopReason: 'requires_action', content: '', messageIndex: 1, pendingActionIds: ['act_1'] });
    expect(db.rows.at(-1)).toMatchObject({ type: 'session.status_idle', data: { stopReason: 'requires_action', pendingActionIds: ['act_1'] } });
    expect(db.rows.some((r) => r.type === 'session.work_done')).toBe(false);
    const last = [0, Object.assign({}, ...db.updateAgentConversationRuntime.mock.calls.map((c) => c[1]))] as unknown as [number, Record<string, unknown>];
    expect(last[1]).toMatchObject({ runtimeStatus: 'requires_action', pendingActionIds: ['act_1'] });
  });

  it('a resumed turn starts without a user message', async () => {
    const db = fakeDb();
    const turn = startSessionTurnEvents({ db, ...ids, bus: recordingBus().bus, trigger: 'resume' });
    await turn.finish({ stopReason: 'end_turn', content: 'ok' });
    expect(db.rows.map((r) => r.type)).toEqual(['session.status_running', 'agent.message', 'session.status_idle', 'session.work_done']);
    expect(db.rows[0].data).toEqual({ trigger: 'resume' });
  });
});

describe('session event bus over a relay transport', () => {
  it('delivers across processes once and skips its own echo', async () => {
    const listeners = new Map<string, Set<(m: string) => void>>();
    const transport = {
      publish: async (channel: string, message: string) => {
        for (const l of listeners.get(channel) ?? []) l(message);
      },
      subscribe: async (channel: string, on: (m: string) => void) => {
        const set = listeners.get(channel) ?? new Set();
        set.add(on);
        listeners.set(channel, set);
        return async () => { set.delete(on); };
      },
    };
    const nodeA = createSessionEventBus(() => transport);
    const nodeB = createSessionEventBus(() => transport);
    const onA: SessionEventFrame[] = [];
    const onB: SessionEventFrame[] = [];
    nodeA.subscribe('c1', (f) => onA.push(f));
    nodeB.subscribe('c1', (f) => onB.push(f));
    await new Promise((resolve) => setTimeout(resolve, 5));

    nodeA.publish('c1', { seq: 1, type: 'agent.message', data: {}, createdAt: new Date().toISOString() });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(onA.map((f) => f.seq)).toEqual([1]); // local delivery only, not echoed back
    expect(onB.map((f) => f.seq)).toEqual([1]);
  });
});
