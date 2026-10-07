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
 * The fix does not touch the SDK. It passes every chunk through — the live
 * text deltas still stream — then yields ONE extra, fully assembled message
 * with `role: 'assistant'` at the end. The SDK keeps the last role-bearing
 * chunk as the response, and does not re-emit its text because that text
 * equals what it already streamed.
 *
 * A streamed call also has to read like a non-streamed one in what it keeps OUT
 * of the answer. Some OpenAI-compatible upstreams (Bedrock's `/openai/v1` with
 * gpt-oss and MiniMax) leave a reasoning model's `<reasoning>…</reasoning>`
 * block inside `content`. For a JSON body the provider contracts strip it on
 * the wire (`withInlineReasoningNormalization`); an event stream passes through
 * that wrapper untouched, as it does in the gateway, whose streaming path runs
 * `createInlineReasoningSplitter` over the deltas. This wrapper is the agent
 * side of that: the block never reaches the live text (the realtime engine
 * would speak it), nor the assembled answer that is persisted and replayed as
 * history, and it is kept as `additional_kwargs.reasoning_content` — where the
 * provider's own reasoning stream is read from.
 */

import { createInlineReasoningSplitter } from '@/lib/shared/inlineReasoning';

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
    additional_kwargs?: Record<string, unknown>;
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
 * A copy of `chunk` that carries `content` instead — same class, so LangChain's
 * `concat` and `getType` still work on it. Never mutates the original: the
 * provider's own aggregation holds a reference to it.
 */
function withContent(chunk: unknown, content: string): unknown {
    if (!chunk || typeof chunk !== 'object') return { content };
    return Object.assign(Object.create(Object.getPrototypeOf(chunk)), chunk, { content });
}

/**
 * The assembled final message. Exported for tests.
 *
 * `usage` is filled from wherever the provider put it — LangChain's
 * `usage_metadata`, or the raw `token_usage` in `response_metadata` — because
 * the SDK's ledger reads `usage` first.
 *
 * The reasoning travels on `additional_kwargs.reasoning_content`, as it does on
 * a non-streamed message (that is where `extractAgentReasoning` reads it): the
 * provider's own reasoning stream, merged by `concat`, plus `inlineReasoning`,
 * the block an upstream left inside `content`.
 */
export function assembleStreamedMessage(merged: ConcatenableChunk, text: string, inlineReasoning = '') {
    const toolCalls = Array.isArray(merged.tool_calls) && merged.tool_calls.length > 0
        ? merged.tool_calls
        : undefined;
    const usage = merged.usage_metadata
        ?? merged.response_metadata?.token_usage
        ?? merged.response_metadata?.tokenUsage
        ?? merged.response_metadata?.usage;
    const providerReasoning = merged.additional_kwargs?.reasoning_content;
    const reasoning = `${typeof providerReasoning === 'string' ? providerReasoning : ''}${inlineReasoning}`;
    return {
        role: 'assistant' as const,
        content: text,
        ...(toolCalls ? { tool_calls: toolCalls } : {}),
        ...(usage ? { usage } : {}),
        ...(merged.usage_metadata ? { usage_metadata: merged.usage_metadata } : {}),
        ...(merged.response_metadata ? { response_metadata: merged.response_metadata } : {}),
        ...(reasoning ? { additional_kwargs: { reasoning_content: reasoning } } : {}),
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
            let inlineReasoning = '';
            // One splitter per model call: a leaked reasoning block arrives
            // split across deltas, and it only ever opens the call's text.
            const splitter = createInlineReasoningSplitter();
            for await (const chunk of stream(messages, options) as AsyncIterable<unknown>) {
                const piece = chunk as ConcatenableChunk;
                const raw = chunkText(piece?.content);
                const split = splitter.push(raw);
                text += split.content;
                inlineReasoning += split.reasoning;
                // LangChain's concat is what merges partial tool-call argument
                // JSON across chunks; without it, a call's args arrive in
                // fragments and never parse.
                merged = typeof merged?.concat === 'function' ? merged.concat(piece) : piece;
                // Only a chunk whose text the splitter changed is rebuilt; every
                // other one — tool-call and usage chunks included — goes out as is.
                yield split.content === raw ? chunk : withContent(chunk, split.content);
            }
            // The stream ended inside a tag, or inside the reasoning itself.
            const tail = splitter.flush();
            inlineReasoning += tail.reasoning;
            if (tail.content) {
                text += tail.content;
                yield { content: tail.content };
            }
            if (merged) yield assembleStreamedMessage(merged, text, inlineReasoning);
        };
    }

    return wrapped as unknown as T;
}

