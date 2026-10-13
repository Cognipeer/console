/**
 * The Model Hub form and the gateway decide the Anthropic thinking form with the console's own copy of the
 * rule (reasoning.ts is bundled into the browser); the native providers use the SDK's. They must agree.
 */
import { describe, expect, it } from 'vitest';
import { supportsAdaptiveThinking as sdkRule } from '@cognipeer/agent-sdk';
import { supportsAdaptiveThinking } from '@/lib/services/models/reasoning';

const IDS = [
  'claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-fable-5',
  'claude-opus-4-8', 'claude-sonnet-4-5', 'claude-3-7-sonnet-20250219', 'claude-haiku-4-5-20251001',
  'anthropic.claude-sonnet-5-5-v1:0', 'us.anthropic.claude-opus-4-1-20250805-v1:0', 'gpt-5.6-luna', 'qwen/qwen3.8-27b', '',
];

describe('adaptive thinking rule', () => {
  it.each(IDS)('console and SDK agree on %s', (id) => {
    expect(supportsAdaptiveThinking(id)).toBe(sdkRule(id));
  });
  it('picks the adaptive form for Claude 5.x and fable, the budget form for older models', () => {
    expect(supportsAdaptiveThinking('claude-haiku-5-5')).toBe(true);
    expect(supportsAdaptiveThinking('claude-fable-5-1')).toBe(true);
    expect(supportsAdaptiveThinking('claude-sonnet-4-5')).toBe(false);
  });
});
