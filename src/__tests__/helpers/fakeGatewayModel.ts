/**
 * A scripted chat model standing in for `buildGatewayChatModel` in agent tests that
 * do not care about the gateway itself (it has its own tests): it plays the one
 * part of the gateway an agent's bookkeeping depends on - settling what a model
 * request cost (`onCost`, the run's token tally) when the reply carries usage.
 */

import { addRunUsage } from '@/lib/services/agents/runUsage';
import { calculateCost } from '@/lib/services/models/usageLogger';

type AnyRecord = Record<string, unknown>;
type AnyFn = (...args: any[]) => any; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface FakeGatewayInput {
  model: { pricing?: AnyRecord };
  onCost?: (cost: { currency: string; totalCost: number }) => void;
}

/** Token usage out of a model reply (the SDK's `usage` shape, or the older spellings). */
export function usageOf(message: unknown): { inputTokens: number; outputTokens: number; totalTokens: number } | undefined {
  if (!message || typeof message !== 'object') return undefined;
  const m = message as AnyRecord;
  const meta = (m.response_metadata ?? {}) as AnyRecord;
  for (const candidate of [m.usage, m.usage_metadata, meta.token_usage, meta.tokenUsage, meta.usage]) {
    if (!candidate || typeof candidate !== 'object') continue;
    const u = candidate as AnyRecord;
    const num = (...keys: string[]) => keys.map((key) => u[key]).find((v): v is number => typeof v === 'number');
    const inputTokens = num('input_tokens', 'inputTokens', 'prompt_tokens');
    const outputTokens = num('output_tokens', 'outputTokens', 'completion_tokens');
    if (inputTokens === undefined && outputTokens === undefined) continue;
    return {
      inputTokens: inputTokens ?? 0,
      outputTokens: outputTokens ?? 0,
      totalTokens: num('total_tokens', 'totalTokens') ?? (inputTokens ?? 0) + (outputTokens ?? 0),
    };
  }
  return undefined;
}

export function settlingModel<T extends object>(input: FakeGatewayInput, fake: T): T {
  const model = fake as T & { invoke?: AnyFn; stream?: AnyFn; bindTools?: AnyFn };
  const wrapped = { ...model } as unknown as Record<string, AnyFn>;

  const settle = (message: unknown) => {
    const usage = usageOf(message);
    if (!usage || (!usage.inputTokens && !usage.outputTokens)) return;
    addRunUsage(usage.totalTokens);
    input.onCost?.(calculateCost((input.model.pricing ?? {}) as never, usage));
  };

  if (typeof model.bindTools === 'function') {
    const bindTools = model.bindTools.bind(model);
    wrapped.bindTools = (...args: unknown[]) => settlingModel(input, bindTools(...args) as object);
  }
  if (typeof model.invoke === 'function') {
    const invoke = model.invoke.bind(model);
    wrapped.invoke = async (...args: unknown[]) => {
      const reply = await invoke(...args);
      settle(reply);
      return reply;
    };
  }
  if (typeof model.stream === 'function') {
    const stream = model.stream.bind(model);
    wrapped.stream = async function* settled(...args: unknown[]) {
      let last: unknown;
      try {
        for await (const chunk of stream(...args) as AsyncIterable<unknown>) {
          if (usageOf(chunk)) last = chunk;
          yield chunk;
        }
      } finally {
        settle(last);
      }
    };
  }
  return wrapped as unknown as T;
}
