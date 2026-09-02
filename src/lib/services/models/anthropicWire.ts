/**
 * Anthropic Messages ⇄ OpenAI chat-completions translation.
 *
 * The Model Hub serves one dialect: the OpenAI chat-completions schema. That is
 * the right internal shape — every provider contract already normalises into it
 * and `handleChatCompletion` is the single metered, guardrailed, quota-checked
 * path through the platform. But a growing share of clients speak Anthropic's
 * Messages API instead, and telling them "use the OpenAI SDK" is telling them
 * to rewrite their app.
 *
 * So this module adds a dialect at the EDGE and nothing else: an inbound
 * Messages request is translated to the OpenAI body `handleChatCompletion`
 * already understands, and its response — buffered or streamed — is translated
 * back. Nothing downstream of the route handler knows the difference, which is
 * exactly the property that keeps metering, guardrails and quota honest.
 *
 * Deliberately NOT symmetric with the AI App Gateway's native mode. There, the
 * bytes must reach api.anthropic.com unchanged and translation is forbidden.
 * Here the destination is our own Model Hub and translation is the entire job.
 * The cost of translating is real and worth naming: `cache_control` breakpoints
 * and extended-thinking blocks have no OpenAI equivalent and are dropped, so a
 * client that depends on prompt caching should point at a native gateway
 * instance rather than at this endpoint.
 */

/** Anthropic content blocks we understand on the way in. */
type AnthropicContentBlock = {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  source?: { type?: string; media_type?: string; data?: string; url?: string };
};

type AnthropicMessage = {
  role?: string;
  content?: string | AnthropicContentBlock[];
};

export interface AnthropicMessagesRequest {
  [key: string]: unknown;
  model?: string;
  max_tokens?: number;
  messages?: AnthropicMessage[];
  system?: string | AnthropicContentBlock[];
  tools?: Array<{ type?: string; name?: string; description?: string; input_schema?: unknown }>;
  tool_choice?: { type?: string; name?: string };
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  stream?: boolean;
  metadata?: { user_id?: string };
}

type OpenAiToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

type OpenAiMessage = {
  role: string;
  content?: unknown;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
};

export class AnthropicRequestError extends Error {}

function textOf(blocks: AnthropicContentBlock[]): string {
  return blocks
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n');
}

/**
 * `tool_result.content` is a string OR a block array OR (per the SDKs) an
 * arbitrary JSON value. OpenAI's `tool` role takes a plain string, so everything
 * collapses to text — losing the block structure but never the content.
 */
function flattenToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((b) => {
        const block = b as AnthropicContentBlock;
        if (typeof block?.text === 'string') return block.text;
        return JSON.stringify(b);
      })
      .filter(Boolean);
    return parts.join('\n');
  }
  if (content === undefined || content === null) return '';
  return JSON.stringify(content);
}

/** Anthropic carries images as base64 + media type, or as a URL. */
function imagePartFrom(block: AnthropicContentBlock): Record<string, unknown> | null {
  const source = block.source;
  if (!source) return null;
  if (source.type === 'url' && typeof source.url === 'string') {
    return { type: 'image_url', image_url: { url: source.url } };
  }
  if (typeof source.data === 'string') {
    const mediaType = source.media_type || 'image/png';
    return { type: 'image_url', image_url: { url: `data:${mediaType};base64,${source.data}` } };
  }
  return null;
}

/**
 * `document` blocks have no chat-completions equivalent. A PDF wrapped in an
 * `image_url` data URL — the tempting shortcut — is rejected or silently
 * mis-read by every OpenAI-schema provider, so only plain-text documents are
 * carried (as text); anything else is refused up front with a reason.
 */
function documentTextFrom(block: AnthropicContentBlock, position: string): string {
  const source = block.source;
  if (source?.type === 'text' && typeof source.data === 'string') return source.data;
  if (source?.media_type === 'text/plain' && typeof source.data === 'string') {
    try {
      return Buffer.from(source.data, 'base64').toString('utf8');
    } catch {
      /* fall through to the rejection below */
    }
  }
  const mediaType = source?.media_type ?? source?.type ?? 'unknown';
  throw new AnthropicRequestError(
    `${position}: document blocks are not supported by this endpoint (media_type ${mediaType}); `
    + 'pass the document as text, or use an AI App Gateway instance in native mode',
  );
}

/**
 * Tool types the Messages API executes server-side (`web_search_*`, `bash_*`,
 * `text_editor_*`, `computer_*`, …) have no `input_schema` and nothing here
 * could run them. Naming the type in the 400 beats the opaque provider error
 * that `{ function: { name: undefined } }` would otherwise produce.
 */
function assertClientTool(
  tool: { type?: string; name?: string; input_schema?: unknown },
  position: string,
): void {
  if (typeof tool?.type === 'string' && tool.type !== 'custom') {
    throw new AnthropicRequestError(
      `${position}: tool type "${tool.type}" is a server-side tool and is not supported by this endpoint`,
    );
  }
  if (typeof tool?.name !== 'string' || !tool.name) {
    throw new AnthropicRequestError(`${position}: tool \`name\` is required`);
  }
  if (!tool.input_schema || typeof tool.input_schema !== 'object') {
    throw new AnthropicRequestError(
      `${position}: tool "${tool.name}" has no \`input_schema\`; only client tools with a JSON schema are supported`,
    );
  }
}

/**
 * Messages request → OpenAI chat body.
 *
 * The one structural difference that needs care: Anthropic puts a tool's RESULT
 * inside the next user message as a `tool_result` block, while OpenAI makes it
 * its own `tool`-role message. One inbound message can therefore fan out into
 * several outbound ones, and the order has to be preserved or the assistant's
 * tool call and its result stop lining up.
 */
export function anthropicRequestToOpenAi(
  body: AnthropicMessagesRequest,
): Record<string, unknown> {
  if (!body.model || typeof body.model !== 'string') {
    throw new AnthropicRequestError('`model` is required');
  }
  if (!Array.isArray(body.messages)) {
    throw new AnthropicRequestError('`messages` array is required');
  }
  // Unlike OpenAI, the Messages API makes max_tokens mandatory. Enforce it here
  // rather than letting a request without it silently become unbounded.
  if (!Number.isInteger(body.max_tokens) || (body.max_tokens as number) <= 0) {
    throw new AnthropicRequestError('`max_tokens` is required and must be a positive integer');
  }

  const messages: OpenAiMessage[] = [];

  // `system` is a top-level field in Messages and a message in chat-completions.
  const system = typeof body.system === 'string'
    ? body.system
    : Array.isArray(body.system) ? textOf(body.system) : '';
  if (system.trim()) {
    messages.push({ role: 'system', content: system });
  }

  body.messages.forEach((message, position) => {
    // Messages knows exactly two roles. A `system` entry inside `messages` (a
    // common OpenAI habit) must be a 400 here, as it is upstream — silently
    // downgrading it to `user` changes what the model is told.
    const role = message?.role;
    if (role !== 'user' && role !== 'assistant') {
      throw new AnthropicRequestError(
        `messages[${position}].role must be "user" or "assistant"${role ? ` (got "${String(role)}")` : ''}`,
      );
    }
    const content = message?.content;

    if (typeof content === 'string') {
      messages.push({ role, content });
      return;
    }
    if (!Array.isArray(content)) return;

    // Results first: they belong to the PREVIOUS assistant turn's tool calls, so
    // they have to be emitted before this turn's own text or the transcript
    // reads as "answer, then the question it answered".
    for (const block of content) {
      if (block?.type !== 'tool_result') continue;
      const flattened = flattenToolResult(block.content);
      messages.push({
        role: 'tool',
        tool_call_id: block.tool_use_id ?? '',
        // OpenAI's `tool` message has no error flag; the marker is how the model
        // still learns the call failed rather than reading the error text as a
        // successful result.
        content: block.is_error === true ? `[tool error] ${flattened}` : flattened,
      });
    }

    const parts: Array<Record<string, unknown>> = [];
    const toolCalls: OpenAiToolCall[] = [];
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        parts.push({ type: 'text', text: block.text });
        continue;
      }
      if (block?.type === 'image') {
        const part = imagePartFrom(block);
        if (part) parts.push(part);
        continue;
      }
      if (block?.type === 'document') {
        parts.push({ type: 'text', text: documentTextFrom(block, `messages[${position}]`) });
        continue;
      }
      if (block?.type === 'tool_use') {
        toolCalls.push({
          id: block.id ?? '',
          type: 'function',
          function: {
            name: block.name ?? '',
            arguments: JSON.stringify(block.input ?? {}),
          },
        });
      }
    }

    if (parts.length === 0 && toolCalls.length === 0) return;

    const out: OpenAiMessage = { role };
    // A single text part goes as a plain string: some providers reject the
    // multipart array form for text-only messages.
    if (parts.length === 1 && parts[0].type === 'text') {
      out.content = parts[0].text;
    } else if (parts.length > 0) {
      out.content = parts;
    } else {
      // An assistant turn that is only tool calls still needs the key present.
      out.content = null;
    }
    if (toolCalls.length > 0) out.tool_calls = toolCalls;
    messages.push(out);
  });

  const openAi: Record<string, unknown> = {
    model: body.model,
    messages,
    max_tokens: body.max_tokens,
    stream: body.stream === true,
  };
  if (body.stream === true) {
    // chat-completions only emits a usage frame when asked. Without this the
    // translated `message_delta` reports 0 output tokens on every streamed turn
    // and every SDK-side cost meter reads zero.
    openAi.stream_options = { include_usage: true };
  }

  if (typeof body.temperature === 'number') openAi.temperature = body.temperature;
  if (typeof body.top_p === 'number') openAi.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) {
    openAi.stop = body.stop_sequences;
  }
  if (typeof body.metadata?.user_id === 'string') openAi.user = body.metadata.user_id;
  // `top_k` has no chat-completions equivalent. It is kept on the body so a
  // model configured with `settings.allowUnknownPassthrough` forwards it to a
  // provider that understands it; for every other model the inference layer
  // strips it as an unknown parameter, which is the right outcome too.
  if (typeof body.top_k === 'number') openAi.top_k = body.top_k;

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    openAi.tools = body.tools.map((tool, index) => {
      assertClientTool(tool, `tools[${index}]`);
      return {
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema,
        },
      };
    });
  }

  if (body.tool_choice?.type) {
    const choice = body.tool_choice;
    openAi.tool_choice = choice.type === 'tool' && choice.name
      ? { type: 'function', function: { name: choice.name } }
      // Anthropic's `any` means "you must call some tool" — OpenAI spells that
      // `required`. `auto` and `none` line up already.
      : choice.type === 'any' ? 'required' : choice.type;
  }

  return openAi;
}

const STOP_REASON: Record<string, string> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  // Messages has no refusal stop reason in this dialect's vocabulary, and the
  // provider already withheld the content; `end_turn` is the honest closest
  // value and is kept explicit here so the mapping is a decision, not a
  // fall-through.
  content_filter: 'end_turn',
};

function toStopReason(finishReason: unknown): string {
  return typeof finishReason === 'string' ? STOP_REASON[finishReason] ?? 'end_turn' : 'end_turn';
}

/**
 * chat-completions reports `finish_reason: "stop"` for both a natural stop and
 * a matched `stop` sequence, and never says WHICH sequence matched. There is
 * nothing to translate `stop_sequence` from, so it stays `null` — a client
 * that needs it has to compare the tail of the text against its own list.
 */
const STOP_SEQUENCE_UNKNOWN = null;

/** Anthropic's own error-type vocabulary — anything else is not a legal `error.type`. */
const ANTHROPIC_ERROR_TYPES = new Set([
  'invalid_request_error',
  'authentication_error',
  'billing_error',
  'permission_error',
  'not_found_error',
  'request_too_large',
  'rate_limit_error',
  'timeout_error',
  'api_error',
  'overloaded_error',
]);

/**
 * Maps an upstream (OpenAI-dialect) error frame to an Anthropic error type. The
 * status wins when present, then a few well-known OpenAI type strings; the
 * default is `api_error`, never the upstream string verbatim (`server_error` is
 * not a Messages error type and strict SDKs reject it).
 */
export function anthropicErrorTypeForUpstream(err: Record<string, unknown>): string {
  const status = typeof err.status === 'number' ? err.status : undefined;
  if (status === 529 || status === 503) return 'overloaded_error';
  if (status !== undefined) return anthropicErrorTypeForStatus(status);
  const type = typeof err.type === 'string' ? err.type : '';
  if (ANTHROPIC_ERROR_TYPES.has(type)) return type;
  const code = typeof err.code === 'string' ? err.code : '';
  if (/rate_limit|insufficient_quota/.test(`${type} ${code}`)) return 'rate_limit_error';
  if (/overloaded/.test(`${type} ${code}`)) return 'overloaded_error';
  return 'api_error';
}

/**
 * `msg_` + 24 hex, matching the shape Anthropic SDKs expect. Not a security
 * value — clients only ever echo it back in logs.
 */
export function anthropicMessageId(seed?: string): string {
  const raw = (seed ?? '').replace(/[^a-zA-Z0-9]/g, '');
  const body = raw.length >= 24 ? raw.slice(0, 24) : `${raw}${'0'.repeat(24)}`.slice(0, 24);
  return `msg_${body}`;
}

function anthropicUsage(usage: Record<string, unknown> | undefined) {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const cached = num(
    (usage?.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens
      ?? usage?.cached_tokens,
  );
  return {
    // Messages reports input EXCLUSIVE of cache reads; chat-completions reports
    // it inclusive. Subtracting here is what keeps a translated response from
    // over-reporting every cached turn.
    input_tokens: Math.max(0, num(usage?.prompt_tokens) - cached),
    output_tokens: num(usage?.completion_tokens),
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
  };
}

/** Buffered OpenAI chat completion → Messages response. */
export function openAiResponseToAnthropic(
  response: Record<string, unknown>,
  requestedModel: string,
): Record<string, unknown> {
  const choices = Array.isArray(response.choices) ? response.choices : [];
  const choice = (choices[0] ?? {}) as Record<string, unknown>;
  const message = (choice.message ?? {}) as Record<string, unknown>;

  const content: Array<Record<string, unknown>> = [];
  if (typeof message.content === 'string' && message.content) {
    content.push({ type: 'text', text: message.content });
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      const p = part as Record<string, unknown>;
      if (typeof p?.text === 'string') content.push({ type: 'text', text: p.text });
    }
  }

  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    const c = call as Record<string, unknown>;
    const fn = (c.function ?? {}) as Record<string, unknown>;
    let input: unknown = {};
    try {
      input = typeof fn.arguments === 'string' && fn.arguments ? JSON.parse(fn.arguments) : {};
    } catch {
      // A provider that streamed malformed JSON should not turn into a 500 —
      // hand the client the raw string so it can see what it got.
      input = { _raw: fn.arguments };
    }
    content.push({
      type: 'tool_use',
      id: typeof c.id === 'string' ? c.id : '',
      name: typeof fn.name === 'string' ? fn.name : '',
      input,
    });
  }

  return {
    id: anthropicMessageId(typeof response.id === 'string' ? response.id : undefined),
    type: 'message',
    role: 'assistant',
    model: typeof response.model === 'string' ? response.model : requestedModel,
    content,
    stop_reason: toStopReason(choice.finish_reason),
    stop_sequence: STOP_SEQUENCE_UNKNOWN,
    usage: anthropicUsage(response.usage as Record<string, unknown> | undefined),
  };
}

// ── Streaming ───────────────────────────────────────────────────────────────

function frame(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * OpenAI SSE → Anthropic SSE.
 *
 * The shapes are not merely different, they are differently *structured*.
 * OpenAI streams one flat sequence of deltas and lets the client work out where
 * a tool call began. Messages streams explicitly bracketed content blocks —
 * `content_block_start` / `_delta` / `_stop` with an index — and an SDK that
 * receives a delta for a block it was never told about throws.
 *
 * So this holds exactly the state needed to keep the brackets balanced: which
 * block index is currently open, and which tool-call slots have been announced.
 * Everything else is forwarded as it arrives, and the terminal frames are
 * emitted once, on the way out, however the upstream ended.
 */
export function openAiStreamToAnthropic(
  source: ReadableStream<Uint8Array>,
  requestedModel: string,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  // Acquired here, not inside `start()`, so `cancel()` can reach it. The
  // translated stream owns the source for its whole life either way.
  const reader = source.getReader();

  let buffer = '';
  let started = false;
  let messageId = anthropicMessageId();
  let model = requestedModel;
  let nextIndex = 0;
  let textIndex: number | null = null;
  /** OpenAI tool_call index → the Messages content-block index we opened for it. */
  const toolBlocks = new Map<number, number>();
  /** The one tool block currently open, if any — Messages allows a single open block. */
  let openToolIndex: number | null = null;
  let stopReason = 'end_turn';
  let outputTokens = 0;
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let closed = false;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      // Every frame goes through here. Once the consumer has cancelled, the
      // controller throws on enqueue — that must not become an unhandled
      // rejection out of `start()` on every user-initiated stop.
      const emit = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(frame(event, data));
        } catch {
          closed = true;
        }
      };

      const openMessage = () => {
        if (started) return;
        started = true;
        emit('message_start', {
          type: 'message_start',
          message: {
            id: messageId,
            type: 'message',
            role: 'assistant',
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: inputTokens,
              output_tokens: 0,
              cache_read_input_tokens: cacheReadTokens,
              cache_creation_input_tokens: 0,
            },
          },
        });
      };

      const closeBlock = (index: number | null) => {
        if (index === null) return;
        emit('content_block_stop', { type: 'content_block_stop', index });
      };

      /** Closes whichever block is open so exactly one is open at any time. */
      const closeOpenBlocks = () => {
        closeBlock(textIndex);
        textIndex = null;
        closeBlock(openToolIndex);
        openToolIndex = null;
      };

      const handleChunk = (payload: Record<string, unknown>) => {
        if (typeof payload.model === 'string') model = payload.model;
        if (typeof payload.id === 'string' && !started) messageId = anthropicMessageId(payload.id);

        const usage = payload.usage as Record<string, unknown> | undefined;
        if (usage) {
          const mapped = anthropicUsage(usage);
          inputTokens = mapped.input_tokens || inputTokens;
          cacheReadTokens = mapped.cache_read_input_tokens || cacheReadTokens;
          outputTokens = mapped.output_tokens || outputTokens;
        }

        const choices = Array.isArray(payload.choices) ? payload.choices : [];
        const choice = (choices[0] ?? {}) as Record<string, unknown>;
        if (typeof choice.finish_reason === 'string') {
          stopReason = toStopReason(choice.finish_reason);
        }
        const delta = choice.delta as Record<string, unknown> | undefined;
        if (!delta) return;

        openMessage();

        if (typeof delta.content === 'string' && delta.content) {
          if (textIndex === null) {
            // Text after a tool call: the tool block is finished first.
            closeOpenBlocks();
            textIndex = nextIndex++;
            emit('content_block_start', {
              type: 'content_block_start',
              index: textIndex,
              content_block: { type: 'text', text: '' },
            });
          }
          emit('content_block_delta', {
            type: 'content_block_delta',
            index: textIndex,
            delta: { type: 'text_delta', text: delta.content },
          });
        }

        for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
          const c = call as Record<string, unknown>;
          const slot = typeof c.index === 'number' ? c.index : 0;
          const fn = (c.function ?? {}) as Record<string, unknown>;

          if (!toolBlocks.has(slot)) {
            // A tool call begins: whatever is open — text, or the previous
            // tool call — is finished, because Messages allows one open block.
            closeOpenBlocks();
            const index = nextIndex++;
            toolBlocks.set(slot, index);
            openToolIndex = index;
            emit('content_block_start', {
              type: 'content_block_start',
              index,
              content_block: {
                type: 'tool_use',
                id: typeof c.id === 'string' ? c.id : `toolu_${index}`,
                name: typeof fn.name === 'string' ? fn.name : '',
                input: {},
              },
            });
          }

          if (typeof fn.arguments === 'string' && fn.arguments) {
            emit('content_block_delta', {
              type: 'content_block_delta',
              index: toolBlocks.get(slot) as number,
              delta: { type: 'input_json_delta', partial_json: fn.arguments },
            });
          }
        }
      };

      const consume = (line: string) => {
        if (!line.startsWith('data:')) return;
        const raw = line.slice(5).trim();
        if (!raw || raw === '[DONE]') return;
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          return;
        }
        // An error frame mid-stream is terminal for the caller: relay it in the
        // Messages dialect and stop producing content. `message_stop` must NOT
        // follow, or the SDK resolves a truncated message as a success.
        if (payload.error) {
          const err = payload.error as Record<string, unknown>;
          emit('error', {
            type: 'error',
            error: {
              type: anthropicErrorTypeForUpstream(err),
              message: typeof err.message === 'string' ? err.message : 'Upstream error',
            },
          });
          throw new Error('stream-error-relayed');
        }
        handleChunk(payload);
      };

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done || closed) break;
          buffer += decoder.decode(value, { stream: true });
          let idx = buffer.indexOf('\n\n');
          while (idx !== -1) {
            for (const line of buffer.slice(0, idx).split('\n')) consume(line);
            buffer = buffer.slice(idx + 2);
            idx = buffer.indexOf('\n\n');
          }
        }
        if (!closed && buffer.trim()) {
          for (const line of buffer.split('\n')) consume(line);
        }
        if (closed) return;

        // A completion with no content at all still owes the client a
        // well-formed message envelope.
        openMessage();
        closeOpenBlocks();

        emit('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: stopReason, stop_sequence: STOP_SEQUENCE_UNKNOWN },
          // MessageDeltaUsage carries the input side too; the SDK's
          // `finalMessage()` merges it, which is how a streamed turn ends up
          // with the same usage a buffered one reports.
          usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cache_read_input_tokens: cacheReadTokens,
            cache_creation_input_tokens: 0,
          },
        });
        emit('message_stop', { type: 'message_stop' });
      } catch (error) {
        if ((error as Error)?.message !== 'stream-error-relayed') {
          emit('error', {
            type: 'error',
            error: { type: 'api_error', message: 'The stream ended unexpectedly.' },
          });
        }
      } finally {
        try { reader.releaseLock(); } catch { /* already released */ }
        if (!closed) {
          closed = true;
          try { controller.close(); } catch { /* cancelled by the consumer */ }
        }
      }
    },
    // The consumer went away (Node's `Readable.fromWeb` calls this when the
    // socket closes). Propagating to the source is what aborts the provider
    // request — otherwise it runs to completion and is billed as a success.
    cancel(reason) {
      closed = true;
      return reader.cancel(reason);
    },
  });
}

/**
 * Anthropic's error `type` for an HTTP status.
 *
 * The two dialects do not share a vocabulary: OpenAI answers a missing model
 * with `not_found_error` + `code: model_not_found`, Anthropic with a bare
 * `not_found_error` and no code. Collapsing everything to `api_error` — which
 * is what a naive port does — tells an Anthropic SDK that a client mistake was
 * a server fault, and its retry logic then hammers a request that can never
 * succeed.
 */
export function anthropicErrorTypeForStatus(status: number): string {
  if (status === 400) return 'invalid_request_error';
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 404) return 'not_found_error';
  if (status === 413) return 'request_too_large';
  if (status === 429) return 'rate_limit_error';
  if (status === 529) return 'overloaded_error';
  return 'api_error';
}

/** Messages-dialect error envelope, for the route's own failures. */
export function anthropicErrorBody(message: string, type = 'invalid_request_error') {
  return { type: 'error', error: { type, message } };
}
