import { describe, expect, it } from 'vitest';
import type { IModel } from '@/lib/database';
import {
  applyModelCapabilityOverrides,
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
      maxOutputTokens: 4096,
      inputModalities: ['text', 'image'],
      outputModalities: ['embeddings'],
      supportsReasoning: false,
      supportsToolCalls: true,
    }));
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
