/**
 * Plan-limit slots for agent sessions (concurrency pool 'agent').
 *
 * Which runs count. Only runs started from the console, a portal, a channel or
 * a schedule hold a slot. A run started through the client API is covered by
 * requests per minute plus the technical per-tenant cap, so it takes none.
 *
 * Where a run's origin is known:
 * - Dashboard turns (`/agents/:id/chat`, `/chat/stream`, session continue)
 *   are 'console'; the route itself is the origin.
 * - Approval answers carry `actor.channel`: 'dashboard' -> console, 'portal'
 *   -> portal, 'api' -> api (not counted).
 * - Rows made by `startAgentRun` carry `channel`: 'runs' | 'responses' |
 *   'chat_completions' | 'a2a' are client API (not counted); 'trigger' and
 *   'reminder' are schedule; 'messaging' is channel. A row without a channel
 *   cannot be placed and is counted as console.
 * - Portal sync turns run in the EE console backend, which asks here with
 *   origin 'portal'.
 *
 * Sync turns wait up to SYNC_WAIT_MS for a slot (`run.queued` when they start
 * waiting, `run.started` once admitted) and are refused with
 * 'tenant_concurrency_limited' after that, in 'on' mode only. Background rows
 * never wait here: the caller leaves them queued and retries later.
 *
 * A slot is never held while a run waits for a person: the turn ends, the slot
 * is released, and the resume takes a new one.
 */
import { randomUUID } from 'node:crypto';
import {
  type PlanLease,
  type PlanLimitSource,
  type PlanLimitSourceType,
  waitForPlanLease,
} from '@/lib/limits';
import type { IAgentRun } from '@/lib/database';
import { concurrencyRefusal, releaseQuietly, tryPoolLease, type PoolLeaseAttempt } from '../planLeases';

export const SYNC_WAIT_MS = 15_000;
export const SYNC_POLL_MS = 500;

export type AgentSessionOrigin = 'console' | 'portal' | 'channel' | 'schedule' | 'api';

const API_CHANNELS: ReadonlySet<string> = new Set(['runs', 'responses', 'chat_completions', 'a2a']);

/** Origin of a stored run, from the surface that created it. Unknown = console (counted). */
export function agentRunOrigin(run: Pick<IAgentRun, 'channel'>): AgentSessionOrigin {
  const channel = run.channel;
  if (!channel) return 'console';
  if (API_CHANNELS.has(channel)) return 'api';
  if (channel === 'trigger' || channel === 'reminder') return 'schedule';
  if (channel === 'messaging') return 'channel';
  return 'console';
}

/** Origin of an approval answer, from `ResolveActor.channel`. */
export function actorChannelOrigin(channel: string | undefined): AgentSessionOrigin {
  if (channel === 'api') return 'api';
  if (channel === 'portal') return 'portal';
  return 'console';
}

export function countsAsAgentSession(origin: AgentSessionOrigin): boolean {
  return origin !== 'api';
}

const SOURCE_TYPE: Record<Exclude<AgentSessionOrigin, 'api'>, PlanLimitSourceType> = {
  console: 'user',
  portal: 'portal',
  channel: 'channel',
  schedule: 'schedule',
};

function sourceFor(origin: AgentSessionOrigin, holderId: string): PlanLimitSource {
  return origin === 'api' ? { type: 'api_token', id: holderId } : { type: SOURCE_TYPE[origin], id: holderId };
}

export interface AgentSessionSlot {
  /** Idempotent. */
  release(): Promise<void>;
}

const NO_SLOT: AgentSessionSlot = { release: async () => undefined };

function slotOf(lease: PlanLease | null): AgentSessionSlot {
  if (!lease) return NO_SLOT;
  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      await releaseQuietly(lease);
    },
  };
}

export interface AcquireAgentSessionSlotInput {
  tenantId: string;
  /** One id per turn (the sync reservation's run id); a fresh one is made when absent. */
  holderId?: string;
  origin: AgentSessionOrigin;
  /** Told once when the turn starts waiting for a slot (`run.queued`). */
  onQueued?: (info: { limit: number; active: number; retryInMs: number }) => void;
  /** Told once when a turn that waited is admitted (`run.started`). */
  onStarted?: () => void;
  signal?: AbortSignal;
  maxWaitMs?: number;
  pollMs?: number;
}

/**
 * Slot for a synchronous turn: waits up to 15 s, then throws a PlanLimitError
 * (only when limits are enforced). A run that does not count returns at once.
 */
export async function acquireAgentSessionSlot(input: AcquireAgentSessionSlotInput): Promise<AgentSessionSlot> {
  if (!countsAsAgentSession(input.origin)) return NO_SLOT;
  const holderId = input.holderId ?? `turn_${randomUUID()}`;
  let queued = false;
  const result = await waitForPlanLease({
    tenantId: input.tenantId,
    pool: 'agent',
    holderId,
    source: sourceFor(input.origin, holderId),
    maxWaitMs: input.maxWaitMs ?? SYNC_WAIT_MS,
    pollMs: input.pollMs ?? SYNC_POLL_MS,
    ...(input.signal ? { signal: input.signal } : {}),
    onQueued: (info) => {
      queued = true;
      input.onQueued?.(info);
    },
  });
  if (!result.decision.allowed) throw concurrencyRefusal('agent', result.decision, 'agent sessions');
  if (queued) {
    try {
      input.onStarted?.();
    } catch {
      /* a progress callback must not break the turn */
    }
  }
  return slotOf(result.lease);
}

/**
 * One non-waiting attempt for a background run. `refused` = leave the run
 * queued and try again later; never fail it.
 */
export async function tryAcquireAgentSessionSlot(input: {
  tenantId: string;
  holderId: string;
  origin: AgentSessionOrigin;
}): Promise<{ refused: boolean; slot: AgentSessionSlot; attempt: PoolLeaseAttempt | null }> {
  if (!countsAsAgentSession(input.origin)) return { refused: false, slot: NO_SLOT, attempt: null };
  const attempt = await tryPoolLease({
    tenantId: input.tenantId,
    pool: 'agent',
    holderId: input.holderId,
    source: sourceFor(input.origin, input.holderId),
  });
  return { refused: attempt.refused, slot: slotOf(attempt.lease), attempt };
}
