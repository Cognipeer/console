/**
 * Makes a streaming model call report what a non-streaming one does.
 *
 * agent-sdk 0.10.1 only treats a streamed chunk as "the message" when the
 * chunk carries a `role`. `fromLangchainModel`'s `stream` yields raw LangChain
 * `AIMessageChunk`s, which have none — so under `stream: true` the SDK rebuilt
 * the response from the concatenated TEXT alone and threw away everything
 * else the chunks carried:
 *
 *  - the tool calls, so a turn whose model answered with a tool call (no text)
 *    came back as an empty string and never ran the tool;
 *  - the usage, so every streamed turn was recorded at 0 tokens.
 *
 * Both were visible in a live session: the same agent and question ran 8
 * web_search calls and 4.7k tokens over `/chat`, and one empty model call at
 * 0 tokens over `/chat/stream`.
 *
 * The fix does not touch the SDK. It passes every chunk through unchanged —
 * the live text deltas still stream — then yields ONE extra, fully assembled
 * message with `role: 'assistant'` at the end. The SDK keeps the last
 * role-bearing chunk as the response, and does not re-emit its text because
 * that text equals what it already streamed.
 */

/*
 * Deliberately loose: the SDK's model type, LangChain's and the adapter's
 * each type `stream` / `bindTools` differently, and this wrapper only needs to
 * forward whatever arguments it is given.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;
interface StreamingModel {
    stream?: AnyFn;
    bindTools?: AnyFn;
}

interface ConcatenableChunk {
    content?: unknown;
    tool_calls?: unknown[];
    usage_metadata?: unknown;
    response_metadata?: Record<string, unknown>;
    concat?: (other: unknown) => ConcatenableChunk;
}

/** Plain text of a chunk's content, whether a string or an array of parts. */
export function chunkText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .map((part) => {
            if (typeof part === 'string') return part;
            if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
                return (part as { text: string }).text;
            }
            return '';
        })
        .join('');
}

/**
 * The assembled final message. Exported for tests.
 *
 * `usage` is filled from wherever the provider put it — LangChain's
 * `usage_metadata`, or the raw `token_usage` in `response_metadata` — because
 * the SDK's ledger reads `usage` first.
 */
export function assembleStreamedMessage(merged: ConcatenableChunk, text: string) {
    const toolCalls = Array.isArray(merged.tool_calls) && merged.tool_calls.length > 0
        ? merged.tool_calls
        : undefined;
    const usage = merged.usage_metadata
        ?? merged.response_metadata?.token_usage
        ?? merged.response_metadata?.tokenUsage
        ?? merged.response_metadata?.usage;
    return {
        role: 'assistant' as const,
        content: text,
        ...(toolCalls ? { tool_calls: toolCalls } : {}),
        ...(usage ? { usage } : {}),
        ...(merged.usage_metadata ? { usage_metadata: merged.usage_metadata } : {}),
        ...(merged.response_metadata ? { response_metadata: merged.response_metadata } : {}),
    };
}

export function withAssembledStream<T extends object>(input: T): T {
    const model = input as T & StreamingModel;
    if (!model || typeof model !== 'object') return input;

    const wrapped = { ...model } as StreamingModel & Record<string, unknown>;

    if (typeof model.bindTools === 'function') {
        const bindTools = model.bindTools.bind(model);
        // Tools are bound per call, so the bound model must carry the fix too —
        // it is the one that actually streams.
        wrapped.bindTools = (tools: unknown, options?: unknown) =>
            withAssembledStream(bindTools(tools, options) as object);
    }

    if (typeof model.stream === 'function') {
        const stream = model.stream.bind(model);
        wrapped.stream = async function* assembled(messages: unknown[], options?: unknown) {
            let merged: ConcatenableChunk | undefined;
            let text = '';
            for await (const chunk of stream(messages, options) as AsyncIterable<unknown>) {
                const piece = chunk as ConcatenableChunk;
                text += chunkText(piece?.content);
                // LangChain's concat is what merges partial tool-call argument
                // JSON across chunks; without it, a call's args arrive in
                // fragments and never parse.
                merged = typeof merged?.concat === 'function' ? merged.concat(piece) : piece;
                yield chunk;
            }
            if (merged) yield assembleStreamedMessage(merged, text);
        };
    }

    return wrapped as unknown as T;
}

