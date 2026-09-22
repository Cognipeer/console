/**
 * What a session cost and consumed, derived from the turns it already stores.
 *
 * Kept out of the panel component so it can be tested without rendering, and
 * so the transcript header and the inspector cannot disagree about a total.
 */

import type { ChatMessage } from './sessionTypes';

export interface SessionTotals {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    totalTokens: number;
    costUsd: number;
    /** Time the agent spent working, not wall-clock time the session existed. */
    activeMs: number;
    turns: number;
    /**
     * False when a turn reported usage but no price — an unpriced model, or a
     * turn recorded before per-turn pricing existed. The total is then a lower
     * bound, and the UI says so rather than presenting it as exact.
     */
    costComplete: boolean;
}

export function summariseSession(messages: ChatMessage[]): SessionTotals {
    return messages
        .filter((message) => message.role === 'assistant')
        .reduce<SessionTotals>(
            (acc, message) => {
                acc.turns += 1;
                acc.inputTokens += message.usage?.inputTokens ?? 0;
                acc.outputTokens += message.usage?.outputTokens ?? 0;
                acc.cachedInputTokens += message.usage?.cachedInputTokens ?? 0;
                acc.totalTokens += message.usage?.totalTokens ?? 0;
                acc.activeMs += message.latencyMs ?? 0;
                if (message.usage?.costUsd === undefined) {
                    if (message.usage) acc.costComplete = false;
                } else {
                    acc.costUsd += message.usage.costUsd;
                }
                return acc;
            },
            {
                inputTokens: 0,
                outputTokens: 0,
                cachedInputTokens: 0,
                totalTokens: 0,
                costUsd: 0,
                activeMs: 0,
                turns: 0,
                costComplete: true,
            },
        );
}

/**
 * Four decimals below a cent: a single cheap turn costing $0.0003 reads as
 * "$0.00" at two, which makes the whole column look free.
 */
export function formatCost(value: number): string {
    if (value === 0) return '$0.00';
    if (value < 0.01) return `$${value.toFixed(4)}`;
    return `$${value.toFixed(2)}`;
}

export function formatCompactTokens(value: number): string {
    if (value < 1000) return String(value);
    if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
    return `${(value / 1_000_000).toFixed(1)}M`;
}
