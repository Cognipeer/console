/**
 * Turning whatever a run reports about tokens into the one shape a session
 * turn stores.
 *
 * Pulled out of `agentService.ts` so it can be tested without a database: it
 * has already been the source of one silent data loss (sessions recorded with
 * no token counts at all), and the failure mode is invisible — a turn that
 * answers correctly and simply saves nothing.
 */

import type { IAgentConversationMessage } from '@/lib/database/provider/types.domain';

/** The usage a session turn stores. `cachedInputTokens` is a discounted slice of `inputTokens`, not an addition to it. */
export type PlaygroundUsage = NonNullable<IAgentConversationMessage['usage']>;

/**
 * Two shapes arrive here. `AgentInvokeResult.metadata.usage` is the SDK's own
 * run ledger — `{ perRequest, totals: { [modelName]: { input, output, total,
 * cachedInput } } }` — which is per MODEL, not per run, because one turn can
 * hit a main model and a summarizer. Everything else (a raw provider response,
 * an external agent's reply) is flat `inputTokens`/`input_tokens`/…
 *
 * Reading only the flat shape is what left sessions with no token counts at
 * all: none of those keys exist on the ledger, so a perfectly good turn was
 * recorded as usage-less.
 */
export function normalizePlaygroundUsage(usage: unknown): { usage: PlaygroundUsage } | undefined {
    if (!usage || typeof usage !== 'object') return undefined;
    const raw = usage as Record<string, unknown>;

    const ledger = normalizeUsageLedger(raw.totals);
    if (ledger) return { usage: ledger };

    const pick = (...keys: string[]): number | undefined => {
        for (const key of keys) {
            const value = raw[key];
            if (typeof value === 'number' && Number.isFinite(value)) return value;
        }
        return undefined;
    };

    const inputTokens = pick('inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens');
    const outputTokens = pick('outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens');
    const cachedInputTokens = pick(
        'cachedInputTokens',
        'cached_input_tokens',
        'cacheReadInputTokens',
        'cache_read_input_tokens',
    );
    const totalTokens = pick('totalTokens', 'total_tokens')
        ?? (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined);

    if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
        return undefined;
    }
    return { usage: { inputTokens, outputTokens, cachedInputTokens, totalTokens } };
}

/**
 * Collapses the SDK's per-model `usage.totals` into one turn total.
 *
 * Summed across models on purpose: the turn's cost is what every model it
 * touched cost together, and showing only the main model would under-report a
 * run that summarized or delegated.
 *
 * A delegated turn is counted once here. The SDK (0.15) merges the sub-agents'
 * model calls into the parent's ledger — each `perRequest` entry tagged with its
 * `subagent` — so these totals already are the whole turn; nothing adds the
 * sub-agents' usage on top of them.
 */
export function normalizeUsageLedger(totals: unknown): PlaygroundUsage | undefined {
    if (!totals || typeof totals !== 'object') return undefined;
    const entries = Object.values(totals as Record<string, unknown>)
        .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object');
    if (entries.length === 0) return undefined;

    const sum = (key: string): number => entries.reduce((acc, entry) => {
        const value = entry[key];
        return acc + (typeof value === 'number' && Number.isFinite(value) ? value : 0);
    }, 0);

    const inputTokens = sum('input');
    const outputTokens = sum('output');
    const cachedInputTokens = sum('cachedInput');
    const totalTokens = sum('total') || inputTokens + outputTokens;

    if (inputTokens === 0 && outputTokens === 0 && totalTokens === 0) return undefined;
    return { inputTokens, outputTokens, cachedInputTokens, totalTokens };
}

/** Sums two usages field by field; a field neither has stays absent, and a cost is kept only when both legs priced theirs. */
export function addPlaygroundUsage(a: PlaygroundUsage, b: PlaygroundUsage): PlaygroundUsage {
    const sum = (x?: number, y?: number): number | undefined => (x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0));
    const costUsd = a.costUsd !== undefined && b.costUsd !== undefined ? a.costUsd + b.costUsd : undefined;
    const merged: PlaygroundUsage = {
        inputTokens: sum(a.inputTokens, b.inputTokens),
        outputTokens: sum(a.outputTokens, b.outputTokens),
        cachedInputTokens: sum(a.cachedInputTokens, b.cachedInputTokens),
        totalTokens: sum(a.totalTokens, b.totalTokens),
    };
    if (costUsd !== undefined) merged.costUsd = costUsd;
    return merged;
}

/**
 * What the earlier legs of a paused turn already spent: the trailing run of
 * assistant messages that paused (each leg of a turn that pauses and resumes is
 * its own stored message, with its own usage). A continuation reports this plus
 * its own leg as the turn's usage; the stored messages stay per-leg so a session's
 * totals (the sum over messages) are not counted twice.
 */
export function pausedLegsUsage(
    messages: ReadonlyArray<Pick<IAgentConversationMessage, 'role' | 'usage' | 'pendingActions'>>,
): PlaygroundUsage | undefined {
    let total: PlaygroundUsage | undefined;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i]!;
        if (message.role !== 'assistant' || !message.pendingActions?.length) break;
        if (message.usage) total = total ? addPlaygroundUsage(message.usage, total) : { ...message.usage };
    }
    return total;
}
