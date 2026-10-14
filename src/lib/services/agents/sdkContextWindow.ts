/**
 * Which of the saved messages the agent SDK will actually send to the model.
 *
 * The SDK keeps the whole conversation in its state but builds every model
 * request from a WINDOW of it (`buildModelMessages` in agent-sdk): the system
 * message, the first user message, and the latest `context.lastTurnsToKeep`
 * turns. A picture that sits in an older message is still in the saved state
 * and never reaches the model again.
 *
 * `attachments.carryRecentImages` re-shows the person's recent pictures with
 * the new message when "the history no longer holds them". Asked of the whole
 * saved list that is the wrong question — the list holds the picture long after
 * the window dropped it (16-turn retest: the image was attached at turn 2 and
 * was gone from the request at turn 12 while the state still carried it). This
 * module answers it for the window.
 *
 * It mirrors the SDK's selection rules (`collectRecentTurns`,
 * `collectSummaryOnlyBody`) and nothing else: the token clamp
 * (`maxContextTokens`) is not modelled, because a picture reference weighs a
 * few tokens and the clamp removes the oldest messages first anyway. If the SDK
 * exports its own selector one day, this file is the one to replace.
 */

import type { ContextPolicy } from '@cognipeer/agent-sdk';

type WindowMessage = { role?: unknown; name?: unknown; tool_calls?: unknown };

export interface SdkContextWindowOptions {
    /** `runtime.context.policy`. */
    policy: ContextPolicy;
    /** `runtime.context.lastTurnsToKeep`. */
    lastTurnsToKeep: number;
    /** The state carries a context summary (`summaryRecords` is not empty); only `summary_only` cares. */
    hasSummary?: boolean;
}

function isSyntheticSummary(message: WindowMessage): boolean {
    if (message.role === 'tool' && message.name === 'summarize_context') return true;
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
        return (message.tool_calls as Array<{ function?: { name?: string }; name?: string }>)
            .some((call) => (call?.function?.name || call?.name) === 'summarize_context');
    }
    return false;
}

/** The latest `lastTurnsToKeep` turns, plus the first user message and the leading system message. */
function collectRecentTurns<T extends WindowMessage>(messages: readonly T[], lastTurnsToKeep: number): T[] {
    if (lastTurnsToKeep <= 0) return [];
    const systemPrefix = messages.length > 0 && messages[0]!.role === 'system' ? [messages[0]!] : [];
    const body = systemPrefix.length > 0 ? messages.slice(1) : [...messages];
    // With fewer user turns than the window, turns are counted by assistant replies instead.
    const totalUserTurns = body.filter((message) => message.role === 'user').length;
    const countAssistantTurns = totalUserTurns < lastTurnsToKeep;
    let turnCount = 0;
    const collected: T[] = [];
    for (let index = body.length - 1; index >= 0; index -= 1) {
        const message = body[index]!;
        collected.unshift(message);
        const boundary = countAssistantTurns ? message.role === 'assistant' : message.role === 'user';
        if (boundary) {
            turnCount += 1;
            if (turnCount >= lastTurnsToKeep) break;
        }
    }
    if (collected.length > 0) {
        const firstUser = body.find((message) => message.role === 'user');
        if (firstUser && !collected.includes(firstUser)) collected.unshift(firstUser);
    }
    return [...systemPrefix, ...collected];
}

/** `summary_only`: with a summary, everything from the latest summary on plus the first user message. */
function collectSummaryOnlyBody<T extends WindowMessage>(body: readonly T[], hasSummary: boolean, lastTurnsToKeep: number): T[] {
    if (!hasSummary) return collectRecentTurns(body, Math.max(1, lastTurnsToKeep)).slice();
    let boundary = -1;
    for (let index = body.length - 1; index >= 0; index -= 1) {
        if (isSyntheticSummary(body[index]!)) { boundary = index; break; }
    }
    let lastUserIndex = -1;
    for (let index = body.length - 1; index >= 0; index -= 1) {
        if (body[index]!.role === 'user') { lastUserIndex = index; break; }
    }
    const keep = new Set<number>();
    const firstUserIndex = body.findIndex((message) => message.role === 'user');
    if (firstUserIndex >= 0) keep.add(firstUserIndex);
    const verbatimFrom = Math.min(lastUserIndex >= 0 ? lastUserIndex : body.length, boundary + 1);
    for (let index = Math.max(0, verbatimFrom); index < body.length; index += 1) {
        if (!isSyntheticSummary(body[index]!)) keep.add(index);
    }
    return body.filter((_, index) => keep.has(index));
}

/**
 * The messages the SDK sends to the model for these saved messages.
 * `raw` sends them all (only the token clamp could trim, and it is not modelled).
 */
export function sdkContextWindow<T extends WindowMessage>(messages: readonly T[], options: SdkContextWindowOptions): T[] {
    if (options.policy === 'raw') return [...messages];
    if (options.policy === 'summary_only') {
        const hasSystem = messages.length > 0 && messages[0]!.role === 'system';
        const body = hasSystem ? messages.slice(1) : [...messages];
        const kept = collectSummaryOnlyBody(body, Boolean(options.hasSummary), options.lastTurnsToKeep);
        return hasSystem ? [messages[0]!, ...kept] : kept;
    }
    return collectRecentTurns(messages, options.lastTurnsToKeep);
}
