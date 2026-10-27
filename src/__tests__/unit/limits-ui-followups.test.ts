/**
 * Unit tests — UI follow-ups of the limits work
 *
 *  - the "Default max tokens" placeholder shows both defaults when streaming and non-streaming differ, one value when
 *    they agree, and the fallback when the driver sends none;
 *  - the reasoning picker offers no effort list for a Bedrock model that does not carry thinking, still does for Claude;
 *  - the Bedrock region is a free-text field (a region list would be out of date the day AWS adds one).
 */

import { describe, expect, it } from 'vitest';
import { blankMaxTokensPlaceholder } from '@/components/models/requestParams';
import { reasoningPickerOptions } from '@/components/agents/studio/AgentReasoningPicker';
import { PROVIDER_DEFINITIONS } from '@/lib/services/models/providerCatalog';

const SPLIT = 'default {streaming} / {nonStreaming}';
const FALLBACK = 'provider default';

describe('blankMaxTokensPlaceholder', () => {
  it('shows both defaults when a streaming and a non-streaming call differ', () => {
    // Anthropic, 64,000 declared: a streaming call gets it all, a non-streaming one a lower cap.
    const text = blankMaxTokensPlaceholder({ driver: 'anthropic', modelId: 'claude-haiku-4-5', maxOutputTokens: 64000 }, SPLIT, FALLBACK);
    expect(text).toMatch(/^default 64,000 \/ [\d,]+$/);
    expect(text).not.toBe('default 64,000 / 64,000');
  });

  it('shows one value when both agree', () => {
    expect(blankMaxTokensPlaceholder({ driver: 'anthropic', modelId: 'claude-haiku-4-5', maxOutputTokens: 4096 }, SPLIT, FALLBACK)).toBe('4,096');
  });

  it('is the fallback when the driver sends none', () => {
    expect(blankMaxTokensPlaceholder({ driver: 'openai', modelId: 'gpt-5', maxOutputTokens: '' }, SPLIT, FALLBACK)).toBe(FALLBACK);
    expect(blankMaxTokensPlaceholder({ driver: undefined, modelId: undefined, maxOutputTokens: '' }, SPLIT, FALLBACK)).toBe(FALLBACK);
  });
});

describe('reasoningPickerOptions on Bedrock', () => {
  const reasoning = { supportsReasoning: true };

  it('offers no effort list for a non-Claude model, even flagged as reasoning', () => {
    for (const modelId of ['us.amazon.nova-pro-v1:0', 'openai.gpt-oss-120b-1:0']) {
      expect(reasoningPickerOptions({ key: 'm', name: 'm', providerDriver: 'bedrock', modelId, capabilities: reasoning }, {})).toBeUndefined();
    }
  });

  it('still offers its control for a Bedrock Claude', () => {
    const options = reasoningPickerOptions(
      { key: 'm', name: 'm', providerDriver: 'bedrock', modelId: 'eu.anthropic.claude-sonnet-4-5-v1:0', capabilities: reasoning },
      {},
    );
    expect(options?.kind).toBe('budget');
    expect(options?.efforts.length).toBeGreaterThan(0);
  });
});

describe('the Bedrock region field', () => {
  it('is free text, not a fixed list', () => {
    const bedrock = PROVIDER_DEFINITIONS.find((p) => p.id === 'bedrock');
    const region = JSON.parse(JSON.stringify(bedrock)) as { [k: string]: unknown };
    const fields = Object.values(region).flatMap((v) => (Array.isArray(v) ? v : [])) as Array<{ name?: string; type?: string; options?: unknown }>;
    const field = fields.find((f) => f && f.name === 'region');
    expect(field?.type).toBe('text');
    expect(field?.options).toBeUndefined();
  });
});
