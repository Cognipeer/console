/**
 * OpenAI Responses ⇄ chat-completions translation, and the Responses event
 * stream (§5.3).
 *
 * A model named on `POST /client/v1/responses` is served by the same metered,
 * guardrailed path as `POST /client/v1/chat/completions`: the request is
 * translated to the chat body `handleChatCompletion` understands and the
 * answer — buffered or streamed — is translated back, like the Messages
 * dialect (anthropicWire.ts). Model responses are not stored: there is no
 * `previous_response_id`, `conversation` or `background` for a model.
 *
 * `createResponsesEventEncoder` is the one place the `response.*` event
 * sequence is produced; the agent stream (agent-responses-stream.ts) and the
 * model stream translator below both drive it.
 */

import crypto from 'node:crypto';

type AnyRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is AnyRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A Responses request a model target cannot take: 400 in the OpenAI envelope. */
export class ResponsesRequestError extends Error {
  readonly status = 400;

  constructor(message: string, readonly code: string, readonly param: string | null = null) {
    super(message);
    this.name = 'ResponsesRequestError';
  }
}

/** A new, unstored response id (`resp_` + 32 hex): nothing can be read back by it. */
export function newModelResponseId(): string {
  return `resp_${crypto.randomUUID().replace(/-/g, '')}`;
}

// ── Request: Responses → chat completions ───────────────────────────────

type ChatMessage = { role: string; content?: unknown; tool_calls?: AnyRecord[]; tool_call_id?: string };

/** Fields a model target refuses: they need a stored response or a queue, and model responses have neither. */
const STATEFUL_PARAMS = ['previous_response_id', 'conversation'] as const;

function unsupportedPart(type: string, where: string): ResponsesRequestError {
  return new ResponsesRequestError(`${where}: content part type "${type}" is not supported for model targets`, 'unsupported_content_part', 'input');
}

/** A user/system message's parts as chat parts (text, image_url). */
function userParts(content: unknown[], where: string): AnyRecord[] {
  const parts: AnyRecord[] = [];
  content.forEach((raw, index) => {
    const part = isRecord(raw) ? raw : {};
    const type = typeof part.type === 'string' ? part.type : '';
    if (type === 'input_text' || type === 'text') {
      if (typeof part.text === 'string') parts.push({ type: 'text', text: part.text });
      return;
    }
    if (type === 'input_image') {
      const url = isRecord(part.image_url) ? part.image_url.url : part.image_url;
      if (typeof url !== 'string' || url === '') {
        throw new ResponsesRequestError(
          `${where}.content[${index}]: input_image needs an image_url (file_id is not supported for model targets)`,
          'unsupported_content_part',
          'input',
        );
      }
      parts.push({ type: 'image_url', image_url: { url, ...(typeof part.detail === 'string' ? { detail: part.detail } : {}) } });
      return;
    }
    if (type === 'input_file') {
      throw new ResponsesRequestError(`${where}.content[${index}]: input_file is not supported for model targets`, 'unsupported_content_part', 'input');
    }
    throw unsupportedPart(type || 'unknown', `${where}.content[${index}]`);
  });
  return parts;
}

/** An assistant message's text (`output_text` / `refusal` parts). */
function assistantText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (isRecord(part) ? (typeof part.text === 'string' ? part.text : typeof part.refusal === 'string' ? part.refusal : '') : ''))
    .join('');
}

/** A function call output (a string, or text parts) as the tool message's content. */
function toolOutputText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return output.map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : '')).join('');
  return output === undefined || output === null ? '' : JSON.stringify(output);
}

/** Single text parts go as a plain string: some providers refuse the array form for text-only messages. */
function compactContent(parts: AnyRecord[]): unknown {
  if (parts.length === 1 && parts[0].type === 'text') return parts[0].text;
  return parts;
}

function translateInput(input: unknown): ChatMessage[] {
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  if (!Array.isArray(input)) throw new ResponsesRequestError('input is required: a string or an array of input items', 'missing_input', 'input');
  const messages: ChatMessage[] = [];
  input.forEach((raw, index) => {
    const where = `input[${index}]`;
    const item = isRecord(raw) ? raw : {};
    const type = typeof item.type === 'string' ? item.type : 'message';
    if (type === 'message') {
      const role = item.role;
      if (role === 'assistant') {
        const text = assistantText(item.content);
        messages.push({ role: 'assistant', content: text });
        return;
      }
      if (role !== 'user' && role !== 'system' && role !== 'developer') {
        throw new ResponsesRequestError(`${where}.role must be "user", "assistant", "system" or "developer"`, 'invalid_input', 'input');
      }
      // `developer` is the system message of newer OpenAI models; providers behind the gateway know `system`.
      const chatRole = role === 'user' ? 'user' : 'system';
      if (typeof item.content === 'string') {
        messages.push({ role: chatRole, content: item.content });
        return;
      }
      if (!Array.isArray(item.content)) throw new ResponsesRequestError(`${where}.content must be a string or an array of parts`, 'invalid_input', 'input');
      const parts = userParts(item.content, where);
      if (chatRole === 'system') {
        messages.push({ role: 'system', content: parts.map((part) => (typeof part.text === 'string' ? part.text : '')).join('\n\n') });
        return;
      }
      messages.push({ role: 'user', content: compactContent(parts) });
      return;
    }
    if (type === 'function_call') {
      const call = {
        id: typeof item.call_id === 'string' ? item.call_id : typeof item.id === 'string' ? item.id : '',
        type: 'function',
        function: { name: typeof item.name === 'string' ? item.name : '', arguments: typeof item.arguments === 'string' ? item.arguments : '' },
      };
      // Calls of one turn are one assistant message (and join the text it said before them).
      const last = messages[messages.length - 1];
      if (last?.role === 'assistant') {
        last.tool_calls = [...(last.tool_calls ?? []), call];
        if (last.content === '') last.content = null;
      } else {
        messages.push({ role: 'assistant', content: null, tool_calls: [call] });
      }
      return;
    }
    if (type === 'function_call_output') {
      messages.push({ role: 'tool', tool_call_id: typeof item.call_id === 'string' ? item.call_id : '', content: toolOutputText(item.output) });
      return;
    }
    // Reasoning a client sends back is the model's own earlier output; chat completions has no slot for it.
    if (type === 'reasoning') return;
    throw new ResponsesRequestError(`${where}: input item type "${type}" is not supported for model targets`, 'unsupported_parameter', 'input');
  });
  return messages;
}

function translateTextFormat(text: unknown): AnyRecord | undefined {
  if (text === undefined || text === null) return undefined;
  if (!isRecord(text)) throw new ResponsesRequestError('text must be an object', 'invalid_request', 'text');
  const format = text.format;
  if (format === undefined || format === null) return undefined;
  if (!isRecord(format)) throw new ResponsesRequestError('text.format must be an object', 'invalid_response_format', 'text.format');
  if (format.type === 'text') return undefined;
  if (format.type === 'json_object') return { type: 'json_object' };
  if (format.type === 'json_schema') {
    if (!isRecord(format.schema)) throw new ResponsesRequestError('text.format json_schema needs a schema object', 'invalid_response_format', 'text.format');
    return {
      type: 'json_schema',
      json_schema: {
        name: typeof format.name === 'string' ? format.name : 'response',
        schema: format.schema,
        ...(typeof format.description === 'string' ? { description: format.description } : {}),
        ...(typeof format.strict === 'boolean' ? { strict: format.strict } : {}),
      },
    };
  }
  throw new ResponsesRequestError('text.format.type must be "text", "json_object" or "json_schema"', 'invalid_response_format', 'text.format');
}

function translateTools(tools: unknown): AnyRecord[] | undefined {
  if (tools === undefined || tools === null) return undefined;
  if (!Array.isArray(tools)) throw new ResponsesRequestError('tools must be an array', 'invalid_request', 'tools');
  return tools.map((raw, index) => {
    const tool = isRecord(raw) ? raw : {};
    if (tool.type !== 'function') {
      throw new ResponsesRequestError(
        `tools[${index}]: tool type "${String(tool.type ?? 'unknown')}" is not supported for model targets (function tools only)`,
        'unsupported_parameter',
        'tools',
      );
    }
    if (typeof tool.name !== 'string' || tool.name === '') throw new ResponsesRequestError(`tools[${index}].name is required`, 'invalid_request', 'tools');
    return {
      type: 'function',
      function: {
        name: tool.name,
        ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
        parameters: isRecord(tool.parameters) ? tool.parameters : { type: 'object', properties: {} },
        ...(typeof tool.strict === 'boolean' ? { strict: tool.strict } : {}),
      },
    };
  });
}

function translateToolChoice(choice: unknown): unknown {
  if (choice === undefined || choice === null) return undefined;
  if (choice === 'auto' || choice === 'none' || choice === 'required') return choice;
  if (isRecord(choice) && choice.type === 'function' && typeof choice.name === 'string') {
    return { type: 'function', function: { name: choice.name } };
  }
  throw new ResponsesRequestError('tool_choice must be "auto", "none", "required" or { type: "function", name }', 'unsupported_parameter', 'tool_choice');
}

/**
 * A Responses request for a model, as the chat-completions body the gateway
 * runs. Throws `ResponsesRequestError` for what a model target does not take.
 * `metadata` is echoed on the response, never sent upstream; `store` is
 * ignored (nothing is stored).
 */
export function responsesRequestToChat(body: AnyRecord): AnyRecord {
  for (const param of STATEFUL_PARAMS) {
    if (body[param] !== undefined && body[param] !== null) {
      throw new ResponsesRequestError(`${param} is not supported for model targets: model responses are not stored`, 'unsupported_parameter', param);
    }
  }
  if (body.background === true) {
    throw new ResponsesRequestError('background is not supported for model targets', 'unsupported_parameter', 'background');
  }

  const messages: ChatMessage[] = [];
  if (typeof body.instructions === 'string' && body.instructions.trim() !== '') {
    messages.push({ role: 'system', content: body.instructions });
  }
  messages.push(...translateInput(body.input));

  const chat: AnyRecord = { model: body.model, messages };
  const stream = body.stream === true;
  if (stream) {
    chat.stream = true;
    // Usage arrives on a frame of its own only when asked; `response.completed` carries it.
    chat.stream_options = { include_usage: true };
  }
  const responseFormat = translateTextFormat(body.text);
  if (responseFormat) chat.response_format = responseFormat;
  const tools = translateTools(body.tools);
  if (tools) chat.tools = tools;
  const toolChoice = translateToolChoice(body.tool_choice);
  if (toolChoice !== undefined) chat.tool_choice = toolChoice;
  if (typeof body.parallel_tool_calls === 'boolean') chat.parallel_tool_calls = body.parallel_tool_calls;
  if (typeof body.temperature === 'number') chat.temperature = body.temperature;
  if (typeof body.top_p === 'number') chat.top_p = body.top_p;
  if (typeof body.max_output_tokens === 'number') chat.max_tokens = body.max_output_tokens;
  const effort = isRecord(body.reasoning) ? body.reasoning.effort : body.reasoning_effort;
  if (typeof effort === 'string') chat.reasoning_effort = effort;
  if (typeof body.include_reasoning === 'boolean') chat.include_reasoning = body.include_reasoning;
  if (typeof body.user === 'string') chat.user = body.user;
  // OpenAI's prompt-cache fields ride along unchanged; the gateway sends them to an OpenAI-schema upstream only.
  for (const field of ['prompt_cache_key', 'prompt_cache_retention', 'prompt_cache_options']) {
    if (body[field] !== undefined && body[field] !== null) chat[field] = body[field];
  }
  return chat;
}

// ── Response: chat completion → Response object ─────────────────────────

/** The id and time of the response being built (one for its whole stream). */
export interface ResponsesContext {
  id: string;
  createdAt: number;
}

function responseUsage(usage: unknown): AnyRecord | null {
  if (!isRecord(usage)) return null;
  const input = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0;
  const output = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0;
  const promptDetails = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  const completionDetails = isRecord(usage.completion_tokens_details) ? usage.completion_tokens_details : {};
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: typeof promptDetails.cached_tokens === 'number' ? promptDetails.cached_tokens : 0 },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: typeof completionDetails.reasoning_tokens === 'number' ? completionDetails.reasoning_tokens : 0 },
    total_tokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : input + output,
  };
}

/** `length` and `content_filter` end a model response early: `incomplete`, with OpenAI's reason. */
function statusOf(finishReason: unknown): { status: 'completed' | 'incomplete'; incomplete_details: AnyRecord | null } {
  if (finishReason === 'length') return { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } };
  if (finishReason === 'content_filter') return { status: 'incomplete', incomplete_details: { reason: 'content_filter' } };
  return { status: 'completed', incomplete_details: null };
}

function outputTextOf(output: AnyRecord[]): string {
  return output
    .filter((item) => item.type === 'message' && Array.isArray(item.content))
    .flatMap((item) => (item.content as AnyRecord[]).map((part) => (part.type === 'output_text' && typeof part.text === 'string' ? part.text : '')))
    .join('');
}

/** The Response object's envelope: what the request asked for, echoed, around the output. */
export function modelResponseObject(
  request: AnyRecord,
  context: ResponsesContext,
  state: { status: string; output: AnyRecord[]; usage?: AnyRecord | null; error?: AnyRecord | null; incomplete_details?: AnyRecord | null; model?: string },
): AnyRecord {
  const format = isRecord(request.text) && isRecord(request.text.format) ? request.text.format : { type: 'text' };
  return {
    id: context.id,
    object: 'response',
    created_at: context.createdAt,
    status: state.status,
    error: state.error ?? null,
    incomplete_details: state.incomplete_details ?? null,
    instructions: typeof request.instructions === 'string' ? request.instructions : null,
    max_output_tokens: typeof request.max_output_tokens === 'number' ? request.max_output_tokens : null,
    model: typeof request.model === 'string' ? request.model : state.model ?? '',
    output: state.output,
    output_text: outputTextOf(state.output),
    parallel_tool_calls: typeof request.parallel_tool_calls === 'boolean' ? request.parallel_tool_calls : true,
    previous_response_id: null,
    reasoning: { effort: isRecord(request.reasoning) && typeof request.reasoning.effort === 'string' ? request.reasoning.effort : null, summary: null },
    service_tier: typeof request.service_tier === 'string' ? request.service_tier : 'default',
    store: false,
    background: false,
    temperature: typeof request.temperature === 'number' ? request.temperature : null,
    text: { format },
    tool_choice: request.tool_choice ?? 'auto',
    tools: Array.isArray(request.tools) ? request.tools : [],
    top_p: typeof request.top_p === 'number' ? request.top_p : null,
    usage: state.usage ?? null,
    metadata: isRecord(request.metadata) ? request.metadata : {},
  };
}

/** A buffered chat completion as the Response object of `request`. */
export function chatCompletionToResponse(completion: AnyRecord, request: AnyRecord, context: ResponsesContext): AnyRecord {
  const choice = (Array.isArray(completion.choices) ? completion.choices[0] : undefined) as AnyRecord | undefined;
  const message = isRecord(choice?.message) ? choice!.message as AnyRecord : {};
  const output: AnyRecord[] = [];
  const reasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content : '';
  if (reasoning) {
    output.push({ id: `rs_${context.id}_${output.length}`, type: 'reasoning', summary: [{ type: 'summary_text', text: reasoning }] });
  }
  const text = typeof message.content === 'string' ? message.content : assistantText(message.content);
  if (text) {
    output.push({
      id: `msg_${context.id}_${output.length}`,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }],
    });
  }
  for (const raw of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    const call = isRecord(raw) ? raw : {};
    const fn = isRecord(call.function) ? call.function : {};
    output.push({
      id: `fc_${context.id}_${output.length}`,
      type: 'function_call',
      status: 'completed',
      call_id: typeof call.id === 'string' ? call.id : '',
      name: typeof fn.name === 'string' ? fn.name : '',
      arguments: typeof fn.arguments === 'string' ? fn.arguments : '',
    });
  }
  return modelResponseObject(request, context, {
    ...statusOf(choice?.finish_reason),
    output,
    usage: responseUsage(completion.usage),
    model: typeof completion.model === 'string' ? completion.model : undefined,
  });
}

// ── The event stream ────────────────────────────────────────────────────

export interface ResponsesEventEncoder {
  /** The response the stream is about (id known): `response.created` + `response.in_progress`. */
  started(response: AnyRecord): void;
  text(delta: string): void;
  reasoning(delta: string): void;
  /** A fragment of the function call at `slot` (the chat `tool_calls[].index`); the first one opens its item. */
  functionCall(slot: number, fragment: { callId?: string; name?: string; arguments?: string }): void;
  /** Closes every open item (`.done` events); `finish` / `error` do it too. */
  closeItems(): void;
  /** The output items closed so far, in output order (each as its `output_item.done` said it). */
  items(): AnyRecord[];
  /** The final object; its `status` picks the closing event. */
  finish(response: AnyRecord): void;
  /** An `error` event, then `response.failed` when the failed object is known. */
  error(error: { message: string; code?: string | null; type?: string; param?: string | null }, response?: AnyRecord): void;
}

/**
 * The Responses event sequence (§5.3), as SSE frames handed to `write`: a
 * reasoning item (`response.reasoning_summary_*`), a message item
 * (`output_item.added` → `content_part.added` → `output_text.delta`… →
 * `.done`s) and function call items (`function_call_arguments.*`), each closed
 * before the next text or reasoning item opens, then `response.completed` |
 * `response.incomplete` | `response.failed`. Every `data` carries `type` and
 * a `sequence_number` counting from 0.
 */
export function createResponsesEventEncoder(write: (frame: string) => void): ResponsesEventEncoder {
  let sequence = 0;
  const emit = (type: string, data: AnyRecord = {}) => {
    write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`);
  };

  let responseId = '';
  let outputIndex = -1;
  const done: Array<{ index: number; item: AnyRecord }> = [];
  let message: { id: string; index: number; text: string } | null = null;
  let reasoningItem: { id: string; index: number; text: string } | null = null;
  const calls = new Map<number, { id: string; index: number; callId: string; name: string; arguments: string; open: boolean }>();
  const itemDone = (index: number, item: AnyRecord) => {
    done.push({ index, item });
    emit('response.output_item.done', { output_index: index, item });
  };

  const closeReasoning = () => {
    if (!reasoningItem) return;
    const { id, index, text } = reasoningItem;
    emit('response.reasoning_summary_text.done', { item_id: id, output_index: index, summary_index: 0, text });
    emit('response.reasoning_summary_part.done', { item_id: id, output_index: index, summary_index: 0, part: { type: 'summary_text', text } });
    itemDone(index, { id, type: 'reasoning', summary: [{ type: 'summary_text', text }] });
    reasoningItem = null;
  };
  const closeMessage = () => {
    if (!message) return;
    const { id, index, text } = message;
    const part = { type: 'output_text', text, annotations: [] };
    emit('response.output_text.done', { item_id: id, output_index: index, content_index: 0, text });
    emit('response.content_part.done', { item_id: id, output_index: index, content_index: 0, part });
    itemDone(index, { id, type: 'message', role: 'assistant', status: 'completed', content: [part] });
    message = null;
  };
  const closeCalls = () => {
    for (const call of calls.values()) {
      if (!call.open) continue;
      call.open = false;
      emit('response.function_call_arguments.done', { item_id: call.id, output_index: call.index, name: call.name, arguments: call.arguments });
      itemDone(call.index, { id: call.id, type: 'function_call', status: 'completed', call_id: call.callId, name: call.name, arguments: call.arguments });
    }
  };
  const closeAll = () => {
    closeReasoning();
    closeMessage();
    closeCalls();
  };
  const nextId = (prefix: string) => `${prefix}_${responseId}_${outputIndex + 1}`;

  return {
    started(response) {
      responseId = String(response.id ?? '');
      emit('response.created', { response });
      emit('response.in_progress', { response });
    },
    reasoning(delta) {
      if (!delta) return;
      if (!reasoningItem) {
        closeMessage();
        closeCalls();
        reasoningItem = { id: nextId('rs'), index: ++outputIndex, text: '' };
        emit('response.output_item.added', { output_index: reasoningItem.index, item: { id: reasoningItem.id, type: 'reasoning', summary: [] } });
        emit('response.reasoning_summary_part.added', {
          item_id: reasoningItem.id, output_index: reasoningItem.index, summary_index: 0, part: { type: 'summary_text', text: '' },
        });
      }
      reasoningItem.text += delta;
      emit('response.reasoning_summary_text.delta', { item_id: reasoningItem.id, output_index: reasoningItem.index, summary_index: 0, delta });
    },
    text(delta) {
      if (!delta) return;
      if (!message) {
        closeReasoning();
        closeCalls();
        message = { id: nextId('msg'), index: ++outputIndex, text: '' };
        emit('response.output_item.added', {
          output_index: message.index,
          item: { id: message.id, type: 'message', role: 'assistant', status: 'in_progress', content: [] },
        });
        emit('response.content_part.added', {
          item_id: message.id, output_index: message.index, content_index: 0, part: { type: 'output_text', text: '', annotations: [] },
        });
      }
      message.text += delta;
      emit('response.output_text.delta', { item_id: message.id, output_index: message.index, content_index: 0, delta });
    },
    functionCall(slot, fragment) {
      let call = calls.get(slot);
      if (!call) {
        closeReasoning();
        closeMessage();
        call = { id: nextId('fc'), index: ++outputIndex, callId: fragment.callId ?? `call_${slot}`, name: fragment.name ?? '', arguments: '', open: true };
        calls.set(slot, call);
        emit('response.output_item.added', {
          output_index: call.index,
          item: { id: call.id, type: 'function_call', status: 'in_progress', call_id: call.callId, name: call.name, arguments: '' },
        });
      } else if (fragment.name && !call.name) {
        call.name = fragment.name;
      }
      if (fragment.arguments && call.open) {
        call.arguments += fragment.arguments;
        emit('response.function_call_arguments.delta', { item_id: call.id, output_index: call.index, delta: fragment.arguments });
      }
    },
    closeItems: closeAll,
    items() {
      return [...done].sort((a, b) => a.index - b.index).map((entry) => entry.item);
    },
    finish(response) {
      closeAll();
      const status = response.status;
      const type = status === 'failed'
        ? 'response.failed'
        : status === 'incomplete' || status === 'cancelled'
          ? 'response.incomplete'
          : status === 'completed' || status === 'requires_action'
            ? 'response.completed'
            // Still going (an idempotent replay of an active run): no terminal event; GET /responses/{id} follows it.
            : 'response.in_progress';
      emit(type, { response });
    },
    error(error, response) {
      closeAll();
      emit('error', { code: error.code ?? null, message: error.message, param: error.param ?? null, ...(error.type ? { error_type: error.type } : {}) });
      if (response) emit('response.failed', { response });
    },
  };
}

/** Holds idle proxies open on a long stream. */
export const RESPONSES_PING_INTERVAL_MS = 15_000;

/**
 * A chat-completions SSE stream (`handleChatCompletion`) as the Responses
 * event stream of `request`. An upstream error frame becomes an `error` event
 * and `response.failed`; cancelling the result cancels the source, which is
 * what stops the provider call when the client goes away.
 */
export function chatStreamToResponses(
  source: ReadableStream<Uint8Array>,
  request: AnyRecord,
  context: ResponsesContext,
  options: { pingIntervalMs?: number } = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reader = source.getReader();
  let closed = false;
  let ping: ReturnType<typeof setInterval> | undefined;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (frame: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(frame));
        } catch {
          closed = true;
        }
      };
      const events = createResponsesEventEncoder(write);
      ping = setInterval(() => write(': ping\n\n'), options.pingIntervalMs ?? RESPONSES_PING_INTERVAL_MS);
      ping.unref?.();

      let usage: AnyRecord | null = null;
      let finishReason: unknown = null;
      let model: string | undefined;
      let failed = false;
      events.started(modelResponseObject(request, context, { status: 'in_progress', output: [] }));

      const handle = (payload: AnyRecord) => {
        if (isRecord(payload.error)) {
          const error = payload.error;
          failed = true;
          events.closeItems();
          const message = typeof error.message === 'string' ? error.message : 'The model call failed.';
          const code = typeof error.code === 'string' ? error.code : typeof error.type === 'string' ? error.type : 'upstream_error';
          events.error(
            { message, code, ...(typeof error.type === 'string' ? { type: error.type } : {}) },
            modelResponseObject(request, context, { status: 'failed', output: events.items(), usage, error: { code, message }, model }),
          );
          return;
        }
        if (typeof payload.model === 'string') model = payload.model;
        if (isRecord(payload.usage)) usage = responseUsage(payload.usage);
        const choice = Array.isArray(payload.choices) && isRecord(payload.choices[0]) ? payload.choices[0] : null;
        if (!choice) return;
        if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;
        const delta = isRecord(choice.delta) ? choice.delta : {};
        if (typeof delta.reasoning_content === 'string') events.reasoning(delta.reasoning_content);
        if (typeof delta.content === 'string') events.text(delta.content);
        for (const raw of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
          const call = isRecord(raw) ? raw : {};
          const fn = isRecord(call.function) ? call.function : {};
          events.functionCall(typeof call.index === 'number' ? call.index : 0, {
            ...(typeof call.id === 'string' && call.id ? { callId: call.id } : {}),
            ...(typeof fn.name === 'string' && fn.name ? { name: fn.name } : {}),
            ...(typeof fn.arguments === 'string' ? { arguments: fn.arguments } : {}),
          });
        }
      };
      const consume = (line: string) => {
        if (failed || !line.startsWith('data:')) return;
        const raw = line.slice(5).trim();
        if (!raw || raw === '[DONE]') return;
        try {
          handle(JSON.parse(raw) as AnyRecord);
        } catch {
          // A frame that is not JSON carries nothing a Responses client could use.
        }
      };

      try {
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done || closed) break;
          buffer += decoder.decode(value, { stream: true });
          let cut = buffer.indexOf('\n\n');
          while (cut !== -1) {
            for (const line of buffer.slice(0, cut).split('\n')) consume(line);
            buffer = buffer.slice(cut + 2);
            cut = buffer.indexOf('\n\n');
          }
        }
        if (!closed && buffer.trim()) for (const line of buffer.split('\n')) consume(line);
        if (!closed && !failed) {
          // Closing the open items first is what makes `items()` the whole output.
          events.closeItems();
          events.finish(modelResponseObject(request, context, { ...statusOf(finishReason), output: events.items(), usage, model }));
        }
      } catch {
        if (!failed) {
          events.closeItems();
          events.error(
            { message: 'The stream ended unexpectedly.', code: 'stream_error', type: 'server_error' },
            modelResponseObject(request, context, { status: 'failed', output: events.items(), usage, error: { code: 'stream_error', message: 'The stream ended unexpectedly.' }, model }),
          );
        }
      } finally {
        clearInterval(ping);
        try { reader.releaseLock(); } catch { /* already released */ }
        if (!closed) {
          closed = true;
          try { controller.close(); } catch { /* cancelled by the consumer */ }
        }
      }
    },
    cancel(reason) {
      closed = true;
      clearInterval(ping);
      return reader.cancel(reason);
    },
  });
}
