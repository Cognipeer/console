/**
 * The agent session a trace belongs to.
 *
 * An agent turn records its trace under a thread whose id is the conversation's
 * id (`tracing.threadId = conversationId`). A recorded message that carries a
 * picture from the session's Files names it by reference (`session-file://<id>`),
 * so the tracing inspector needs the agent and the session to draw it from the
 * session's content route.
 *
 * This only names them: it says nothing about what the viewer may open. The
 * content route does that check again, and a refusal there is what makes the
 * inspector fall back to the file's name.
 */

import type { IAgent, IAgentConversation } from '@/lib/database';
import { getAgentByKey, getConversationById } from './agentService';

export interface TraceSessionRef {
    /** The agent's id — the `:agentId` of the dashboard's session routes. */
    agentId: string;
    /** The conversation's id — the `:sessionId` of the same routes. */
    sessionId: string;
}

export interface TraceSessionLookups {
    getConversationById: (tenantDbName: string, conversationId: string) => Promise<IAgentConversation | null>;
    getAgentByKey: (tenantDbName: string, key: string, projectId?: string) => Promise<IAgent | null>;
}

/**
 * The session `threadId` names, or null when the thread is not one of this
 * project's agent sessions (an API caller's own thread id, another project's
 * session, an agent that is gone).
 */
export async function resolveTraceSession(
    input: { tenantDbName: string; projectId: string; threadId: string },
    lookups: TraceSessionLookups = { getConversationById, getAgentByKey },
): Promise<TraceSessionRef | null> {
    let conversation: IAgentConversation | null = null;
    try {
        conversation = await lookups.getConversationById(input.tenantDbName, input.threadId);
    } catch {
        // Not an id of this store's shape: not a session.
        return null;
    }
    if (!conversation || conversation.projectId !== input.projectId) return null;

    const agent = await lookups.getAgentByKey(input.tenantDbName, conversation.agentKey, input.projectId);
    if (!agent) return null;
    return { agentId: String(agent._id), sessionId: String(conversation._id) };
}
