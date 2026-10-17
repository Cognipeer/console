/**
 * The routine scheduler: every `AGENT_ROUTINE_TICK_MS`, on EVERY node, each
 * tenant's due routines (`nextFireAt <= now`) are fired.
 *
 * Exactly once across replicas without a coordinator: each due slot is claimed
 * in the tenant DB (`claimSchedulerSlot('routine:<id>:<slotISO>')`, the
 * database picks one winner) and the run carries the same key as its
 * idempotency key. Every node that saw the slot advances `nextFireAt` with a
 * CAS, so a winner that died after its claim does not leave the routine stuck
 * on that slot (the slot is lost, never run twice).
 *
 * A refused fire (run limit, spend limit, quota) is not retried: the slot is
 * skipped and the next one waits for its own time. A slot older than
 * `AGENT_ROUTINE_MISFIRE_GRACE_MS` (the server was down) is skipped too; of
 * several missed slots only the latest still within the grace fires.
 */

import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';
import { getDatabase, runWithTenantScope } from '@/lib/database';
import type { DatabaseProvider, IAgentRoutine } from '@/lib/database';
import { fireRoutine, resolveRoutineInputs, routineAgentConfig, type RoutineTenant } from './agentRoutines';
import { planDueRoutine } from './routineSchedule';

const logger = createLogger('agent-routine-scheduler');

/** Due routines handled per tenant per tick; the rest wait for the next tick. */
const DUE_BATCH = 100;
/** A claim outlives any chance of the same slot being seen again (nextFireAt has moved on by then). */
const CLAIM_TTL_MS = 86_400_000;

export interface RoutineTickResult {
  tenants: number;
  fired: number;
  /** Slots another node claimed first. */
  claimedElsewhere: number;
  /** Slots that did not run: missed (older than the grace), refused, or failed. */
  skipped: number;
}

export function routineSlotKey(routineId: string, slot: Date): string {
  return `routine:${routineId}:${slot.toISOString()}`;
}

async function fireDueRoutine(
  db: DatabaseProvider,
  tenant: RoutineTenant,
  routine: IAgentRoutine,
  now: Date,
  result: RoutineTickResult,
): Promise<void> {
  const routineId = String(routine._id);
  const dueAt = new Date(routine.nextFireAt!);
  const plan = planDueRoutine(routine, dueAt, now, getConfig().agent.routineMisfireGraceMs);

  if (plan.kind === 'missed') {
    if (await db.advanceRoutineNextFire(routineId, dueAt, plan.next)) {
      result.skipped += 1;
      logger.warn('Routine slot missed (older than the misfire grace); skipped', {
        routineId, slot: plan.slot.toISOString(), next: plan.next?.toISOString() ?? null,
      });
    }
    return;
  }

  const key = routineSlotKey(routineId, plan.fireAt);
  const won = await db.claimSchedulerSlot(key, new Date(Math.max(plan.fireAt.getTime(), now.getTime()) + CLAIM_TTL_MS));
  // Whoever saw the slot moves the routine on; the CAS lets one of them do it.
  await db.advanceRoutineNextFire(routineId, dueAt, plan.next);
  if (!won) {
    result.claimedElsewhere += 1;
    return;
  }

  const config = await routineAgentConfig(tenant.tenantDbName, routine);
  const inputs = resolveRoutineInputs(config, routine);
  if (!inputs.ok) {
    result.skipped += 1;
    await db.setRoutineFireResult(routineId, { fireAt: plan.fireAt, status: 'failed', error: inputs.reason });
    logger.warn('Routine slot skipped: its inputs no longer match the agent', { routineId, reason: inputs.reason });
    return;
  }

  const fired = await fireRoutine(routine, tenant, {
    trigger: routine.type === 'once' ? 'once' : 'schedule',
    message: routine.prompt,
    inputs: inputs.inputs,
    idempotencyKey: key,
    fireAt: plan.fireAt,
  });
  if (fired.kind === 'accepted') {
    result.fired += 1;
    return;
  }
  result.skipped += 1;
  logger.warn('Routine slot did not start a run; skipped', {
    routineId, slot: plan.fireAt.toISOString(), outcome: fired.kind, ...('reason' in fired ? { reason: fired.reason } : {}),
  });
}

/** One pass over every tenant. Exported for tests and a manual trigger. */
export async function tickAgentRoutines(now: Date = new Date()): Promise<RoutineTickResult> {
  const result: RoutineTickResult = { tenants: 0, fired: 0, claimedElsewhere: 0, skipped: 0 };
  const tenants = await (await getDatabase()).listTenants();
  for (const tenant of tenants) {
    if (!tenant.dbName || !tenant._id) continue;
    result.tenants += 1;
    const routineTenant: RoutineTenant = { tenantId: String(tenant._id), tenantDbName: tenant.dbName, licenseType: tenant.licenseType };
    try {
      await runWithTenantScope(tenant.dbName, async (db) => {
        const due = await db.listDueRoutines(now, DUE_BATCH);
        for (const routine of due) {
          try {
            await fireDueRoutine(db, routineTenant, routine, now, result);
          } catch (error) {
            logger.error('Routine tick failed for a routine', {
              routineId: String(routine._id), error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      });
    } catch (error) {
      logger.warn('Routine tick failed for a tenant', {
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
    const result = await tickAgentRoutines();
    if (result.fired > 0 || result.skipped > 0) logger.info('Routine tick', { ...result });
  } catch (error) {
    logger.error('Routine tick failed', { error: error instanceof Error ? error.message : String(error) });
  } finally {
    ticking = false;
  }
}

export function startAgentRoutineScheduler(): void {
  if (timer !== null) return;
  const tickMs = getConfig().agent.routineTickMs;
  logger.info(`Started (tick: ${tickMs / 1000}s)`);
  timer = setInterval(() => { void runTick(); }, tickMs);
  timer.unref?.();
}

export function stopAgentRoutineScheduler(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}
