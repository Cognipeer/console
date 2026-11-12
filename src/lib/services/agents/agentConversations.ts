/**
 * Agent conversation records: create, read, list and delete.
 */

import { type IAgentSessionBudget, type IAgentConversation, getDatabase } from '@/lib/database';
import { agentSessionBudget, withSessionSpend } from './sessionBudget';
import { normalizeStaleRunningStatus, normalizeStaleRunningStatuses } from './sessionRuntime';
import { destroyConversationSandbox } from './agentSandboxTools';
import { deleteConversationFiles } from './sessionFiles';

// ── Conversation CRUD ────────────────────────────────────────────────

/**
 * Where a conversation came from, stored as `metadata.source`. Only
 * `console` sessions — the ones a person started from the dashboard to try the
 * agent — can be continued from the UI; the rest are real traffic (or a
 * run's own bookkeeping) and are shown read-only. Records written before this
 * existed carry no source. `portal` is end-user traffic through an enterprise
 * portal page (/p/<key>): real usage, so read-only in the Studio like the rest.
 */
export type AgentConversationSource = 'console' | 'api' | 'a2a' | 'trigger' | 'evaluation' | 'redteam' | 'portal' | 'slack' | 'teams';

export async function createConversation(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    userId: string,
    agentKey: string,
    title?: string,
    /** Session-level context — applied to every turn, see `executePlaygroundChatLocal`. */
    metadata?: Record<string, unknown>,
    /**
     * The session's spend budget. Absent = the agent's own default
     * (`config.budget`); `null` = none, whatever the agent's default.
     */
    budget?: IAgentSessionBudget | null,
): Promise<IAgentConversation> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);

    const sessionBudget = budget === undefined
        ? agentSessionBudget((await db.findAgentByKey(agentKey, projectId))?.config)
        : budget ?? undefined;

    return db.createAgentConversation({
        tenantId,
        projectId,
        agentKey,
        title: title || 'New conversation',
        messages: [],
        ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
        ...(sessionBudget ? { budget: sessionBudget, spentUsd: 0 } : {}),
        createdBy: userId,
    });
}

export async function getConversationById(
    tenantDbName: string,
    conversationId: string,
): Promise<IAgentConversation | null> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    const conversation = await db.findAgentConversationById(conversationId);
    // A "running" session whose turn died (process crash) reads as ended.
    return conversation ? withSessionSpend(await normalizeStaleRunningStatus(db, conversation)) : null;
}

export async function listConversations(
    tenantDbName: string,
    agentKey: string,
    filters?: { projectId?: string; limit?: number; skip?: number; createdBy?: string },
): Promise<IAgentConversation[]> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    return normalizeStaleRunningStatuses(db, await db.listAgentConversations(agentKey, filters));
}

export async function deleteConversation(
    tenantDbName: string,
    conversationId: string,
): Promise<boolean> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    // A persistent agent sandbox belongs to its conversation and goes with it.
    const conversation = await db.findAgentConversationById(conversationId);
    if (conversation?.metadata?.sandbox) {
        await destroyConversationSandbox({ tenantDbName, tenantId: conversation.tenantId, conversation });
    }
    // So do the files attached to it (object, markdown and row).
    if (conversation) await deleteConversationFiles(tenantDbName, conversation);
    return db.deleteAgentConversation(conversationId);
}
