/**
 * The provider model catalog's entries turned into the create form's values and the bulk create body
 * (`components/models/catalog/catalogPrefill.ts`).
 *
 * What a catalog pick fills in (and what it leaves to the form's defaults or the detection from the model id), which
 * prices are trusted enough to fill a form, the body "Add N models" posts (the create form's, with the same provider
 * clamps), and the catalog's search / category counts. That the bulk body equals what the form itself posts is checked
 * by submitting the real form in `model-catalog-ui.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import type { CatalogModel } from '@/lib/services/models/catalog/types';
import {
  catalogCategoryCounts,
  catalogModelToCreatePayload,
  catalogModelToPrefill,
  createModelBodyFromPrefill,
  filterCatalogModels,
  resolveDecisionModes,
  resolveOcrModes,
  resolveProviderCategories,
  trustedCatalogPricing,
  type CatalogProviderRef,
} from '@/components/models/catalog/catalogPrefill';

const model = (overrides: Partial<CatalogModel> & Pick<CatalogModel, 'id'>): CatalogModel => ({
  name: overrides.id,
  category: 'llm',
  source: 'live',
  ...overrides,
});

const openai: CatalogProviderRef = {
  key: 'openai-main',
  driver: 'openai',
  driverCapabilities: { 'model.categories': ['llm', 'embedding', 'stt', 'tts', 'image', 'moderation'], 'model.supports.tool_calls': true },
};

describe('catalogModelToPrefill', () => {
  it('fills a chat model in from everything the listing says', () => {
    const prefill = catalogModelToPrefill(
      model({
        id: 'my-custom-model',
        name: '  My Custom Model  ',
        contextWindow: 128_000,
        maxOutputTokens: 16_384,
        inputModalities: ['text', 'image'],
        supportsToolCalls: false,
        supportsReasoning: true,
        supportsStructuredOutputs: false,
        pricing: { currency: 'USD', inputTokenPer1M: 2.5, outputTokenPer1M: 10, cachedTokenPer1M: 1.25, source: 'provider' },
      }),
      'openai-main',
    );
    expect(prefill).toEqual({
      providerKey: 'openai-main',
      modelId: 'my-custom-model',
      name: 'My Custom Model',
      category: 'llm',
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
      // The id alone is not known to take images: the listing's word is stored as a choice.
      inputModalities: ['text', 'image'],
      supportsToolCalls: false,
      supportsReasoning: true,
      supportsStructuredOutputs: false,
      pricing: { inputTokenPer1M: 2.5, outputTokenPer1M: 10, cachedTokenPer1M: 1.25 },
    });
  });

  it('leaves what the listing does not say to the form (its defaults and the detection from the id)', () => {
    expect(catalogModelToPrefill(model({ id: 'gpt-4o-mini', name: '' }), 'p')).toEqual({
      providerKey: 'p',
      modelId: 'gpt-4o-mini',
      name: 'gpt-4o-mini',
      category: 'llm',
    });
  });

  it('stores input types only when they say more than the detection from the model id', () => {
    // gpt-4o is detected as taking images: nothing to store.
    expect(catalogModelToPrefill(model({ id: 'gpt-4o', inputModalities: ['text', 'image'] }), 'p').inputModalities).toBeUndefined();
    // Text only says nothing beyond the default.
    expect(catalogModelToPrefill(model({ id: 'my-custom-model', inputModalities: ['text'] }), 'p').inputModalities).toBeUndefined();
    // Order follows the form's boxes, and text is always among them.
    expect(catalogModelToPrefill(model({ id: 'my-custom-model', inputModalities: ['audio', 'image'] }), 'p').inputModalities)
      .toEqual(['text', 'image', 'audio']);
  });

  it('never stores limits, capabilities or input types for categories whose form has no such fields', () => {
    const prefill = catalogModelToPrefill(
      model({
        id: 'text-embedding-3-large',
        category: 'embedding',
        contextWindow: 8191,
        inputModalities: ['text', 'image'],
        supportsToolCalls: true,
        pricing: { currency: 'USD', inputTokenPer1M: 0.13, outputTokenPer1M: 0, source: 'reference', confidence: 'exact', catalogKey: 'text-embedding-3-large' },
      }),
      'p',
    );
    expect(prefill).toEqual({
      providerKey: 'p',
      modelId: 'text-embedding-3-large',
      name: 'text-embedding-3-large',
      category: 'embedding',
      pricing: { inputTokenPer1M: 0.13, outputTokenPer1M: 0 },
    });
  });

  it('drops a maximum output above the context window (the form refuses to save one)', () => {
    const prefill = catalogModelToPrefill(model({ id: 'x', contextWindow: 4096, maxOutputTokens: 8192 }), 'p');
    expect(prefill.contextWindow).toBe(4096);
    expect(prefill.maxOutputTokens).toBeUndefined();
    // Nonsense limits are not limits.
    const odd = catalogModelToPrefill(model({ id: 'y', contextWindow: -1, maxOutputTokens: 1.5 }), 'p');
    expect(odd.contextWindow).toBeUndefined();
    expect(odd.maxOutputTokens).toBeUndefined();
  });
});

describe('trustedCatalogPricing', () => {
  const priced = (pricing: CatalogModel['pricing']) => trustedCatalogPricing({ pricing });

  it('fills the provider\'s own prices and exact or normalized reference matches', () => {
    expect(priced({ currency: 'USD', inputTokenPer1M: 1, outputTokenPer1M: 2, source: 'provider' })).toEqual({ inputTokenPer1M: 1, outputTokenPer1M: 2 });
    expect(priced({ currency: 'USD', inputTokenPer1M: 1, outputTokenPer1M: 2, source: 'reference', confidence: 'exact' })).toBeDefined();
    expect(priced({ currency: 'USD', inputTokenPer1M: 1, outputTokenPer1M: 2, source: 'reference', confidence: 'normalized' })).toBeDefined();
  });

  it('never fills a fuzzy match, a reference without a confidence, or a price that is not a number', () => {
    expect(priced({ currency: 'USD', inputTokenPer1M: 1, outputTokenPer1M: 2, source: 'reference', confidence: 'fuzzy' })).toBeUndefined();
    expect(priced({ currency: 'USD', inputTokenPer1M: 1, outputTokenPer1M: 2, source: 'reference' })).toBeUndefined();
    expect(priced({ currency: 'USD', inputTokenPer1M: Number.NaN, outputTokenPer1M: 2, source: 'provider' })).toBeUndefined();
    expect(priced({ currency: 'USD', inputTokenPer1M: -1, outputTokenPer1M: 2, source: 'provider' })).toBeUndefined();
    expect(priced(undefined)).toBeUndefined();
  });

  it('keeps a free model free and leaves a cache price of 0 blank (billed at the input price)', () => {
    expect(priced({ currency: 'USD', inputTokenPer1M: 0, outputTokenPer1M: 0, cachedTokenPer1M: 0, cacheWriteTokenPer1M: 3.75, source: 'provider' }))
      .toEqual({ inputTokenPer1M: 0, outputTokenPer1M: 0, cacheWriteTokenPer1M: 3.75 });
  });
});

describe('catalogModelToCreatePayload (the body "Add N models" posts)', () => {
  it('is the create form\'s body for a chat model with nothing edited', () => {
    const { body, priced } = catalogModelToCreatePayload(
      model({
        id: 'my-custom-model',
        name: 'Custom',
        contextWindow: 200_000,
        inputModalities: ['text', 'image'],
        pricing: { currency: 'USD', inputTokenPer1M: 3, outputTokenPer1M: 15, cachedTokenPer1M: 0.3, cacheWriteTokenPer1M: 3.75, source: 'provider' },
      }),
      openai,
    );
    expect(priced).toBe(true);
    expect(body).toEqual({
      providerKey: 'openai-main',
      name: 'Custom',
      key: '',
      description: '',
      category: 'llm',
      modelId: 'my-custom-model',
      isMultimodal: true,
      supportsToolCalls: true,
      capabilities: {
        contextWindow: 200_000,
        inputModalities: ['text', 'image'],
        outputModalities: ['text'],
        supportsReasoning: true,
        supportsStructuredOutputs: true,
        supportsToolCalls: true,
      },
      pricing: { currency: 'USD', inputTokenPer1M: 3, outputTokenPer1M: 15, cachedTokenPer1M: 0.3, cacheWriteTokenPer1M: 3.75 },
      settings: {},
    });
  });

  it('creates a model without a trusted price at 0 and says so', () => {
    const { body, priced } = catalogModelToCreatePayload(
      model({ id: 'gpt-4o', pricing: { currency: 'USD', inputTokenPer1M: 5, outputTokenPer1M: 15, source: 'reference', confidence: 'fuzzy' } }),
      openai,
    );
    expect(priced).toBe(false);
    expect(body.pricing).toEqual({ currency: 'USD', inputTokenPer1M: 0, outputTokenPer1M: 0 });
    // Detected from the id: vision without a stored choice.
    expect(body.isMultimodal).toBe(true);
    expect(body.capabilities).not.toHaveProperty('inputModalities');
  });

  it('applies the provider clamp on tool calls, as the form does', () => {
    const noTools: CatalogProviderRef = { key: 'local', driver: 'openai-compatible', driverCapabilities: { 'model.categories': ['llm'] } };
    const { body } = catalogModelToCreatePayload(model({ id: 'qwen2.5-72b-instruct', supportsToolCalls: true }), noTools);
    expect(body.supportsToolCalls).toBe(false);
    expect(body.capabilities.supportsToolCalls).toBe(false);
    expect(body.isMultimodal).toBe(false);
  });

  it('builds non-chat categories the way the form does (outputs, no vision flag, no input types)', () => {
    const { body } = catalogModelToCreatePayload(
      model({ id: 'text-embedding-3-small', category: 'embedding', inputModalities: ['text', 'image'] }),
      openai,
    );
    expect(body.category).toBe('embedding');
    expect(body.isMultimodal).toBe(false);
    expect(body.capabilities).toEqual({
      outputModalities: ['embeddings'],
      supportsReasoning: true,
      supportsStructuredOutputs: true,
      supportsToolCalls: true,
    });
    expect(body.settings).toEqual({});
  });

  it('picks the OCR mode and the decision backend the provider allows', () => {
    const ocrNative: CatalogProviderRef = { key: 'ocr', driverCapabilities: { 'model.categories': ['ocr'], 'ocr.modes': ['native'] } };
    expect(catalogModelToCreatePayload(model({ id: 'prebuilt-read', category: 'ocr' }), ocrNative).body.settings)
      .toEqual({ ocr: { mode: 'native' } });
    const ocrBoth: CatalogProviderRef = { key: 'ocr', driverCapabilities: { 'model.categories': ['ocr', 'llm'], 'ocr.modes': ['native', 'vlm'] } };
    expect(catalogModelToCreatePayload(model({ id: 'mistral-ocr-latest', category: 'ocr' }), ocrBoth).body.settings)
      .toEqual({ ocr: { mode: 'vlm' } });

    const decisionNative: CatalogProviderRef = { key: 'd', driverCapabilities: { 'model.categories': ['decision'], 'decision.native': true } };
    expect(catalogModelToCreatePayload(model({ id: 'jev-latest', category: 'decision' }), decisionNative).body.settings)
      .toEqual({ decision: { mode: 'native', supports: { image: false } } });
    const decisionChat: CatalogProviderRef = { key: 'd', driverCapabilities: { 'model.categories': ['llm', 'decision'], 'decision.native': true } };
    expect(catalogModelToCreatePayload(model({ id: 'decision-model-preview', category: 'decision' }), decisionChat).body.settings)
      .toEqual({ decision: { mode: 'structured', supports: { image: false } } });
  });

  it('falls back to the provider\'s first category for one it does not serve (as the form does)', () => {
    const rerankOnly: CatalogProviderRef = { key: 'r', driverCapabilities: { 'model.categories': ['rerank'] } };
    const body = createModelBodyFromPrefill({ providerKey: 'r', modelId: 'x', name: 'x', category: 'llm' }, rerankOnly);
    expect(body.category).toBe('rerank');
    expect(body.capabilities).not.toHaveProperty('inputModalities');
  });
});

describe('provider rules shared with the create form', () => {
  it('reads the categories, OCR modes and decision backends of a driver, with the form\'s defaults', () => {
    expect(resolveProviderCategories(undefined)).toEqual(['llm', 'embedding']);
    expect(resolveProviderCategories({ driverCapabilities: { 'model.categories': ['rerank', 'nonsense', 3] } })).toEqual(['rerank']);
    expect(resolveOcrModes({ driverCapabilities: {} })).toEqual(['vlm']);
    expect(resolveOcrModes({ driverCapabilities: { 'ocr.modes': ['native', 'other'] } })).toEqual(['native']);
    expect(resolveDecisionModes({ driverCapabilities: { 'model.categories': ['rerank'] } })).toEqual(['structured']);
    expect(resolveDecisionModes({ driverCapabilities: { 'model.categories': ['llm'], 'decision.native': true } })).toEqual(['structured', 'native']);
  });
});

describe('filterCatalogModels / catalogCategoryCounts', () => {
  const list: CatalogModel[] = [
    model({ id: 'gpt-4o', name: 'GPT-4o', ownedBy: 'openai' }),
    model({ id: 'text-embedding-3-small', category: 'embedding', description: 'Small embedding model' }),
    model({ id: 'whisper-1', category: 'stt', registeredModelKeys: ['whisper'] }),
    model({ id: 'anthropic.claude-3-haiku', name: 'Claude 3 Haiku', upstreamModel: 'claude-3-haiku-20240307' }),
  ];

  it('matches every word of the query against id, name, description, owner and upstream model', () => {
    expect(filterCatalogModels(list, { query: 'gpt' }).map((m) => m.id)).toEqual(['gpt-4o']);
    expect(filterCatalogModels(list, { query: 'SMALL embedding' }).map((m) => m.id)).toEqual(['text-embedding-3-small']);
    expect(filterCatalogModels(list, { query: 'haiku 20240307' }).map((m) => m.id)).toEqual(['anthropic.claude-3-haiku']);
    expect(filterCatalogModels(list, { query: 'openai' }).map((m) => m.id)).toEqual(['gpt-4o']);
    expect(filterCatalogModels(list, { query: '  ' })).toHaveLength(4);
  });

  it('narrows by category and hides models already in the project', () => {
    expect(filterCatalogModels(list, { category: 'embedding' }).map((m) => m.id)).toEqual(['text-embedding-3-small']);
    expect(filterCatalogModels(list, { hideRegistered: true }).map((m) => m.id)).not.toContain('whisper-1');
    expect(filterCatalogModels(list, { category: 'all', hideRegistered: false })).toHaveLength(4);
  });

  it('counts the categories present, in catalog order', () => {
    expect(catalogCategoryCounts(list)).toEqual([
      { category: 'llm', count: 2 },
      { category: 'embedding', count: 1 },
      { category: 'stt', count: 1 },
    ]);
    expect(catalogCategoryCounts([])).toEqual([]);
  });
});
