/**
 * `mergeClientConversationMetadata`: what a route that stores client-supplied metadata at the top level of
 * `conversation.metadata` leaves alone. The server keeps its own bookkeeping in the same column (the session's
 * tool allow-list among it); none of it is the client's to set.
 */
import { describe, expect, it } from 'vitest';
import { SERVER_OWNED_CONVERSATION_METADATA_KEYS, mergeClientConversationMetadata } from '@/lib/services/agents/conversationMetadata';

describe('mergeClientConversationMetadata', () => {
  it('lays the caller\'s keys over the stored ones', () => {
    expect(mergeClientConversationMetadata({ a: 1, b: 2 }, { b: 3, c: 4 })).toEqual({ a: 1, b: 3, c: 4 });
    expect(mergeClientConversationMetadata(undefined, { c: 4 })).toEqual({ c: 4 });
  });

  it.each(SERVER_OWNED_CONVERSATION_METADATA_KEYS.map((key) => [key]))('keeps the stored value of %s, whatever the patch says', (key) => {
    expect(mergeClientConversationMetadata({ [key]: 'stored', keep: 1 }, { [key]: 'patched', other: 2 })).toEqual({ [key]: 'stored', keep: 1, other: 2 });
  });

  it.each(SERVER_OWNED_CONVERSATION_METADATA_KEYS.map((key) => [key]))('leaves %s absent when nothing was stored', (key) => {
    const merged = mergeClientConversationMetadata({ keep: 1 }, { [key]: 'patched' });
    expect(merged).toEqual({ keep: 1 });
    expect(Object.prototype.hasOwnProperty.call(merged, key)).toBe(false);
  });

  it('covers the session tool allow-list and the settings a run is configured by', () => {
    for (const key of ['hitlAllowedTools', 'source', 'runtimeContext', 'portalId', 'channel', 'sandbox', 'assistantsApi']) {
      expect(SERVER_OWNED_CONVERSATION_METADATA_KEYS).toContain(key);
    }
  });

  it('does not touch the stored object', () => {
    const stored = { hitlAllowedTools: ['web_search'], note: 'x' };
    mergeClientConversationMetadata(stored, { hitlAllowedTools: [], note: 'y' });
    expect(stored).toEqual({ hitlAllowedTools: ['web_search'], note: 'x' });
  });
});
