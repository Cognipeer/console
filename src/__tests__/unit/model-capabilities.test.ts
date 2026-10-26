import { describe, expect, it } from 'vitest';
import type { IModel } from '@/lib/database';
import {
  applyModelCapabilityOverrides,
  limitsFromCatalogFill,
  parseModelCapabilityOverrides,
  resolveModelCapabilities,
} from '@/lib/services/models/modelCapabilities';

function makeModel(overrides: Partial<IModel> = {}): IModel {
  return {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    name: 'Public Alias',
    key: 'public-alias',
    providerKey: 'provider-1',
    providerDriver: 'openai-compatible',
    category: 'llm',
    modelId: 'upstream-model',
    isMultimodal: false,
    supportsToolCalls: false,
    settings: {},
    pricing: {
      currency: 'USD',
      inputTokenPer1M: 0,
      outputTokenPer1M: 0,
      cachedTokenPer1M: 0,
    },
    metadata: {},
    ...overrides,
  };
}

describe('model capabilities', () => {
  it('uses explicit capability metadata ahead of legacy fields', () => {
    const capabilities = resolveModelCapabilities(makeModel({
      isMultimodal: false,
      supportsToolCalls: false,
      settings: { maxTokens: 2048 },
      metadata: {
        contextLength: 8192,
        supportsReasoning: false,
        capabilities: {
          contextWindow: 131072,
          maxOutputTokens: 16384,
          inputModalities: ['text', 'image'],
          outputModalities: ['text'],
          supportsReasoning: true,
          supportsStructuredOutputs: true,
          supportsToolCalls: true,
        },
      },
    }));

    expect(capabilities).toEqual({
      schemaVersion: '1.0',
      canonicalModelId: 'upstream-model',
      contextWindow: 131072,
      maxOutputTokens: 16384,
      inputModalities: ['text', 'image'],
      outputModalities: ['text'],
      supportsReasoning: true,
      supportsStructuredOutputs: true,
      supportsToolCalls: true,
    });
  });

  it('keeps legacy model records discoverable without migration', () => {
    const capabilities = resolveModelCapabilities(makeModel({
      category: 'embedding',
      isMultimodal: true,
      supportsToolCalls: true,
      settings: { context_length: 32768, max_tokens: 4096 },
      metadata: { supports_reasoning: false },
    }));

    expect(capabilities).toEqual(expect.objectContaining({
      contextWindow: 32768,
      // `settings.max_tokens` is the default per-request limit, not the model maximum: never advertised as one.
      maxOutputTokens: undefined,
      inputModalities: ['text', 'image'],
      outputModalities: ['embeddings'],
      supportsReasoning: false,
      supportsToolCalls: true,
    }));
  });

  it('does not advertise the default per-request limit (settings.maxTokens / max_tokens) as the model maximum', () => {
    expect(resolveModelCapabilities(makeModel({ settings: { maxTokens: 2048 } })).maxOutputTokens).toBeUndefined();
    expect(resolveModelCapabilities(makeModel({ settings: { max_tokens: 2048 } })).maxOutputTokens).toBeUndefined();
  });

  it('still reads a declared maximum from metadata and from settings.maxOutputTokens', () => {
    expect(resolveModelCapabilities(makeModel({ settings: { maxTokens: 2048 }, metadata: { max_output_tokens: 64000 } })).maxOutputTokens).toBe(64000);
    expect(resolveModelCapabilities(makeModel({ settings: { maxTokens: 2048, maxOutputTokens: 32000 } })).maxOutputTokens).toBe(32000);
    expect(resolveModelCapabilities(makeModel({
      settings: { maxTokens: 2048 },
      metadata: { capabilities: { maxOutputTokens: 128000 } },
    })).maxOutputTokens).toBe(128000);
  });

  it('uses category-specific modalities for speech and OCR models', () => {
    expect(resolveModelCapabilities(makeModel({ category: 'stt' }))).toEqual(
      expect.objectContaining({
        inputModalities: ['audio'],
        outputModalities: ['text'],
      }),
    );
    expect(resolveModelCapabilities(makeModel({ category: 'tts' }))).toEqual(
      expect.objectContaining({
        inputModalities: ['text'],
        outputModalities: ['audio'],
      }),
    );
    expect(resolveModelCapabilities(makeModel({ category: 'ocr' }))).toEqual(
      expect.objectContaining({
        inputModalities: ['image', 'file'],
        outputModalities: ['text'],
      }),
    );
  });

  it('validates token limits and modalities', () => {
    expect(() => parseModelCapabilityOverrides({
      contextWindow: 4096,
      maxOutputTokens: 8192,
    })).toThrow('cannot exceed');

    expect(() => parseModelCapabilityOverrides({
      inputModalities: ['text', 'telepathy'],
    })).toThrow('unsupported modality');
  });

  describe('limitsFromCatalogFill (Fill from catalog)', () => {
    it('fills both limits while the fields are empty', () => {
      expect(limitsFromCatalogFill(
        { contextWindow: '', maxOutputTokens: '' },
        { maxInputTokens: 200000, maxOutputTokens: 64000 },
      )).toEqual({ contextWindow: 200000, maxOutputTokens: 64000 });
    });

    it('never overwrites a value somebody typed', () => {
      expect(limitsFromCatalogFill(
        { contextWindow: 100000, maxOutputTokens: 8000 },
        { maxInputTokens: 200000, maxOutputTokens: 64000 },
      )).toEqual({});
      expect(limitsFromCatalogFill(
        { contextWindow: 100000, maxOutputTokens: '' },
        { maxInputTokens: 200000, maxOutputTokens: 64000 },
      )).toEqual({ maxOutputTokens: 64000 });
    });

    it('skips a maximum output that would exceed the context window the form holds (the save would refuse it)', () => {
      expect(limitsFromCatalogFill(
        { contextWindow: 32000, maxOutputTokens: '' },
        { maxInputTokens: 200000, maxOutputTokens: 64000 },
      )).toEqual({});
      expect(limitsFromCatalogFill(
        { contextWindow: '', maxOutputTokens: '' },
        { maxInputTokens: 32000, maxOutputTokens: 64000 },
      )).toEqual({ contextWindow: 32000 });
    });

    it('fills only what the catalog entry has, and ignores junk', () => {
      expect(limitsFromCatalogFill({ contextWindow: '', maxOutputTokens: '' }, { maxOutputTokens: 16384 }))
        .toEqual({ maxOutputTokens: 16384 });
      expect(limitsFromCatalogFill({ contextWindow: '', maxOutputTokens: '' }, { maxInputTokens: 0, maxOutputTokens: -1 }))
        .toEqual({});
      expect(limitsFromCatalogFill({ contextWindow: '', maxOutputTokens: '' }, {})).toEqual({});
    });
  });

  it('normalizes duplicate modalities and removes overrides explicitly', () => {
    expect(parseModelCapabilityOverrides({
      inputModalities: ['text', 'text', 'image'],
    })).toEqual(expect.objectContaining({
      inputModalities: ['text', 'image'],
    }));

    expect(applyModelCapabilityOverrides(
      { owner: 'platform', capabilities: { supportsReasoning: true } },
      null,
    )).toEqual({ owner: 'platform' });
  });
});
