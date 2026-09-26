/**
 * Background scheduler for agents.
 *
 * Follows the crawlerScheduler convention exactly — one tick per interval,
 * tenants iterated sequentially, per-entity cluster assignment with a
 * distributed lock for the unassigned bucket. Copying that shape is deliberate:
 * two schedulers in one process that disagree about locking is how the same
 * job ends up running twice on a Tuesday.
 *
 * Schedule semantics live in `schedulePlanner.ts`, shared with crawlers.
 */

import { getDatabase, runWithTenantScope } from '@/lib/database';
import type { IAgent, IAgentSchedule } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import { getCache } from '@/lib/core/cache';
import { findInstanceAssignment, getThisNodeName, resolveDefaultNodeName } from '@/lib/core/cluster';
import { isDue } from '@/lib/services/crawler/schedulePlanner';

import { agentEntityId } from './agentEntityId';
import { readSchedules, recordScheduleRun, runAgentSchedule } from './agentScheduleService';

const logger = createLogger('agent-scheduler');

const CHECK_INTERVAL_MS = 30_000;
const SCHEDULER_LOCK_KEY = 'scheduler:agent';
const SCHEDULER_LOCK_TTL_SECONDS = 5 * 60;
const SCHEDULE_ACTOR = 'system:agent-scheduler';

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let running = false;

/**
 * Fires currently in flight, keyed `${agentId}:${scheduleId}`.
 *
 * An agent run is not a crawl: it can take minutes, and the tick that started
 * it will come round again long before it finishes. Without this an hourly
 * schedule whose run takes 90 seconds is fine, but a five-minute schedule whose
 * run takes six minutes quietly turns into an unbounded fan-out.
 */
const inFlight = new Set<string>();

async function runOnce(): Promise<void> {
    if (running) return;
    running = true;

    let lockToken: string | undefined;

    try {
        const cache = await getCache();
        lockToken = await cache.acquireLock(SCHEDULER_LOCK_KEY, SCHEDULER_LOCK_TTL_SECONDS);
        const holdsGlobalLock = Boolean(lockToken);
        const thisNode = getThisNodeName();
        const defaultNode = await resolveDefaultNodeName();

        const mainDb = await getDatabase();
        const tenants = await mainDb.listTenants();

        for (const tenant of tenants) {
            if (!tenant.dbName) continue;

            try {
                await runWithTenantScope(tenant.dbName, async (tenantDb) => {
                    const tenantId = String(tenant._id);
                    // Every agent in the tenant: schedules are per-project but the
                    // scheduler runs tenant-wide, and `listAgents` scopes by
                    // project, not tenant.
                    const agents = await tenantDb.listAgents();
                    const now = new Date();

                    for (const agent of agents) {
                        if (agent.status !== 'active') continue;
                        // Never published means there is no immutable config to
                        // run. Firing the draft would make a scheduled job change
                        // behaviour the moment somebody opened the playground.
                        if (!agent.publishedVersion) continue;

                        const due = readSchedules(agent).filter((schedule) => isDue(schedule, now));
                        if (due.length === 0) continue;

                        const assignment = await findInstanceAssignment(
                            'agent',
                            agentEntityId(tenantId, agent.key),
                        );
                        const target = assignment?.nodeName ?? defaultNode;
                        if (assignment ? target !== thisNode : !holdsGlobalLock) continue;

                        for (const schedule of due) {
                            const fireKey = `${String(agent._id)}:${schedule.id}`;
                            if (inFlight.has(fireKey)) {
                                logger.warn('Skipping fire: previous run still in flight', {
                                    agentKey: agent.key,
                                    schedule: schedule.name,
                                });
                                continue;
                            }
                            void dispatch(tenant.dbName!, tenantId, agent, schedule, fireKey);
                        }
                    }
                });
            } catch (err) {
                logger.error(`Error processing tenant ${tenant.slug}`, {
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('Fatal scheduler error', { error: message });
        throw err;
    } finally {
        if (lockToken) {
            try {
                const cache = await getCache();
                await cache.releaseLock(SCHEDULER_LOCK_KEY, lockToken);
            } catch (err) {
                logger.warn('Failed to release scheduler lock', {
                    error: err instanceof Error ? err.message : err,
                });
            }
        }
        running = false;
    }
}

/**
 * Runs one fire without blocking the tick.
 *
 * The outcome is written back in `finally`, including on failure: a schedule
 * whose run throws must still advance its `nextRunAt`, or the next tick finds
 * it due again and retries forever at 30-second intervals.
 */
async function dispatch(
    tenantDbName: string,
    tenantId: string,
    agent: IAgent,
    schedule: IAgentSchedule,
    fireKey: string,
): Promise<void> {
    inFlight.add(fireKey);
    const at = new Date();
    let status: 'ok' | 'error' = 'ok';
    let error: string | undefined;
    let conversationId: string | undefined;

    try {
        const result = await runAgentSchedule({
            tenantDbName,
            tenantId,
            projectId: agent.projectId,
            agent,
            schedule,
            trigger: 'schedule',
            userId: SCHEDULE_ACTOR,
        });
        conversationId = result.conversationId;
        logger.info('Scheduled agent run completed', {
            agentKey: agent.key,
            schedule: schedule.name,
            conversationId,
        });
    } catch (err) {
        status = 'error';
        error = err instanceof Error ? err.message : String(err);
        logger.error('Scheduled agent run failed', {
            agentKey: agent.key,
            schedule: schedule.name,
            error,
        });
    } finally {
        inFlight.delete(fireKey);
        try {
            await recordScheduleRun(tenantDbName, String(agent._id), schedule.id, {
                at,
                status,
                error,
                conversationId,
            });
        } catch (err) {
            // The run itself succeeded or failed on its own terms; losing the
            // bookkeeping write must not be reported as a run failure.
            logger.error('Failed to record schedule outcome', {
                agentKey: agent.key,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
}

export function startAgentScheduler(): void {
    if (schedulerTimer !== null) return;
    logger.info(`Started (check interval: ${CHECK_INTERVAL_MS / 1000}s)`);
    void runOnce();
    schedulerTimer = setInterval(() => {
        void runOnce();
    }, CHECK_INTERVAL_MS);
    if (schedulerTimer.unref) schedulerTimer.unref();
}
