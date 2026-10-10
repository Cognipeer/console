/**
 * Which chat models take images, judged by the model id: the table next to the
 * provider contracts, and how the capability resolver uses it — a default for a
 * model with nothing stored, always beaten by an explicit setting.
 */

import { describe, expect, it } from 'vitest';
import type { IModel } from '@/lib/database';
import {
  VISION_MODEL_FAMILIES,
  inferModelAcceptsImages,
  matchVisionModelFamily,
  normalizeModelIdForInference,
} from '@/lib/providers/contracts/modelCapabilityInference';
import { getDefaultModelInputModalities, resolveModelCapabilities } from '@/lib/services/models/modelCapabilities';

const VISION = [
  // OpenAI
  'gpt-4o', 'gpt-4o-mini', 'gpt-4o-2024-08-06', 'chatgpt-4o-latest', 'gpt-4.1', 'gpt-4.1-nano', 'gpt-4.5-preview',
  'gpt-4-turbo', 'gpt-4-turbo-2024-04-09', 'gpt-4-vision-preview', 'gpt-5', 'gpt-5-mini', 'gpt-5.1', 'gpt-6-luna', 'gpt-5-codex',
  'o1', 'o1-pro', 'o3', 'o3-pro', 'o4-mini',
  // Anthropic (plain, Bedrock and Vertex spellings)
  'claude-3-haiku-20240307', 'claude-3-5-sonnet-20241022', 'claude-3-7-sonnet-latest', 'claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5',
  'anthropic.claude-3-5-sonnet-20240620-v1:0', 'us.anthropic.claude-3-7-sonnet-20250219-v1:0', 'claude-3-5-sonnet@20240620', 'claude-5-sonnet',
  // Google
  'gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-2.0-flash', 'gemini-2.5-pro', 'gemini-pro-vision', 'gemini-1.0-pro-vision', 'models/gemini-2.5-flash', 'gemini-3-pro',
  // Open weights
  'llama-3.2-11b-vision-instruct', 'Llama-3.2-90B-Vision-Instruct', 'llama3.2-vision', 'meta.llama3-2-11b-instruct-v1:0', 'us.meta.llama3-2-90b-instruct-v1:0',
  'accounts/fireworks/models/llama-v3p2-11b-vision-instruct', 'llama-4-scout-17b-16e-instruct', 'llama4:maverick', 'llava:13b', 'llava-v1.6-34b',
  'qwen2-vl-7b-instruct', 'qwen2.5-vl-72b-instruct', 'qwen2.5vl:7b', 'qwen-vl-max', 'qwen3-vl-235b', 'qvq-72b-preview', 'Qwen/Qwen2.5-VL-7B-Instruct',
  'pixtral-12b-2409', 'mistral.pixtral-large-2502-v1:0', 'mistral-small-3.1-24b-instruct', 'mistral-medium-3',
  'grok-2-vision-1212', 'grok-4', 'grok-4-fast',
  'amazon.nova-pro-v1:0', 'us.amazon.nova-lite-v1:0', 'nova-premier-v1:0',
  'phi-3.5-vision-instruct', 'phi-4-multimodal-instruct', 'glm-4v-plus', 'internvl2-26b', 'deepseek-vl2', 'minicpm-v:8b', 'openai/gpt-4o',
];

const TEXT_ONLY = [
  'gpt-3.5-turbo', 'gpt-35-turbo', 'gpt-4', 'gpt-4-32k', 'gpt-4-0613', 'gpt-4-turbo-preview', 'gpt-4-1106-preview', 'gpt-oss-120b', 'gpt-oss-20b',
  'o1-mini', 'o1-preview', 'o3-mini', 'o3-mini-high',
  'claude-2.1', 'claude-instant-1.2', 'anthropic.claude-v2:1', 'claude-v2',
  'gemini-pro', 'gemini-1.0-pro', 'gemini-1.0-pro-001', 'gemini-embedding-001', 'gemini-2.5-flash-preview-tts',
  'llama-3.1-70b-instruct', 'llama-3.2-3b-instruct', 'llama-3.2-1b-instruct', 'meta.llama3-1-405b-instruct-v1:0', 'llama-3.3-70b', 'llama-2-70b-chat',
  'qwen2.5-72b-instruct', 'qwen3-32b', 'qwen2.5-coder-32b',
  'mistral-large-2407', 'mistral-small-latest', 'mixtral-8x7b-instruct', 'codestral-latest', 'mistral-small-3.0',
  'grok-3', 'grok-2-1212', 'amazon.nova-micro-v1:0', 'phi-3-mini-4k-instruct', 'phi-4',
  'deepseek-chat', 'deepseek-r1', 'command-r-plus', 'text-embedding-3-large', 'whisper-1', 'in-house-llm-7b', 'my-deployment', '',
];

describe('the vision family table', () => {
  it.each(VISION)('%s takes images', (modelId) => {
    expect(inferModelAcceptsImages(modelId), modelId).toBe(true);
  });

  it.each(TEXT_ONLY)('"%s" is not taken for a vision model', (modelId) => {
    expect(inferModelAcceptsImages(modelId), modelId).toBe(false);
  });

  it('names the family that matched, so a surprise can be traced', () => {
    expect(matchVisionModelFamily('gpt-6-luna')?.family).toBe('openai-gpt-5+');
    expect(matchVisionModelFamily('us.anthropic.claude-3-7-sonnet-20250219-v1:0')?.family).toBe('anthropic-claude-3+');
    expect(matchVisionModelFamily('gemini-pro')).toBeNull();
    expect(matchVisionModelFamily(undefined)).toBeNull();
    expect(matchVisionModelFamily(null)).toBeNull();
  });

  it('normalises ids: no path, no region or vendor prefix, lower case', () => {
    expect(normalizeModelIdForInference(' OpenAI/GPT-4o ')).toBe('gpt-4o');
    expect(normalizeModelIdForInference('accounts/x/models/Llama-3.2-11B-Vision')).toBe('llama-3.2-11b-vision');
    expect(normalizeModelIdForInference('eu.anthropic.claude-3-haiku-20240307-v1:0')).toBe('claude-3-haiku-20240307-v1:0');
    // A version dot that is not a vendor prefix stays.
    expect(normalizeModelIdForInference('gpt-4.1')).toBe('gpt-4.1');
  });

  it('every rule has a family name and a pattern; an exception only narrows its own family', () => {
    const names = VISION_MODEL_FAMILIES.map((rule) => rule.family);
    expect(new Set(names).size).toBe(names.length);
    for (const rule of VISION_MODEL_FAMILIES) {
      expect(rule.family).toBeTruthy();
      expect(rule.match).toBeInstanceOf(RegExp);
    }
  });
});

describe('capabilities of a model with nothing stored', () => {
  const model = (overrides: Partial<IModel> = {}): IModel => ({
    tenantId: 't', projectId: 'p', name: 'Alias', key: 'alias', providerKey: 'prov', providerDriver: 'openai',
    category: 'llm', modelId: 'gpt-6-luna', isMultimodal: false, supportsToolCalls: true, settings: {},
    pricing: { currency: 'USD', inputTokenPer1M: 0, outputTokenPer1M: 0, cachedTokenPer1M: 0 }, metadata: {}, ...overrides,
  });

  it('a chat model of a known vision family reads images without any flag', () => {
    expect(resolveModelCapabilities(model()).inputModalities).toEqual(['text', 'image']);
    expect(resolveModelCapabilities(model({ modelId: 'in-house-llm-7b' })).inputModalities).toEqual(['text']);
  });

  it('the "multimodal" flag still makes any chat model take images', () => {
    expect(resolveModelCapabilities(model({ modelId: 'in-house-llm-7b', isMultimodal: true })).inputModalities).toEqual(['text', 'image']);
  });

  it('an explicit choice wins over the name — "text only" included', () => {
    const textOnly = model({ metadata: { capabilities: { inputModalities: ['text'] } } });
    expect(resolveModelCapabilities(textOnly).inputModalities).toEqual(['text']);
    const explicitImage = model({ modelId: 'in-house-llm-7b', metadata: { capabilities: { inputModalities: ['text', 'image'] } } });
    expect(resolveModelCapabilities(explicitImage).inputModalities).toEqual(['text', 'image']);
  });

  it('other categories are not guessed at', () => {
    expect(resolveModelCapabilities(model({ category: 'embedding', modelId: 'gpt-5' })).inputModalities).toEqual(['text']);
    expect(resolveModelCapabilities(model({ category: 'stt', modelId: 'gpt-5' })).inputModalities).toEqual(['audio']);
    expect(resolveModelCapabilities(model({ category: 'ocr', modelId: 'x' })).inputModalities).toEqual(['image', 'file']);
  });

  it('the model forms get their prefill from the same place', () => {
    expect(getDefaultModelInputModalities('llm', false, 'gpt-6-luna')).toEqual(['text', 'image']);
    expect(getDefaultModelInputModalities('llm', false, 'in-house-llm-7b')).toEqual(['text']);
    expect(getDefaultModelInputModalities('llm', false)).toEqual(['text']);
    expect(getDefaultModelInputModalities('llm', true)).toEqual(['text', 'image']);
    expect(getDefaultModelInputModalities('embedding', false, 'gpt-5')).toEqual(['text']);
  });
});
