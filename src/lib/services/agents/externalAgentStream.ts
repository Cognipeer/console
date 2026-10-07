/**
 * Server-Sent Events plumbing for connected (external) agents.
 *
 * `externalAgent.ts` asks a connected agent to stream when its caller wants
 * the answer as it is written (realtime voice speaks the first clause while the
 * rest is still being generated). Each wire protocol streams differently:
 *
 *  - `openai-chat`      — `data: {choices:[{delta:{content}}]}` lines, ended by `data: [DONE]`;
 *  - `openai-responses` — typed events, the text in `response.output_text.delta`,
 *                         ended by `response.completed` / `.failed` / `.incomplete`;
 *  - `a2a`              — `message/stream`: every event is a JSON-RPC response whose
 *                         `result` is a Task, a Message, a `status-update` or an
 *                         `artifact-update`.
 *
 * This module is transport-free on purpose: a parser that turns bytes into
 * events, and one accumulator per protocol that turns events into "text to
 * emit now" plus the final answer. The HTTP call (SSRF guard, headers, the
 * non-streaming fallback) stays in `externalAgent.ts`.
 *
 * INVARIANT every accumulator keeps: the text it emits is a prefix of the
 * final `content` whenever that is possible, and `remainder()` emits the rest
 * once the stream ends — so a caller that concatenates every chunk ends up
 * with exactly the answer the non-streaming path would have returned.
 *
 * LIMITS. The endpoint is whatever URL a project member typed in, so the body
 * is untrusted: the parser caps what it holds for one event, and
 * `readEventStream` caps the whole body (bytes and wall-clock time) — the same
 * stance the guardrail webhook takes with its `MAX_RESPONSE_BYTES`. Work is
 * linear in the bytes received: nothing is rescanned or re-copied per chunk.
 */

/**
 * Raised for an error the agent reported INSIDE the stream (HTTP status was
 * 200), and for a stream that broke one of the limits above.
 */
export class ExternalAgentStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExternalAgentStreamError';
  }
}

export interface SseEvent {
  /** `event:` field; `message` when the server sent none (per the SSE spec). */
  event: string;
  /** All `data:` lines of the event, joined by `\n`. */
  data: string;
  id?: string;
}

export interface SseParser {
  /**
   * Feed decoded text of any length; complete events are dispatched
   * synchronously. Throws `ExternalAgentStreamError` when one event outgrows
   * `maxEventChars` — the stream is not worth reading any further then.
   */
  push(text: string): void;
  /** End of stream: dispatch a trailing event that never got its blank line. */
  flush(): void;
}

/**
 * Most characters the parser holds for ONE event: the `data:` lines it has
 * collected plus the line still being received. Real events are tiny (an
 * OpenAI delta is ~200 bytes; an A2A task snapshot or a Responses
 * `response.completed` carries a whole answer, tens of KB), so this is only
 * ever reached by a stream that never ends a line or never ends an event —
 * with headroom for a snapshot that embeds an inline file.
 */
export const SSE_MAX_EVENT_CHARS = 4 * 1024 * 1024;

export interface SseParserOptions {
  /** Defaults to {@link SSE_MAX_EVENT_CHARS}. */
  maxEventChars?: number;
}

const LF = 0x0a;
const CR = 0x0d;

/**
 * Incremental SSE parser (WHATWG event-stream format).
 *
 * Handles every line terminator (`\n`, `\r\n`, `\r`) including a `\r\n` split
 * across two network chunks, multi-line `data:`, comments (`: keep-alive`) and
 * the optional single space after the colon. `retry:` is ignored — this is a
 * one-shot request, never reconnected.
 *
 * Lenient in one place: an event still pending when the body ends is
 * dispatched, not dropped. Agent servers routinely omit the final blank line,
 * and the last event is typically the one carrying the end of the answer.
 */
export function createSseParser(
  onEvent: (event: SseEvent) => void,
  options: SseParserOptions = {},
): SseParser {
  const maxEventChars = options.maxEventChars ?? SSE_MAX_EVENT_CHARS;
  // The unterminated tail of the stream, as the pieces that arrived. They are
  // joined once their line ends, never earlier: a line that goes on for
  // megabytes then costs one pass over each chunk, where re-scanning (and
  // re-copying) the whole buffer on every push is quadratic in the line length.
  let pending: string[] = [];
  let pendingChars = 0;
  // Characters of `data:` the event under construction holds.
  let eventChars = 0;
  // The previous chunk ended in `\r`. That already ended its line, so a `\n`
  // that opens this chunk is the second half of the same CRLF.
  let skipLf = false;
  let eventType = '';
  let dataLines: string[] = [];
  let lastId: string | undefined;

  const tooLarge = () =>
    new ExternalAgentStreamError(`External agent stream event exceeds ${maxEventChars} characters`);

  const dispatch = () => {
    eventChars = 0;
    if (dataLines.length === 0) {
      eventType = '';
      return;
    }
    const event: SseEvent = { event: eventType || 'message', data: dataLines.join('\n') };
    if (lastId !== undefined) event.id = lastId;
    eventType = '';
    dataLines = [];
    onEvent(event);
  };

  const processLine = (line: string) => {
    if (line === '') {
      dispatch();
      return;
    }
    if (line.length > maxEventChars) throw tooLarge();
    if (line.startsWith(':')) return; // comment / keep-alive
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'event':
        eventType = value;
        break;
      case 'data':
        eventChars += value.length + 1;
        if (eventChars > maxEventChars) throw tooLarge();
        dataLines.push(value);
        break;
      case 'id':
        if (!value.includes('\0')) lastId = value;
        break;
      default:
        break; // `retry` and unknown fields
    }
  };

  /** The line a terminator just ended: what was held back plus the part of this chunk before it. */
  const takeLine = (tail: string): string => {
    if (pending.length === 0) return tail;
    pending.push(tail);
    const line = pending.join('');
    pending = [];
    pendingChars = 0;
    return line;
  };

  /** Keep the part of a line whose terminator has not arrived yet. */
  const hold = (piece: string) => {
    pendingChars += piece.length;
    if (eventChars + pendingChars > maxEventChars) throw tooLarge();
    pending.push(piece);
  };

  return {
    push(text: string) {
      let start = 0;
      if (skipLf && text.length > 0) {
        skipLf = false;
        if (text.charCodeAt(0) === LF) start = 1;
      }
      for (let i = start; i < text.length; i += 1) {
        const code = text.charCodeAt(i);
        if (code !== LF && code !== CR) continue;
        processLine(takeLine(text.slice(start, i)));
        if (code === CR) {
          if (i + 1 < text.length) {
            if (text.charCodeAt(i + 1) === LF) i += 1;
          } else {
            skipLf = true; // the chunk ends in `\r`: its `\n` may open the next one
          }
        }
        start = i + 1;
      }
      if (start < text.length) hold(text.slice(start));
    },
    flush() {
      if (pendingChars > 0) processLine(takeLine(''));
      dispatch();
    },
  };
}

/**
 * What a protocol accumulator does with one event.
 *  - `emit`: text to hand to `onTextChunk` now (may be empty);
 *  - `done`: the stream's terminal event — stop reading.
 * Throws `ExternalAgentStreamError` for an error event.
 */
export interface StreamStep {
  emit?: string;
  done?: boolean;
}

export interface ExternalStreamAccumulator {
  handle(event: SseEvent): StreamStep;
  /** The final answer, as the non-streaming extractor would have produced it. */
  content(): string;
  /**
   * Text still owed to the caller once the stream ended: the part of
   * `content()` not yet emitted, or '' when what was emitted diverged from it
   * (it can never be taken back).
   */
  remainder(): string;
  /** Everything handed out through `emit` / `remainder()` so far. */
  emitted(): string;
  /** A compact stand-in for the non-streaming `raw` response (diagnostics only). */
  raw(): unknown;
}

function parseJson(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

/** Text of a content value that is a string or an array of `{text}` parts. */
export function normalizeContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string'
          ? (c as { text: string }).text
          : '',
      )
      .filter(Boolean)
      .join('');
  }
  return '';
}

function errorMessage(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const message = (value as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
    const nested = (value as { error?: unknown }).error;
    if (nested !== undefined && nested !== value) return errorMessage(nested);
    try {
      return JSON.stringify(value).slice(0, 500);
    } catch {
      return 'unknown error';
    }
  }
  return 'unknown error';
}

/**
 * Shared bookkeeping: what was emitted, and the remainder rule (only ever
 * extend what the caller already has, never contradict it).
 */
function emissionLedger() {
  let emitted = '';
  return {
    emit(text: string): string {
      emitted += text;
      return text;
    },
    remainder(content: string): string {
      if (!content.startsWith(emitted)) return '';
      const rest = content.slice(emitted.length);
      emitted = content;
      return rest;
    },
    get emitted() {
      return emitted;
    },
  };
}

/* ── openai-chat ──────────────────────────────────────────────────────── */

/**
 * `POST /chat/completions` with `stream: true`.
 *
 * Text is `choices[0].delta.content`. A few OpenAI-compatible servers put a
 * complete `message` on a chunk instead of a delta (typically a single final
 * chunk); that is used only when no delta text arrived at all, so it can never
 * double the answer.
 */
export function createOpenAiChatAccumulator(): ExternalStreamAccumulator {
  const ledger = emissionLedger();
  let deltas = '';
  let messageFallback = '';
  let events = 0;
  let finishReason: string | undefined;

  return {
    handle(event) {
      const data = event.data.trim();
      if (data === '[DONE]') return { done: true };
      const json = parseJson(data) as Record<string, unknown> | undefined;
      if (event.event === 'error') {
        throw new ExternalAgentStreamError(`External agent stream error: ${errorMessage(json ?? data)}`);
      }
      if (!json || typeof json !== 'object') return {};
      events += 1;
      if (json.error) {
        throw new ExternalAgentStreamError(`External agent stream error: ${errorMessage(json.error)}`);
      }
      const choice = (json.choices as Array<Record<string, unknown>> | undefined)?.[0];
      if (!choice) return {};
      if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;
      const delta = normalizeContent((choice.delta as { content?: unknown } | undefined)?.content);
      if (delta) {
        deltas += delta;
        return { emit: ledger.emit(delta) };
      }
      const message = normalizeContent((choice.message as { content?: unknown } | undefined)?.content);
      if (message && !deltas) messageFallback = message;
      return {};
    },
    content() {
      return deltas || messageFallback;
    },
    remainder() {
      return ledger.remainder(this.content());
    },
    emitted() {
      return ledger.emitted;
    },
    raw() {
      return { stream: true, protocol: 'openai-chat', events, ...(finishReason ? { finish_reason: finishReason } : {}) };
    },
  };
}

/* ── openai-responses ─────────────────────────────────────────────────── */

/** Same extraction the non-streaming path applies to a full Responses object. */
export function extractOpenAiResponsesText(data: unknown): string {
  const direct = (data as { output_text?: unknown })?.output_text;
  if (typeof direct === 'string' && direct) return direct;
  const output = (data as { output?: Array<{ content?: Array<{ text?: unknown; type?: string }> }> })?.output;
  if (Array.isArray(output)) {
    const parts: string[] = [];
    for (const item of output) {
      for (const c of item.content ?? []) {
        if (typeof c.text === 'string') parts.push(c.text);
      }
    }
    if (parts.length) return parts.join('');
  }
  return '';
}

/**
 * `POST /responses` with `stream: true`.
 *
 * The event type is read from the payload's `type` (always present on OpenAI's
 * wire) and falls back to the SSE `event:` name. Text is
 * `response.output_text.delta`; the terminal `response.completed` carries the
 * full response, used for the final answer only when no delta arrived (a
 * server that sends the result in one piece).
 */
export function createOpenAiResponsesAccumulator(): ExternalStreamAccumulator {
  const ledger = emissionLedger();
  let deltas = '';
  let doneText = '';
  let finalResponse: unknown;
  let status: string | undefined;
  let events = 0;

  return {
    handle(event) {
      const data = event.data.trim();
      if (data === '[DONE]') return { done: true };
      const json = parseJson(data) as Record<string, unknown> | undefined;
      const type = typeof json?.type === 'string' ? json.type : event.event;
      if (type === 'error' || event.event === 'error') {
        throw new ExternalAgentStreamError(`External agent stream error: ${errorMessage(json ?? data)}`);
      }
      if (!json) return {};
      events += 1;
      switch (type) {
        case 'response.output_text.delta': {
          const delta = typeof json.delta === 'string' ? json.delta : '';
          if (!delta) return {};
          deltas += delta;
          return { emit: ledger.emit(delta) };
        }
        case 'response.output_text.done': {
          if (typeof json.text === 'string') doneText += json.text;
          return {};
        }
        case 'response.failed': {
          const response = json.response as { error?: unknown } | undefined;
          throw new ExternalAgentStreamError(
            `External agent response failed: ${errorMessage(response?.error ?? 'unknown error')}`,
          );
        }
        case 'response.completed':
        case 'response.incomplete': {
          finalResponse = json.response;
          status = type === 'response.completed' ? 'completed' : 'incomplete';
          return { done: true };
        }
        default:
          return {};
      }
    },
    content() {
      return deltas || doneText || extractOpenAiResponsesText(finalResponse);
    },
    remainder() {
      return ledger.remainder(this.content());
    },
    emitted() {
      return ledger.emitted;
    },
    raw() {
      return { stream: true, protocol: 'openai-responses', events, ...(status ? { status } : {}) };
    },
  };
}

/* ── a2a ──────────────────────────────────────────────────────────────── */

/** Task states after which the agent says nothing more for this request. */
const A2A_TERMINAL_STATES = new Set([
  'completed', 'failed', 'canceled', 'cancelled', 'rejected', 'input-required', 'auth-required', 'unknown',
]);

function a2aPartsText(parts: unknown): string {
  if (!Array.isArray(parts)) return '';
  return parts
    .map((p) => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string'
      ? (p as { text: string }).text
      : ''))
    .filter(Boolean)
    .join('');
}

/**
 * How much text `createA2aAccumulator` may compare in full, in total, before it
 * stops following the answer live. A server that keeps rewriting an artifact
 * (or re-sending status messages) while a large answer is held makes every one
 * of those events cost the whole answer, however small the event is. An honest
 * stream that re-sends the answer so far in every event compares about twice
 * what it receives, so the body limit keeps it well inside this.
 */
const A2A_MAX_RECHECK_CHARS = 64 * 1024 * 1024;

type A2aResultKind = 'task' | 'message' | 'status-update' | 'artifact-update' | 'unknown';

/** `kind` per A2A ≥ 0.2; inferred from the shape for servers on older drafts that omit it. */
function a2aKind(result: Record<string, unknown>): A2aResultKind {
  const kind = typeof result.kind === 'string' ? result.kind : typeof result.type === 'string' ? result.type : '';
  if (kind === 'task' || kind === 'message' || kind === 'status-update' || kind === 'artifact-update') return kind;
  if (result.artifact && typeof result.artifact === 'object') return 'artifact-update';
  if (Array.isArray(result.parts) && typeof result.role === 'string') return 'message';
  if (result.status && typeof result.status === 'object') {
    return typeof result.taskId === 'string' && !Array.isArray(result.artifacts) ? 'status-update' : 'task';
  }
  return 'unknown';
}

/**
 * `message/stream` (A2A JSON-RPC over SSE).
 *
 * What counts as THE ANSWER follows the non-streaming extractor exactly
 * (`extractA2aText`): a direct Message reply, else the task's artifacts (joined
 * by a newline), else the last status message. Emission is built on that:
 *
 *  - artifact text streams as it arrives (`append: true` extends an artifact;
 *    a repeated non-append update replaces it and only a pure extension is
 *    emitted);
 *  - a status message is emitted when it ENDS the task (`final: true` or a
 *    terminal state) and no artifact carried the answer — the a2a-js pattern
 *    where the completed status message is the reply;
 *  - `working` status messages are progress notes ("Looking up the exchange
 *    rates…") in the common agent frameworks, not the answer, so they are not
 *    streamed; when nothing else ever arrives the last one becomes the answer
 *    and `remainder()` delivers it.
 */
export function createA2aAccumulator(): ExternalStreamAccumulator {
  const ledger = emissionLedger();
  const artifactOrder: string[] = [];
  const artifacts = new Map<string, string>();
  let nonEmptyArtifacts = 0;
  let statusText = '';
  let messageText = '';
  let lastState: string | undefined;
  let events = 0;
  // `ledger.emitted === content()`: everything the answer says so far went out.
  // Only then can text that merely GREW at the tail of the answer be emitted
  // as it is, without reading the whole answer again (`emitAppended`).
  let inSync = true;
  // What `emitTowardsContent` has compared so far (see A2A_MAX_RECHECK_CHARS).
  let recheckedChars = 0;

  const artifactsText = () => artifactOrder.map((id) => artifacts.get(id) ?? '').filter(Boolean).join('\n');

  const content = () => messageText || artifactsText() || statusText;

  /**
   * Emit whatever extends what the caller already has towards `content()`.
   * This reads the whole answer, so it is for the events that are not a plain
   * tail append, and it is budgeted: past `A2A_MAX_RECHECK_CHARS` the answer is
   * no longer followed live, and `remainder()` hands out what is owed once the
   * stream ends — the same fallback as for an answer that never streamed.
   */
  const emitTowardsContent = (): StreamStep => {
    if (recheckedChars > A2A_MAX_RECHECK_CHARS) {
      inSync = false;
      return {};
    }
    const target = content();
    recheckedChars += target.length + ledger.emitted.length;
    if (!target.startsWith(ledger.emitted)) {
      inSync = false;
      return {};
    }
    inSync = true;
    const rest = target.slice(ledger.emitted.length);
    return rest ? { emit: ledger.emit(rest) } : {};
  };

  /**
   * `content()` just grew by `text` at its very end — the case a streamed
   * answer is almost entirely made of. With everything before it already out,
   * `text` is exactly what is owed, and re-reading the answer for every token
   * would make a long one cost the square of its length.
   */
  const emitAppended = (text: string): StreamStep =>
    inSync ? { emit: ledger.emit(text) } : emitTowardsContent();

  /** Returns the appended text when the update only extended the end of `content()`. */
  const applyArtifact = (artifact: Record<string, unknown>, append: boolean, index: number): string | undefined => {
    const id = typeof artifact.artifactId === 'string'
      ? artifact.artifactId
      : typeof artifact.name === 'string' ? `name:${artifact.name}` : `index:${index}`;
    const text = a2aPartsText(artifact.parts);
    if (!artifacts.has(id)) artifactOrder.push(id);
    const previous = artifacts.get(id) ?? '';
    const next = append ? previous + text : text;
    artifacts.set(id, next);
    nonEmptyArtifacts += (next !== '' ? 1 : 0) - (previous !== '' ? 1 : 0);
    // The answer is the artifacts joined in order: it only grows at its end
    // when the LAST artifact (one that already had text) was extended — and no
    // message outranks the artifacts.
    return append && text !== '' && previous !== '' && messageText === '' && artifactOrder[artifactOrder.length - 1] === id
      ? text
      : undefined;
  };

  const applyStatus = (status: Record<string, unknown> | undefined) => {
    if (!status) return;
    if (typeof status.state === 'string') lastState = status.state;
    const message = status.message as Record<string, unknown> | undefined;
    const text = a2aPartsText(message?.parts);
    if (!text) return;
    // The status text is the answer only while nothing outranks it.
    if (text !== statusText && messageText === '' && nonEmptyArtifacts === 0) inSync = false;
    statusText = text;
  };

  return {
    handle(event) {
      const json = parseJson(event.data.trim()) as Record<string, unknown> | undefined;
      if (!json || typeof json !== 'object') return {};
      events += 1;
      if (json.error) {
        throw new ExternalAgentStreamError(`A2A error: ${errorMessage(json.error)}`);
      }
      const result = (json.result ?? json) as Record<string, unknown>;
      if (!result || typeof result !== 'object') return {};

      switch (a2aKind(result)) {
        case 'message': {
          const text = a2aPartsText(result.parts);
          // A second piece of a message that already had text lands at its end.
          const growsTail = text !== '' && messageText !== '';
          if (text) messageText += text;
          return {
            ...(growsTail ? emitAppended(text) : emitTowardsContent()),
            done: result.final === true ? true : undefined,
          };
        }
        case 'artifact-update': {
          const appended = applyArtifact(
            result.artifact as Record<string, unknown>,
            result.append === true,
            artifactOrder.length,
          );
          return appended !== undefined ? emitAppended(appended) : emitTowardsContent();
        }
        case 'task': {
          if (Array.isArray(result.artifacts)) {
            (result.artifacts as Array<Record<string, unknown>>).forEach((artifact, index) => {
              if (artifact && typeof artifact === 'object') applyArtifact(artifact, false, index);
            });
          }
          applyStatus(result.status as Record<string, unknown> | undefined);
          const terminal = lastState !== undefined && A2A_TERMINAL_STATES.has(lastState);
          // Artifacts are always answer text; a status message only once it ends the task.
          if (artifactOrder.length > 0 || terminal) return { ...emitTowardsContent(), done: terminal || undefined };
          return {};
        }
        case 'status-update': {
          applyStatus(result.status as Record<string, unknown> | undefined);
          const terminal = result.final === true || (lastState !== undefined && A2A_TERMINAL_STATES.has(lastState));
          if (!terminal) return {};
          return { ...emitTowardsContent(), done: true };
        }
        default:
          return {};
      }
    },
    content,
    remainder() {
      return ledger.remainder(content());
    },
    emitted() {
      return ledger.emitted;
    },
    raw() {
      return { stream: true, protocol: 'a2a', events, ...(lastState ? { state: lastState } : {}) };
    },
  };
}

/* ── Reading a body ───────────────────────────────────────────────────── */

export interface ReadEventStreamOptions {
  signal?: AbortSignal;
  /** Give up when the server sends nothing at all for this long. */
  idleTimeoutMs: number;
  /**
   * Give up once the body is longer than this many bytes. A server that never
   * pauses never trips `idleTimeoutMs`, and every byte it sends is decoded,
   * parsed and (as text) kept by the accumulator.
   */
  maxBodyBytes: number;
  /** Give up when the body takes longer than this in total, however steadily it flows. */
  maxDurationMs: number;
  /** Largest single event; defaults to {@link SSE_MAX_EVENT_CHARS}. */
  maxEventChars?: number;
}

/**
 * Pumps an SSE body through `onEvent` until the stream ends, `onEvent` returns
 * `true` (terminal event), the caller aborts, or the server goes silent for
 * `idleTimeoutMs`.
 *
 * Resolves `{ aborted: true }` on abort rather than rejecting — an aborted
 * agent turn resolves with what it had (see `AgentPlaygroundChatRequest.signal`).
 * The reader is cancelled on every early exit, which closes the upstream
 * connection: an agent that keeps generating after we stopped listening would
 * otherwise keep billing for an answer nobody reads.
 *
 * `safeFetch` only bounds the time to the response HEADERS; the body of a
 * long-running stream needs its own bounds, which these are: silence
 * (`idleTimeoutMs`), size (`maxBodyBytes`, `maxEventChars`) and total time
 * (`maxDurationMs`). Breaking any of them rejects with an
 * `ExternalAgentStreamError` — a stream that does that is a fault of the
 * agent, not a caller abort.
 */
export async function readEventStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: SseEvent) => boolean | void,
  options: ReadEventStreamOptions,
): Promise<{ aborted: boolean }> {
  const { signal, idleTimeoutMs, maxBodyBytes, maxDurationMs, maxEventChars } = options;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let stop = false;
  let finished = false;
  let timedOut = false;
  let overran = false;
  let received = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let durationTimer: ReturnType<typeof setTimeout> | undefined;

  const parser = createSseParser(
    (event) => {
      if (stop) return;
      if (onEvent(event) === true) stop = true;
    },
    maxEventChars === undefined ? {} : { maxEventChars },
  );

  const cancelReader = () => {
    reader.cancel().catch(() => {
      /* the connection is going away either way */
    });
  };
  const armIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timedOut = true;
      cancelReader();
    }, idleTimeoutMs);
    idleTimer.unref?.();
  };
  const onAbort = () => cancelReader();

  if (signal?.aborted) {
    cancelReader();
    return { aborted: true };
  }
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    armIdleTimer();
    durationTimer = setTimeout(() => {
      overran = true;
      cancelReader();
    }, maxDurationMs);
    durationTimer.unref?.();
    while (!stop) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        if (signal?.aborted) return { aborted: true };
        if (timedOut || overran) break;
        throw error;
      }
      if (signal?.aborted) return { aborted: true };
      if (chunk.done) {
        finished = true;
        break;
      }
      received += chunk.value.byteLength;
      if (received > maxBodyBytes) {
        throw new ExternalAgentStreamError(`External agent stream exceeds ${maxBodyBytes} bytes`);
      }
      armIdleTimer();
      parser.push(decoder.decode(chunk.value, { stream: true }));
    }
    if (overran && !stop) {
      throw new ExternalAgentStreamError(
        `External agent stream ran longer than ${Math.round(maxDurationMs / 1000)}s`,
      );
    }
    if (timedOut && !stop) {
      throw new ExternalAgentStreamError(
        `External agent stream stalled: no data for ${Math.round(idleTimeoutMs / 1000)}s`,
      );
    }
    if (!stop) {
      parser.push(decoder.decode());
      parser.flush();
    }
    return { aborted: false };
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    if (durationTimer) clearTimeout(durationTimer);
    signal?.removeEventListener('abort', onAbort);
    if (!finished) cancelReader();
  }
}
