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
import { getDatabase, type AgentSessionRuntimeStatus, type IAgentConversationActivityRow, type IAgentConversationListItem } from '@/lib/database';
import { normalizeStaleRunningStatus, normalizeStaleRunningStatuses } from './sessionRuntime';

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
        // A finite number can still be no date at all (1e20): the databases would choke on it, so it is no cursor.
        const date = new Date(createdAt);
        if (Number.isNaN(date.getTime())) return null;
        return { createdAt: date, id };
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

/**
 * The dashboard's cross-agent Sessions list pages by last activity (`updatedAt`), not by creation, so a
 * session that just ran moves to the top; its cursor is the (updatedAt, id) of the last row.
 */
export function encodeActivityCursor(row: { updatedAt?: Date | string; _id?: unknown }): string {
    const updatedAt = row.updatedAt ? new Date(row.updatedAt).getTime() : 0;
    return Buffer.from(JSON.stringify([updatedAt, String(row._id)]), 'utf8').toString('base64url');
}

/** The keyset an activity cursor stands for, or null when it is not one this service issued. */
export function decodeActivityCursor(cursor: string): { updatedAt: Date; id: string } | null {
    const keyset = decodeSessionCursor(cursor);
    return keyset ? { updatedAt: keyset.createdAt, id: keyset.id } : null;
}

export interface ProjectSessionFilters {
    projectId: string;
    /** Only sessions in one of these states (an empty list matches nothing; 'idle' also matches one that never ran). */
    runtimeStatuses?: AgentSessionRuntimeStatus[];
    /** Only these sessions (an empty list matches nothing). */
    ids?: string[];
    /** The caller may view other people's sessions of only these agents (none when no keys). */
    ownOnly?: { userId: string; viewableAgentKeys?: string[] };
    before?: { updatedAt: Date; id: string };
    limit: number;
    /** Ids of sessions with a queued or running run: their "running" status is not questioned (no stale-run lookup). */
    knownInFlight?: ReadonlySet<string>;
}

/** A page of a project's sessions as summary rows (message tallies, never transcripts), most recently active first. */
export async function listProjectSessions(
    tenantDbName: string,
    filters: ProjectSessionFilters,
): Promise<{ sessions: IAgentConversationActivityRow[]; hasMore: boolean; nextCursor?: string }> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    // Not a provider filter.
    const { knownInFlight, ...query } = filters;
    // One more than asked, to know whether there is a next page.
    const rows = await db.listProjectAgentConversations({ ...query, limit: filters.limit + 1 });
    const hasMore = rows.length > filters.limit;
    const page = rows.slice(0, filters.limit);
    // A "running" row whose turn died reads as ended, like everywhere else a session's state is read - except one
    // the caller knows has a run in flight, which needs no lookup.
    const sessions = await Promise.all(page.map((row) => (
        knownInFlight?.has(String(row._id)) ? row : normalizeStaleRunningStatus(db, row)
    )));
    const last = page[page.length - 1];
    return { sessions, hasMore, ...(hasMore && last ? { nextCursor: encodeActivityCursor(last) } : {}) };
}
