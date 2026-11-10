/**
 * Pure request-body parsers shared by the dashboard and client plugin pairs
 * (reranker, prompts, OCR jobs, memory stores, models).
 */
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_STRATEGIES,
  RerankerInputError,
  isStrategy,
  normalizeDocuments,
  readCreateBody,
  readPatchBody,
} from '@/lib/services/reranker/requestParsing';
import { parseCreatePromptBody, parseUpdatePromptBody } from '@/lib/services/prompts/promptRequest';
import { parseOcrJobItem, parseOcrJobItems } from '@/lib/services/ocrJobs/itemInput';
import {
  parseCreateMemoryStoreBody,
  parseUpdateMemoryStoreBody,
} from '@/lib/services/memory/memoryRequest';
import {
  PLACEHOLDER,
  mergeSettings,
  sanitizeSettings,
} from '@/server/api/plugins/models-shared';

describe('reranker requestParsing', () => {
  it('accepts only the known strategies', () => {
    for (const s of ALLOWED_STRATEGIES) expect(isStrategy(s)).toBe(true);
    expect(isStrategy('nope')).toBe(false);
    expect(isStrategy(undefined)).toBe(false);
  });

  it('normalizes strings and { content | text } documents', () => {
    expect(normalizeDocuments(['a', { text: 'b', id: 'x', score: 1 }, { content: 'c', metadata: { k: 1 } }])).toEqual([
      { content: 'a' },
      { id: 'x', content: 'b', score: 1, metadata: undefined },
      { id: undefined, content: 'c', score: undefined, metadata: { k: 1 } },
    ]);
  });

  it('throws a typed error for malformed documents', () => {
    expect(() => normalizeDocuments('x')).toThrow(RerankerInputError);
    expect(() => normalizeDocuments([{}])).toThrow(RerankerInputError);
    expect(() => normalizeDocuments([1])).toThrow(/documents\[0\]/);
  });

  it('validates the create body in order', () => {
    expect(readCreateBody({})).toMatchObject({ ok: false, status: 400, error: '`name` is required.' });
    expect(readCreateBody({ name: 'n', strategy: 'x' })).toMatchObject({ ok: false });
    expect(readCreateBody({ name: 'n', strategy: 'heuristic' })).toMatchObject({
      ok: false,
      error: '`config` object is required.',
    });
    const ok = readCreateBody({ name: 'n', strategy: 'heuristic', config: {}, status: 'disabled', key: 'k' });
    expect(ok).toMatchObject({ ok: true, value: { name: 'n', key: 'k', status: 'disabled' } });
  });

  it('defaults status to active on create and leaves it unset on patch', () => {
    const created = readCreateBody({ name: 'n', strategy: 'heuristic', config: {} });
    expect(created.ok && created.value.status).toBe('active');
    expect(readPatchBody({ status: 'bogus', strategy: 'bogus', name: 3 })).toEqual({
      name: undefined,
      description: undefined,
      strategy: undefined,
      config: undefined,
      status: undefined,
      metadata: undefined,
    });
    expect(readPatchBody({ status: 'active' }).status).toBe('active');
  });
});

describe('prompt request parsing', () => {
  it('requires a non-empty string name and template', () => {
    expect(parseCreatePromptBody({ template: 't' })).toEqual({ ok: false, status: 400, error: 'name is required' });
    expect(parseCreatePromptBody({ name: '  ', template: 't' })).toMatchObject({ ok: false });
    expect(parseCreatePromptBody({ name: 'n' })).toMatchObject({ ok: false, error: 'template is required' });
    expect(parseCreatePromptBody({ name: 'n', template: 5 })).toMatchObject({
      ok: false,
      status: 400,
      error: 'template must be a string',
    });
  });

  it('maps optional fields and accepts `comment` as the version comment', () => {
    const parsed = parseCreatePromptBody({ name: 'n', template: 't', comment: 'c', metadata: { a: 1 }, key: 'k' });
    expect(parsed).toEqual({
      ok: true,
      value: { name: 'n', template: 't', key: 'k', description: undefined, metadata: { a: 1 }, versionComment: 'c' },
    });
  });

  it('keeps only well-typed fields on update', () => {
    expect(parseUpdatePromptBody({ name: 'n', template: 4, versionComment: 'v', metadata: [] })).toEqual({
      name: 'n',
      template: undefined,
      description: undefined,
      metadata: undefined,
      versionComment: 'v',
    });
  });
});

describe('OCR job item parsing', () => {
  it('parses the explicit source shapes', () => {
    expect(parseOcrJobItem({ source: { kind: 'url', url: 'https://x/y.pdf' }, fileName: 'y.pdf' })).toEqual({
      source: { kind: 'url', url: 'https://x/y.pdf', contentType: undefined },
      fileName: 'y.pdf',
    });
    expect(parseOcrJobItem({ source: { kind: 'bucket', bucketKey: 'b', objectKey: 'o' } })).toEqual({
      source: { kind: 'bucket', bucketKey: 'b', objectKey: 'o' },
      fileName: undefined,
    });
    expect(parseOcrJobItem({ source: { kind: 'inline', data: 'QQ==', fileName: 'a.txt' } })).toMatchObject({
      source: { kind: 'inline', data: 'QQ==', fileName: 'a.txt' },
      fileName: 'a.txt',
    });
  });

  it('parses the shorthand shapes', () => {
    expect(parseOcrJobItem({ url: 'https://x' })?.source).toMatchObject({ kind: 'url', url: 'https://x' });
    expect(parseOcrJobItem({ data: 'QQ==', contentType: 'text/plain' })?.source).toMatchObject({
      kind: 'inline',
      contentType: 'text/plain',
    });
    expect(parseOcrJobItem({ bucket: { bucketKey: 'b', objectKey: 'o' } })?.source).toEqual({
      kind: 'bucket',
      bucketKey: 'b',
      objectKey: 'o',
    });
    expect(parseOcrJobItem({ document: { url: 'https://d' } })?.source).toMatchObject({ kind: 'url', url: 'https://d' });
  });

  it('returns null / skips entries without a usable source', () => {
    expect(parseOcrJobItem(null)).toBeNull();
    expect(parseOcrJobItem({ source: { kind: 'url' } })).toBeNull();
    expect(parseOcrJobItems('x')).toEqual([]);
    expect(parseOcrJobItems([{}, { url: 'https://x' }, 3])).toHaveLength(1);
  });
});

describe('memory store request parsing', () => {
  it('requires name, vectorProviderKey and embeddingModelKey', () => {
    expect(parseCreateMemoryStoreBody({})).toEqual({ ok: false, status: 400, error: 'name is required' });
    expect(parseCreateMemoryStoreBody({ name: 'n' })).toMatchObject({ error: 'vectorProviderKey is required' });
    expect(parseCreateMemoryStoreBody({ name: 'n', vectorProviderKey: 'v' })).toMatchObject({
      error: 'embeddingModelKey is required',
    });
    expect(
      parseCreateMemoryStoreBody({ name: 'n', vectorProviderKey: 'v', embeddingModelKey: 'e', description: 'd' }),
    ).toMatchObject({ ok: true, value: { name: 'n', vectorProviderKey: 'v', embeddingModelKey: 'e', description: 'd' } });
  });

  it('whitelists the update fields', () => {
    const update = parseUpdateMemoryStoreBody({
      name: 'n',
      status: 'inactive',
      config: { a: 1 },
      description: 'd',
      projectId: 'other',
      createdBy: 'someone',
      updatedBy: 'someone',
    });
    expect(Object.keys(update).sort()).toEqual(['config', 'description', 'name', 'status']);
  });
});

describe('models-shared settings helpers', () => {
  it('masks credential fields and leaves others', () => {
    expect(sanitizeSettings({ apiKey: 'secret', region: 'eu', sessionToken: '' })).toEqual({
      apiKey: PLACEHOLDER,
      region: 'eu',
      sessionToken: '',
    });
  });

  it('keeps stored values for the placeholder and undefined, deletes on null', () => {
    const merged = mergeSettings(
      { apiKey: 'real', region: 'eu', drop: 'x' },
      { apiKey: PLACEHOLDER, region: undefined, drop: null, extra: 'y' },
    );
    expect(merged).toMatchObject({ apiKey: 'real', region: 'eu', extra: 'y' });
    expect(merged).not.toHaveProperty('drop');
  });
});
