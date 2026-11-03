/**
 * Reversible PII protection at the gateway: the edge between the caller and the
 * whole gateway core.
 *
 * `executeModelCall` hands the core a request in which every value the PII policy
 * finds is a token (`services/pii/roundTrip.ts`), and turns the tokens in the
 * answer back into values before the caller sees it. Everything inside the core
 * therefore works on tokens only: the provider, the input / output / stream
 * guardrails, the semantic cache, Dynamic LLM routing signals and the usage rows.
 *
 * Which policy: the caller's (`context.piiProtection`, an agent's setting) over
 * the model's own `piiProtection`. Whose tokens: the caller's scope (an agent
 * session) or, for a direct call, the model.
 */

import type { ChatCompletionResponse, UnifiedMessage } from '@cognipeer/agent-sdk';
import { getConfig } from '@/lib/core/config';
import { InvalidRequestError } from '@/lib/providers/contracts/upstreamError';
import { loadPolicyScanner } from '@/lib/services/pii/piiService';
import {
  PiiRoundTrip,
  PiiUnscannableContentError,
  deriveRoundTripKey,
  type StreamRestorer,
} from '@/lib/services/pii/roundTrip';
import { getModelByKey } from './modelService';
import type { ModelCallInput, ModelCallOutcome, ModelStreamEvent } from './gatewayTypes';

type AnyRecord = Record<string, unknown>;

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function roundTripSecret(): string {
  const { auth } = getConfig();
  const secret = auth.providerEncryptionSecret || auth.jwtSecret;
  if (!secret) throw new Error('PII protection needs PROVIDER_ENCRYPTION_SECRET (or JWT_SECRET) to key its tokens.');
  return secret;
}

/** The round trip of one call, or null when nothing protects it. */
export async function openPiiRoundTrip(input: ModelCallInput): Promise<PiiRoundTrip | null> {
  const context = input.context;
  if (context?.piiProtected) return null;
  let policyKey = context?.piiProtection?.policyKey;
  if (!policyKey) {
    const model = await getModelByKey(input.tenantDbName, input.modelKey, input.projectId);
    policyKey = model?.piiProtection?.policyKey;
  }
  if (!policyKey) return null;

  const scanner = await loadPolicyScanner({ tenantDbName: input.tenantDbName, policyKey, projectId: input.projectId });
  // A disabled policy, or the tenant's PII service switched off: the call goes as it is.
  if (!scanner) return null;

  const scope = context?.piiProtection?.scope ?? `model:${input.projectId}:${input.modelKey}`;
  return new PiiRoundTrip({
    key: deriveRoundTripKey(roundTripSecret(), input.tenantId ?? input.tenantDbName, scope),
    version: scanner.version,
    scan: scanner.scan,
  });
}

// ── Request ─────────────────────────────────────────────────────────────────

async function protectNativeMessages(rt: PiiRoundTrip, messages: UnifiedMessage[]): Promise<UnifiedMessage[]> {
  return Promise.all(messages.map(async (message) => {
    const out: UnifiedMessage = { ...message };
    if (typeof message.content === 'string') {
      out.content = await rt.protectText(message.content);
    } else if (Array.isArray(message.content)) {
      out.content = await Promise.all(message.content.map(async (part) => {
        if (part.type === 'text') return { ...part, text: await rt.protectText((part as { text: string }).text) };
        throw new PiiUnscannableContentError(part.type);
      }));
    }
    if (message.toolCalls?.length) {
      out.toolCalls = await Promise.all(message.toolCalls.map(async (call) => ({
        ...call,
        arguments: await rt.protectText(call.arguments),
      })));
    }
    // `reasoning` is replayed verbatim (signed thinking blocks): never rewritten.
    return out;
  }));
}

/** The OpenAI-shaped view of the request (logs, cache key, routing signals): the same texts, the same tokens. */
async function protectWireMessages(rt: PiiRoundTrip, messages: unknown): Promise<unknown> {
  if (!Array.isArray(messages)) return messages;
  return Promise.all(messages.map(async (raw) => {
    if (!isRecord(raw)) return raw;
    const message: AnyRecord = { ...raw };
    if (typeof raw.content === 'string') {
      message.content = await rt.protectText(raw.content);
    } else if (Array.isArray(raw.content)) {
      message.content = await Promise.all(raw.content.map(async (part) => {
        if (isRecord(part) && part.type === 'text' && typeof part.text === 'string') {
          return { ...part, text: await rt.protectText(part.text) };
        }
        return part;
      }));
    }
    if (Array.isArray(raw.tool_calls)) {
      message.tool_calls = await Promise.all(raw.tool_calls.map(async (call) => {
        const fn = isRecord(call) && isRecord(call.function) ? call.function : undefined;
        if (!fn || typeof fn.arguments !== 'string') return call;
        return { ...(call as AnyRecord), function: { ...fn, arguments: await rt.protectText(fn.arguments) } };
      }));
    }
    if (isRecord(raw.function_call) && typeof raw.function_call.arguments === 'string') {
      message.function_call = { ...raw.function_call, arguments: await rt.protectText(raw.function_call.arguments) };
    }
    return message;
  }));
}

/** `input` with every message tokenized, marked so a Dynamic LLM's child does not tokenize it again. */
export async function protectCallInput(rt: PiiRoundTrip, input: ModelCallInput): Promise<ModelCallInput> {
  let messages: UnifiedMessage[];
  try {
    messages = await protectNativeMessages(rt, input.request.messages);
  } catch (error) {
    if (error instanceof PiiUnscannableContentError) throw new InvalidRequestError(error.message);
    throw error;
  }
  const wire = input.wire
    ? { ...input.wire, messages: await protectWireMessages(rt, input.wire.messages) }
    : undefined;
  return {
    ...input,
    request: { ...input.request, messages },
    ...(wire ? { wire } : {}),
    context: { ...(input.context ?? {}), piiProtected: true },
  };
}

// ── Answer ──────────────────────────────────────────────────────────────────

/** A JSON answer (`response_format`) restores with JSON escaping, so it stays parseable. */
function answersInJson(input: ModelCallInput): boolean {
  const type = input.request.responseFormat?.type;
  if (type === 'json_object' || type === 'json_schema') return true;
  const wireFormat = isRecord(input.wire?.response_format) ? input.wire?.response_format as AnyRecord : undefined;
  return wireFormat?.type === 'json_object' || wireFormat?.type === 'json_schema';
}

function restoreNativeResponse(rt: PiiRoundTrip, response: ChatCompletionResponse, json: boolean): ChatCompletionResponse {
  return {
    ...response,
    content: typeof response.content === 'string' ? rt.restoreText(response.content, json) : response.content,
    toolCalls: (response.toolCalls ?? []).map((call) => ({ ...call, arguments: rt.restoreText(call.arguments, true) })),
  };
}

function restoreWireResponse(rt: PiiRoundTrip, wire: AnyRecord, json: boolean): AnyRecord {
  if (!Array.isArray(wire.choices)) return wire;
  return {
    ...wire,
    choices: wire.choices.map((choice) => {
      if (!isRecord(choice) || !isRecord(choice.message)) return choice;
      const message: AnyRecord = { ...choice.message };
      if (typeof message.content === 'string') message.content = rt.restoreText(message.content, json);
      if (Array.isArray(message.tool_calls)) {
        message.tool_calls = message.tool_calls.map((call) => {
          const fn = isRecord(call) && isRecord(call.function) ? call.function : undefined;
          if (!fn || typeof fn.arguments !== 'string') return call;
          return { ...(call as AnyRecord), function: { ...fn, arguments: rt.restoreText(fn.arguments, true) } };
        });
      }
      return { ...choice, message };
    }),
  };
}

async function* restoreStream(
  rt: PiiRoundTrip,
  events: AsyncGenerator<ModelStreamEvent, void, void>,
  json: boolean,
): AsyncGenerator<ModelStreamEvent, void, void> {
  const content = rt.streamRestorer(json);
  const toolArgs = new Map<number, StreamRestorer>();

  /** What is still held back, as one delta, before the stream says it is over. */
  const drain = (): ModelStreamEvent | undefined => {
    const text = content.flush();
    const calls = [...toolArgs.entries()]
      .map(([index, restorer]) => ({ index, arguments: restorer.flush() }))
      .filter((call) => call.arguments.length > 0);
    if (!text && calls.length === 0) return undefined;
    return { type: 'delta', ...(text ? { content: text } : {}), ...(calls.length ? { toolCalls: calls } : {}) };
  };

  try {
    for (;;) {
      const next = await events.next();
      if (next.done) return;
      const event = next.value;
      switch (event.type) {
        case 'delta': {
          const out = { ...event };
          if (typeof event.content === 'string') out.content = content.push(event.content);
          if (event.toolCalls?.length) {
            out.toolCalls = event.toolCalls.map((call) => {
              if (typeof call.arguments !== 'string') return call;
              const index = call.index ?? 0;
              let restorer = toolArgs.get(index);
              if (!restorer) {
                restorer = rt.streamRestorer(true);
                toolArgs.set(index, restorer);
              }
              return { ...call, arguments: restorer.push(call.arguments) };
            });
          }
          if (event.finishReason) {
            // The last delta: nothing more will come to complete a held-back token.
            const rest = drain();
            if (rest && rest.type === 'delta') {
              if (rest.content) out.content = (out.content ?? '') + rest.content;
              if (rest.toolCalls) out.toolCalls = [...(out.toolCalls ?? []), ...rest.toolCalls];
            }
          }
          yield out;
          break;
        }
        case 'done': {
          const rest = drain();
          if (rest) yield rest;
          yield { ...event, response: restoreNativeResponse(rt, event.response, json) };
          break;
        }
        case 'finish':
        case 'output_limit':
        case 'failed':
        case 'cancelled': {
          const rest = drain();
          if (rest) yield rest;
          yield event;
          break;
        }
        default:
          yield event;
      }
    }
  } finally {
    // The consumer stopped early (or the stream ended): let the core close the upstream.
    await events.return?.(undefined);
  }
}

/** The core's outcome with every token the caller would see turned back into its value. */
export function restoreCallOutcome(rt: PiiRoundTrip, input: ModelCallInput, outcome: ModelCallOutcome): ModelCallOutcome {
  const json = answersInJson(input);
  return {
    ...outcome,
    ...(outcome.wire ? { wire: restoreWireResponse(rt, outcome.wire, json) } : {}),
    ...(outcome.result
      ? { result: { ...outcome.result, response: restoreNativeResponse(rt, outcome.result.response, json) } }
      : {}),
    ...(outcome.stream ? { stream: restoreStream(rt, outcome.stream, json) } : {}),
  };
}
