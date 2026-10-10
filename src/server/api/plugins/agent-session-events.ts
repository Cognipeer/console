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
import { toClientEventData, toClientEventFrame } from '@/lib/services/agents/clientWire';
import { followSessionEvents, parseResumeSeq } from '@/lib/services/agents/sessionEvents';
import { applyStreamHeaders } from '../fastify-utils';

const logger = createLogger('api:agent-session-events');

const DEFAULT_EVENT_LIMIT = 100;
const MAX_EVENT_LIMIT = 1_000;

/** Who is reading: the dashboard keeps the stored (camelCase) `data`; a client gets it snake_cased. */
export type SessionEventWire = 'dashboard' | 'client';

/** The wire shape of one logged event. */
export function serializeSessionEvent(event: IAgentSessionEvent, wire: SessionEventWire = 'dashboard') {
  return {
    seq: event.seq,
    type: event.type,
    data: wire === 'client' ? toClientEventData(event.data) : event.data,
    ...(event.runId ? { run_id: event.runId } : {}),
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
  }));
  const page = rows.slice(0, limit);
  return {
    events: page.map((event) => serializeSessionEvent(event, wire)),
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

/** What the session record exposes about its runtime state (client `GET …/sessions/:id`). */
export async function describeSessionRuntime(tenantDbName: string, conversation: IAgentConversation) {
  const pending = await runWithTenantDb(tenantDbName, (db) => db.listAgentPendingActions(String(conversation._id), { status: 'pending' }));
  return {
    runtimeStatus: conversation.runtimeStatus ?? 'idle',
    stopReason: conversation.stopReason ?? null,
    pendingActions: pending.map(toPublicPendingAction),
    lastEventSeq: conversation.lastEventSeq ?? 0,
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
): Promise<FastifyReply> {
  const query = (request.query ?? {}) as Record<string, unknown>;
  const afterSeq = parseResumeSeq(request.headers['last-event-id'], query.after);
  const types = parseTypes(query.types);

  applyStreamHeaders(reply);
  reply.raw.flushHeaders?.();

  const controller = new AbortController();
  reply.raw.on('close', () => controller.abort());

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
      signal: controller.signal,
      write: (frame) => writeRaw(
        `${frame.id !== undefined ? `id: ${frame.id}\n` : ''}event: ${frame.event}\ndata: ${JSON.stringify(wire === 'client' ? toClientEventFrame(frame.data) : frame.data)}\n\n`,
      ),
      writePing: () => writeRaw(': ping\n\n'),
    }));
  } catch (error) {
    // Headers are long gone; end the stream, the client reconnects with Last-Event-ID.
    logger.warn('Session event stream failed', { conversationId, error: error instanceof Error ? error.message : String(error) });
    writeRaw(`event: error\ndata: ${JSON.stringify({ error: 'event stream failed' })}\n\n`);
  } finally {
    if (!reply.raw.writableEnded) reply.raw.end();
  }
  return reply;
}
