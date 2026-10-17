/**
 * Matching a chat-completions client back to its session by its transcript.
 *
 * The wire is stateless: a client resends the whole conversation on every call and has no idea a session
 * exists. After each turn the session remembers a digest of what that client now holds (its messages, minus
 * the system/developer ones the agent ignores, plus the answer it was given). A request whose messages before
 * its last user message digest to a remembered value is the next turn of that session; any other request
 * starts a new one. Scoped to project, agent and the person who started the session.
 *
 * The digest covers role and text only (images, ids and extra fields differ between clients and resends),
 * trimmed, so a client that re-serializes its history still matches.
 */

import crypto from 'node:crypto';
import { createLogger } from '@/lib/core/logger';
import { runWithTenantDb } from './agentRunService';

const logger = createLogger('agents:chat-transcript');

interface ChatMessageLike {
    role?: unknown;
    content?: unknown;
}

/** Roles the agent ignores (it owns its system prompt), so they never take part in a transcript digest. */
const IGNORED_ROLES = new Set(['system', 'developer']);

function textOf(content: unknown): string {
    if (typeof content === 'string') return content.trim();
    if (!Array.isArray(content)) return '';
    return content
        .map((part) => {
            if (typeof part === 'string') return part;
            const record = part as { type?: unknown; text?: unknown } | null;
            return record && (record.type === 'text' || record.type === 'input_text') && typeof record.text === 'string' ? record.text : '';
        })
        .filter((text) => text !== '')
        .join('\n\n')
        .trim();
}

function digestOf(messages: ChatMessageLike[]): string {
    const canonical = messages
        .filter((message) => typeof message?.role === 'string' && !IGNORED_ROLES.has(message.role))
        .map((message) => ({ role: message.role, content: textOf(message.content) }));
    return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** The digest a session remembers after a turn: the request's messages and the answer it got. */
export function transcriptDigestAfterTurn(messages: ChatMessageLike[], answer: string): string {
    return digestOf([...messages, { role: 'assistant', content: answer }]);
}

/**
 * The digest of what a request says came before its last user message, or null when nothing did (a first
 * turn: there is nothing to match).
 */
export function priorTranscriptDigest(messages: ChatMessageLike[] | undefined): string | null {
    if (!Array.isArray(messages)) return null;
    let last = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index]?.role === 'user') { last = index; break; }
    }
    const prior = messages.slice(0, Math.max(last, 0)).filter((message) => typeof message?.role === 'string' && !IGNORED_ROLES.has(message.role as string));
    return prior.length > 0 ? digestOf(prior) : null;
}

/** The id of the caller's session whose last turn left the transcript `messages` continue, if any. */
export async function findChatTranscriptSessionId(
    tenantDbName: string,
    scope: { projectId: string; agentKey: string; userId: string },
    messages: ChatMessageLike[] | undefined,
): Promise<string | null> {
    const transcriptHash = priorTranscriptDigest(messages);
    if (!transcriptHash) return null;
    const found = await runWithTenantDb(tenantDbName, (db) => db.findAgentConversationByTranscriptHash({ ...scope, createdBy: scope.userId, transcriptHash }));
    return found?._id ? String(found._id) : null;
}

/** Remembers the transcript a client holds after a turn. Best effort: the answer is already on its way. */
export async function rememberChatTranscript(
    tenantDbName: string,
    conversationId: string,
    messages: ChatMessageLike[] | undefined,
    answer: string,
): Promise<void> {
    if (!Array.isArray(messages) || !answer) return;
    try {
        await runWithTenantDb(tenantDbName, (db) => db.updateAgentConversationRuntime(conversationId, { transcriptHash: transcriptDigestAfterTurn(messages, answer) }));
    } catch (error) {
        logger.warn('Could not remember the chat transcript of a session', { conversationId, error: error instanceof Error ? error.message : String(error) });
    }
}
