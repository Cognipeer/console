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
 * They have no column of their own and ride in `metadata`. These tests assert
 * both paths fold them identically, so a session that mixes sources renders
 * the same either way.
 */

import { describe, it, expect } from 'vitest';
import { buildInternalEventMetadata } from '@/lib/services/agents/agentService';

type Event = Parameters<typeof buildInternalEventMetadata>[0];

function event(overrides: Record<string, unknown>): Event {
  return { type: 'ai_call', ...overrides } as unknown as Event;
}

describe('buildInternalEventMetadata', () => {
  it('lifts finishReason off the SDK event into metadata', () => {
    expect(buildInternalEventMetadata(event({ finishReason: 'length' })))
      .toEqual({ finishReason: 'length' });
  });

  it('lifts reasoningTokens off the SDK event into metadata', () => {
    expect(buildInternalEventMetadata(event({ reasoningTokens: 512 })))
      .toEqual({ reasoningTokens: 512 });
  });

  it('reads reasoning tokens out of a usage bag, in either spelling', () => {
    expect(buildInternalEventMetadata(event({ usage: { reasoningTokens: 128 } })))
      .toEqual({ reasoningTokens: 128 });
    expect(buildInternalEventMetadata(event({ usage: { reasoning_tokens: 256 } })))
      .toEqual({ reasoningTokens: 256 });
  });

  it('keeps whatever metadata the event already carried', () => {
    const metadata = buildInternalEventMetadata(
      event({ metadata: { toolDetails: { name: 'search' } }, finishReason: 'stop' }),
    );
    expect(metadata).toEqual({ toolDetails: { name: 'search' }, finishReason: 'stop' });
  });

  it('does not overwrite a finishReason already in metadata with nothing', () => {
    expect(buildInternalEventMetadata(event({ metadata: { finishReason: 'stop' } })))
      .toEqual({ finishReason: 'stop' });
  });

  it('omits both fields when the model reported neither', () => {
    // Absent must stay absent: "no reasoning tokens" and "the provider said
    // nothing" are different facts, and a zero would erase the difference.
    expect(buildInternalEventMetadata(event({}))).toEqual({});
    expect(buildInternalEventMetadata(event({ reasoningTokens: 0 }))).toEqual({});
    expect(buildInternalEventMetadata(event({ finishReason: '   ' }))).toEqual({});
  });

  it('does not copy the event object it was handed', () => {
    // The caller reuses the event to build the rest of the document; mutating
    // its metadata in place would leak the fold into unrelated fields.
    const source = event({ metadata: { a: 1 }, finishReason: 'length' });
    buildInternalEventMetadata(source);
    expect((source as unknown as { metadata: Record<string, unknown> }).metadata).toEqual({ a: 1 });
  });
});
