/**
 * Internal tracing sink ↔ HTTP ingest parity for the SDK's diagnostic fields.
 *
 * A trace reaches the same collection, and the same UI, by two routes: an
 * external SDK POSTing to `/api/client/v1/tracing/*`, and the console running
 * an agent itself and writing through `createInternalTracingSink`. The two are
 * separate code paths, so a field added to the SDK lands in one and not the
 * other unless something pins them together — which is exactly what happened
 * to `finishReason` / `reasoningTokens` when agent-sdk 0.9.3 introduced them.
 *
 * They are now first-class columns rather than `metadata` passengers, and each
 * path has its own extractor: `extractTraceDiagnostics` (HTTP) and
 * `extractInternalTraceDiagnostics` (internal sink). These tests pin the two
 * together, so a session that mixes sources renders the same either way.
 *
 * The HTTP extractor accepts strictly more shapes, because only external SDKs
 * send the odd ones (Anthropic's `stop_reason`, the OTel exporter's plural
 * `finishReasons`, raw OpenAI usage bags). Those cases are asserted on the HTTP
 * side alone and are called out as such.
 */

import { describe, it, expect } from 'vitest';

import { extractTraceDiagnostics } from '@/server/api/plugins/client-tracing';
import { extractInternalTraceDiagnostics } from '@/lib/services/agents/agentService';

type AnyEvent = Record<string, unknown>;

/** Run one logical event through BOTH extractors. */
function both(event: AnyEvent) {
  return {
    http: extractTraceDiagnostics(event as Parameters<typeof extractTraceDiagnostics>[0]),
    internal: extractInternalTraceDiagnostics(
      event as Parameters<typeof extractInternalTraceDiagnostics>[0],
    ),
  };
}

describe('trace diagnostics extraction — shared shapes', () => {
  it('reads the SDK top-level fields identically on both paths', () => {
    const { http, internal } = both({
      type: 'ai_call',
      finishReason: 'length',
      reasoningTokens: 1024,
    });

    expect(http).toEqual({ finishReason: 'length', reasoningTokens: 1024 });
    expect(internal).toEqual(http);
  });

  it('falls back to metadata.finishReason on both paths', () => {
    const { http, internal } = both({
      type: 'ai_call',
      metadata: { finishReason: 'tool_calls' },
    });

    expect(http.finishReason).toBe('tool_calls');
    expect(internal.finishReason).toBe('tool_calls');
  });

  it('falls back to metadata.stop_reason on both paths (Claude Agent SDK vocabulary)', () => {
    const { http, internal } = both({
      type: 'ai_call',
      metadata: { stop_reason: 'max_tokens' },
    });

    expect(http.finishReason).toBe('max_tokens');
    expect(internal.finishReason).toBe('max_tokens');
  });

  it('normalizes casing and whitespace the same way', () => {
    const { http, internal } = both({ type: 'ai_call', finishReason: '  LENGTH  ' });

    expect(http.finishReason).toBe('length');
    expect(internal.finishReason).toBe('length');
  });

  it('drops a finish reason that is not a plausible token', () => {
    const { http, internal } = both({
      type: 'ai_call',
      finishReason: 'stopped because the user cancelled the request mid-stream, see logs',
    });

    expect(http.finishReason).toBeUndefined();
    expect(internal.finishReason).toBeUndefined();
  });

  it('reads reasoning tokens from the usage bag on both paths', () => {
    const flat = both({ type: 'ai_call', usage: { reasoningTokens: 512 } });
    expect(flat.http.reasoningTokens).toBe(512);
    expect(flat.internal.reasoningTokens).toBe(512);

    const snake = both({ type: 'ai_call', usage: { reasoning_tokens: 512 } });
    expect(snake.http.reasoningTokens).toBe(512);
    expect(snake.internal.reasoningTokens).toBe(512);
  });

  it('treats a zero or negative reasoning count as "not reported"', () => {
    for (const value of [0, -5]) {
      const { http, internal } = both({ type: 'ai_call', reasoningTokens: value });
      expect(http.reasoningTokens).toBeUndefined();
      expect(internal.reasoningTokens).toBeUndefined();
    }
  });

  it('ignores a non-numeric reasoning count instead of persisting NaN', () => {
    const { http, internal } = both({ type: 'ai_call', reasoningTokens: 'lots' });

    expect(http.reasoningTokens).toBeUndefined();
    expect(internal.reasoningTokens).toBeUndefined();
  });

  it('returns nothing for an event that carries neither field', () => {
    const { http, internal } = both({ type: 'tool_call', toolName: 'search' });

    expect(http).toEqual({ finishReason: undefined, reasoningTokens: undefined });
    expect(internal).toEqual(http);
  });

  it('prefers the top-level field over the metadata fallback on both paths', () => {
    const { http, internal } = both({
      type: 'ai_call',
      finishReason: 'stop',
      reasoningTokens: 10,
      metadata: { finishReason: 'length', reasoningTokens: 999 },
    });

    expect(http).toEqual({ finishReason: 'stop', reasoningTokens: 10 });
    expect(internal).toEqual(http);
  });
});

describe('trace diagnostics extraction — HTTP-only producer shapes', () => {
  it('takes the first entry of the OTel exporter\'s plural finishReasons array', () => {
    expect(
      extractTraceDiagnostics({
        metadata: { finishReasons: ['content_filter', 'stop'] },
      } as Parameters<typeof extractTraceDiagnostics>[0]).finishReason,
    ).toBe('content_filter');
  });

  it('takes the first entry when finishReasons arrives comma-joined', () => {
    expect(
      extractTraceDiagnostics({
        metadata: { finishReasons: 'length,stop' },
      } as Parameters<typeof extractTraceDiagnostics>[0]).finishReason,
    ).toBe('length');
  });

  it('reads reasoning tokens out of a raw OpenAI usage bag', () => {
    expect(
      extractTraceDiagnostics({
        usage: { completion_tokens_details: { reasoning_tokens: 320 } },
      } as Parameters<typeof extractTraceDiagnostics>[0]).reasoningTokens,
    ).toBe(320);
  });

  it('reads reasoning tokens out of a Responses-API usage bag', () => {
    expect(
      extractTraceDiagnostics({
        usage: { output_tokens_details: { reasoning_tokens: 64 } },
      } as Parameters<typeof extractTraceDiagnostics>[0]).reasoningTokens,
    ).toBe(64);
  });
});
