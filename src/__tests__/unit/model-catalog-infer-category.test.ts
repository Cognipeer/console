/**
 * The category a listed model id is served under, by its naming family: what the catalog shows for the bare ids most
 * "list models" APIs return, and which ids it leaves out because no route here can serve them.
 */
import { describe, expect, it } from 'vitest';
import { constrainCategory, inferCatalogCategory } from '@/lib/services/models/catalog/inferCategory';

describe('inferCatalogCategory', () => {
  it.each([
    ['gpt-4o', 'llm'],
    ['gpt-4o-mini', 'llm'],
    ['o3-mini', 'llm'],
    ['gpt-5-codex', 'llm'],
    ['ft:gpt-4o-mini:acme::abc123', 'llm'],
    ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'llm'],
    ['claude-sonnet-4-20250514', 'llm'],
    ['us.anthropic.claude-3-5-sonnet-20240620-v1:0', 'llm'],
  ])('%s is a chat model', (id, category) => {
    expect(inferCatalogCategory(id)).toBe(category);
  });

  it.each([
    'text-embedding-3-small',
    'text-embedding-ada-002',
    'nomic-embed-text',
    'mistral-embed',
    'BAAI/bge-large-en-v1.5',
    'bge-m3',
    'intfloat/multilingual-e5-large',
    'e5-mistral-7b-instruct',
    'thenlper/gte-large',
    'voyage-3',
    'sentence-transformers/all-MiniLM-L6-v2',
    'gemini-embedding-001',
    'amazon.titan-embed-text-v2:0',
  ])('%s is an embedding model', (id) => {
    expect(inferCatalogCategory(id)).toBe('embedding');
  });

  it.each(['rerank-v3.5', 'BAAI/bge-reranker-v2-m3', 'jina-reranker-v2-base-multilingual', 'cohere.rerank-v3-5:0'])(
    '%s is a reranker (before any embedding family)',
    (id) => {
      expect(inferCatalogCategory(id)).toBe('rerank');
    },
  );

  it.each([
    ['whisper-1', 'stt'],
    ['whisper-large-v3', 'stt'],
    ['distil-whisper-large-v3-en', 'stt'],
    ['gpt-4o-transcribe', 'stt'],
    ['gpt-4o-mini-transcribe', 'stt'],
    ['tts-1', 'tts'],
    ['tts-1-hd', 'tts'],
    ['gpt-4o-mini-tts', 'tts'],
    ['playai-tts', 'tts'],
    ['dall-e-3', 'image'],
    ['gpt-image-1', 'image'],
    ['black-forest-labs/FLUX.1-schnell', 'image'],
    ['stabilityai/stable-diffusion-xl-base-1.0', 'image'],
    ['imagen-4.0-generate-001', 'image'],
    ['omni-moderation-latest', 'moderation'],
    ['text-moderation-latest', 'moderation'],
  ])('%s → %s', (id, category) => {
    expect(inferCatalogCategory(id)).toBe(category);
  });

  it.each([
    'gpt-4o-realtime-preview',
    'gpt-realtime',
    'gpt-4o-audio-preview',
    'gpt-audio',
    'sora-2',
    'veo-3.0-generate-preview',
    'davinci-002',
    'babbage-002',
    'gpt-3.5-turbo-instruct',
    'computer-use-preview',
    'gemini-2.0-flash-live-001',
    'gemini-live-2.5-flash-preview',
    'gemini-2.5-flash-preview-native-audio-dialog',
  ])('%s is left out: no route here can serve it', (id) => {
    expect(inferCatalogCategory(id)).toBeNull();
  });

  it('reads the output modalities a provider states', () => {
    expect(inferCatalogCategory('some/model', { outputModalities: ['embeddings'] })).toBe('embedding');
    expect(inferCatalogCategory('some/model', { outputModalities: ['EMBEDDING'] })).toBe('embedding');
    expect(inferCatalogCategory('some/model', { outputModalities: ['text', 'image'] })).toBe('llm');
    expect(inferCatalogCategory('some/model', { outputModalities: ['audio'] })).toBeNull();
  });

  it('answers null for an empty or non-string id', () => {
    expect(inferCatalogCategory('')).toBeNull();
    expect(inferCatalogCategory(42 as unknown as string)).toBeNull();
  });
});

describe('constrainCategory', () => {
  it('keeps a category the driver serves and drops the rest', () => {
    expect(constrainCategory('llm', ['llm', 'embedding'])).toBe('llm');
    expect(constrainCategory('tts', ['llm', 'embedding'])).toBeNull();
    expect(constrainCategory(null, ['llm'])).toBeNull();
  });
});
