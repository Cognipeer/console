/**
 * Agent session event log.
 *
 * Every turn of a persisted agent session (dashboard session, API conversation,
 * background run) writes a small, ordered stream of events to
 * `agent_session_events`: the user message, tool calls and results, a pause for
 * approval, the answer, why the turn stopped. The log is what lets a client that
 * was not holding the original HTTP request (a reload, a second device, a
 * channel adapter) catch up and follow a turn that is still running.
 *
 *   producer (turn)                       consumer (SSE / poll)
 *   ───────────────                       ─────────────────────
 *   writer.emit(type, data)               subscribe to the bus FIRST
 *     buffered → batched insert           replay from the DB after `seq`
 *     → published to the bus AFTER        drop bus frames with seq <= last replayed
 *       it is persisted                   then follow the bus
 *   writer.emitLive(type, data)
 *     published at once, never stored (text deltas)
 *
 * Properties this keeps:
 *
 *  - `seq` is dense and increasing per conversation. The conversation is locked
 *    for the whole turn, so the writer is the only producer: it reads the max
 *    seq once and counts locally. A unique-index conflict (a producer that did
 *    not take the lock) re-reads the max and retries once.
 *  - A frame reaches the bus only once its row exists, so a consumer that
 *    replays from the DB after subscribing can never see a seq on the bus that
 *    the DB does not yet have — and an event it replayed AND receives live is
 *    dropped by seq.
 *  - Events are best effort. A failed write is logged and the batch dropped;
 *    the log must never fail the turn it describes.
 *  - The bus is in-process, plus Redis (the cluster `RelayTransport`) when the
 *    deployment has one, so a consumer on another node follows the same turn.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { getConfig } from '@/lib/core/config';
import { getRelayTransport, type RelayTransport } from '@/lib/core/cluster';
import { createLogger } from '@/lib/core/logger';
import type { DatabaseProvider, IAgentSessionEvent } from '@/lib/database';
import { AgentSessionEventSeqConflictError } from '@/lib/database/provider/errors';
import { publishSessionWebhooks } from '@/lib/services/webhooks/sessionWebhookEvents';

const logger = createLogger('agents:session-events');

/** Persisted event types (the log's vocabulary). */
export type SessionEventType =
  | 'user.message'
  | 'session.status_running'
  | 'agent.tool_use'
  | 'agent.tool_result'
  | 'agent.compaction'
  | 'action.required'
  | 'action.resolved'
  | 'agent.message'
  | 'session.status_idle'
  | 'session.error'
  | 'session.work_done'
  | 'session.usage'
  | 'session.truncated'
  | 'budget.reached';

/** Never persisted — published to live subscribers only. */
export type SessionLiveEventType = 'agent.message.delta';

/** Why a turn stopped, as events and the conversation record report it. */
export type SessionStopReason = 'end_turn' | 'requires_action' | 'limit' | 'cancelled' | 'error' | 'budget_reached';

/**
 * Maps the runtime's turn outcome (`AgentStopReason`, plus a thrown error) onto
 * the session stop reason. completed → end_turn, paused → requires_action,
 * limit → limit, cancelled → cancelled, thrown → error.
 */
export function toSessionStopReason(
  outcome: 'completed' | 'paused' | 'requires_action' | 'limit' | 'cancelled' | 'error' | 'budget_reached' | undefined,
): SessionStopReason {
  switch (outcome) {
    case 'budget_reached':
      return 'budget_reached';
    case 'paused':
    case 'requires_action':
      return 'requires_action';
    case 'limit':
      return 'limit';
    case 'cancelled':
      return 'cancelled';
    case 'error':
      return 'error';
    default:
      return 'end_turn';
  }
}

/** A frame as the bus carries it. Persisted frames have a `seq`; live ones do not. */
export interface SessionEventFrame {
  seq?: number;
  type: string;
  data: Record<string, unknown>;
  runId?: string;
  createdAt: string;
}

/** `data` above this serializes to a truncated copy with `_truncated: true`. */
export const SESSION_EVENT_MAX_DATA_BYTES = 16 * 1024;
const MAX_STRING_CHARS = 2_000;
const MAX_VALUE_PREVIEW_CHARS = 1_000;

/**
 * Keeps an event's `data` under {@link SESSION_EVENT_MAX_DATA_BYTES}. Small
 * data passes through untouched. Larger data keeps its keys (so `toolCallId`,
 * `name`, … stay readable) but long strings are cut and big nested values are
 * replaced by a JSON preview, and `_truncated: true` is set.
 */
export function truncateSessionEventData(data: Record<string, unknown>): Record<string, unknown> {
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(data) ?? '{}', 'utf8');
  } catch {
    return { _truncated: true };
  }
  if (size <= SESSION_EVENT_MAX_DATA_BYTES) return data;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string') {
      out[key] = value.length > MAX_STRING_CHARS ? `${value.slice(0, MAX_STRING_CHARS)}…` : value;
      continue;
    }
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(value);
    } catch {
      serialized = undefined;
    }
    if (serialized !== undefined && serialized.length > MAX_VALUE_PREVIEW_CHARS) {
      out[key] = `${serialized.slice(0, MAX_VALUE_PREVIEW_CHARS)}…`;
    } else {
      out[key] = value;
    }
  }
  out._truncated = true;
  // Still over (very many keys)? Hard cap: keep only the marker and a preview.
  if (Buffer.byteLength(JSON.stringify(out), 'utf8') > SESSION_EVENT_MAX_DATA_BYTES) {
    return { _truncated: true, preview: JSON.stringify(out).slice(0, MAX_VALUE_PREVIEW_CHARS) };
  }
  return out;
}

// ── Bus ──────────────────────────────────────────────────────────────────

export interface SessionEventBus {
  /** Fan a frame out to every subscriber of the conversation (this node and, with Redis, the others). */
  publish(conversationId: string, frame: SessionEventFrame, options?: { scope?: 'all' | 'local' | 'remote' }): void;
  /** The returned function unsubscribes. */
  subscribe(conversationId: string, listener: (frame: SessionEventFrame) => void): () => void;
}

const busChannel = (conversationId: string) => `session-events:${conversationId}`;

interface BusMessage {
  /** The publishing process — its own subscribers were served locally already. */
  origin: string;
  frame: SessionEventFrame;
}

/**
 * In-process EventEmitter per conversation, bridged over Redis pub/sub when the
 * transport exists. The Redis subscription for a conversation is opened with its
 * first local subscriber and closed with its last; a message that originated in
 * this process is skipped on the way back (it was delivered locally already).
 */
export function createSessionEventBus(
  resolveTransport: () => RelayTransport | null = () => getRelayTransport(),
): SessionEventBus {
  const origin = randomUUID();
  // No Redis (or a transport that cannot be built) means in-process only.
  let transportWarned = false;
  const safeTransport = (): RelayTransport | null => {
    try {
      return resolveTransport();
    } catch (error) {
      if (!transportWarned) {
        transportWarned = true;
        logger.warn('Session event transport unavailable; in-process only', { error: String(error) });
      }
      return null;
    }
  };
  const emitters = new Map<string, EventEmitter>();
  const remote = new Map<string, Promise<() => Promise<void>> | null>();

  const emitterFor = (conversationId: string) => {
    let emitter = emitters.get(conversationId);
    if (!emitter) {
      emitter = new EventEmitter();
      emitter.setMaxListeners(0);
      emitters.set(conversationId, emitter);
    }
    return emitter;
  };

  const deliver = (conversationId: string, frame: SessionEventFrame) => {
    const emitter = emitters.get(conversationId);
    if (!emitter) return;
    for (const listener of emitter.listeners('frame') as Array<(f: SessionEventFrame) => void>) {
      try {
        listener(frame);
      } catch (error) {
        logger.warn('Session event listener failed', { conversationId, error: String(error) });
      }
    }
  };

  return {
    publish(conversationId, frame, publishOptions) {
      const scope = publishOptions?.scope ?? 'all';
      if (scope !== 'remote') deliver(conversationId, frame);
      if (scope === 'local') return;
      const transport = safeTransport();
      if (!transport) return;
      const message: BusMessage = { origin, frame };
      transport.publish(busChannel(conversationId), JSON.stringify(message)).catch((error) => {
        logger.warn('Session event publish failed', { conversationId, error: String(error) });
      });
    },

    subscribe(conversationId, listener) {
      const emitter = emitterFor(conversationId);
      emitter.on('frame', listener);

      if (!remote.has(conversationId)) {
        const transport = safeTransport();
        if (transport) {
          const opened = transport.subscribe(busChannel(conversationId), (raw) => {
            try {
              const message = JSON.parse(raw) as BusMessage;
              if (!message || message.origin === origin || !message.frame) return;
              deliver(conversationId, message.frame);
            } catch {
              /* a malformed frame is not ours */
            }
          });
          remote.set(conversationId, opened);
          opened.catch((error) => {
            logger.warn('Session event Redis subscribe failed; following this node only', {
              conversationId,
              error: String(error),
            });
          });
        } else {
          remote.set(conversationId, null);
        }
      }

      let active = true;
      return () => {
        if (!active) return;
        active = false;
        emitter.off('frame', listener);
        if (emitter.listenerCount('frame') > 0) return;
        emitters.delete(conversationId);
        const opened = remote.get(conversationId);
        remote.delete(conversationId);
        opened?.then((unsubscribe) => unsubscribe()).catch(() => undefined);
      };
    },
  };
}

/** The process-wide bus. */
export const sessionEventBus: SessionEventBus = createSessionEventBus();

// ── Writer ───────────────────────────────────────────────────────────────

type SessionEventDb = Pick<DatabaseProvider, 'appendAgentSessionEvents' | 'getAgentSessionMaxSeq'>;

export interface SessionEventWriterOptions {
  db: SessionEventDb;
  tenantId: string;
  projectId: string;
  agentKey: string;
  conversationId: string;
  runId?: string;
  /**
   * When set, the events that are also webhook events (`session.idled`,
   * `session.work_done`, `action.required`, `budget.reached`) are published to
   * the tenant's webhook subscriptions once they are stored.
   */
  tenantDbName?: string;
  /** Defaults to the process-wide bus. */
  bus?: SessionEventBus;
  /** Defaults to `AGENT_SESSION_EVENT_RETENTION_DAYS` (30). */
  retentionDays?: number;
  /** Flush at most this long after the first buffered event. Default 250 ms. */
  flushIntervalMs?: number;
  /** Flush as soon as this many events are buffered. Default 20. */
  maxBatchSize?: number;
}

export interface SessionEventWriter {
  /** Buffer a persisted event. Never throws; never blocks the turn. */
  emit(type: SessionEventType, data?: Record<string, unknown>): void;
  /** Publish a live-only event (text deltas) at once, without persisting it. */
  emitLive(type: SessionLiveEventType, data?: Record<string, unknown>): void;
  /** Write whatever is buffered and wait for it. */
  flush(): Promise<void>;
  /** Flush and stop; later `emit`s are ignored. Idempotent. */
  close(): Promise<void>;
  /**
   * Stop WITHOUT writing what is still buffered: the turn that owned this writer
   * was overtaken by a newer one, so its last events would only interleave with
   * the newer turn's. Events already written stay. Idempotent.
   */
  abandon(): void;
  /**
   * The seq of the last event persisted so far (the conversation's earlier max
   * once the first flush has seeded it, 0 before). The caller stamps it on the
   * conversation as `lastEventSeq`.
   */
  lastSeq(): number;
}

/**
 * Types that make a consumer's screen change state. They flush on the next
 * tick instead of waiting out the batching window; same-tick emissions still
 * share one insert.
 */
const URGENT_TYPES = new Set<string>([
  'session.status_running',
  'session.status_idle',
  'session.error',
  'session.work_done',
  'action.required',
  'action.resolved',
  'agent.message',
  'budget.reached',
]);

const DAY_MS = 86_400_000;

const newSessionEventId = () => `sevt_${randomUUID().replace(/-/g, '').slice(0, 24)}`;

/** A coalesced live delta is relayed to other nodes at most this often / this big. */
const DELTA_RELAY_MS = 100;
const DELTA_RELAY_CHARS = 512;

interface BufferedEvent {
  /**
   * Fixed when the event is buffered and kept through a retry, so a batch that
   * was partly stored before a conflict can be told apart from the rest.
   */
  id: string;
  type: string;
  data: Record<string, unknown>;
  createdAt: Date;
}

type SessionEventRow = Omit<IAgentSessionEvent, '_id'> & { _id: string };

export function createSessionEventWriter(options: SessionEventWriterOptions): SessionEventWriter {
  const {
    db, tenantId, projectId, agentKey, conversationId, runId,
  } = options;
  const bus = options.bus ?? sessionEventBus;
  const flushIntervalMs = options.flushIntervalMs ?? 250;
  const maxBatchSize = options.maxBatchSize ?? 20;
  const retentionMs = (options.retentionDays ?? getConfig().agent.sessionEventRetentionDays) * DAY_MS;

  let buffer: BufferedEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timerDueAt = 0;
  let closed = false;
  let chain: Promise<void> = Promise.resolve();
  let nextSeq = 1;

  // Read once up front; the first flush waits for it. A failed read starts at 1
  // and relies on the conflict retry.
  const seeded = Promise.resolve()
    .then(() => db.getAgentSessionMaxSeq(conversationId))
    .then((max) => { nextSeq = (Number.isFinite(max) ? max : 0) + 1; })
    .catch((error) => {
      logger.warn('Could not read the session max seq; starting at 1', { conversationId, error: String(error) });
    });

  const toRows = (events: BufferedEvent[], firstSeq: number): SessionEventRow[] => events.map((event, i) => ({
    _id: event.id,
    tenantId,
    projectId,
    agentKey,
    conversationId,
    seq: firstSeq + i,
    type: event.type,
    data: event.data,
    ...(runId ? { runId } : {}),
    createdAt: event.createdAt,
    expiresAt: new Date(event.createdAt.getTime() + retentionMs),
  }));

  const persist = async (events: BufferedEvent[]): Promise<SessionEventRow[] | null> => {
    const rows = toRows(events, nextSeq);
    try {
      await db.appendAgentSessionEvents(rows);
      nextSeq += events.length;
      return rows;
    } catch (error) {
      if (!(error instanceof AgentSessionEventSeqConflictError)) {
        logger.warn('Session events dropped (write failed)', { conversationId, count: events.length, error: String(error) });
        return null;
      }
      return retryAfterConflict(events, rows, error);
    }
  };

  /**
   * Someone else wrote to this conversation (a producer that did not take the
   * lock). Part of the batch may already be stored — an ordered insert keeps
   * what came before the conflicting event — and those events stay where they
   * are, at the seq they were given; only the rest continues after whatever is
   * in the log now. Re-inserting the stored ones would duplicate them under
   * new seq numbers.
   */
  const retryAfterConflict = async (
    events: BufferedEvent[],
    firstRows: SessionEventRow[],
    conflict: AgentSessionEventSeqConflictError,
  ): Promise<SessionEventRow[] | null> => {
    const alreadyStored = new Set(conflict.writtenIds);
    const stored = firstRows.filter((row) => alreadyStored.has(row._id));
    const remaining = events.filter((event) => !alreadyStored.has(event.id));
    let retried: SessionEventRow[] = [];
    try {
      const max = await db.getAgentSessionMaxSeq(conversationId);
      nextSeq = Math.max(nextSeq, max + 1);
      retried = toRows(remaining, nextSeq);
      if (retried.length > 0) await db.appendAgentSessionEvents(retried);
      nextSeq = (retried.length > 0 ? retried[retried.length - 1].seq : nextSeq - 1) + 1;
    } catch (retryError) {
      logger.warn('Session events dropped (seq conflict persisted)', { conversationId, count: remaining.length, error: String(retryError) });
      // Whatever the second attempt did store is just as real as the first's.
      const alsoStored = new Set(retryError instanceof AgentSessionEventSeqConflictError ? retryError.writtenIds : []);
      retried = retried.filter((row) => alsoStored.has(row._id));
    }
    const rows = [...stored, ...retried];
    return rows.length > 0 ? rows : null;
  };

  // Live text deltas reach this node's followers per chunk, but cross to other
  // nodes (Redis) coalesced: one PUBLISH per ~100 ms / 512 chars, not per token.
  let deltaText = '';
  let deltaTimer: ReturnType<typeof setTimeout> | null = null;
  const flushDeltas = () => {
    if (deltaTimer) clearTimeout(deltaTimer);
    deltaTimer = null;
    if (!deltaText) return;
    const text = deltaText;
    deltaText = '';
    bus.publish(conversationId, {
      type: 'agent.message.delta',
      data: { text },
      ...(runId ? { runId } : {}),
      createdAt: new Date().toISOString(),
    }, { scope: 'remote' });
  };

  const writeBatch = async (events: BufferedEvent[]) => {
    await seeded;
    const rows = await persist(events);
    if (!rows) return;
    // Published only now that the rows exist; earlier text goes out first.
    flushDeltas();
    for (const row of rows) {
      bus.publish(conversationId, {
        seq: row.seq,
        type: row.type,
        data: row.data,
        ...(row.runId ? { runId: row.runId } : {}),
        createdAt: row.createdAt.toISOString(),
      });
    }
    // After the stored rows and the conversation's status are in place, so a
    // receiver that calls back reads the state the event describes. Never fails the turn.
    if (options.tenantDbName) {
      await publishSessionWebhooks(rows, {
        tenantDbName: options.tenantDbName, tenantId, projectId, agentKey, conversationId,
      }).catch((error) => {
        logger.warn('Session webhook events not published', { conversationId, error: String(error) });
      });
    }
  };

  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    timerDueAt = 0;
  };

  const flush = (): Promise<void> => {
    clearTimer();
    if (buffer.length === 0) return chain;
    const batch = buffer;
    buffer = [];
    chain = chain.then(() => writeBatch(batch)).catch((error) => {
      logger.warn('Session event flush failed', { conversationId, error: String(error) });
    });
    return chain;
  };

  const schedule = (delayMs: number) => {
    const dueAt = Date.now() + delayMs;
    if (timer && timerDueAt <= dueAt) return;
    if (timer) clearTimeout(timer);
    timerDueAt = dueAt;
    timer = setTimeout(() => { void flush(); }, delayMs);
    timer.unref?.();
  };

  return {
    emit(type, data = {}) {
      if (closed) return;
      buffer.push({ id: newSessionEventId(), type, data: truncateSessionEventData(data), createdAt: new Date() });
      if (buffer.length >= maxBatchSize) {
        void flush();
      } else {
        schedule(URGENT_TYPES.has(type) ? 0 : flushIntervalMs);
      }
    },

    emitLive(type, data = {}) {
      if (closed) return;
      if (type === 'agent.message.delta' && typeof data.text === 'string') {
        bus.publish(conversationId, {
          type,
          data,
          ...(runId ? { runId } : {}),
          createdAt: new Date().toISOString(),
        }, { scope: 'local' });
        deltaText += data.text;
        if (deltaText.length >= DELTA_RELAY_CHARS) {
          flushDeltas();
        } else if (!deltaTimer) {
          deltaTimer = setTimeout(flushDeltas, DELTA_RELAY_MS);
          deltaTimer.unref?.();
        }
        return;
      }
      bus.publish(conversationId, {
        type,
        data,
        ...(runId ? { runId } : {}),
        createdAt: new Date().toISOString(),
      });
    },

    flush,

    async close() {
      if (closed) return;
      await flush();
      flushDeltas();
      closed = true;
      await chain;
    },

    abandon() {
      if (closed) return;
      closed = true;
      clearTimer();
      buffer = [];
      deltaText = '';
      if (deltaTimer) clearTimeout(deltaTimer);
      deltaTimer = null;
    },

    lastSeq: () => nextSeq - 1,
  };
}

// ── Following (SSE replay + live) ────────────────────────────────────────

/** `Last-Event-ID` (or `?after=`) → the seq to resume after. Header wins when it is a valid integer. */
export function parseResumeSeq(lastEventId: unknown, after: unknown): number {
  const parse = (value: unknown): number | undefined => {
    const text = Array.isArray(value) ? value[0] : value;
    if (typeof text === 'number' && Number.isInteger(text) && text >= 0) return text;
    if (typeof text !== 'string' || !/^\d+$/.test(text.trim())) return undefined;
    return Number(text.trim());
  };
  return parse(lastEventId) ?? parse(after) ?? 0;
}

/** One SSE frame as the follower hands it to the transport. */
export interface FollowedFrame {
  /** Set on persisted events (becomes the SSE `id:`). */
  id?: number;
  event: string;
  data: SessionEventFrame;
}

export interface FollowSessionEventsOptions {
  db: Pick<DatabaseProvider, 'listAgentSessionEvents'>;
  conversationId: string;
  /** Resume after this seq (0 = from the beginning). */
  afterSeq: number;
  types?: string[];
  write: (frame: FollowedFrame) => void;
  writePing: () => void;
  /** Aborted when the client goes away. */
  signal: AbortSignal;
  bus?: SessionEventBus;
  maxDurationMs?: number;
  pingIntervalMs?: number;
  replayPageSize?: number;
  /**
   * Is the follower still allowed to watch? Asked every `recheckIntervalMs` while the stream is open, because the
   * check that let it in ran once, at the start, and a stream can run for an hour: a rule written since, a removed
   * membership or a revoked token must end it too. `false` - or a check that fails: not knowing is not an allow -
   * ends the stream (`onRevoked` runs first, to tell the client); the client resumes with `Last-Event-ID` and is
   * answered by the same check at the door.
   */
  recheck?: () => Promise<boolean>;
  recheckIntervalMs?: number;
  onRevoked?: () => void;
}

const FOLLOW_MAX_DURATION_MS = 60 * 60 * 1000;
const FOLLOW_PING_INTERVAL_MS = 15_000;
/** How often an open stream asks whether its viewer is still allowed to watch. */
export const FOLLOW_RECHECK_INTERVAL_MS = 60_000;
const REPLAY_PAGE_SIZE = 500;

/**
 * Replays the persisted events after `afterSeq`, then follows the bus until the
 * client closes or the time cap passes. Subscribes to the bus BEFORE reading the
 * DB, so nothing persisted in between is missed; a frame the replay already
 * delivered is dropped by seq.
 */
export async function followSessionEvents(options: FollowSessionEventsOptions): Promise<void> {
  const {
    db, conversationId, types, write, writePing, signal,
  } = options;
  const bus = options.bus ?? sessionEventBus;
  const typeFilter = types && types.length > 0 ? new Set(types) : null;
  const wanted = (type: string) => !typeFilter || typeFilter.has(type);

  let lastSent = Math.max(0, options.afterSeq);
  let replaying = true;
  let revoked = false;
  const held: SessionEventFrame[] = [];

  const send = (frame: SessionEventFrame) => {
    if (revoked || !wanted(frame.type)) return;
    if (frame.seq !== undefined) {
      if (frame.seq <= lastSent) return;
      lastSent = frame.seq;
      write({ id: frame.seq, event: frame.type, data: frame });
      return;
    }
    write({ event: frame.type, data: frame });
  };

  const unsubscribe = bus.subscribe(conversationId, (frame) => {
    if (replaying) held.push(frame);
    else send(frame);
  });

  let ping: ReturnType<typeof setInterval> | undefined;
  let cap: ReturnType<typeof setTimeout> | undefined;
  let recheck: ReturnType<typeof setInterval> | undefined;
  const done = new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener('abort', () => resolve(), { once: true });
    cap = setTimeout(resolve, options.maxDurationMs ?? FOLLOW_MAX_DURATION_MS);
    cap.unref?.();
    ping = setInterval(() => {
      try { writePing(); } catch { resolve(); }
    }, options.pingIntervalMs ?? FOLLOW_PING_INTERVAL_MS);
    ping.unref?.();
    if (options.recheck) {
      const stillAllowed = options.recheck;
      let asking = false;
      recheck = setInterval(() => {
        if (asking || revoked) return;
        asking = true;
        stillAllowed()
          .catch((error: unknown) => {
            logger.warn('Re-checking access to a followed session failed; ending the stream', {
              conversationId,
              error: error instanceof Error ? error.message : String(error),
            });
            return false;
          })
          .then((allowed) => {
            if (allowed) return;
            revoked = true;
            try { options.onRevoked?.(); } catch { /* the stream ends either way */ }
            resolve();
          })
          .finally(() => { asking = false; });
      }, options.recheckIntervalMs ?? FOLLOW_RECHECK_INTERVAL_MS);
      recheck.unref?.();
    }
  });

  try {
    const pageSize = options.replayPageSize ?? REPLAY_PAGE_SIZE;
    let cursor = lastSent;
    // A page of any size ends the replay only when it comes back short.
    for (;;) {
      if (signal.aborted) return;
      const page = await db.listAgentSessionEvents(conversationId, {
        afterSeq: cursor,
        ...(typeFilter ? { types: [...typeFilter] } : {}),
        limit: pageSize,
      });
      for (const row of page) {
        cursor = Math.max(cursor, row.seq);
        send({
          seq: row.seq,
          type: row.type,
          data: row.data,
          ...(row.runId ? { runId: row.runId } : {}),
          createdAt: new Date(row.createdAt).toISOString(),
        });
      }
      if (page.length < pageSize) break;
    }
    replaying = false;
    for (const frame of held.splice(0)) send(frame);
    await done;
  } finally {
    replaying = false;
    unsubscribe();
    if (ping) clearInterval(ping);
    if (recheck) clearInterval(recheck);
    if (cap) clearTimeout(cap);
  }
}
