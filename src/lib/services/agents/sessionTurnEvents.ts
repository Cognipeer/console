/**
 * One turn's view of the session event log: the call sites of
 * `executeAgentChatLocal` / `executePlaygroundChatLocal` (and the resume path)
 * feed it the SDK's events and the turn's outcome; it writes the events
 * (`sessionEvents.ts`) and keeps the conversation's runtime fields
 * (`runtimeStatus`, `stopReason`, `pendingActionIds`, `lastEventSeq`) in step.
 *
 * Everything here is best effort: nothing it does may fail the turn.
 */

import { randomUUID } from 'node:crypto';
import type { SmartAgentEvent as AgentSdkEvent } from '@cognipeer/agent-sdk';
import { createLogger } from '@/lib/core/logger';
import type { DatabaseProvider, IAgentTurnCompaction, IAgentTurnUsageSummary } from '@/lib/database';
import { classifyAgentRunError } from './agentErrors';
import { delegatedSubagentName } from './subagentEvents';
import { sessionUsageEventData, type SessionBudgetSettlement } from './sessionBudget';
import {
  createSessionEventWriter,
  type SessionEventBus,
  type SessionEventWriter,
  type SessionStopReason,
} from './sessionEvents';

const logger = createLogger('agents:session-turn-events');

type TurnDb = Pick<
  DatabaseProvider,
  'appendAgentSessionEvents' | 'getAgentSessionMaxSeq' | 'updateAgentConversationRuntime'
> & {
  /** The ledger of this turn's model calls (what they cost so far), for a turn that ends without a usage of its own. */
  summarizeModelUsageForTurn?: DatabaseProvider['summarizeModelUsageForTurn'];
  /** Present on a resuming leg's database: the earlier legs' tool events, to avoid writing them twice. */
  listAgentSessionEvents?: (
    conversationId: string,
    options?: { types?: string[] },
  ) => Promise<Array<{ type: string; data?: unknown }>>;
};

export interface SessionTurnEventsOptions {
  db: TurnDb;
  /** Present = the turn's `session.idled` / `action.required` / … also reach webhook subscriptions. */
  tenantDbName?: string;
  tenantId: string;
  projectId: string;
  agentKey: string;
  conversationId: string;
  runId?: string;
  /**
   * The user's message, when this turn starts from one (absent when resuming a
   * pause). A function reads it late: a guardrail may rewrite the text during
   * the run, and the log must carry what the transcript stores, not the raw
   * input — see `ensureStarted`.
   */
  userMessage?: string | (() => string);
  trigger: 'message' | 'resume' | 'timeout' | 'reminder';
  /** Extra fields of the `user.message` event (a reminder's wake turn: `origin` and the note). */
  userMessageData?: Record<string, unknown>;
  /** The model the turn runs on, for an agent that offers several (rides on `session.status_running`). */
  model?: { modelKey: string; reason: string };
  bus?: SessionEventBus;
  /**
   * True once this turn has been given up on (its deadline passed, or it was
   * cancelled) while the model call it was waiting on is still going. A turn in
   * that state stops writing mid-turn events — a newer turn may already own the
   * log — and its end is recorded only if no newer turn has started
   * (`updateAgentConversationRuntime`'s `onlyIfTurn`).
   */
  superseded?: () => boolean;
}

export interface SessionTurnFinish {
  stopReason: SessionStopReason;
  /** The user turn as persisted (after any guardrail rewrite); used if the turn's start events are still unwritten. */
  userMessage?: string;
  /** The answer (or the partial text a stopped run ended with). Omit when the turn produced no message. */
  content?: string;
  /** Index of the assistant message in `conversation.messages`. */
  messageIndex?: number;
  usage?: Record<string, unknown>;
  /** The runtime's wording for a limit / pause. */
  detail?: string;
  pendingActionIds?: string[];
  /**
   * The session's spend budget after this turn. Present only for a session that
   * has one: it adds `session.usage` (and `budget.reached` when the turn was
   * stopped by it), and a pausing budget leaves the session `budget_paused`.
   */
  budget?: SessionBudgetSettlement;
}

export interface SessionTurnEvents {
  readonly writer: SessionEventWriter;
  /** Names this turn: the conversation's `runtimeTurnId` and the `turnId` on the usage rows of its model calls. */
  readonly turnId: string;
  /** Maps the SDK's tool-call events onto `agent.tool_use` / `agent.tool_result`. */
  onSdkEvent(event: AgentSdkEvent): void;
  onCompaction(compaction: IAgentTurnCompaction): void;
  /** A text delta of the answer — live only. */
  onText(text: string): void;
  /** A delta of the model's reasoning text — live only. */
  onReasoning(text: string): void;
  /**
   * Emit any persisted event directly (bookkeeping that happens before the
   * model is called, like cancelling a pending request for a new message).
   */
  emit: SessionEventWriter['emit'];
  /**
   * Emit an event that belongs after the turn's opening events (`action.required`
   * when the run stops for a person): the lazily written `user.message` /
   * `session.status_running` go first so the log reads in order.
   */
  emitInTurn: SessionEventWriter['emit'];
  /** Turn ended normally (any stop reason but a thrown error). */
  finish(result: SessionTurnFinish): Promise<void>;
  /** Turn threw. */
  fail(error: unknown): Promise<void>;
}

/** The conversation fields that describe a turn's end. */
export function conversationRuntimePatch(
  stopReason: SessionStopReason,
  pendingActionIds: string[] = [],
  budget?: SessionBudgetSettlement,
) {
  const budgetPaused = stopReason === 'budget_reached' && budget?.budget.onReach === 'pause';
  return {
    runtimeStatus: stopReason === 'requires_action'
      ? ('requires_action' as const)
      : budgetPaused ? ('budget_paused' as const) : ('idle' as const),
    stopReason,
    pendingActionIds: stopReason === 'requires_action' ? pendingActionIds : [],
  };
}

export function startSessionTurnEvents(options: SessionTurnEventsOptions): SessionTurnEvents {
  const { db, conversationId } = options;
  const writer = createSessionEventWriter({
    db,
    tenantId: options.tenantId,
    projectId: options.projectId,
    agentKey: options.agentKey,
    conversationId,
    ...(options.runId ? { runId: options.runId } : {}),
    ...(options.tenantDbName ? { tenantDbName: options.tenantDbName } : {}),
    ...(options.bus ? { bus: options.bus } : {}),
  });

  // `user.message` + `session.status_running` are written lazily — at the first
  // sign the model call went out (a tool call, a text delta, the end of the
  // turn) — so the message is the one the transcript stores: an `input.pre`
  // guardrail rewrites it before the first model call, and writing the raw text
  // up front would put into the event log what the guardrail just removed.
  let started = false;
  const ensureStarted = (persistedText?: string) => {
    if (started) return;
    started = true;
    if (options.userMessage !== undefined) {
      const text = persistedText
        ?? (typeof options.userMessage === 'function' ? options.userMessage() : options.userMessage);
      writer.emit('user.message', { content: text, ...(options.userMessageData ?? {}) });
    }
    writer.emit('session.status_running', { trigger: options.trigger, ...(options.model ? { model: options.model } : {}) });
  };
  // A turn that resumes a pause has no message to hold back.
  if (options.userMessage === undefined) ensureStarted();

  // The conversation row says "running" at once, so a client that loads the
  // session mid-turn knows to attach. It also names this turn as the owner of the
  // runtime fields: a turn that is cut off and finishes late checks it before
  // writing its end, so it cannot overwrite the turn that started after it.
  const turnToken = randomUUID();
  const marked = (async () => {
    await db.updateAgentConversationRuntime(conversationId, { runtimeStatus: 'running', runtimeTurnId: turnToken });
  })()
    .catch((error) => {
      logger.warn('Could not mark the session running', { conversationId, error: String(error) });
    });

  // One `agent.tool_use` / `agent.tool_result` per tool call id: the SDK re-enters a
  // delegation (and a tool that paused) when a pause is resumed, with the same call id.
  // A resumed leg reads the ids the earlier legs already wrote before it writes its own.
  const usedIds = new Set<string>();
  const resultIds = new Set<string>();
  let seeded: Promise<void> = Promise.resolve();
  let seedPending = false;
  const deferred: Array<() => void> = [];
  if (options.trigger === 'resume' && db.listAgentSessionEvents) {
    seedPending = true;
    seeded = (async () => {
      try {
        const prior = await db.listAgentSessionEvents!(conversationId, { types: ['agent.tool_use', 'agent.tool_result'] });
        for (const e of prior) {
          const id = (e.data as { toolCallId?: unknown } | undefined)?.toolCallId;
          if (typeof id !== 'string') continue;
          (e.type === 'agent.tool_use' ? usedIds : resultIds).add(id);
        }
      } catch (error) {
        logger.warn('Could not read the earlier tool events of the session', { conversationId, error: String(error) });
      }
    })().finally(() => {
      seedPending = false;
      for (const run of deferred.splice(0)) run();
    });
  }

  let finished = false;
  /**
   * Records the turn's end: the status first, then the closing events, then the
   * last seq. The status goes in BEFORE the idle / action frames are written, so
   * a follower that reloads the session on that frame never reads 'running' —
   * and because it is conditional on this turn still owning the session, a turn
   * a newer one has overtaken writes nothing at all (`false` from the database).
   */
  const settle = async (
    stopReason: SessionStopReason,
    emitClosing: () => void,
    pendingActionIds?: string[],
    budget?: SessionBudgetSettlement,
  ) => {
    await marked;
    await seeded;
    let current = true;
    try {
      const applied = await db.updateAgentConversationRuntime(
        conversationId,
        conversationRuntimePatch(stopReason, pendingActionIds, budget),
        { onlyIfTurn: turnToken },
      );
      current = applied !== false;
    } catch (error) {
      logger.warn('Could not record the session stop reason', { conversationId, error: String(error) });
    }
    if (!current) {
      logger.info('A turn ended after a newer one took over the session; its end is not recorded', { conversationId, stopReason });
      writer.abandon();
      return;
    }
    guarded('closing events', emitClosing);
    await writer.close();
    try {
      await db.updateAgentConversationRuntime(conversationId, { lastEventSeq: writer.lastSeq() }, { onlyIfTurn: turnToken });
    } catch (error) {
      logger.warn('Could not record the last session event seq', { conversationId, error: String(error) });
    }
  };
  const isSuperseded = () => {
    try {
      return options.superseded?.() === true;
    } catch {
      return false;
    }
  };

  /** The recorder is an observer: nothing it does may reach the turn it observes. */
  const guarded = (what: string, fn: () => void) => {
    try {
      fn();
    } catch (error) {
      logger.warn(`Session event recorder failed (${what})`, { conversationId, error: String(error) });
    }
  };

  /**
   * What this turn's model calls have cost so far, from their usage rows — the
   * ledger a turn that threw or was cut off still has. Nothing when the turn made
   * no call, or the store cannot say.
   */
  const ledgerUsage = async (): Promise<Record<string, unknown> | undefined> => {
    if (!db.summarizeModelUsageForTurn) return undefined;
    try {
      const spent: IAgentTurnUsageSummary = await db.summarizeModelUsageForTurn(conversationId, turnToken, options.projectId);
      if (spent.calls === 0) return undefined;
      return {
        inputTokens: spent.inputTokens,
        outputTokens: spent.outputTokens,
        cachedInputTokens: spent.cachedInputTokens,
        reasoningTokens: spent.reasoningTokens,
        totalTokens: spent.totalTokens,
        costUsd: spent.costUsd,
        calls: spent.calls,
        source: 'ledger',
      };
    } catch (error) {
      logger.warn('Could not read the usage ledger of the turn', { conversationId, error: String(error) });
      return undefined;
    }
  };

  return {
    writer,
    turnId: turnToken,
    emit: (type, data) => guarded('emit', () => writer.emit(type, data)),
    emitInTurn: (type, data) => guarded('emit', () => {
      if (isSuperseded()) return;
      ensureStarted();
      writer.emit(type, data);
    }),

    onSdkEvent(event) {
      if (event.type !== 'tool_call' || !event.name) return;
      guarded('tool event', () => {
        if (isSuperseded()) return;
        ensureStarted();
        // A forwarded child event names its child; a delegation call names the one it handed the task to.
        const subagent = (event as { subagentName?: string }).subagentName
          ?? delegatedSubagentName(event.name, event.args, (event as { result?: unknown }).result);
        const write = () => {
          const id = typeof event.id === 'string' ? event.id : undefined;
          if (event.phase === 'start') {
            if (id) {
              if (usedIds.has(id)) return;
              usedIds.add(id);
            }
            writer.emit('agent.tool_use', {
              toolCallId: event.id,
              name: event.name,
              ...(event.args !== undefined ? { args: event.args } : {}),
              ...(subagent ? { subagent } : {}),
            });
          } else if (event.phase === 'success' || event.phase === 'error') {
            if (id) {
              if (resultIds.has(id)) return;
              resultIds.add(id);
            }
            writer.emit('agent.tool_result', {
              toolCallId: event.id,
              name: event.name,
              ok: event.phase === 'success',
              ...(typeof event.durationMs === 'number' ? { durationMs: event.durationMs } : {}),
              ...(event.error?.message ? { error: event.error.message } : {}),
              ...(subagent ? { subagent } : {}),
            });
          }
        };
        if (seedPending || deferred.length) deferred.push(write);
        else write();
      });
    },

    onCompaction(compaction) {
      guarded('compaction', () => {
        if (isSuperseded()) return;
        ensureStarted();
        writer.emit('agent.compaction', { ...compaction });
      });
    },

    onText(text) {
      guarded('text delta', () => {
        if (isSuperseded()) return;
        ensureStarted();
        writer.emitLive('agent.message.delta', { text });
      });
    },

    onReasoning(text) {
      guarded('reasoning delta', () => {
        if (isSuperseded()) return;
        ensureStarted();
        writer.emitLive('agent.reasoning.delta', { text });
      });
    },

    async finish(result) {
      if (finished) return;
      finished = true;
      // A turn the runtime could not account for (cancelled, timed out) still spent what its ledger says.
      const spent = result.usage ? undefined : await ledgerUsage();
      try {
        await settle(result.stopReason, () => {
          ensureStarted(result.userMessage);
          // A pause with nothing written yet has no message to report.
          if (result.content !== undefined && !(result.stopReason === 'requires_action' && !result.content.trim())) {
            writer.emit('agent.message', {
              content: result.content,
              ...(result.messageIndex !== undefined ? { messageIndex: result.messageIndex } : {}),
              ...(result.stopReason !== 'end_turn' ? { stopReason: result.stopReason } : {}),
              ...(result.usage ? { usage: result.usage } : {}),
            });
          }
          if (result.budget) {
            writer.emit('session.usage', sessionUsageEventData(result.budget));
            if (result.budget.reached) {
              writer.emit('budget.reached', {
                spentUsd: result.budget.spentUsd,
                maxCostUsd: result.budget.budget.maxCostUsd,
              });
            }
          }
          writer.emit('session.status_idle', {
            stopReason: result.stopReason,
            ...(spent ? { usage: spent } : {}),
            ...(result.pendingActionIds?.length ? { pendingActionIds: result.pendingActionIds } : {}),
            ...(result.detail ? { detail: result.detail } : {}),
          });
          if (result.stopReason === 'end_turn') writer.emit('session.work_done', {});
        }, result.pendingActionIds, result.budget);
      } catch (error) {
        logger.warn('Session event recorder failed (finish)', { conversationId, error: String(error) });
      }
    },

    async fail(error) {
      if (finished) return;
      finished = true;
      const spent = await ledgerUsage();
      try {
        await settle('error', () => {
          ensureStarted();
          // The client-safe classification: these events are readable by API callers.
          // A guardrail refusal is the configured outcome and its message is meant for the caller.
          const blocked = error instanceof Error && error.name === 'AgentGuardrailBlockedError';
          const classified = classifyAgentRunError(error, { exposeInternal: false });
          const message = blocked ? (error as Error).message : classified.error.message;
          const code = blocked ? 'guardrail_block' : classified.error.code;
          writer.emit('session.error', { message, ...(code ? { code } : {}), ...(spent ? { usage: spent } : {}) });
          writer.emit('session.status_idle', { stopReason: 'error', detail: message });
        });
      } catch (settleError) {
        logger.warn('Session event recorder failed (fail)', { conversationId, error: String(settleError) });
      }
    },
  };
}
