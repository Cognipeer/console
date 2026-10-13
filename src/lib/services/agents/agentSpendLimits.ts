/**
 * Agent spend now counts toward the tenant's spend limits.
 *
 * The gateway checks a tenant's daily / monthly spend limit before a model call
 * and debits the real cost afterwards (`checkBudget` / `settleUsageBudget` in
 * the quota guard). An agent turn calls its model directly and did neither, so
 * what agents spend was not counted against those limits. It is now.
 *
 * Two small pieces, used by every channel an agent turn can start from
 * (Studio, the client API, portals, background runs, resuming a paused turn,
 * continuing a session):
 *  - `assertAgentSpendAllowed` — the pre-flight check, before the turn's model
 *    is called. A refusal is a 429, the same error the gateway answers.
 *  - `agentSpendSettler` — debits each priced model request, from the one place
 *    every request of an agent passes through (the model usage tap, which also
 *    covers sub-agent models). One debit per provider call, so a turn that is
 *    resumed, continued or retried cannot be debited twice, and the requests of
 *    a turn that later fails are still counted — the provider billed them.
 *
 * The quota context is built the way the gateway builds it (domain `llm`,
 * resource = the model key, the acting user), so agent spend and direct model
 * calls share one set of counters.
 */

import { isSyntheticActor } from './syntheticActor';
import { getDatabase, type IAgentConfig } from '@/lib/database';
import type { LicenseType } from '@/lib/license/license-manager';
import { AgentSpendLimitError } from './agentErrors';
import { checkBudget, settleUsageBudget, type QuotaContext } from '@/lib/quota/quotaGuard';

export { AgentSpendLimitError };

/** Who an agent turn's spend is attributed to. */
export interface AgentSpendScope {
  tenantDbName: string;
  tenantId: string;
  projectId: string;
  /** The acting user; absent for a synthetic actor (schedule, timeout sweep, public A2A). */
  userId?: string;
  licenseType: LicenseType;
  /**
   * Sees every priced request of the run next to the debit — the session budget
   * adds them up so a turn that is aborted, superseded or thrown still counts.
   */
  observe?: (cost: { currency: string; totalCost: number }) => void;
}


export async function resolveAgentSpendScope(input: {
  tenantDbName: string;
  tenantId: string;
  projectId: string;
  userId?: string;
}): Promise<AgentSpendScope> {
  const db = await getDatabase();
  const tenant = await db.findTenantById(input.tenantId).catch(() => null);
  return {
    tenantDbName: input.tenantDbName,
    tenantId: input.tenantId,
    projectId: input.projectId,
    ...(input.userId && !isSyntheticActor(input.userId) ? { userId: input.userId } : {}),
    licenseType: (tenant?.licenseType ?? 'FREE') as LicenseType,
  };
}

function quotaContext(scope: AgentSpendScope, modelKey: string): QuotaContext {
  return {
    domain: 'llm',
    licenseType: scope.licenseType,
    projectId: scope.projectId,
    resourceKey: modelKey,
    tenantDbName: scope.tenantDbName,
    tenantId: scope.tenantId,
    ...(scope.userId ? { userId: scope.userId } : {}),
  };
}

/** Pre-flight: throws `AgentSpendLimitError` when the spend limit is already used up. */
export async function assertAgentSpendAllowed(scope: AgentSpendScope, modelKey: string): Promise<void> {
  const result = await checkBudget(quotaContext(scope, modelKey));
  if (!result.allowed) throw new AgentSpendLimitError(result.reason || 'Budget exceeded');
}

/** Debits the spend limit with one model request's realized cost (fire and forget; never throws). */
export function agentSpendSettler(
  scope: AgentSpendScope,
  modelKey: string,
): (cost: { currency: string; totalCost: number }) => void {
  const context = quotaContext(scope, modelKey);
  return (cost) => {
    scope.observe?.(cost);
    void settleUsageBudget(context, cost);
  };
}

/**
 * The tenant spend pre-flight for a turn. Counters are per model key, and a
 * sub-agent with its own model debits its own counter, so every model the turn
 * can call is checked — not only the primary one. (A `ref` sub-agent borrows
 * another agent's model and is resolved at build time, so it is not covered.)
 */
export async function assertAgentTurnSpendAllowed(
 spend: AgentSpendScope,
 config: Pick<IAgentConfig, 'modelKey' | 'subagents'>,
): Promise<void> {
  const keys = new Set<string>();
  if (config.modelKey) keys.add(config.modelKey);
  for (const entry of config.subagents ?? []) {
    if (entry.modelKey) keys.add(entry.modelKey);
  }
  for (const key of keys) await assertAgentSpendAllowed(spend, key);
}

/**
 * Pre-flight for a turn that is queued rather than run inline (a background
 * run, a budget continuation): the caller gets the 429 at once instead of a 202
 * and a run that fails later. A connected (external) agent calls no model.
 */
export async function assertQueuedTurnSpendAllowed(input: {
  tenantDbName: string;
  tenantId: string;
  projectId: string;
  agentKey: string;
  userId?: string;
}): Promise<void> {
  const db = await getDatabase();
  await db.switchToTenant(input.tenantDbName);
  const agent = await db.findAgentByKey(input.agentKey, input.projectId);
  const config = agent?.config;
  if (!config?.modelKey || (config.kind === 'external' && config.connection)) return;
  const scope = await resolveAgentSpendScope(input);
  await assertAgentTurnSpendAllowed(scope, config);
}
