/**
 * The compare drawer's pure half: how a chat response becomes a turn, and how
 * a side's turns add up to the stats row beneath it.
 *
 * Kept free of React so it can be tested without rendering. The rule that
 * matters here is the difference between "zero" and "not reported": a model
 * that does not report cache reads must show "—", not "0", or the drawer claims
 * the other side is the only one using the cache.
 */

import type { PlaygroundStep } from '../session/sessionTypes';

export type CompareResponseFormat = 'markdown' | 'plain';

export const DEFAULT_RESPONSE_FORMAT: CompareResponseFormat = 'markdown';

export interface CompareTurnUsage {
    inputTokens?: number;
    outputTokens?: number;
    /** A discounted slice of `inputTokens`, not an addition to it. */
    cachedInputTokens?: number;
    totalTokens?: number;
    costUsd?: number;
}

export interface CompareTurn extends CompareTurnUsage {
    role: 'user' | 'assistant' | 'error';
    content: string;
    steps?: PlaygroundStep[];
    latencyMs?: number;
}

export interface CompareTotals {
    latencyMs: number;
    /** `undefined` when no answer on this side reported the value. */
    tokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    cost: number;
    toolCalls: number;
}

function finite(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Reads `usage` off a `/api/agents/:id/chat` response, dropping anything that is not a number. */
export function readTurnUsage(usage: unknown): CompareTurnUsage {
    if (!usage || typeof usage !== 'object') return {};
    const raw = usage as Record<string, unknown>;
    const inputTokens = finite(raw.inputTokens);
    const outputTokens = finite(raw.outputTokens);
    const totalTokens = finite(raw.totalTokens)
        ?? (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined);
    return {
        inputTokens,
        outputTokens,
        cachedInputTokens: finite(raw.cachedInputTokens),
        totalTokens,
        costUsd: finite(raw.costUsd),
    };
}

/** Sums the values answers reported; stays `undefined` when none of them did. */
function sumReported(values: Array<number | undefined>): number | undefined {
    return values.reduce<number | undefined>(
        (acc, value) => (value === undefined ? acc : (acc ?? 0) + value),
        undefined,
    );
}

export function compareTotals(turns: CompareTurn[]): CompareTotals {
    const answers = turns.filter((turn) => turn.role === 'assistant');
    return {
        latencyMs: answers.reduce((sum, turn) => sum + (turn.latencyMs ?? 0), 0),
        tokens: sumReported(answers.map((turn) => turn.totalTokens)),
        inputTokens: sumReported(answers.map((turn) => turn.inputTokens)),
        outputTokens: sumReported(answers.map((turn) => turn.outputTokens)),
        cachedInputTokens: sumReported(answers.map((turn) => turn.cachedInputTokens)),
        cost: answers.reduce((sum, turn) => sum + (turn.costUsd ?? 0), 0),
        toolCalls: answers.reduce((sum, turn) => sum + (turn.steps?.length ?? 0), 0),
    };
}

export function isResponseFormat(value: unknown): value is CompareResponseFormat {
    return value === 'markdown' || value === 'plain';
}
