/**
 * CRUD and execution for agent schedules.
 *
 * Schedules ride on `agent.metadata.schedules`. That keeps the feature to one
 * collection and makes a schedule part of the agent's own record — which also
 * means it travels with the agent through export/import without a second
 * migration path.
 */

import { randomUUID } from 'node:crypto';

import { getDatabase } from '@/lib/database';
import type { IAgent, IAgentSchedule } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import { computeNextRun, validateSchedule } from '@/lib/services/crawler/schedulePlanner';

import { createConversation, executeAgentChat } from './agentService';

const logger = createLogger('agent-schedule');

/** Timing fields shared with `ICrawlerSchedule`, as the planner expects them. */
function timingOf(schedule: IAgentSchedule) {
    return {
        mode: schedule.mode,
        enabled: schedule.enabled,
        intervalSeconds: schedule.intervalSeconds,
        cron: schedule.cron,
        startAt: schedule.startAt,
        endAt: schedule.endAt,
        lastRunAt: schedule.lastRunAt,
        nextRunAt: schedule.nextRunAt,
    };
}

export function computeScheduleNextRun(schedule: IAgentSchedule, from: Date = new Date()): Date | null {
    return computeNextRun(timingOf(schedule), from);
}

export function validateAgentSchedule(schedule: IAgentSchedule): string | null {
    if (!schedule.name?.trim()) return 'name is required';
    if (!schedule.message?.trim()) return 'message is required';
    return validateSchedule(timingOf(schedule));
}

export function readSchedules(agent: Pick<IAgent, 'metadata'>): IAgentSchedule[] {
    const raw = (agent.metadata as { schedules?: unknown } | undefined)?.schedules;
    return Array.isArray(raw) ? (raw as IAgentSchedule[]) : [];
}

async function writeSchedules(
    tenantDbName: string,
    agent: IAgent,
    schedules: IAgentSchedule[],
    userId: string,
): Promise<IAgentSchedule[]> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    // Merge into the existing metadata rather than replacing it: `metadata.a2a`
    // lives in the same object, and a schedule edit must not unpublish an agent.
    await db.updateAgent(String(agent._id), {
        metadata: { ...(agent.metadata ?? {}), schedules },
        updatedBy: userId,
    });
    return schedules;
}

export type AgentScheduleInput = Omit<
    IAgentSchedule,
    'id' | 'lastRunAt' | 'nextRunAt' | 'lastStatus' | 'lastError' | 'lastConversationId' | 'createdAt' | 'createdBy'
> & { id?: string };

export async function upsertAgentSchedule(
    tenantDbName: string,
    agent: IAgent,
    input: AgentScheduleInput,
    userId: string,
): Promise<{ schedules: IAgentSchedule[]; schedule: IAgentSchedule }> {
    const existing = readSchedules(agent);
    const index = input.id ? existing.findIndex((entry) => entry.id === input.id) : -1;
    const previous = index >= 0 ? existing[index] : undefined;

    const schedule: IAgentSchedule = {
        ...previous,
        ...input,
        id: previous?.id ?? input.id ?? randomUUID(),
        createdBy: previous?.createdBy ?? userId,
        createdAt: previous?.createdAt ?? new Date(),
    };

    const error = validateAgentSchedule(schedule);
    if (error) throw new Error(error);

    // Recomputed on every write so the UI's "next run" is never stale after an
    // edit — a cron change that left the old nextRunAt in place would fire once
    // more on the old schedule before correcting itself.
    schedule.nextRunAt = computeScheduleNextRun(schedule) ?? undefined;

    const next = [...existing];
    if (index >= 0) next[index] = schedule;
    else next.push(schedule);

    await writeSchedules(tenantDbName, agent, next, userId);
    return { schedules: next, schedule };
}

export async function deleteAgentSchedule(
    tenantDbName: string,
    agent: IAgent,
    scheduleId: string,
    userId: string,
): Promise<IAgentSchedule[]> {
    const next = readSchedules(agent).filter((entry) => entry.id !== scheduleId);
    await writeSchedules(tenantDbName, agent, next, userId);
    return next;
}

export interface RunScheduleContext {
    tenantDbName: string;
    tenantId: string;
    projectId: string;
    agent: IAgent;
    schedule: IAgentSchedule;
    /** 'schedule' for the timer, 'manual' for a Run-now from the UI. */
    trigger: 'schedule' | 'manual';
    userId: string;
}

export interface ScheduleRunResult {
    conversationId: string;
    content: string;
}

/**
 * Executes one fire of a schedule.
 *
 * Each fire gets its own conversation. A scheduled agent that appended to one
 * long conversation would carry every previous night's context into tonight's
 * run — and would hit the context limit on a timescale nobody is watching.
 *
 * The run always uses the PUBLISHED config. A scheduled job reading the draft
 * would change behaviour the moment somebody opened the playground.
 */
export async function runAgentSchedule(ctx: RunScheduleContext): Promise<ScheduleRunResult> {
    const conversation = await createConversation(
        ctx.tenantDbName,
        ctx.tenantId,
        ctx.projectId,
        ctx.userId,
        ctx.agent.key,
        `${ctx.schedule.name} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
        { source: 'schedule' },
    );

    const response = await executeAgentChat({
        tenantDbName: ctx.tenantDbName,
        tenantId: ctx.tenantId,
        projectId: ctx.projectId,
        agentKey: ctx.agent.key,
        conversationId: String(conversation._id),
        userMessage: ctx.schedule.message,
        userId: ctx.userId,
        usePublished: true,
        runtimeContext: {
            source: 'api',
            userId: ctx.userId,
            // Schedule variables reach the prompt through exactly the same path
            // a live caller's metadata does, so a prompt cannot behave one way
            // on a schedule and another way in production.
            metadata: {
                ...(ctx.schedule.variables ?? {}),
                scheduleId: ctx.schedule.id,
                scheduleName: ctx.schedule.name,
                trigger: ctx.trigger,
            },
        },
    });

    return {
        conversationId: String(conversation._id),
        content: extractResponseText(response),
    };
}

/** Records the outcome of a fire back onto the schedule. */
export async function recordScheduleRun(
    tenantDbName: string,
    agentId: string,
    scheduleId: string,
    outcome: { at: Date; status: 'ok' | 'error'; error?: string; conversationId?: string },
): Promise<void> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    // Re-read rather than reusing the caller's copy: a run can outlive the tick
    // that started it, and writing a stale metadata object back would drop any
    // schedule added in between.
    const fresh = await db.findAgentById(agentId);
    if (!fresh) return;

    const schedules = readSchedules(fresh).map((entry) => {
        if (entry.id !== scheduleId) return entry;
        const updated: IAgentSchedule = {
            ...entry,
            lastRunAt: outcome.at,
            lastStatus: outcome.status,
            lastError: outcome.status === 'error' ? outcome.error : undefined,
            lastConversationId: outcome.conversationId ?? entry.lastConversationId,
        };
        updated.nextRunAt = computeScheduleNextRun(updated, outcome.at) ?? undefined;
        return updated;
    });

    await db.updateAgent(agentId, { metadata: { ...(fresh.metadata ?? {}), schedules } });
}

function extractResponseText(response: unknown): string {
    const payload = response as { output?: Array<{ content?: Array<{ text?: string }> }> } | undefined;
    const text = payload?.output?.[0]?.content?.[0]?.text;
    if (typeof text === 'string') return text;
    logger.debug('Scheduled run produced no extractable text');
    return '';
}
