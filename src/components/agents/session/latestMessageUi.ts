/**
 * The newest message of a session, for the bar pinned above the transcript.
 *
 * A long run is one turn with hundreds of tool rows: what the agent last SAID
 * sits somewhere above the trailing calls, or under a page of steps, and
 * scrolling for it is the slow part of reading a session. The bar shows that
 * message at the top and jumps to it.
 *
 * "Message" means text someone wrote: the running turn's newest text, else the
 * newest stored message with text (an answer, the narration between tool calls,
 * a user message, a failure). A turn with no text at all is skipped, so the bar
 * never shows an empty message; its time says how recent the shown one is.
 */

import { reminderOfMessage } from '../studio/reminderUi';
import type { LiveSegment } from './liveFlow';
import type { ChatMessage } from './sessionTypes';

/** Anchor on the running turn's newest text block. */
export const LIVE_LATEST_ANCHOR_ID = 'agent-session-latest-live';

/** Anchor on the newest message in the read-only session inspector. */
export const INSPECTOR_LATEST_ANCHOR_ID = 'agent-inspector-latest';

/** Anchor on a stored answer's text (the part after the turn's steps). */
export function answerAnchorId(messageIndex: number): string {
    return `agent-session-answer-${messageIndex}`;
}

export interface LatestMessageView {
    /** The text comes from the turn that is running now. */
    live: boolean;
    role: 'agent' | 'user' | 'error';
    text: string;
    /** When a stored message was written; none for live text. */
    timestamp?: string;
    /** The stored message's place on screen: the jump falls back to its turn when there is no anchor. */
    messageIndex?: number;
    /** Where the jump lands: the start of the text itself, when it has its own anchor. */
    anchorId?: string;
}

function lastNarration(message: ChatMessage): string {
    const steps = message.steps ?? [];
    for (let i = steps.length - 1; i >= 0; i -= 1) {
        const narration = steps[i]?.narration?.trim();
        if (narration) return narration;
    }
    return '';
}

export function latestMessageOf({
    messages,
    liveSegments,
    liveActive,
    followedUserText,
}: {
    messages: ReadonlyArray<ChatMessage>;
    liveSegments: ReadonlyArray<LiveSegment>;
    liveActive: boolean;
    /** The user message that started a followed turn (not yet in `messages`). */
    followedUserText?: string | null;
}): LatestMessageView | null {
    if (liveActive) {
        for (let i = liveSegments.length - 1; i >= 0; i -= 1) {
            const segment = liveSegments[i];
            if (segment.kind === 'text' && segment.text.trim()) {
                return { live: true, role: 'agent', text: segment.text.trim(), anchorId: LIVE_LATEST_ANCHOR_ID };
            }
        }
        if (followedUserText?.trim()) return { live: true, role: 'user', text: followedUserText.trim() };
    }

    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        const timestamp = message.timestamp ? { timestamp: message.timestamp } : {};
        if (message.role === 'assistant') {
            const answer = message.content?.trim() ?? '';
            if (answer) return { live: false, role: 'agent', text: answer, ...timestamp, messageIndex: i, anchorId: answerAnchorId(i) };
            const narration = lastNarration(message);
            if (narration) return { live: false, role: 'agent', text: narration, ...timestamp, messageIndex: i };
            continue;
        }
        if (message.role === 'user') {
            const text = (reminderOfMessage(message)?.message ?? message.content ?? '').trim();
            if (text) return { live: false, role: 'user', text, ...timestamp, messageIndex: i };
            continue;
        }
        if (message.role === 'error') {
            const text = message.content?.trim() ?? '';
            if (text) return { live: false, role: 'error', text, ...timestamp, messageIndex: i };
        }
    }
    return null;
}

/** Markdown read as one line of plain text, cut at `max` characters: the bar's folded preview. */
export function previewText(text: string, max = 280): string {
    const plain = text
        .replace(/```[^\n]*\n?/g, ' ')
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
        .replace(/(\*\*|__|\*|~~|`)/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}
