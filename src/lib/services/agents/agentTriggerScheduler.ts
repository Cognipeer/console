/**
 * The trigger scheduler: every `AGENT_TRIGGER_TICK_MS`, on EVERY node, each
 * tenant's due triggers (`nextFireAt <= now`) are fired.
 *
 * Exactly once across replicas without a coordinator: each due slot is claimed
 * in the tenant DB (`claimSchedulerSlot('trigger:<id>:<slotISO>')`, the
 * database picks one winner) and the run carries the same key as its
 * idempotency key. Every node that saw the slot advances `nextFireAt` with a
 * CAS, so a winner that died after its claim does not leave the trigger stuck
 * on that slot (the slot is lost, never run twice).
 *
 * A refused fire (run limit, spend limit, quota) is not retried: the slot is
 * skipped and the next one waits for its own time. A slot older than
 * `AGENT_TRIGGER_MISFIRE_GRACE_MS` (the server was down) is skipped too; of
 * several missed slots only the latest still within the grace fires.
 */

import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';
import { getDatabase, runWithTenantScope } from '@/lib/database';
import type { DatabaseProvider, IAgentTrigger } from '@/lib/database';
import { fireTrigger, resolveTriggerVariables, triggerAgentConfig, triggerTargetAvailability, type TriggerTenant } from './agentTriggers';
import { planDueTrigger } from './agentTriggerSchedule';

const logger = createLogger('agent-trigger-scheduler');

/** Due triggers handled per tenant per tick; the rest wait for the next tick. */
const DUE_BATCH = 100;
/** A claim outlives any chance of the same slot being seen again (nextFireAt has moved on by then). */
const CLAIM_TTL_MS = 86_400_000;

export interface TriggerTickResult {
  tenants: number;
  fired: number;
  /** Slots another node claimed first. */
  claimedElsewhere: number;
  /** Slots that did not run: missed (older than the grace), refused, or failed. */
  skipped: number;
}

export function triggerSlotKey(triggerId: string, slot: Date): string {
  return `trigger:${triggerId}:${slot.toISOString()}`;
}

async function fireDueTrigger(
  db: DatabaseProvider,
  tenant: TriggerTenant,
  trigger: IAgentTrigger,
  now: Date,
  result: TriggerTickResult,
): Promise<void> {
  const triggerId = String(trigger._id);
  const dueAt = new Date(trigger.nextFireAt!);
  const plan = planDueTrigger(trigger, dueAt, now, getConfig().agent.triggerMisfireGraceMs);

  if (plan.kind === 'missed') {
    if (await db.advanceTriggerNextFire(triggerId, dueAt, plan.next)) {
      result.skipped += 1;
      logger.warn('Trigger slot missed (older than the misfire grace); skipped', {
        triggerId, slot: plan.slot.toISOString(), next: plan.next?.toISOString() ?? null,
      });
    }
    return;
  }

  // A target that is switched off: nothing is claimed and no fire is recorded as failed. A
  // one-shot stays pending, so it still fires if the target is back on within the grace (else
  // the missed path above closes it); a schedule skips this slot and waits for the next one.
  const availability = await triggerTargetAvailability(db, trigger);
  if (!availability.ok) {
    if (plan.next && await db.advanceTriggerNextFire(triggerId, dueAt, plan.next)) {
      result.skipped += 1;
      logger.info('Trigger slot skipped: its target is not available', {
        triggerId, slot: plan.fireAt.toISOString(), reason: availability.reason, next: plan.next.toISOString(),
      });
    }
    return;
  }

  const key = triggerSlotKey(triggerId, plan.fireAt);
  const won = await db.claimSchedulerSlot(key, new Date(Math.max(plan.fireAt.getTime(), now.getTime()) + CLAIM_TTL_MS));
  // Whoever saw the slot moves the trigger on; the CAS lets one of them do it.
  await db.advanceTriggerNextFire(triggerId, dueAt, plan.next);
  if (!won) {
    result.claimedElsewhere += 1;
    return;
  }

  const config = await triggerAgentConfig(tenant.tenantDbName, trigger);
  const variables = resolveTriggerVariables(config, trigger);
  if (!variables.ok) {
    result.skipped += 1;
    await db.setTriggerFireResult(triggerId, { fireAt: plan.fireAt, status: 'failed', error: variables.reason });
    logger.warn('Trigger slot skipped: its variables no longer match the agent', { triggerId, reason: variables.reason });
    return;
  }

  const fired = await fireTrigger(trigger, tenant, {
    trigger: trigger.type === 'once' ? 'once' : 'schedule',
    message: trigger.prompt,
    variables: variables.variables,
    idempotencyKey: key,
    fireAt: plan.fireAt,
  });
  if (fired.kind === 'accepted') {
    result.fired += 1;
    return;
  }
  result.skipped += 1;
  logger.warn('Trigger slot did not start a run; skipped', {
    triggerId, slot: plan.fireAt.toISOString(), outcome: fired.kind, ...('reason' in fired ? { reason: fired.reason } : {}),
  });
}

/** One pass over every tenant. Exported for tests and a manual trigger. */
export async function tickAgentTriggers(now: Date = new Date()): Promise<TriggerTickResult> {
  const result: TriggerTickResult = { tenants: 0, fired: 0, claimedElsewhere: 0, skipped: 0 };
  const tenants = await (await getDatabase()).listTenants();
  for (const tenant of tenants) {
    if (!tenant.dbName || !tenant._id) continue;
    result.tenants += 1;
    const triggerTenant: TriggerTenant = { tenantId: String(tenant._id), tenantDbName: tenant.dbName, licenseType: tenant.licenseType };
    try {
      await runWithTenantScope(tenant.dbName, async (db) => {
        const due = await db.listDueTriggers(now, DUE_BATCH);
        for (const trigger of due) {
          try {
            await fireDueTrigger(db, triggerTenant, trigger, now, result);
          } catch (error) {
            logger.error('Trigger tick failed for a trigger', {
              triggerId: String(trigger._id), error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      });
    } catch (error) {
      logger.warn('Trigger tick failed for a tenant', {
        tenantDbName: tenant.dbName, error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

async function runTick(): Promise<void> {
  // One tick at a time on this node: a slow tick is not overtaken by the next.
  if (ticking) return;
  ticking = true;
  try {
    const result = await tickAgentTriggers();
    if (result.fired > 0 || result.skipped > 0) logger.info('Trigger tick', { ...result });
  } catch (error) {
    logger.error('Trigger tick failed', { error: error instanceof Error ? error.message : String(error) });
  } finally {
    ticking = false;
  }
}

export function startAgentTriggerScheduler(): void {
  if (timer !== null) return;
  const tickMs = getConfig().agent.triggerTickMs;
  logger.info(`Started (tick: ${tickMs / 1000}s)`);
  timer = setInterval(() => { void runTick(); }, tickMs);
  timer.unref?.();
}

export function stopAgentTriggerScheduler(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}
