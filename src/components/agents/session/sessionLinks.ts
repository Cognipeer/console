/**
 * Where a session is opened from a link. The chat page only takes sessions
 * started from the console; everything else — and any link that cannot tell
 * which kind it holds — goes to the inspector, which is the agent's Sessions
 * tab with that session's drawer open.
 */

/** The query parameter that opens a session's inspector on the agent page. */
export const SESSION_QUERY_PARAM = 'session';

/** The inspector of one session. */
export function sessionInspectorHref(agentId: string, sessionId: string): string {
    return `/dashboard/agents/${encodeURIComponent(agentId)}?tab=sessions&${SESSION_QUERY_PARAM}=${encodeURIComponent(sessionId)}`;
}
