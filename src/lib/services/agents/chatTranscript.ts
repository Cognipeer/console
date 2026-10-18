/**
 * Matching a chat-completions client back to its session by its transcript.
 *
 * The wire is stateless: a client resends the whole conversation on every call and has no idea a session
 * exists. After each turn the session remembers a digest of what that client now holds (its messages, minus
 * the system/developer ones the agent ignores, plus the answer it was given). A request whose messages before
 * its last user message digest to a remembered value is the next turn of that session; any other request
 * starts a new one. Scoped to project, agent and the person who started the session; a digest that more than
 * one of that person's sessions holds is ambiguous and starts a new session too (one application token serves
 * many end users, and two of them can say the same thing).
 *
 * The digest covers role, text (trimmed, so a client that re-serializes its history still matches) and what
 * names the files and images a message carries (a file id, an image URL, a digest of inline data), plus the
 * OpenAI `user` field when the request sends one. Other fields differ between clients and resends.
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

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

/** Inline data (`data:` URLs, base64) by its digest; a URL or an id as it is. */
const referenceOf = (value: string) => (value.startsWith('data:') || value.length > 512 ? `sha256:${sha256(value)}` : value);

/** What names the files and images of a message's content parts, in order. */
function attachmentRefsOf(content: unknown): string[] {
    if (!Array.isArray(content)) return [];
    const refs: string[] = [];
    for (const part of content) {
        if (!part || typeof part !== 'object') continue;
        const record = part as Record<string, unknown>;
        // Chat nests a file under `file`; the Responses spelling keeps the fields on the part.
        const spec = record.type === 'file' && record.file && typeof record.file === 'object' ? record.file as Record<string, unknown> : record;
        const image = record.image_url && typeof record.image_url === 'object' ? (record.image_url as { url?: unknown }).url : record.image_url;
        for (const value of [spec.file_id, spec.file_data, spec.file_url, image]) {
            if (typeof value === 'string' && value !== '') refs.push(referenceOf(value));
        }
    }
    return refs;
}

function digestOf(messages: ChatMessageLike[], user?: string): string {
    const canonical = messages
        .filter((message) => typeof message?.role === 'string' && !IGNORED_ROLES.has(message.role))
        .map((message) => {
            const refs = attachmentRefsOf(message.content);
            // A text-only message digests as it always did.
            return refs.length > 0 ? { role: message.role, content: textOf(message.content), refs } : { role: message.role, content: textOf(message.content) };
        });
    return sha256(JSON.stringify(user ? { user, messages: canonical } : canonical));
}

/** The digest a session remembers after a turn: the request's messages and the answer it got (and its `user`). */
export function transcriptDigestAfterTurn(messages: ChatMessageLike[], answer: string, user?: string): string {
    return digestOf([...messages, { role: 'assistant', content: answer }], user);
}

/**
 * The digest of what a request says came before its last user message, or null when nothing did (a first
 * turn: there is nothing to match).
 */
export function priorTranscriptDigest(messages: ChatMessageLike[] | undefined, user?: string): string | null {
    if (!Array.isArray(messages)) return null;
    let last = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index]?.role === 'user') { last = index; break; }
    }
    const prior = messages.slice(0, Math.max(last, 0)).filter((message) => typeof message?.role === 'string' && !IGNORED_ROLES.has(message.role as string));
    return prior.length > 0 ? digestOf(prior, user) : null;
}

/**
 * The id of the caller's session whose last turn left the transcript `messages` continue, if exactly one
 * does: null when none does, and when several do (which one is meant cannot be told, so a new one starts).
 */
export async function findChatTranscriptSessionId(
    tenantDbName: string,
    scope: { projectId: string; agentKey: string; userId: string },
    messages: ChatMessageLike[] | undefined,
    /** The request's OpenAI `user` field, when it sends one. */
    user?: string,
): Promise<string | null> {
    const transcriptHash = priorTranscriptDigest(messages, user);
    if (!transcriptHash) return null;
    const found = await runWithTenantDb(tenantDbName, (db) => db.findAgentConversationsByTranscriptHash({ ...scope, createdBy: scope.userId, transcriptHash }, 2));
    return found.length === 1 && found[0]?._id ? String(found[0]._id) : null;
}

/** Remembers the transcript a client holds after a turn. Best effort: the answer is already on its way. */
export async function rememberChatTranscript(
    tenantDbName: string,
    conversationId: string,
    messages: ChatMessageLike[] | undefined,
    answer: string,
    /** The request's OpenAI `user` field, when it sent one. */
    user?: string,
): Promise<void> {
    if (!Array.isArray(messages) || !answer) return;
    try {
        await runWithTenantDb(tenantDbName, (db) => db.updateAgentConversationRuntime(conversationId, { transcriptHash: transcriptDigestAfterTurn(messages, answer, user) }));
    } catch (error) {
        logger.warn('Could not remember the chat transcript of a session', { conversationId, error: error instanceof Error ? error.message : String(error) });
    }
}
