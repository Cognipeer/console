/**
 * External (connected) agent client.
 *
 * Connected agents are invoked over HTTP using one of the supported wire
 * protocols (a2a / openai-chat / openai-responses) instead of being run through
 * the local agent-sdk. This module resolves credentials and performs the call,
 * normalizing every protocol down to a single assistant-text reply.
 *
 * NO GUARDRAIL RUNS IN HERE. The caller owns enforcement: `agentService` fires
 * `input.pre` on the message before it is handed to `invokeExternalAgent` and
 * `output.pre` on the returned content before it is persisted or returned. The
 * split is deliberate — the hooks need the agent's bindings and tenant scope,
 * which this transport has no business resolving, and putting a second
 * evaluation here would double-log and double-bill the model-backed families.
 * `tool.pre` / `tool.post` are not enforceable on this path at all: the remote
 * agent runs its own tools and only the final text comes back.
 *
 * STREAMING. Given an `onTextChunk`, the call asks the agent to stream (SSE —
 * see `externalAgentStream.ts` for the per-protocol wire formats) and hands
 * each piece of text over as it arrives. Those chunks are RAW: they leave
 * before the caller's `output.pre` check runs on the complete answer, exactly
 * like an internal agent's streamed tokens precede its post-hoc check. A
 * response that is not `text/event-stream` (the agent ignored `stream`, or the
 * protocol fell back) is parsed as before and NOT emitted here — `streamed:
 * false` tells the caller to emit the guarded answer itself, in one piece.
 */

import { createLogger } from '@/lib/core/logger';
import { safeFetch } from '@/lib/security/outboundFetch';
import { decryptObject, encryptObject } from '@/lib/utils/crypto';
import { loadProviderRuntimeData } from '@/lib/services/providers/providerService';
import type { ExternalAgentProtocol, IExternalAgentConnection } from '@/lib/database';
import {
  createA2aAccumulator,
  createOpenAiChatAccumulator,
  createOpenAiResponsesAccumulator,
  extractOpenAiResponsesText,
  normalizeContent,
  readEventStream,
  type ExternalStreamAccumulator,
} from './externalAgentStream';

const logger = createLogger('agents:external');

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * A streaming body that goes quiet for this long is abandoned. Same budget as
 * the request timeout: an agent running a slow tool sends nothing meanwhile,
 * and it must get as long to do that streamed as it would have unstreamed.
 */
const STREAM_IDLE_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;

/**
 * The idle bound only covers silence. The endpoint is a URL a project member
 * chose, so a stream that never pauses is bounded separately — in time and in
 * size — instead of being read until the process runs out of memory.
 *
 * Time: no longer than a whole synchronous agent turn may run
 * (`AGENT_SYNC_TIMEOUT_MS`, 10 minutes by default). Size: ~80 000 OpenAI-style
 * token deltas (≈200 bytes each), far past any model's output limit; the
 * accumulators keep the extracted text, so this also bounds what a hostile
 * stream can make us hold.
 */
const STREAM_MAX_DURATION_MS = 10 * 60_000;
const STREAM_MAX_BODY_BYTES = 16 * 1024 * 1024;

/**
 * Endpoints that told us they cannot stream, remembered so the next turn does
 * not pay a failed round trip first. Per process, short-lived: a deployment
 * that gains streaming support is picked up within the TTL.
 *
 * Scoped to the tenant and the full connection (protocol, URL, model): a
 * verdict one tenant provokes on a shared gateway URL never turns streaming
 * off for another tenant, or for another model on the same endpoint.
 */
const STREAM_UNSUPPORTED_TTL_MS = 10 * 60_000;
const streamUnsupported = new Map<string, number>();

function streamSupportKey(connection: IExternalAgentConnection, ctx: ExternalAgentContext): string {
  return [ctx.tenantId, connection.protocol, connection.url, connection.model ?? ''].join('\u0000');
}

function isStreamKnownUnsupported(connection: IExternalAgentConnection, ctx: ExternalAgentContext): boolean {
  const key = streamSupportKey(connection, ctx);
  const until = streamUnsupported.get(key);
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  streamUnsupported.delete(key);
  return false;
}

function markStreamUnsupported(connection: IExternalAgentConnection, ctx: ExternalAgentContext): void {
  // Bounded: a tenant cannot grow this map without limit by cycling URLs.
  if (streamUnsupported.size >= 1_000) streamUnsupported.clear();
  streamUnsupported.set(streamSupportKey(connection, ctx), Date.now() + STREAM_UNSUPPORTED_TTL_MS);
}

/** EXPORTED FOR TESTS — forget every remembered "cannot stream" verdict. */
export function resetExternalStreamSupportCache(): void {
  streamUnsupported.clear();
}

const SUPPORTED_PROTOCOLS: ExternalAgentProtocol[] = ['a2a', 'openai-chat', 'openai-responses'];

/**
 * Normalize a raw connection payload (from the API/client) into the stored shape:
 * validates the protocol, encrypts an inline `apiKey` into `apiKeyEnc`, and drops
 * empty fields. Throws on invalid input.
 */
export function prepareConnectionForStorage(input: unknown): IExternalAgentConnection {
  if (!input || typeof input !== 'object') {
    throw new Error('Connection settings are required for a connected agent');
  }
  const raw = input as Record<string, unknown>;
  const protocol = raw.protocol as ExternalAgentProtocol;
  if (!SUPPORTED_PROTOCOLS.includes(protocol)) {
    throw new Error(`Unsupported connected agent protocol: ${String(raw.protocol)}`);
  }
  const url = typeof raw.url === 'string' ? raw.url.trim() : '';
  if (!url) throw new Error('Connected agent endpoint URL is required');

  const conn: IExternalAgentConnection = { protocol, url };

  if (typeof raw.model === 'string' && raw.model.trim()) conn.model = raw.model.trim();
  if ((protocol === 'openai-chat' || protocol === 'openai-responses') && !conn.model) {
    throw new Error('Model id is required for OpenAI-compatible connected agents');
  }
  if (raw.headers && typeof raw.headers === 'object') {
    const entries = Object.entries(raw.headers as Record<string, unknown>)
      .filter(([k, v]) => k.trim() && typeof v === 'string' && v.trim())
      .map(([k, v]) => [k.trim(), (v as string).trim()] as const);
    if (entries.length) conn.headers = Object.fromEntries(entries);
  }
  if (typeof raw.responsePath === 'string' && raw.responsePath.trim()) {
    conn.responsePath = raw.responsePath.trim();
  }
  if (typeof raw.credentialProviderKey === 'string' && raw.credentialProviderKey.trim()) {
    conn.credentialProviderKey = raw.credentialProviderKey.trim();
  }
  if (raw.runtimeHeaders && typeof raw.runtimeHeaders === 'object') {
    const policy = raw.runtimeHeaders as Record<string, unknown>;
    conn.runtimeHeaders = {
      allow: policy.allow === true,
      ...(Array.isArray(policy.allowedNames)
        ? { allowedNames: policy.allowedNames.filter((n): n is string => typeof n === 'string' && !!n.trim()) }
        : {}),
    };
  }

  const rawKey = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '';
  if (rawKey) {
    conn.apiKeyEnc = encryptObject(rawKey);
  } else if (typeof raw.apiKeyEnc === 'string' && raw.apiKeyEnc) {
    // Preserve an already-encrypted key on update when the client doesn't resend it.
    conn.apiKeyEnc = raw.apiKeyEnc;
  }

  return conn;
}

export interface ExternalChatMessage {
  role: string;
  content: string;
}

export interface ExternalAgentContext {
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
}

/** Resolve the bearer token for a connection from inline key or provider reference. */
async function resolveApiKey(
  connection: IExternalAgentConnection,
  ctx: ExternalAgentContext,
): Promise<string | undefined> {
  if (connection.credentialProviderKey) {
    try {
      const { credentials } = await loadProviderRuntimeData<Record<string, unknown>>(
        ctx.tenantDbName,
        {
          key: connection.credentialProviderKey,
          tenantId: ctx.tenantId,
          projectId: ctx.projectId,
        },
      );
      const fromProvider = pickCredentialValue(credentials);
      if (fromProvider) return fromProvider;
    } catch (error) {
      logger.warn('Failed to resolve provider credentials for connected agent', {
        providerKey: connection.credentialProviderKey,
        error,
      });
    }
  }

  if (connection.apiKeyEnc) {
    try {
      return decryptObject<string>(connection.apiKeyEnc);
    } catch (error) {
      logger.warn('Failed to decrypt inline API key for connected agent', { error });
    }
  }

  return undefined;
}

function pickCredentialValue(credentials: Record<string, unknown>): string | undefined {
  for (const field of ['apiKey', 'api_key', 'token', 'accessToken', 'key', 'secret']) {
    const value = credentials[field];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

async function buildHeaders(
  connection: IExternalAgentConnection,
  ctx: ExternalAgentContext,
  runtimeHeaders?: Record<string, string>,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(connection.headers ?? {}),
  };

  const hasAuthHeader = Object.keys(headers).some((h) => h.toLowerCase() === 'authorization');
  if (!hasAuthHeader) {
    const apiKey = await resolveApiKey(connection, ctx);
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  }

  // Caller-supplied runtime headers (already policy-filtered) win over static config.
  Object.assign(headers, runtimeHeaders);

  return headers;
}

/** Extract a value from an object using a dot-path (supports [index] segments). */
function extractByPath(source: unknown, path: string): unknown {
  return path
    .split('.')
    .flatMap((seg) => seg.split(/\[(\d+)\]/).filter(Boolean))
    .reduce<unknown>((acc, key) => {
      if (acc == null) return undefined;
      const idx = Number(key);
      if (!Number.isNaN(idx) && Array.isArray(acc)) return acc[idx];
      if (typeof acc === 'object') return (acc as Record<string, unknown>)[key];
      return undefined;
    }, source);
}

function joinUrl(base: string, suffix: string): string {
  const trimmed = base.replace(/\/+$/, '');
  if (trimmed.endsWith(suffix)) return trimmed;
  return `${trimmed}${suffix}`;
}

function httpError(status: number, json: unknown): Error {
  const detail = typeof json === 'string' ? json : JSON.stringify(json);
  return new Error(`External agent returned ${status}: ${detail?.slice(0, 500)}`);
}

async function postRequest(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  return safeFetch(
    url,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    },
    { timeoutMs: DEFAULT_TIMEOUT_MS },
  );
}

/**
 * The whole body as text, or `null` when the caller aborted while it was
 * still arriving. `safeFetch` stops listening to the caller's signal once the
 * headers are in, so the body read has to watch it itself — cancelling the
 * reader, which also drops the upstream connection.
 */
async function readTextAbortable(res: Response, signal?: AbortSignal): Promise<string | null> {
  if (!signal || !res.body) return res.text();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const onAbort = () => {
    reader.cancel().catch(() => {
      /* closing regardless */
    });
  };
  if (signal.aborted) {
    onAbort();
    return null;
  }
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    let text = '';
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        if (signal.aborted) return null;
        throw error;
      }
      if (signal.aborted) return null;
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** Parsed JSON when the body is JSON, the raw text otherwise; `null` = aborted. */
async function readBody(res: Response, signal?: AbortSignal): Promise<{ json: unknown } | null> {
  const text = await readTextAbortable(res, signal);
  if (text === null) return null;
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { json };
}

function isEventStream(res: Response): boolean {
  return (res.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream');
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((h) => h.toLowerCase() === lower);
}

/* ── Protocol response extractors ─────────────────────────────────────── */

function extractOpenAiChatText(data: unknown): string {
  const choices = (data as { choices?: Array<{ message?: { content?: unknown } }> })?.choices;
  const content = choices?.[0]?.message?.content;
  return normalizeContent(content);
}

function extractA2aText(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const r = result as Record<string, unknown>;

  const collectParts = (parts: unknown): string => {
    if (!Array.isArray(parts)) return '';
    return parts
      .map((p) => {
        if (p && typeof p === 'object') {
          const part = p as Record<string, unknown>;
          if (typeof part.text === 'string') return part.text;
        }
        return '';
      })
      .filter(Boolean)
      .join('');
  };

  // result is a Message
  if (Array.isArray(r.parts)) {
    const text = collectParts(r.parts);
    if (text) return text;
  }
  // result is a Task — prefer artifacts, fall back to status message
  if (Array.isArray(r.artifacts)) {
    const text = (r.artifacts as Array<Record<string, unknown>>)
      .map((a) => collectParts(a.parts))
      .filter(Boolean)
      .join('\n');
    if (text) return text;
  }
  const status = r.status as Record<string, unknown> | undefined;
  const statusMessage = status?.message as Record<string, unknown> | undefined;
  if (statusMessage && Array.isArray(statusMessage.parts)) {
    const text = collectParts(statusMessage.parts);
    if (text) return text;
  }
  return '';
}

function extractA2aResponseText(data: unknown): string {
  const result = (data as { result?: unknown })?.result;
  const err = (data as { error?: { message?: string } })?.error;
  if (err) throw new Error(`A2A error: ${err.message ?? 'unknown'}`);
  return extractA2aText(result);
}

/* ── Requests ─────────────────────────────────────────────────────────── */

interface ProtocolRequest {
  url: string;
  body: Record<string, unknown>;
  extract: (data: unknown) => string;
}

/** The wire request for one turn; `stream` switches each protocol to its streaming form. */
function buildProtocolRequest(
  connection: IExternalAgentConnection,
  messages: ExternalChatMessage[],
  stream: boolean,
): ProtocolRequest {
  switch (connection.protocol) {
    case 'openai-chat':
      return {
        url: joinUrl(connection.url, '/chat/completions'),
        body: { model: connection.model, messages, ...(stream ? { stream: true } : {}) },
        extract: extractOpenAiChatText,
      };
    case 'openai-responses':
      return {
        url: joinUrl(connection.url, '/responses'),
        body: {
          model: connection.model,
          input: messages.map((m) => ({ role: m.role, content: m.content })),
          ...(stream ? { stream: true } : {}),
        },
        extract: extractOpenAiResponsesText,
      };
    case 'a2a': {
      // A2A message/send carries a single message; fold prior turns into the
      // text so context survives without a persisted contextId (stateless v1).
      const text = foldConversationForA2a(messages);
      return {
        url: connection.url,
        body: {
          jsonrpc: '2.0',
          id: `req-${messages.length}`,
          method: stream ? 'message/stream' : 'message/send',
          params: {
            message: {
              role: 'user',
              parts: [{ kind: 'text', text }],
              messageId: `msg-${messages.length}`,
            },
          },
        },
        extract: extractA2aResponseText,
      };
    }
    default:
      throw new Error(`Unsupported connected agent protocol: ${connection.protocol}`);
  }
}

function streamAccumulatorFor(protocol: ExternalAgentProtocol): ExternalStreamAccumulator {
  switch (protocol) {
    case 'openai-chat':
      return createOpenAiChatAccumulator();
    case 'openai-responses':
      return createOpenAiResponsesAccumulator();
    case 'a2a':
      return createA2aAccumulator();
    default:
      throw new Error(`Unsupported connected agent protocol: ${String(protocol)}`);
  }
}

function extractContent(
  connection: IExternalAgentConnection,
  request: ProtocolRequest,
  data: unknown,
): string {
  if (connection.responsePath) {
    const picked = extractByPath(data, connection.responsePath);
    return typeof picked === 'string' ? picked : normalizeContent(picked);
  }
  return request.extract(data);
}

/** JSON-RPC "Method not found" and A2A "UnsupportedOperationError". */
const A2A_STREAM_REFUSAL_CODES = new Set([-32601, -32004]);

/**
 * Error text that rejects the `stream` PARAMETER / streaming itself:
 * "Unsupported parameter: 'stream'", "Streaming is not supported",
 * "this endpoint does not support streaming". Text that merely contains
 * "stream" — a model named `stream-me` that does not exist — does not match.
 */
const STREAM_PARAMETER_REFUSAL =
  /(unsupported|unknown|unrecognized|unexpected|invalid|extra)[^.\n]{0,24}(parameter|field|argument|key|property|option)s?[^.\n]{0,8}['"`]?stream['"`]?(?![\w-])|\bstream(ing)?['"`]?\s+(is\s+|are\s+)?(not\s+(supported|allowed|available|implemented|permitted)|unsupported|disabled)|(does\s+not|doesn't|cannot|can't|do\s+not)\s+support\s+stream(ing)?\b/i;

/** OpenAI-style `error.param === 'stream'`, or a validation error located at `stream`. */
function namesStreamParameter(json: unknown): boolean {
  if (!json || typeof json !== 'object') return false;
  const error = (json as { error?: unknown }).error;
  if (error && typeof error === 'object' && (error as { param?: unknown }).param === 'stream') return true;
  const detail = (json as { detail?: unknown }).detail;
  return Array.isArray(detail) && detail.some((entry) => {
    const loc = (entry as { loc?: unknown } | null)?.loc;
    return Array.isArray(loc) && loc[loc.length - 1] === 'stream';
  });
}

/**
 * Did the agent refuse the STREAMING form of the call (as opposed to failing
 * the turn)? Only then is the non-streaming request worth sending — retrying a
 * real failure would just run the turn twice.
 */
function isStreamingRefusal(
  connection: IExternalAgentConnection,
  res: Response,
  json: unknown,
): boolean {
  if (connection.protocol === 'a2a') {
    const code = (json as { error?: { code?: unknown } } | undefined)?.error?.code;
    return typeof code === 'number' && A2A_STREAM_REFUSAL_CODES.has(code);
  }
  if (res.ok || ![400, 404, 405, 415, 422, 501].includes(res.status)) return false;
  if (namesStreamParameter(json)) return true;
  const detail = typeof json === 'string' ? json : JSON.stringify(json ?? '');
  return STREAM_PARAMETER_REFUSAL.test(detail);
}

/* ── Public invoke ───────────────────────────────────────────────────── */

export interface InvokeExternalAgentOptions {
  /**
   * Receives the answer as it is written. Turns the call into a streaming one
   * (SSE) for every protocol that can; see the module comment for what is and
   * is not emitted through it.
   */
  onTextChunk?: (text: string) => void;
  /**
   * Aborts the call — while connecting, waiting, or mid-stream. An aborted
   * call RESOLVES with `cancelled: true` and the text already emitted.
   */
  signal?: AbortSignal;
}

export interface InvokeExternalAgentResult {
  content: string;
  raw: unknown;
  /**
   * The answer arrived as an event stream and went out through `onTextChunk`
   * piece by piece. False/absent: nothing was emitted — the caller emits the
   * (guarded) answer itself if it wants one.
   */
  streamed?: boolean;
  /** The caller's signal ended the call; `content` is what had been emitted by then. */
  cancelled?: boolean;
}

function cancelledResult(content: string, raw: unknown, streamed: boolean): InvokeExternalAgentResult {
  return { content, raw, streamed, cancelled: true };
}

/**
 * The streaming attempt. Resolves `null` when the agent refused to stream, so
 * the caller can repeat the turn in its non-streaming form.
 */
async function invokeStreaming(
  connection: IExternalAgentConnection,
  ctx: ExternalAgentContext,
  messages: ExternalChatMessage[],
  headers: Record<string, string>,
  onTextChunk: (text: string) => void,
  signal: AbortSignal | undefined,
): Promise<InvokeExternalAgentResult | null> {
  const request = buildProtocolRequest(connection, messages, true);
  const streamHeaders = hasHeader(headers, 'accept') ? headers : { ...headers, Accept: 'text/event-stream' };
  const res = await postRequest(request.url, streamHeaders, request.body, signal);

  if (!isEventStream(res)) {
    // One JSON document: the agent ignored `stream`, refused it, or failed.
    const body = await readBody(res, signal);
    if (body === null) return cancelledResult('', undefined, false);
    if (isStreamingRefusal(connection, res, body.json)) {
      markStreamUnsupported(connection, ctx);
      logger.info('Connected agent cannot stream; falling back to a single response', {
        protocol: connection.protocol,
        status: res.status,
      });
      return null;
    }
    if (!res.ok) throw httpError(res.status, body.json);
    return { content: extractContent(connection, request, body.json), raw: body.json, streamed: false };
  }

  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => undefined);
    throw httpError(res.status, 'event stream');
  }

  const accumulator = streamAccumulatorFor(connection.protocol);
  const deliver = (text: string | undefined) => {
    if (!text) return;
    try {
      onTextChunk(text);
    } catch (callbackError) {
      logger.warn('onTextChunk callback failed', { protocol: connection.protocol, error: callbackError });
    }
  };

  const { aborted } = await readEventStream(
    res.body,
    (event) => {
      const step = accumulator.handle(event);
      deliver(step.emit);
      return step.done === true;
    },
    {
      signal,
      idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
      maxBodyBytes: STREAM_MAX_BODY_BYTES,
      maxDurationMs: STREAM_MAX_DURATION_MS,
    },
  );
  if (aborted) return cancelledResult(accumulator.emitted(), accumulator.raw(), true);

  deliver(accumulator.remainder());
  return { content: accumulator.content(), raw: accumulator.raw(), streamed: true };
}

/**
 * Invoke a connected agent and return the normalized assistant text.
 * `messages` is the full conversation (system/user/assistant) in order.
 *
 * With `options.onTextChunk` the agent is asked to stream (unless its
 * connection maps a custom `responsePath`, which names a field of one JSON
 * document a stream does not have). The SSRF guard covers every request,
 * streamed or not: all of them go through `safeFetch`.
 */
export async function invokeExternalAgent(
  connection: IExternalAgentConnection,
  messages: ExternalChatMessage[],
  ctx: ExternalAgentContext,
  runtimeHeaders?: Record<string, string>,
  options: InvokeExternalAgentOptions = {},
): Promise<InvokeExternalAgentResult> {
  if (!connection.url) throw new Error('Connected agent has no endpoint URL configured');
  const { onTextChunk, signal } = options;
  if (signal?.aborted) return cancelledResult('', undefined, false);
  const headers = await buildHeaders(connection, ctx, runtimeHeaders);

  const wantStream = Boolean(onTextChunk)
    && !connection.responsePath
    && !isStreamKnownUnsupported(connection, ctx);

  let result: InvokeExternalAgentResult | null = null;
  try {
    if (wantStream && onTextChunk) {
      result = await invokeStreaming(connection, ctx, messages, headers, onTextChunk, signal);
    }
    if (!result) {
      const request = buildProtocolRequest(connection, messages, false);
      const res = await postRequest(request.url, headers, request.body, signal);
      const body = await readBody(res, signal);
      if (body === null) {
        result = cancelledResult('', undefined, false);
      } else {
        if (!res.ok) throw httpError(res.status, body.json);
        result = { content: extractContent(connection, request, body.json), raw: body.json, streamed: false };
      }
    }
  } catch (error) {
    // Aborted before any text arrived (connecting / waiting for headers):
    // the fetch rejects, but an aborted turn resolves.
    if (signal?.aborted) {
      result = cancelledResult('', undefined, false);
    } else {
      throw error;
    }
  }

  logger.info(result.cancelled ? 'Connected agent call cancelled' : 'Connected agent invoked', {
    protocol: connection.protocol,
    chars: result.content.length,
    streamed: result.streamed === true,
  });

  return result;
}

function foldConversationForA2a(messages: ExternalChatMessage[]): string {
  const userOnly = messages.filter((m) => m.role !== 'system');
  if (userOnly.length <= 1) {
    return userOnly[userOnly.length - 1]?.content ?? '';
  }
  // Multiple turns: render a compact transcript, last user message highlighted.
  return userOnly
    .map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`)
    .join('\n');
}
