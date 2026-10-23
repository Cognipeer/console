/**
 * The session event log over HTTP — shared by the dashboard
 * (`/agents/:agentId/sessions/:sessionId/events…`) and the client API
 * (`/client/v1/agents/sessions/:conversationId/events…`). The two surfaces
 * differ only in how they authenticate and scope the conversation; what they
 * return for an event list, an event stream and a pending-action list is the
 * same, so it lives here once.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import type { IAgentConversation, IAgentPendingAction, IAgentSessionEvent } from '@/lib/database';
import { toPublicPendingAction, type PublicPendingAction } from '@/lib/services/agents/agentPendingActions';
import { runWithTenantDb } from '@/lib/services/agents/agentRunService';
import { isClientSessionEvent, toClientEventData, toClientEventFrame, toPublicRunId } from '@/lib/services/agents/clientWire';
import { followSessionEvents, parseResumeSeq } from '@/lib/services/agents/sessionEvents';
import { applyStreamHeaders } from '../fastify-utils';

const logger = createLogger('api:agent-session-events');

/** The session event streams open on this node, ended at shutdown (`closeSessionEventStreams`). */
const openEventStreams = new Set<AbortController>();

/**
 * Ends every session event stream open on this node — at shutdown, once the
 * agent runs are drained: a follower never ends by itself and would hold the
 * HTTP server open. Each client reconnects (Last-Event-ID) to another node.
 */
export function closeSessionEventStreams(): number {
  const count = openEventStreams.size;
  for (const controller of openEventStreams) controller.abort();
  openEventStreams.clear();
  return count;
}

const DEFAULT_EVENT_LIMIT = 100;
const MAX_EVENT_LIMIT = 1_000;

/** Who is reading: the dashboard keeps the stored (camelCase) `data`; a client gets it snake_cased. */
export type SessionEventWire = 'dashboard' | 'client';

/** The wire shape of one logged event. */
export function serializeSessionEvent(event: IAgentSessionEvent, wire: SessionEventWire = 'dashboard') {
  return {
    seq: event.seq,
    type: event.type,
    data: wire === 'client' ? toClientEventData(event.data, event.type) : event.data,
    ...(event.runId ? { run_id: wire === 'client' ? toPublicRunId(event.runId) : event.runId } : {}),
    created_at: new Date(event.createdAt).toISOString(),
  };
}

export { toPublicPendingAction, type PublicPendingAction };

/** `?types=a,b` → ['a', 'b'] (undefined when absent). */
function parseTypes(value: unknown): string[] | undefined {
  const text = Array.isArray(value) ? value.join(',') : value;
  if (typeof text !== 'string') return undefined;
  const types = text.split(',').map((t) => t.trim()).filter(Boolean);
  return types.length > 0 ? types : undefined;
}

/** `GET …/events` — events after `?after=<seq>`, optionally filtered by `?types=`, at most `?limit=`. */
export async function listSessionEvents(
  tenantDbName: string,
  conversationId: string,
  query: Record<string, unknown>,
  wire: SessionEventWire = 'dashboard',
  /** `runId`: only the events of one run (bare id) — the runs API's event log. */
  filter: { runId?: string } = {},
) {
  const afterSeq = parseResumeSeq(undefined, query.after);
  const requested = Number(query.limit);
  const limit = Number.isFinite(requested) && requested > 0
    ? Math.min(Math.floor(requested), MAX_EVENT_LIMIT)
    : DEFAULT_EVENT_LIMIT;
  const types = parseTypes(query.types);

  // One extra row says whether another page exists.
  const rows = await runWithTenantDb(tenantDbName, (db) => db.listAgentSessionEvents(conversationId, {
    afterSeq,
    limit: limit + 1,
    ...(types ? { types } : {}),
    ...(filter.runId ? { runId: filter.runId } : {}),
  }));
  const page = rows.slice(0, limit);
  // A client does not see the rows only the dashboard reads; the page's end is still
  // the unfiltered one, so `last_seq` / `has_more` page past them correctly.
  const visible = wire === 'client' ? page.filter((event) => isClientSessionEvent(event.type, event.data)) : page;
  return {
    events: visible.map((event) => serializeSessionEvent(event, wire)),
    has_more: rows.length > limit,
    last_seq: page.length > 0 ? page[page.length - 1].seq : afterSeq,
  };
}

/** `GET …/actions` — the conversation's approvals / questions (`?status=pending` to filter). */
export async function listConversationActions(
  tenantDbName: string,
  conversationId: string,
  query: Record<string, unknown>,
) {
  const status = typeof query.status === 'string' ? query.status : undefined;
  const allowed = ['pending', 'resolved', 'expired', 'cancelled'];
  const actions = await runWithTenantDb(tenantDbName, (db) => db.listAgentPendingActions(conversationId, {
    ...(status && allowed.includes(status) ? { status: status as IAgentPendingAction['status'] } : {}),
  }));
  return { actions: actions.map(toPublicPendingAction) };
}

/**
 * What the session record exposes about its runtime state (client `GET …/sessions/:id`).
 *
 * `lastEventSeq` is read from the event log, not from the conversation row: the
 * row is stamped only when a turn's writer closes, so mid-run it still held the
 * previous turn's value while the log already held more — and it is the seq a
 * client resumes the stream from. The stamp stays as the floor: once retention
 * has emptied an idle session's log, it is all that is left of the count.
 */
export async function describeSessionRuntime(tenantDbName: string, conversation: IAgentConversation) {
  const conversationId = String(conversation._id);
  const { pending, newestSeq } = await runWithTenantDb(tenantDbName, async (db) => ({
    pending: await db.listAgentPendingActions(conversationId, { status: 'pending' }),
    newestSeq: await db.getAgentSessionMaxSeq(conversationId),
  }));
  return {
    runtimeStatus: conversation.runtimeStatus ?? 'idle',
    stopReason: conversation.stopReason ?? null,
    pendingActions: pending.map(toPublicPendingAction),
    lastEventSeq: Math.max(conversation.lastEventSeq ?? 0, newestSeq),
  };
}

/**
 * `GET …/events/stream` — SSE. Resumes from `Last-Event-ID` (what a browser
 * `EventSource` sends on reconnect) or `?after=`; subscribes to the live bus
 * before replaying from the DB so no event falls between the two. Persisted
 * events carry `id: <seq>`; live-only events (text deltas) have no id.
 * A `client` stream spells the frame like the client event list (`run_id`,
 * `created_at`, snake_case `data`); the dashboard's frames keep their shape.
 */
export async function streamSessionEvents(
  request: FastifyRequest,
  reply: FastifyReply,
  tenantDbName: string,
  conversationId: string,
  wire: SessionEventWire = 'dashboard',
  /** Is the viewer still allowed to watch? Asked while the stream is open (see `followSessionEvents`). */
  recheck?: () => Promise<boolean>,
  filter: { runId?: string } = {},
): Promise<FastifyReply> {
  const query = (request.query ?? {}) as Record<string, unknown>;
  const afterSeq = parseResumeSeq(request.headers['last-event-id'], query.after);
  const types = parseTypes(query.types);

  applyStreamHeaders(reply);
  reply.raw.flushHeaders?.();

  const controller = new AbortController();
  reply.raw.on('close', () => controller.abort());
  openEventStreams.add(controller);

  const writeRaw = (chunk: string) => {
    if (controller.signal.aborted) return;
    try {
      reply.raw.write(chunk);
    } catch {
      controller.abort();
    }
  };

  try {
    await runWithTenantDb(tenantDbName, (db) => followSessionEvents({
      db,
      conversationId,
      afterSeq,
      ...(types ? { types } : {}),
      ...(filter.runId ? { runId: filter.runId } : {}),
      signal: controller.signal,
      write: (frame) => {
        if (wire === 'client' && !isClientSessionEvent(frame.data.type, frame.data.data)) return;
        writeRaw(
          `${frame.id !== undefined ? `id: ${frame.id}\n` : ''}event: ${frame.event}\ndata: ${JSON.stringify(wire === 'client' ? toClientEventFrame(frame.data) : frame.data)}\n\n`,
        );
      },
      writePing: () => writeRaw(': ping\n\n'),
      ...(recheck ? {
        recheck,
        // The client reconnects with Last-Event-ID and is answered at the door.
        onRevoked: () => writeRaw(`event: error\ndata: ${JSON.stringify({ error: 'access to this session ended' })}\n\n`),
      } : {}),
    }));
  } catch (error) {
    // Headers are long gone; end the stream, the client reconnects with Last-Event-ID.
    logger.warn('Session event stream failed', { conversationId, error: error instanceof Error ? error.message : String(error) });
    writeRaw(`event: error\ndata: ${JSON.stringify({ error: 'event stream failed' })}\n\n`);
  } finally {
    openEventStreams.delete(controller);
    if (!reply.raw.writableEnded) reply.raw.end();
  }
  return reply;
}
