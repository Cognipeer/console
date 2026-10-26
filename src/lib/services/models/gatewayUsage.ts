/**
 * Token usage at the gateway boundary.
 *
 * The agent-sdk reports usage in one shape per provider family, and the families
 * disagree on what a number COUNTS. The gateway's own arithmetic (`calculateCost`,
 * the usage rollups, the OpenAI `usage` object) has one rule: `inputTokens` is the
 * whole prompt INCLUDING the cache-read and cache-write parts, `outputTokens` is the
 * whole completion INCLUDING reasoning, and the cache-read / cache-write / reasoning
 * counts are SUBSETS — each priced at its own rate, never added on top. This module
 * is the one place the provider shapes are turned into that rule.
 *
 *  - OpenAI family (openai, azure, together, openai-compatible): already the rule.
 *  - Anthropic / Bedrock Converse: `input_tokens` is only the UNCACHED part and the
 *    cache reads / writes come separately. Both are folded into the prompt count
 *    and stay the cache-read / cache-write subsets.
 *  - Vertex Gemini: `candidatesTokenCount` leaves the thinking tokens out, but they
 *    are billed as output, so they are added to the completion count and stay the
 *    reasoning subset.
 */

import type { TokenUsage as NativeUsage } from '@cognipeer/agent-sdk';
import type { TokenUsage } from './usageLogger';

const UNCACHED_PROMPT_DRIVERS: ReadonlySet<string> = new Set(['anthropic', 'bedrock']);

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** The gateway usage of a native provider usage. Cache / reasoning keys exist only when they are positive. */
export function toGatewayUsage(driver: string | undefined, usage: Partial<NativeUsage> | undefined): TokenUsage {
  if (!usage) return {};
  const reasoning = count(usage.reasoningTokens);
  const cachedRead = count(usage.cachedInputTokens);
  const cachedWrite = count(usage.cachedWriteTokens);

  let input = count(usage.inputTokens);
  let output = count(usage.outputTokens);
  let total = count(usage.totalTokens);

  if (driver && UNCACHED_PROMPT_DRIVERS.has(driver)) {
    input += cachedRead + cachedWrite;
    total = input + output;
  } else if (driver === 'vertex') {
    output += reasoning;
    total = input + output;
  } else if (total === 0) {
    total = input + output;
  }

  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    ...(cachedRead > 0 ? { cachedInputTokens: cachedRead } : {}),
    ...(cachedWrite > 0 ? { cachedWriteTokens: cachedWrite } : {}),
    // Subset of outputTokens: never folded into totalTokens or the cost.
    ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
  };
}

/**
 * The OpenAI `usage` object of a gateway usage. A cache write rides in
 * `prompt_tokens_details.cache_write_tokens` (the key OpenRouter and the agent-sdk
 * message usage use); OpenAI clients ignore detail keys they do not know.
 */
export function toWireUsage(usage: TokenUsage): Record<string, unknown> {
  const prompt = usage.inputTokens ?? 0;
  const completion = usage.outputTokens ?? 0;
  const details = {
    ...(usage.cachedInputTokens ? { cached_tokens: usage.cachedInputTokens } : {}),
    ...(usage.cachedWriteTokens ? { cache_write_tokens: usage.cachedWriteTokens } : {}),
  };
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    cached_tokens: usage.cachedInputTokens ?? 0,
    total_tokens: usage.totalTokens ?? prompt + completion,
    ...(Object.keys(details).length > 0 ? { prompt_tokens_details: details } : {}),
    ...(usage.reasoningTokens ? { completion_tokens_details: { reasoning_tokens: usage.reasoningTokens } } : {}),
  };
}

/** The gateway usage of an OpenAI `usage` object (cache hits, wire fixtures). */
export function fromWireUsage(wire: unknown): TokenUsage {
  if (!wire || typeof wire !== 'object') return {};
  const u = wire as Record<string, unknown>;
  const details = (u.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const completion = (u.completion_tokens_details ?? {}) as Record<string, unknown>;
  const input = count(u.prompt_tokens);
  const output = count(u.completion_tokens);
  const cached = count(u.cached_tokens) || count(details.cached_tokens);
  const written = count(details.cache_write_tokens);
  const reasoning = count(completion.reasoning_tokens);
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: count(u.total_tokens) || input + output,
    ...(cached > 0 ? { cachedInputTokens: cached } : {}),
    ...(written > 0 ? { cachedWriteTokens: written } : {}),
    ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
  };
}

/** chars/4: the same estimator the quota pre-flight uses. */
export function estimateTokensFromText(text: string): number {
  return text ? Math.ceil(text.length / 4) : 0;
}

/**
 * chars/4 over an OpenAI-shaped prompt: every message's text (string content and
 * text parts), the assistant tool-call arguments, and the tool definitions. Images
 * and other binary parts are not counted. For a call the provider billed but never
 * reported usage for (a stream cut before its usage event, an upstream that ignores
 * `stream_options.include_usage`); the estimate is the whole prompt as uncached input.
 */
export function estimateInputTokens(messages: unknown, tools?: unknown): number {
  let chars = 0;
  const addText = (value: unknown) => {
    if (typeof value === 'string') chars += value.length;
  };
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (!message || typeof message !== 'object') continue;
      const m = message as Record<string, unknown>;
      if (typeof m.content === 'string') {
        addText(m.content);
      } else if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part && typeof part === 'object') addText((part as Record<string, unknown>).text);
        }
      }
      if (Array.isArray(m.tool_calls)) {
        for (const call of m.tool_calls) {
          const fn = call && typeof call === 'object' ? (call as Record<string, unknown>).function : undefined;
          if (fn && typeof fn === 'object') {
            addText((fn as Record<string, unknown>).name);
            addText((fn as Record<string, unknown>).arguments);
          }
        }
      }
    }
  }
  if (Array.isArray(tools) && tools.length > 0) {
    try {
      chars += JSON.stringify(tools).length;
    } catch {
      /* an unserializable tool list is left out of the estimate */
    }
  }
  return chars > 0 ? Math.ceil(chars / 4) : 0;
}
