/**
 * The id of a message in an agent session: what a client names when it rates an answer.
 * Pure (a hash), so the response of a turn and the feedback route agree on it without a lookup.
 */

import { createHash } from 'node:crypto';
import type { IAgentConversationMessage } from '@/lib/database/provider/types.domain';

/**
 * The stable id of the message at `index`. An explicit `id` on the message wins;
 * otherwise it is derived from where and when the message was written — the same
 * for every reader, and different for a message that replaces it after a
 * regenerate (new timestamp).
 */
export function messageIdOf(conversationId: string, index: number, message: Pick<IAgentConversationMessage, 'id' | 'timestamp'> | undefined): string {
    if (message?.id) return message.id;
    const ms = message?.timestamp ? new Date(message.timestamp as unknown as string | Date).getTime() : 0;
    const digest = createHash('sha256').update(`${conversationId}|${index}|${Number.isFinite(ms) ? ms : 0}`).digest('hex').slice(0, 20);
    return `msg_${digest}`;
}

