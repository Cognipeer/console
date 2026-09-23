/**
 * What an agent carries from one turn of a conversation to the next, and what
 * a turn reports about how it ended.
 *
 * ── Why the state is persisted ──────────────────────────────────────────────
 * The conversation record keeps the transcript people read: user and assistant
 * TEXT. Every turn used to rebuild the agent's state from that text alone, so
 * the next turn started without
 *  - the tool calls and results already made (the agent queried the same logs
 *    again, or answered "I have no data" about what it had just read),
 *  - the context summaries it had built, and the standing instructions those
 *    summaries carry (`summary_only` then had nothing to stand in for the
 *    past), and
 *  - its plan.
 * The runtime state a turn ends in is stored beside the conversation
 * (`IAgentConversationState`) and restored at the start of the next turn.
 *
 * ── Why a turn reports its stop reason ──────────────────────────────────────
 * When a budget (`maxWallClockMs`, `maxTotalOutputTokens`, `maxCostUsd`) or a
 * cancellation ends a run, agent-sdk stops the loop without a final answer —
 * the caller got an empty message and no hint why. `describeTurnOutcome`
 * reads the SDK's own markers and returns the reason, plus the last text the
 * agent did produce. It never makes another model call: it reports only what
 * the run already has.
 */

import type {
    AgentInvokeResult as AgentSdkInvokeResult,
    Message as AgentSdkMessage,
    SmartState as AgentSdkSmartState,
    SummarizationEvent as AgentSdkSummarizationEvent,
} from '@cognipeer/agent-sdk';

import { createLogger } from '@/lib/core/logger';
import type { IAgentConversation, IAgentConversationState, IAgentTurnCompaction, IModelPricing } from '@/lib/database';

const logger = createLogger('agent-turn-state');

// ── Persistence ─────────────────────────────────────────────────────────────

/**
 * Upper bound for a stored state. Cosmos DB (Mongo API) caps a document at
 * 2 MB; staying well under it leaves room for the envelope and for UTF-8
 * multi-byte text measured as characters.
 */
export const MAX_STATE_BYTES = 1_500_000;

/** Tool payloads above this are cut when a state has to shrink to fit. */
const TRIMMED_TOOL_TEXT_CHARS = 8_000;

/**
 * The state fields that describe the conversation. Everything else on
 * `SmartState` is per-run: `ctx` holds live handles and one-run verdicts
 * (a budget breach, a pause, a guardrail block) that must not leak into the
 * next turn, and `usage` accumulates — carried over, it would bill every turn
 * for all the turns before it.
 */
const CARRIED_FIELDS = [
    'messages',
    'toolHistory',
    'toolHistoryArchived',
    'summaries',
    'summaryRecords',
    'plan',
    'planVersion',
] as const;

type CarriedState = Partial<Pick<AgentSdkSmartState, (typeof CARRIED_FIELDS)[number]>>;

type LooseMessage = Record<string, unknown> & {
    role?: string;
    content?: unknown;
    tool_calls?: Array<Record<string, unknown>>;
    tool_call_id?: string;
};

function roleOf(message: LooseMessage): string | undefined {
    if (typeof message.role === 'string') return message.role;
    const typeFn = (message as { _getType?: () => string; getType?: () => string });
    const type = typeFn.getType?.() ?? typeFn._getType?.();
    if (type === 'ai') return 'assistant';
    if (type === 'human') return 'user';
    return type;
}

/**
 * A message the SDK can take back as input, and nothing else.
 *
 * A model reply reaches the state as a spread LangChain message: it carries
 * `lc_kwargs` (a second copy of the whole message), `response_metadata`, usage
 * blocks and `lc_serializable`. Those are dead weight in storage, and the
 * `lc_*` markers make LangChain treat the restored plain object as a class
 * instance it is not.
 */
export function toPlainMessage(message: unknown): AgentSdkMessage | null {
    if (!message || typeof message !== 'object') return null;
    const source = message as LooseMessage;
    const role = roleOf(source);
    if (!role) return null;
    const plain: Record<string, unknown> = { role, content: source.content ?? '' };
    if (typeof source.name === 'string') plain.name = source.name;
    if (Array.isArray(source.tool_calls) && source.tool_calls.length > 0) plain.tool_calls = source.tool_calls;
    if (typeof source.tool_call_id === 'string') plain.tool_call_id = source.tool_call_id;
    if (source.additional_kwargs && typeof source.additional_kwargs === 'object') {
        plain.additional_kwargs = source.additional_kwargs;
    }
    if (source.reasoning !== undefined) plain.reasoning = source.reasoning;
    return plain as unknown as AgentSdkMessage;
}

function toolCallIdOf(call: Record<string, unknown>): string | undefined {
    return typeof call.id === 'string' ? call.id : undefined;
}

/**
 * Makes the carried transcript a valid provider request again.
 *
 * A run that stopped mid-tool (a budget breach between the call and its
 * result, a pause) leaves an assistant turn whose `tool_calls` have no
 * results. Every provider rejects that on the next request, which would turn
 * one cut-short turn into a conversation that can never answer again. The
 * unanswered calls are dropped (and the assistant turn with them if nothing
 * else is left of it); a tool result whose call is gone is dropped too.
 */
export function repairToolAdjacency(messages: AgentSdkMessage[]): AgentSdkMessage[] {
    const answered = new Set<string>();
    for (const message of messages as LooseMessage[]) {
        if (message.role === 'tool' && typeof message.tool_call_id === 'string') answered.add(message.tool_call_id);
    }
    const issued = new Set<string>();
    const out: AgentSdkMessage[] = [];
    for (const message of messages as LooseMessage[]) {
        if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
            const kept = message.tool_calls.filter((call) => {
                const id = toolCallIdOf(call);
                return id !== undefined && answered.has(id);
            });
            for (const call of kept) issued.add(toolCallIdOf(call)!);
            if (kept.length === message.tool_calls.length) {
                out.push(message as unknown as AgentSdkMessage);
                continue;
            }
            // The provider's raw copy of the calls rides along in
            // `additional_kwargs`, and LangChain falls back to it when
            // `tool_calls` is absent — it must not resurrect a dropped call.
            const kwargs = message.additional_kwargs && typeof message.additional_kwargs === 'object'
                ? { ...(message.additional_kwargs as Record<string, unknown>) }
                : undefined;
            if (kwargs) delete kwargs.tool_calls;
            const repaired: LooseMessage = { ...message, ...(kwargs ? { additional_kwargs: kwargs } : {}) };
            if (kept.length > 0) {
                out.push({ ...repaired, tool_calls: kept } as unknown as AgentSdkMessage);
            } else if (typeof message.content === 'string' && message.content.trim()) {
                delete repaired.tool_calls;
                out.push(repaired as unknown as AgentSdkMessage);
            }
            continue;
        }
        if (message.role === 'tool') {
            if (typeof message.tool_call_id === 'string' && issued.has(message.tool_call_id)) {
                out.push(message as unknown as AgentSdkMessage);
            }
            continue;
        }
        out.push(message as unknown as AgentSdkMessage);
    }
    return out;
}

function pickCarried(state: AgentSdkSmartState | undefined): CarriedState {
    const carried: CarriedState = {};
    if (!state) return carried;
    for (const field of CARRIED_FIELDS) {
        const value = (state as Record<string, unknown>)[field];
        if (value !== undefined) (carried as Record<string, unknown>)[field] = value;
    }
    const messages = Array.isArray(carried.messages) ? carried.messages : [];
    carried.messages = repairToolAdjacency(
        messages
            .map(toPlainMessage)
            .filter((message): message is AgentSdkMessage => message !== null)
            // The system prompt is rebuilt from the CURRENT config every turn;
            // a stored one would pin the prompt the conversation started with.
            .filter((message) => message.role !== 'system'),
    );
    return carried;
}

function truncateText(value: unknown, limit: number): unknown {
    if (typeof value === 'string') {
        return value.length > limit ? `${value.slice(0, limit)}… [truncated for storage]` : value;
    }
    if (value !== null && typeof value === 'object') {
        const text = JSON.stringify(value);
        return text.length > limit ? `${text.slice(0, limit)}… [truncated for storage]` : value;
    }
    return value;
}

/**
 * Shrinks a state to fit `MAX_STATE_BYTES`, cheapest loss first:
 *  1. the untouched `rawOutput` copies (the model worked from `output`);
 *  2. long tool outputs in the tool history;
 *  3. long tool results in the transcript itself.
 * Returns null when even that does not fit — the caller then stores nothing
 * and the next turn falls back to the text transcript.
 */
export function serializeForStorage(carried: CarriedState): string | null {
    let text = JSON.stringify(carried);
    if (text.length <= MAX_STATE_BYTES) return text;

    const strip = (entries: unknown) => Array.isArray(entries)
        ? entries.map((entry) => {
            if (!entry || typeof entry !== 'object') return entry;
            const copy = { ...(entry as Record<string, unknown>) };
            delete copy.rawOutput;
            return copy;
        })
        : entries;
    const shrunk: CarriedState = {
        ...carried,
        toolHistory: strip(carried.toolHistory) as CarriedState['toolHistory'],
        toolHistoryArchived: strip(carried.toolHistoryArchived) as CarriedState['toolHistoryArchived'],
    };
    text = JSON.stringify(shrunk);
    if (text.length <= MAX_STATE_BYTES) return text;

    const cut = (entries: unknown) => Array.isArray(entries)
        ? entries.map((entry) => entry && typeof entry === 'object'
            ? { ...(entry as Record<string, unknown>), output: truncateText((entry as Record<string, unknown>).output, TRIMMED_TOOL_TEXT_CHARS) }
            : entry)
        : entries;
    shrunk.toolHistory = cut(shrunk.toolHistory) as CarriedState['toolHistory'];
    shrunk.toolHistoryArchived = cut(shrunk.toolHistoryArchived) as CarriedState['toolHistoryArchived'];
    text = JSON.stringify(shrunk);
    if (text.length <= MAX_STATE_BYTES) return text;

    shrunk.messages = (shrunk.messages ?? []).map((message) => message.role === 'tool'
        ? { ...message, content: truncateText(message.content, TRIMMED_TOOL_TEXT_CHARS) as string }
        : message);
    text = JSON.stringify(shrunk);
    return text.length <= MAX_STATE_BYTES ? text : null;
}

type StateStore = {
    findAgentConversationState(conversationId: string): Promise<IAgentConversationState | null>;
    saveAgentConversationState(state: Omit<IAgentConversationState, '_id' | 'createdAt' | 'updatedAt'>): Promise<void>;
    deleteAgentConversationState(conversationId: string): Promise<boolean>;
};

/**
 * The state the conversation's last turn ended in, ready to take the next
 * user message. Null — use the text transcript — when there is none, when it
 * cannot be read, or when the transcript has moved on without it (see
 * `IAgentConversationState.messageCount`).
 */
export async function loadConversationState(
    db: StateStore,
    conversation: Pick<IAgentConversation, '_id' | 'messages'>,
): Promise<CarriedState | null> {
    const conversationId = String(conversation._id);
    try {
        const stored = await db.findAgentConversationState(conversationId);
        if (!stored) return null;
        if (stored.messageCount !== (conversation.messages?.length ?? 0)) {
            logger.info('Stored agent state is behind the transcript; replaying the transcript instead', {
                conversationId,
                stateMessageCount: stored.messageCount,
                transcriptMessageCount: conversation.messages?.length ?? 0,
            });
            return null;
        }
        const parsed = JSON.parse(stored.snapshot) as CarriedState;
        return pickCarried(parsed as AgentSdkSmartState);
    } catch (error) {
        logger.warn('Stored agent state could not be read; replaying the transcript instead', {
            conversationId,
            error: error instanceof Error ? error.message : String(error),
        });
        return null;
    }
}

/**
 * Stores the state a turn ended in. Best-effort, like the transcript write it
 * follows: a failure here costs the next turn its memory of this one, not the
 * answer the caller already has.
 */
export async function saveConversationState(
    db: StateStore,
    input: {
        conversationId: string;
        tenantId: string;
        projectId: string;
        agentKey: string;
        state: AgentSdkSmartState | undefined;
        /** `conversation.messages.length` AFTER this turn was appended. */
        messageCount: number;
    },
): Promise<void> {
    try {
        if (!input.state) return;
        const snapshot = serializeForStorage(pickCarried(input.state));
        if (snapshot === null) {
            logger.warn('Agent state is too large to store even trimmed; the next turn replays the transcript', {
                conversationId: input.conversationId,
            });
            await db.deleteAgentConversationState(input.conversationId);
            return;
        }
        await db.saveAgentConversationState({
            conversationId: input.conversationId,
            tenantId: input.tenantId,
            projectId: input.projectId,
            agentKey: input.agentKey,
            snapshot,
            messageCount: input.messageCount,
            sizeBytes: snapshot.length,
        });
    } catch (error) {
        logger.error('Failed to store agent conversation state', {
            conversationId: input.conversationId,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

/**
 * The input state for a turn: the carried state (or the text transcript when
 * there is none) plus the new user message, with an optional system prompt in
 * front — the playground passes its prompt as a message, the live path as an
 * option.
 */
export function buildTurnInputState(input: {
    carried: CarriedState | null;
    transcript: Array<{ role: string; content: string }>;
    userMessage: string;
    systemPrompt?: string;
}): AgentSdkSmartState {
    const history: AgentSdkMessage[] = input.carried?.messages
        ?? input.transcript.map((m) => ({ role: m.role, content: m.content }) as AgentSdkMessage);
    return {
        toolHistory: [],
        toolHistoryArchived: [],
        summaries: [],
        summaryRecords: [],
        ...(input.carried ?? {}),
        messages: [
            ...(input.systemPrompt ? [{ role: 'system', content: input.systemPrompt } as AgentSdkMessage] : []),
            ...history,
            { role: 'user', content: input.userMessage } as AgentSdkMessage,
        ],
    } as AgentSdkSmartState;
}

// ── Turn outcome ────────────────────────────────────────────────────────────

export type AgentStopReason =
    /** The run ended with a final answer. */
    | 'completed'
    /** A `limits` budget (wall clock, output tokens, cost) stopped the loop. */
    | 'limit'
    /** The run was cancelled. */
    | 'cancelled'
    /** The run is waiting for input no console channel can deliver (approval, a question). */
    | 'paused';

export interface AgentTurnOutcome {
    stopReason: AgentStopReason;
    /** The SDK's own wording, e.g. "maxWallClockMs (30000ms) exceeded". */
    stopDetail?: string;
    /**
     * The answer to return. On a normal run this is `result.content`. On a
     * run that stopped early with no answer it is the last text the agent
     * wrote during the run, if any — never a newly generated one.
     */
    content: string;
    /** True when `content` is partial work rather than a final answer. */
    partial: boolean;
}

function messageText(message: LooseMessage | undefined): string {
    if (!message) return '';
    const { content } = message;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
                ? (part as { text: string }).text
                : ''))
            .join('');
    }
    return '';
}

/** Messages the SDK injects itself; their text is not the agent's answer. */
function isSyntheticText(message: LooseMessage): boolean {
    if (Array.isArray(message.tool_calls) && message.tool_calls.some((call) => {
        const fn = call.function as { name?: string } | undefined;
        return (call.name ?? fn?.name) === 'summarize_context';
    })) return true;
    return false;
}

export function describeTurnOutcome(
    result: Pick<AgentSdkInvokeResult, 'content' | 'state'>,
    /** How many messages the run started with — only text written after that counts. */
    inputMessageCount: number,
): AgentTurnOutcome {
    const ctx = ((result.state as { ctx?: Record<string, unknown> } | undefined)?.ctx ?? {}) as Record<string, unknown>;
    const content = result.content || '';

    let stopReason: AgentStopReason = 'completed';
    let stopDetail: string | undefined;
    if (typeof ctx.__limitBreached === 'string' || ctx.__limitBreached) {
        stopReason = 'limit';
        stopDetail = typeof ctx.__limitBreached === 'string' ? ctx.__limitBreached : undefined;
    } else if (ctx.__cancelled) {
        stopReason = 'cancelled';
        const cancelled = ctx.__cancelled as { reason?: unknown };
        stopDetail = typeof cancelled?.reason === 'string' ? cancelled.reason : undefined;
    } else if (ctx.__awaitingApproval || ctx.__awaitingUserQuestion || ctx.__paused) {
        stopReason = 'paused';
        stopDetail = ctx.__awaitingApproval
            ? 'waiting for a tool approval'
            : ctx.__awaitingUserQuestion
                ? 'waiting for an answer to a question'
                : undefined;
    }

    if (stopReason === 'completed' || content.trim()) {
        return { stopReason, ...(stopDetail ? { stopDetail } : {}), content, partial: stopReason !== 'completed' };
    }

    // Stopped early with nothing to say: return the last thing the agent DID
    // write this run (the text next to a tool call, typically "checking the
    // infra logs next…"), so the caller sees how far it got.
    const messages = ((result.state as { messages?: LooseMessage[] } | undefined)?.messages ?? []);
    let lastText = '';
    for (let i = messages.length - 1; i >= Math.max(0, inputMessageCount); i -= 1) {
        const message = messages[i];
        if (roleOf(message) !== 'assistant' || isSyntheticText(message)) continue;
        const text = messageText(message).trim();
        if (text) {
            lastText = text;
            break;
        }
    }
    return { stopReason, ...(stopDetail ? { stopDetail } : {}), content: lastText, partial: true };
}

// ── Context compaction (summarization) ──────────────────────────────────────

/**
 * One context summarization that happened during a turn — the stored shape,
 * built from the SDK's `summarization` event.
 */
export type AgentTurnCompaction = IAgentTurnCompaction;

export function compactionFromEvent(event: AgentSdkSummarizationEvent): AgentTurnCompaction {
    const structured = event.structuredSummary as (AgentSdkSummarizationEvent['structuredSummary'] & {
        user_directives?: string[];
    }) | undefined;
    const notes = event.integrity?.notes ?? [];
    return {
        at: new Date().toISOString(),
        ...(typeof event.messagesCompressed === 'number' ? { messagesCompressed: event.messagesCompressed } : {}),
        ...(typeof event.tokenCountBefore === 'number' ? { tokensBefore: event.tokenCountBefore } : {}),
        ...(typeof event.tokenCountAfter === 'number' ? { tokensAfter: event.tokenCountAfter } : {}),
        ...(typeof event.durationMs === 'number' ? { durationMs: event.durationMs } : {}),
        ...(typeof event.inputTokens === 'number' ? { inputTokens: event.inputTokens } : {}),
        ...(typeof event.outputTokens === 'number' ? { outputTokens: event.outputTokens } : {}),
        ...(structured
            ? {
                summary: {
                    ...(structured.user_directives?.length ? { userDirectives: structured.user_directives } : {}),
                    ...(structured.stable_facts?.length
                        ? { facts: structured.stable_facts.map((fact) => ({ key: fact.key, value: fact.value })) }
                        : {}),
                    ...(structured.active_goals?.length ? { goals: structured.active_goals } : {}),
                    ...(structured.open_questions?.length ? { openQuestions: structured.open_questions } : {}),
                    ...(structured.discarded_obsolete?.length ? { discarded: structured.discarded_obsolete } : {}),
                },
            }
            : {}),
        ...(notes.length > 0 ? { integrityNotes: notes } : {}),
        // The SDK reports a failed summarizer call as a summarization event
        // whose token count did not move — the fallback summary was local.
        ...(notes.some((note) => /fallback/i.test(note)) ? { failed: true } : {}),
    };
}

/**
 * The tool results a turn's compaction replaced with a placeholder, found by
 * comparing the transcript before and after: the SDK's event says HOW MANY,
 * this says WHICH.
 */
export function compactedToolResults(
    before: AgentSdkMessage[],
    after: AgentSdkMessage[] | undefined,
): Array<{ toolName: string; toolCallId: string }> {
    const placeholder = /^(SUMMARIZED|ARCHIVED_TOOL_RESPONSE|SUMMARIZED_TOOL_RESPONSE|STRUCTURED_TOOL_RESPONSE|DROPPED_TOOL_RESPONSE)/;
    const wasPlaceholder = new Set<string>();
    for (const message of before as LooseMessage[]) {
        if (message.role === 'tool' && typeof message.tool_call_id === 'string'
            && typeof message.content === 'string' && placeholder.test(message.content)) {
            wasPlaceholder.add(message.tool_call_id);
        }
    }
    const out: Array<{ toolName: string; toolCallId: string }> = [];
    for (const message of (after ?? []) as LooseMessage[]) {
        if (message.role !== 'tool' || typeof message.tool_call_id !== 'string') continue;
        if (message.name === 'summarize_context') continue;
        if (typeof message.content !== 'string' || !placeholder.test(message.content)) continue;
        if (wasPlaceholder.has(message.tool_call_id)) continue;
        out.push({ toolName: typeof message.name === 'string' ? message.name : 'tool', toolCallId: message.tool_call_id });
    }
    return out;
}

// ── Cost ────────────────────────────────────────────────────────────────────

type CostEstimatorArgs = {
    modelName?: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
};

/**
 * The SDK enforces `limits.maxCostUsd` only through a `costEstimator` — with
 * none, the limit was silently a no-op. Prices each model call from the
 * console model's own `pricing`, the same numbers the bill uses.
 *
 * `models` maps every name a call may be reported under (model id, key) to its
 * pricing; `fallback` prices a call whose name matches nothing — the agent's
 * own model, which makes the cap err on the side of stopping.
 */
export function buildCostEstimator(
    models: Array<{ names: Array<string | undefined>; pricing?: IModelPricing | null }>,
    fallback: IModelPricing | null | undefined,
    calculate: (pricing: IModelPricing, usage: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }) => { totalCost: number },
): ((args: CostEstimatorArgs) => number) | undefined {
    // A pricing record of zeros is "nobody entered prices", not "free": it
    // would price every call at $0 and the cap would never fire.
    const priced = (pricing: IModelPricing | null | undefined): pricing is IModelPricing =>
        Boolean(pricing) && ((pricing!.inputTokenPer1M ?? 0) > 0 || (pricing!.outputTokenPer1M ?? 0) > 0);
    if (!priced(fallback)) fallback = undefined;
    const byName = new Map<string, IModelPricing>();
    for (const entry of models) {
        if (!priced(entry.pricing)) continue;
        for (const name of entry.names) if (name) byName.set(name.toLowerCase(), entry.pricing);
    }
    if (byName.size === 0 && !fallback) return undefined;
    return (args) => {
        const pricing = (args.modelName ? byName.get(args.modelName.toLowerCase()) : undefined) ?? fallback ?? undefined;
        if (!pricing) return 0;
        return calculate(pricing, {
            inputTokens: args.inputTokens,
            outputTokens: args.outputTokens,
            cachedInputTokens: args.cachedInputTokens,
        }).totalCost;
    };
}
