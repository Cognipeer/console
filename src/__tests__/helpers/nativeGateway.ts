/**
 * Fetch-level harness for the gateway: the REAL provider contract runtime and the
 * REAL agent-sdk provider run, and only the network is scripted. A test says what
 * the upstream answers (an OpenAI-shaped JSON or SSE body) and asserts what the
 * upstream received (the wire request) and what the gateway returned.
 */
import { vi } from 'vitest';
import {
  AnthropicModelProviderContract,
  BedrockModelProviderContract,
  OpenAiCompatibleModelProviderContract,
  OpenAiModelProviderContract,
} from '@/lib/providers/contracts/modelContracts';
import type { ModelProviderRuntime } from '@/lib/providers/domains/model';

export interface UpstreamCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, any>;
  signal?: AbortSignal | null;
}

type Responder = (call: UpstreamCall, index: number) => Response | Promise<Response>;

export interface Upstream {
  calls: UpstreamCall[];
  fetch: ReturnType<typeof vi.fn>;
}

/** Replaces the global fetch with a scripted upstream. Pair with `vi.unstubAllGlobals()`. */
export function stubUpstream(respond: Responder): Upstream {
  const calls: UpstreamCall[] = [];
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const raw = typeof init?.body === 'string' ? init.body : '';
    let body: Record<string, any> = {};
    try {
      body = raw.trim().startsWith('{') ? JSON.parse(raw) : {};
    } catch {
      /* not json */
    }
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const call: UpstreamCall = { url: String(input), headers, body, signal: init?.signal };
    calls.push(call);
    return respond(call, calls.length - 1);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetch: fetchMock };
}

const logger = { info() {}, warn() {}, error() {}, debug() {} };

async function runtimeOf(
  contract: { createRuntime: unknown },
  credentials: Record<string, unknown>,
  settings: Record<string, unknown> = {},
): Promise<ModelProviderRuntime> {
  return (contract.createRuntime as (ctx: unknown) => Promise<ModelProviderRuntime>)({
    tenantId: 't', projectId: 'p', providerKey: 'prov', credentials, settings, metadata: {}, logger,
  });
}

export const openAiRuntime = (settings: Record<string, unknown> = {}, apiKey = 'sk-test') =>
  runtimeOf(OpenAiModelProviderContract, { apiKey }, settings);

export const compatibleRuntime = (baseUrl = 'https://llm.internal/v1') =>
  runtimeOf(OpenAiCompatibleModelProviderContract, { apiKey: 'k' }, { baseUrl });

export const anthropicRuntime = () => runtimeOf(AnthropicModelProviderContract, { apiKey: 'sk-ant' });

export const bedrockRuntime = () =>
  runtimeOf(BedrockModelProviderContract, { accessKeyId: 'AKIA', secretAccessKey: 'secret' }, { region: 'us-east-1' });

// ── Upstream bodies ──────────────────────────────────────────────────────

export const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

export const sse = (events: unknown[]) =>
  new Response(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );

export interface CompletionSpec {
  content?: string | null;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  reasoning?: string;
  finish?: string;
  usage?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  message?: Record<string, unknown>;
}

/** An OpenAI `chat.completion` body. */
export function completion(spec: CompletionSpec = {}) {
  return {
    id: 'chatcmpl-upstream',
    object: 'chat.completion',
    created: 1,
    model: 'gpt-4o',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: spec.content === undefined ? 'Hi there!' : spec.content,
          ...(spec.reasoning ? { reasoning_content: spec.reasoning } : {}),
          ...(spec.toolCalls
            ? {
              tool_calls: spec.toolCalls.map((call) => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: call.arguments },
              })),
            }
            : {}),
          ...(spec.message ?? {}),
        },
        finish_reason: spec.finish ?? (spec.toolCalls?.length ? 'tool_calls' : 'stop'),
      },
    ],
    usage: spec.usage ?? { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    ...(spec.extra ?? {}),
  };
}

/** OpenAI stream chunk builders. */
export const chunk = {
  text: (content: string) => ({
    id: 'chatcmpl-up', object: 'chat.completion.chunk', model: 'gpt-4o',
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  }),
  reasoning: (reasoning_content: string) => ({
    id: 'chatcmpl-up', object: 'chat.completion.chunk', model: 'gpt-4o',
    choices: [{ index: 0, delta: { reasoning_content }, finish_reason: null }],
  }),
  tool: (index: number, fn: { id?: string; name?: string; arguments?: string }) => ({
    id: 'chatcmpl-up', object: 'chat.completion.chunk', model: 'gpt-4o',
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index,
          ...(fn.id ? { id: fn.id, type: 'function' } : {}),
          function: { ...(fn.name ? { name: fn.name } : {}), arguments: fn.arguments ?? '' },
        }],
      },
      finish_reason: null,
    }],
  }),
  finish: (finish_reason: string) => ({
    id: 'chatcmpl-up', object: 'chat.completion.chunk', model: 'gpt-4o',
    choices: [{ index: 0, delta: {}, finish_reason }],
  }),
  usage: (usage: Record<string, unknown> = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }) => ({
    id: 'chatcmpl-up', object: 'chat.completion.chunk', model: 'gpt-4o', choices: [], usage,
  }),
};

/**
 * A stream the test drives by hand. It errors with an AbortError when the
 * request's signal aborts, exactly as a real socket would.
 */
export function controlledStream(signal?: AbortSignal | null) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  signal?.addEventListener('abort', () => {
    try {
      controller.error(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
    } catch {
      /* already closed */
    }
  }, { once: true });
  return {
    response: new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    send: (event: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)),
    fail: (error: Error) => controller.error(error),
    end: () => {
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  };
}

/** Reads a gateway SSE stream to the end: the `data:` payloads, parsed (the sentinel stays a string). */
export async function readSse(stream: ReadableStream<Uint8Array>): Promise<{ raw: string; frames: any[] }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    raw += decoder.decode(value, { stream: true });
  }
  const frames = raw
    .split('\n\n')
    .map((block) => block.replace(/^data: /, '').trim())
    .filter(Boolean)
    .map((payload) => (payload === '[DONE]' ? payload : JSON.parse(payload)));
  return { raw, frames };
}

/** Lets the fire-and-forget usage rows land. */
export const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
