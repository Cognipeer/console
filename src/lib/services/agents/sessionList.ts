/**
 * A page of a project's agent sessions for the client API (`GET
 * /client/v1/agents/sessions`): newest created first, optionally one agent's or
 * one runtime status, with an opaque cursor to the next page.
 *
 * The cursor is the (createdAt, id) of the last row, so a session created while
 * the client pages through never shifts a row into or out of a page it has
 * already read. A row comes back without its transcript — only how many
 * messages it holds.
 */

import { Buffer } from 'node:buffer';
import { getDatabase, type AgentSessionRuntimeStatus, type IAgentConversationListItem } from '@/lib/database';
import { normalizeStaleRunningStatuses } from './sessionRuntime';

export const SESSION_LIST_DEFAULT_LIMIT = 20;
export const SESSION_LIST_MAX_LIMIT = 100;
export const SESSION_RUNTIME_STATUSES: readonly AgentSessionRuntimeStatus[] = ['idle', 'running', 'requires_action', 'budget_paused'];

export function encodeSessionCursor(row: Pick<IAgentConversationListItem, 'createdAt'> & { _id?: unknown }): string {
    const createdAt = row.createdAt ? new Date(row.createdAt).getTime() : 0;
    return Buffer.from(JSON.stringify([createdAt, String(row._id)]), 'utf8').toString('base64url');
}

/** The keyset a cursor stands for, or null when it is not one this service issued. */
export function decodeSessionCursor(cursor: string): { createdAt: Date; id: string } | null {
    try {
        const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (!Array.isArray(parsed) || parsed.length !== 2) return null;
        const [createdAt, id] = parsed as [unknown, unknown];
        if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || typeof id !== 'string' || id.length === 0 || id.length > 128) {
            return null;
        }
        return { createdAt: new Date(createdAt), id };
    } catch {
        return null;
    }
}

export interface SessionListFilters {
    projectId: string;
    agentKey?: string;
    status?: AgentSessionRuntimeStatus;
    limit: number;
    after?: { createdAt: Date; id: string };
    /** The caller may view other people's sessions of only these agents (none when no keys): of any other agent only their own are listed. */
    ownOnly?: { userId: string; viewableAgentKeys?: string[] };
}

export interface SessionListPage {
    sessions: IAgentConversationListItem[];
    hasMore: boolean;
    nextCursor?: string;
}

export async function listSessionPage(tenantDbName: string, filters: SessionListFilters): Promise<SessionListPage> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    // One more than asked, to know whether there is a next page.
    const rows = await db.listAgentConversationPage({
        projectId: filters.projectId,
        ...(filters.agentKey ? { agentKey: filters.agentKey } : {}),
        ...(filters.status ? { runtimeStatus: filters.status } : {}),
        limit: filters.limit + 1,
        ...(filters.after ? { after: filters.after } : {}),
        ...(filters.ownOnly ? { ownOnly: filters.ownOnly } : {}),
    });
    const hasMore = rows.length > filters.limit;
    const page = rows.slice(0, filters.limit);
    // A "running" row whose turn died reads as ended, like everywhere else a session's state is read.
    const sessions = await normalizeStaleRunningStatuses(db, page);
    const last = page[page.length - 1];
    return { sessions, hasMore, ...(hasMore && last ? { nextCursor: encodeSessionCursor(last) } : {}) };
}
