/**
 * External (connected) agent client.
 *
 * Connected agents are invoked over HTTP using one of the supported wire
 * protocols (a2a / openai-chat / openai-responses) instead of being run through
 * the local agent-sdk. This module resolves credentials and performs the call,
 * normalizing every protocol down to a single assistant-text reply.
 */

import { createLogger } from '@/lib/core/logger';
import { decryptObject, encryptObject } from '@/lib/utils/crypto';
import { loadProviderRuntimeData } from '@/lib/services/providers/providerService';
import type { ExternalAgentProtocol, IExternalAgentConnection } from '@/lib/database';

const logger = createLogger('agents:external');

const DEFAULT_TIMEOUT_MS = 120_000;

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

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    if (!res.ok) {
      const detail = typeof json === 'string' ? json : JSON.stringify(json);
      throw new Error(`External agent returned ${res.status}: ${detail?.slice(0, 500)}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/* ── Protocol response extractors ─────────────────────────────────────── */

function extractOpenAiChatText(data: unknown): string {
  const choices = (data as { choices?: Array<{ message?: { content?: unknown } }> })?.choices;
  const content = choices?.[0]?.message?.content;
  return normalizeContent(content);
}

function extractOpenAiResponsesText(data: unknown): string {
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

function normalizeContent(content: unknown): string {
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

/* ── Public invoke ───────────────────────────────────────────────────── */

export interface InvokeExternalAgentResult {
  content: string;
  raw: unknown;
}

/**
 * Invoke a connected agent and return the normalized assistant text.
 * `messages` is the full conversation (system/user/assistant) in order.
 */
export async function invokeExternalAgent(
  connection: IExternalAgentConnection,
  messages: ExternalChatMessage[],
  ctx: ExternalAgentContext,
): Promise<InvokeExternalAgentResult> {
  if (!connection.url) throw new Error('Connected agent has no endpoint URL configured');
  const headers = await buildHeaders(connection, ctx);

  let url: string;
  let body: unknown;
  let extract: (data: unknown) => string;

  switch (connection.protocol) {
    case 'openai-chat': {
      url = joinUrl(connection.url, '/chat/completions');
      body = { model: connection.model, messages };
      extract = extractOpenAiChatText;
      break;
    }
    case 'openai-responses': {
      url = joinUrl(connection.url, '/responses');
      body = {
        model: connection.model,
        input: messages.map((m) => ({ role: m.role, content: m.content })),
      };
      extract = extractOpenAiResponsesText;
      break;
    }
    case 'a2a': {
      url = connection.url;
      // A2A message/send carries a single message; fold prior turns into the
      // text so context survives without a persisted contextId (stateless v1).
      const text = foldConversationForA2a(messages);
      body = {
        jsonrpc: '2.0',
        id: `req-${messages.length}`,
        method: 'message/send',
        params: {
          message: {
            role: 'user',
            parts: [{ kind: 'text', text }],
            messageId: `msg-${messages.length}`,
          },
        },
      };
      extract = (data) => {
        const result = (data as { result?: unknown })?.result;
        const err = (data as { error?: { message?: string } })?.error;
        if (err) throw new Error(`A2A error: ${err.message ?? 'unknown'}`);
        return extractA2aText(result);
      };
      break;
    }
    default:
      throw new Error(`Unsupported connected agent protocol: ${connection.protocol}`);
  }

  const data = await postJson(url, headers, body);

  let content: string;
  if (connection.responsePath) {
    const picked = extractByPath(data, connection.responsePath);
    content = typeof picked === 'string' ? picked : normalizeContent(picked);
  } else {
    content = extract(data);
  }

  logger.info('Connected agent invoked', {
    protocol: connection.protocol,
    chars: content.length,
  });

  return { content, raw: data };
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
