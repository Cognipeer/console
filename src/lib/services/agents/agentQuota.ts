/**
 * Quota for agent RUNS (quota domain `agent`): requests and tokens per caller,
 * optionally narrowed to one agent.
 *
 * Agent runs are the one place the quota guard did not reach: a run fans out
 * into many model calls and tool calls, none of which a per-model limit sees as
 * "this person ran an agent". This module is the single enforcement point the
 * run entry points share:
 *
 *   executeAgentChat          sync API, Responses/OpenAI/A2A/Assistants bridges,
 *                             schedules, evaluations, red team
 *   executePlaygroundChat     dashboard playground, portals, realtime voice
 *   dashboard /chat/stream    calls the playground runtime directly (agents.ts)
 *   startAgentRun (queued)    queued runs, checked at submit so the caller
 *                             gets the 429 instead of a run that fails later
 *
 * It deliberately does NOT sit in `executeAgentChatLocal` / `executePlaygroundChatLocal`:
 * those also run on a cluster worker for a call that was already counted on
 * the node that received it, and for a background run that was counted at submit.
 *
 * What is counted, and how. A run costs one REQUEST up front and refuses when
 * that pushes a request window over its limit. Its TOKENS are only known once
 * it ends, so the up-front check only looks whether the token window has already
 * reached its limit (a run is never cut off midway), and the run's real total is
 * added afterwards - also when the run FAILS or is aborted, with the tokens its
 * model calls had spent by then (runUsage.ts). A caller can therefore overshoot a
 * token limit by the runs that were in flight when it was crossed: one when they
 * run one after another, more when they overlap (the request limit of the same
 * policy bounds how many can start). From the next run on it is refused.
 *
 * A policy narrowed to one agent counts the runs that START with that agent. An
 * agent used as a `ref` sub-agent of another is flattened into the parent's run
 * (its prompt, model and tools join the parent's), so that work belongs to the
 * parent and is counted for it.
 *
 * Which policies apply is decided by the guard (lib/quota/quotaGuard.ts): only
 * policies of domain `agent` — `global` ones are intentionally not consulted, so
 * a tenant that never wrote an agent limit decides exactly as before.
 */

import { createLogger } from '@/lib/core/logger';
import { checkRateLimit, type QuotaContext } from '@/lib/quota/quotaGuard';
import { AgentQuotaExceededError } from './agentErrors';
import type { RunUsageSink } from './runUsage';

export { AgentQuotaExceededError, AGENT_QUOTA_EXCEEDED_CODE } from './agentErrors';

const logger = createLogger('agent-quota');

/** Who is running which agent. */
export interface AgentRunCaller {
  tenantDbName: string;
  tenantId: string;
  projectId: string;
  agentKey: string;
  /** The authenticated person (an API token's owner for token calls). */
  userId?: string;
  tokenId?: string;
}

/**
 * Stands in for a missing project id. The guard reads an EMPTY project id as
 * "no project filter" and would load every project's policies; this loads only
 * the tenant-wide ones (which is all an agent-run limit without a project is).
 */
const NO_PROJECT = '__no_project__';

function quotaContextFor(caller: AgentRunCaller): QuotaContext {
  return {
    tenantDbName: caller.tenantDbName,
    tenantId: caller.tenantId,
    projectId: caller.projectId || NO_PROJECT,
    domain: 'agent',
    // The agent: what a policy narrowed to one agent matches on.
    resourceKey: caller.agentKey,
    ...(caller.userId ? { userId: caller.userId } : {}),
    ...(caller.tokenId ? { tokenId: caller.tokenId } : {}),
  };
}

/**
 * Counts the run against the caller's agent limits and throws
 * `AgentQuotaExceededError` when one is exhausted. Resolves quietly when the
 * tenant has no applicable agent limit.
 *
 * A failure of the quota subsystem itself (policy store unreachable) is logged
 * and lets the run through: that read is also what the run is about to do, so
 * the run would fail on its own if the store were really down, and a tenant that
 * never configured an agent limit must not gain a new way to be refused. A
 * COUNTER failure for a limit that IS configured still refuses (the guard fails
 * closed there, exactly as it does for model calls).
 */
export async function enforceAgentRunQuota(caller: AgentRunCaller): Promise<void> {
  let result: Awaited<ReturnType<typeof checkRateLimit>>;
  try {
    result = await checkRateLimit(quotaContextFor(caller), { requests: 1 }, { headroom: ['tokens'] });
  } catch (error) {
    logger.error('Agent run quota check failed; letting the run through', {
      tenantId: caller.tenantId,
      agentKey: caller.agentKey,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  if (!result.allowed) {
    throw new AgentQuotaExceededError(result.reason || 'Agent run quota exceeded');
  }
}

/**
 * Charges a run that is over - however it ended - for the larger of what the
 * run reported and what its model calls were seen to spend (`sink`, runUsage.ts).
 * A failed or aborted run reports nothing, but its tokens are spent all the same.
 */
export function settleAgentRun(caller: AgentRunCaller, sink: RunUsageSink, reportedTokens?: number): void {
  const reported = typeof reportedTokens === 'number' && Number.isFinite(reportedTokens) ? reportedTokens : 0;
  recordAgentRunTokens(caller, Math.max(reported, sink.totalTokens));
}

/**
 * Adds a finished run's tokens to the caller's token windows. Never throws and
 * is not awaited by the run: the answer already exists, and failing it over
 * bookkeeping would only lose it.
 */
export function recordAgentRunTokens(caller: AgentRunCaller, totalTokens: number | undefined): void {
  if (typeof totalTokens !== 'number' || !Number.isFinite(totalTokens) || totalTokens <= 0) return;
  void checkRateLimit(quotaContextFor(caller), { tokens: Math.ceil(totalTokens) }).catch((error) => {
    logger.error('Failed to record agent run token usage', {
      tenantId: caller.tenantId,
      agentKey: caller.agentKey,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
