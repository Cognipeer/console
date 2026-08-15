import { describe, expect, it } from 'vitest';
import {
  inferActiveParamsB,
  inferModelTier,
  inferModelTierDetail,
  inferMultilingualSupport,
  inferTotalParamsB,
  isOpenWeightModel,
  MODEL_TIER_STANDARD,
} from '@/lib/services/modelPriceCatalog/modelTraits';

describe('inferActiveParamsB', () => {
  it('reads a dense parameter count off the name', () => {
    expect(inferActiveParamsB('llama-3.2-3b-instruct')).toBe(3);
    expect(inferActiveParamsB('deepinfra/meta-llama/Meta-Llama-3.1-8B-Instruct')).toBe(8);
    expect(inferActiveParamsB('llama-3.3-70b-versatile')).toBe(70);
    expect(inferActiveParamsB('qwen2.5-1.5b-instruct')).toBe(1.5);
  });

  it('uses the ACTIVE marker when a MoE name states both counts', () => {
    expect(inferActiveParamsB('qwen3-30b-a3b')).toBe(3);
    expect(inferActiveParamsB('qwen3-235b-a22b-instruct')).toBe(22);
  });

  it('estimates active parameters for expert-count MoE names', () => {
    // Two experts route per token; 8x7B activates ~14B, not 7B or 56B.
    expect(inferActiveParamsB('mistralai/mixtral-8x7b-instruct')).toBe(14);
    expect(inferActiveParamsB('mixtral-8x22b')).toBe(44);
  });

  it('takes the first size when a name states several', () => {
    expect(inferActiveParamsB('llama-4-maverick-17b-128e-instruct-fp8')).toBe(17);
  });

  it('abstains when the name carries no size', () => {
    expect(inferActiveParamsB('gpt-5.6-terra')).toBeUndefined();
    expect(inferActiveParamsB('claude-sonnet-4-5')).toBeUndefined();
    expect(inferActiveParamsB('')).toBeUndefined();
  });
});

describe('inferTotalParamsB', () => {
  it('reports resident weights, not active ones, for MoE names', () => {
    expect(inferTotalParamsB('mixtral-8x7b')).toBe(56);
    expect(inferTotalParamsB('qwen3-30b-a3b')).toBe(30);
    expect(inferTotalParamsB('qwen3-235b-a22b-instruct')).toBe(235);
  });

  it('matches the active count for dense models', () => {
    expect(inferTotalParamsB('llama-3.1-8b-instant')).toBe(8);
  });
});

describe('inferModelTier', () => {
  it('keeps the vendor-marker behaviour intact', () => {
    expect(inferModelTier('gpt-5.4-nano')).toBe(1);
    expect(inferModelTier('gpt-4o-mini')).toBe(2);
    expect(inferModelTier('claude-haiku-4-5')).toBe(2);
    expect(inferModelTier('claude-sonnet-4-5')).toBe(3);
    expect(inferModelTier('claude-opus-4-1')).toBe(4);
    expect(inferModelTier('grok-pro-mini')).toBe(2);
  });

  it('rates open-weight models by parameter count instead of STANDARD', () => {
    // The defect this replaces: every one of these used to score STANDARD,
    // i.e. equal to a frontier baseline, which disabled the tier guard.
    expect(inferModelTier('deepinfra/meta-llama/Llama-3.2-3B-Instruct')).toBe(1);
    expect(inferModelTier('groq/llama-3.1-8b-instant')).toBe(2);
    expect(inferModelTier('qwen2.5-32b-instruct')).toBe(3);
    expect(inferModelTier('llama-3.1-405b-instruct')).toBe(4);
  });

  it('sizes MoE models on their active parameters', () => {
    expect(inferModelTier('qwen3-30b-a3b')).toBe(1);
    expect(inferModelTier('mixtral-8x7b-instruct')).toBe(2);
  });

  it('takes the smaller of marker and parameter signals', () => {
    expect(inferModelTier('llama-3.3-70b-mini')).toBe(2);
  });

  it('still defaults to STANDARD when the name says nothing', () => {
    expect(inferModelTier('azure/gpt-5.6-terra-2026-05-01')).toBe(MODEL_TIER_STANDARD);
    expect(inferModelTierDetail('azure/gpt-5.6-terra').source).toBe('default');
  });

  it('reports where the tier came from', () => {
    expect(inferModelTierDetail('gpt-4o-mini').source).toBe('marker');
    expect(inferModelTierDetail('llama-3.1-8b').source).toBe('params');
    expect(inferModelTierDetail('llama-3.1-8b').activeParamsB).toBe(8);
  });
});

describe('isOpenWeightModel', () => {
  it('recognizes families regardless of the hosting provider', () => {
    expect(isOpenWeightModel('groq/llama-3.1-8b-instant')).toBe(true);
    expect(isOpenWeightModel('deepinfra/Qwen/Qwen2.5-72B-Instruct')).toBe(true);
    expect(isOpenWeightModel('together_ai/mistralai/Mixtral-8x7B')).toBe(true);
    expect(isOpenWeightModel('openrouter/openai/gpt-oss-20b')).toBe(true);
  });

  it('does not claim proprietary models', () => {
    expect(isOpenWeightModel('gpt-4o')).toBe(false);
    expect(isOpenWeightModel('claude-sonnet-4-5')).toBe(false);
    expect(isOpenWeightModel('gemini-2.5-flash')).toBe(false);
  });
});

describe('inferMultilingualSupport', () => {
  it('marks documented multilingual families strong', () => {
    expect(inferMultilingualSupport('qwen2.5-32b-instruct')).toBe('strong');
    expect(inferMultilingualSupport('gemma-3-12b-it')).toBe('strong');
  });

  it('marks English-first and code-only families limited', () => {
    expect(inferMultilingualSupport('smollm-1.7b')).toBe('limited');
    expect(inferMultilingualSupport('codestral-2501')).toBe('limited');
  });

  it('lets an explicit multilingual variant override the family', () => {
    expect(inferMultilingualSupport('phi-3-multilingual')).toBe('strong');
  });

  it('abstains rather than guessing', () => {
    expect(inferMultilingualSupport('some-unknown-model-v2')).toBe('unknown');
  });
});
