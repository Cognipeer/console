import type { FastifyInstance } from 'fastify';
import {
  executePlaygroundChat,
} from '@/lib/services/agents';
import {
  acquireAgentSessionSlot,
  type AgentSessionSlot,
} from '@/lib/services/agents/agentSessionLease';
import {
  isPlanLimitError,
  planLimitErrorBody,
  planLimitHeaders,
} from '@/lib/limits/errors';
// By path: the agents barrel does not export the error class.
import {
  AgentGuardrailBlockedError,
  // Imported BY PATH: the barrel exports the queue-routing wrapper, and the
  // streaming route deliberately needs the local one (a progress callback
  // cannot cross the job queue).
  executePlaygroundChatLocal,
} from '@/lib/services/agents/agentService';
import {
  classifyAgentRunError,
  logAgentRunFailure,
} from '@/lib/services/agents/agentErrors';
import {
  enforceAgentRunQuota,
  settleAgentRun,
  type AgentRunCaller,
} from '@/lib/services/agents/agentQuota';
import {
  createRunUsageSink,
  runWithUsageSink,
} from '@/lib/services/agents/runUsage';
import {
  sessionEventBus,
} from '@/lib/services/agents/sessionEvents';
import {
  applyStreamHeaders,
  sendProjectContextError,
  withApiRequestContext,
} from '../../fastify-utils';
import {
  formatSseFrame,
} from '../../sseWire';
import {
  sendAgentGuardrailBlock,
} from '../agent-config-write';
import {
  logger,
  AGENT_SCOPED,
  turnWatchFor,
  readStatelessHistory,
  prepareDashboardTurn,
} from './agentsRouteHelpers';
import { canSeeRawProviderErrors } from './agentsErrorVisibility';

export function registerAgentsChatRoutes(app: FastifyInstance): void {
  /**
   * The same run as `/chat`, reported as it happens.
   *
   * A playground that says only "working…" for forty seconds is asking the
   * operator to trust it. Tool calls are the interesting part of an agent
   * run — which tool, with what argument, how long — and they are precisely
   * what a request/response POST cannot show until it is too late to matter.
   *
   * SSE over POST (rather than EventSource, which is GET-only) because the
   * body carries the message, the session and the runtime context. The final
   * `result` event repeats what `/chat` would have returned, so the client's
   * completed-turn rendering is identical either way — this endpoint adds
   * visibility, it does not fork the contract.
   *
   * `executePlaygroundChatLocal` is called directly, NOT the queue-routing
   * `executePlaygroundChat`: the progress callback is a function and cannot
   * cross the job queue. A run that would have been routed to another node
   * runs here instead, which is the right trade for a dashboard-only debug
   * surface and the reason this is not the path production traffic takes.
   */
  app.post('/agents/:agentId/chat/stream', AGENT_SCOPED, withApiRequestContext(async (request, reply) => {
    const turn = await prepareDashboardTurn(request, reply);
    if (!turn) return reply;

    // Agent-run quota (domain `agent`). This route runs the playground runtime
    // directly (below), bypassing the `executePlaygroundChat` wrapper that
    // counts every other caller, so it counts here — before the stream opens,
    // which lets an exhausted caller get a real 429 instead of an error event.
    const quotaCaller: AgentRunCaller = {
      tenantDbName: turn.run.tenantDbName,
      tenantId: turn.run.tenantId,
      projectId: turn.run.projectId,
      agentKey: turn.run.agentKey,
      userId: turn.run.runtimeContext?.userId,
      tokenId: turn.run.runtimeContext?.tokenId,
    };
    try {
      await enforceAgentRunQuota(quotaCaller);
    } catch (error) {
      await turn.reservation?.release();
      const classified = classifyAgentRunError(error, { exposeInternal: await canSeeRawProviderErrors(request) });
      return reply.code(classified.status).send({
        error: classified.error.message,
        type: classified.error.type,
        code: classified.error.code,
      });
    }

    applyStreamHeaders(reply);
    reply.raw.flushHeaders?.();

    // A stateless turn (no Session) has no run record for `…/cancel` to point at, so the client's
    // Stop is closing the stream: the run ends with what it had streamed. A Session turn keeps
    // running after a tab closes and is stopped through the session instead (`turnWatchFor`).
    const disconnect = typeof turn.run.conversationId === 'string' ? undefined : new AbortController();
    let closed = false;
    reply.raw.on('close', () => {
      closed = true;
      if (!reply.raw.writableEnded) disconnect?.abort();
    });
    const send = (event: string, data: unknown, id?: number) => {
      if (closed) return;
      try {
        reply.raw.write(formatSseFrame(event, data, id));
      } catch {
        closed = true;
      }
    };

    // A run that fails or is aborted late has still spent its tokens (see runUsage.ts).
    const usage = createRunUsageSink();

    // Additive events for a Session turn, taken from the same log the
    // `/events` endpoints serve (`id:` = the event's seq): `action` when the
    // agent pauses for an approval or a question, `status` as the turn starts
    // and stops. The events above are unchanged; an older client ignores these.
    const unsubscribeSessionEvents = typeof turn.run.conversationId === 'string'
      ? sessionEventBus.subscribe(turn.run.conversationId, (frame) => {
        if (frame.type === 'action.required') send('action', frame.data, frame.seq);
        else if (frame.type.startsWith('session.status_')) send('status', { type: frame.type, ...frame.data }, frame.seq);
      })
      : undefined;

    const watch = turnWatchFor(turn);
    // Plan limit (agent sessions): a dashboard turn is console-originated, so it takes a slot,
    // waits up to 15 s for one and tells the page (`run.queued`, `run.started`). Released in `finally`.
    let slot: AgentSessionSlot | undefined;
    try {
      slot = await acquireAgentSessionSlot({
        tenantId: turn.run.tenantId,
        holderId: turn.reservation ? String(turn.reservation.run._id) : undefined,
        origin: 'console',
        signal: watch?.signal ?? disconnect?.signal,
        onQueued: (info) => send('run.queued', info),
        onStarted: () => send('run.started', {}),
      });
      const result = await runWithUsageSink(usage, () => executePlaygroundChatLocal({
        ...turn.run,
        ...(watch ? { signal: watch.signal } : disconnect ? { signal: disconnect.signal } : {}),
        // A stateless call (Compare versions) carries its own earlier messages.
        history: readStatelessHistory(turn.body),
        onToolEvent: (event) => send('tool', event),
        onTextChunk: (text) => send('text', { text }),
        // The model's thinking as it happens (additive event: older clients ignore it).
        onReasoningChunk: (text) => send('reasoning', { text }),
        // The agent summarized its context mid-run: shown in the transcript
        // as it happens, not only once the turn is over.
        onCompaction: (compaction) => send('summary', compaction),
        // The agent's plan and its sub-agents' lifecycle (additive events: older clients ignore them).
        onPlan: (plan) => send('plan', plan),
        onSubagent: (event) => send('subagent', event),
      }));

      settleAgentRun(quotaCaller, usage, result.usage?.totalTokens);
      send('result', result);
    } catch (error) {
      settleAgentRun(quotaCaller, usage);
      // The status line is long gone by now, so the error travels as an
      // event. A client that only listened for `result` would otherwise hang
      // until the socket closed and call it a network fault.
      if (error instanceof AgentGuardrailBlockedError) {
        logger.info('Agent playground stream blocked by guardrail', {
          guardrailKey: error.guardrailKey,
          hook: error.hook,
        });
        send('error', { error: error.message, type: 'guardrail_block' });
      } else {
        logAgentRunFailure(logger, 'Agent playground stream error', error);
        const classified = classifyAgentRunError(error, { exposeInternal: await canSeeRawProviderErrors(request) });
        send('error', isPlanLimitError(error) ? planLimitErrorBody(error) : { error: classified.error.message, type: classified.error.type, code: classified.error.code });
      }
    } finally {
      watch?.stop();
      unsubscribeSessionEvents?.();
      await slot?.release();
      await turn.reservation?.release();
      if (!closed) reply.raw.end();
    }
    return reply;
  }));

  app.post('/agents/:agentId/chat', AGENT_SCOPED, withApiRequestContext(async (request, reply) => {
    try {
      const turn = await prepareDashboardTurn(request, reply);
      if (!turn) return reply;
      const { body } = turn;

      let result: Awaited<ReturnType<typeof executePlaygroundChat>>;
      const watch = turnWatchFor(turn);
      let slot: AgentSessionSlot | undefined;
      try {
        // Plan limit (agent sessions): console-originated, waits up to 15 s; a refusal is a 429 below.
        slot = await acquireAgentSessionSlot({
          tenantId: turn.run.tenantId,
          holderId: turn.reservation ? String(turn.reservation.run._id) : undefined,
          origin: 'console',
          signal: watch?.signal,
        });
        result = await executePlaygroundChat({
          ...turn.run,
          ...(watch ? { signal: watch.signal } : {}),
          // Ignored server-side when conversationId is set (history loads from
          // the session instead) — still parsed so a stateless call (no
          // conversationId) keeps working exactly as before.
          history: readStatelessHistory(body),
        });
      } finally {
        watch?.stop();
        await slot?.release();
        await turn.reservation?.release();
      }

      return reply.code(200).send(result);
    } catch (error) {
      // A guardrail block is logged at info, not error: it is the configured
      // outcome, and an error-level line per refused prompt would page for
      // policy working as written.
      if (error instanceof AgentGuardrailBlockedError) {
        logger.info('Agent playground chat blocked by guardrail', {
          guardrailKey: error.guardrailKey,
          hook: error.hook,
        });
      } else {
        logAgentRunFailure(logger, 'Agent playground chat error', error);
      }
      const classified = classifyAgentRunError(error, { exposeInternal: await canSeeRawProviderErrors(request) });
      if (isPlanLimitError(error)) return reply.headers(planLimitHeaders(error)).code(error.status).send(planLimitErrorBody(error));
      return sendAgentGuardrailBlock(reply, error)
        ?? sendProjectContextError(reply, error)
        ?? reply.code(classified.status).send({
          error: classified.error.message,
          type: classified.error.type,
          code: classified.error.code,
        });
    }
  }));
}
