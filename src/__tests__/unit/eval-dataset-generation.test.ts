/**
 * Unit tests — evaluation dataset generation (`generateDatasetItems`).
 * Covers text-source generation with JSON parsing (incl. code fences), the
 * RAG-source path (chunk gathering), and the count cap. DB + model mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const handleChatCompletion = vi.fn();
vi.mock('@/lib/services/models/inferenceService', () => ({
  handleChatCompletion: (...args: unknown[]) => handleChatCompletion(...args),
}));

const db = {
  switchToTenant: vi.fn().mockResolvedValue(undefined),
  findRagModuleByKey: vi.fn(),
  listRagDocuments: vi.fn(),
  findRagChunksByDocumentId: vi.fn(),
};
vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(async () => db),
}));

import { generateDatasetItems } from '@/lib/services/evaluation/datasetGeneration';

function reply(content: string) {
  return { response: { choices: [{ message: { content } }] } };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('generateDatasetItems — text source', () => {
  it('parses Q&A pairs (with code fences) into dataset items', async () => {
    handleChatCompletion.mockResolvedValue(
      reply('```json\n[{"question":"What is X?","answer":"X is a thing."}]\n```'),
    );

    const result = await generateDatasetItems({
      tenantDbName: 't',
      tenantId: 'tid',
      projectId: 'p',
      generationModelKey: 'gpt',
      source: { type: 'text', text: 'Some paragraph about X.\n\nAnother paragraph.' },
      count: 5,
    });

    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items[0]).toMatchObject({
      input: [{ role: 'user', content: 'What is X?' }],
      expected: { reference: 'X is a thing.' },
      tags: ['generated'],
    });
  });

  it('caps the number of generated items at count', async () => {
    handleChatCompletion.mockResolvedValue(
      reply('[{"question":"q1","answer":"a1"},{"question":"q2","answer":"a2"},{"question":"q3","answer":"a3"}]'),
    );

    const result = await generateDatasetItems({
      tenantDbName: 't',
      tenantId: 'tid',
      generationModelKey: 'gpt',
      source: { type: 'text', text: 'one block of text' },
      count: 2,
    });

    expect(result.items).toHaveLength(2);
  });

  it('throws when the model produces no valid pairs', async () => {
    handleChatCompletion.mockResolvedValue(reply('sorry, I cannot do that'));
    await expect(
      generateDatasetItems({
        tenantDbName: 't',
        tenantId: 'tid',
        generationModelKey: 'gpt',
        source: { type: 'text', text: 'text' },
        count: 3,
      }),
    ).rejects.toThrow(/No question-answer pairs/i);
  });
});

describe('generateDatasetItems — rag source', () => {
  it('gathers chunks from the module documents and generates items', async () => {
    db.findRagModuleByKey.mockResolvedValue({ key: 'kb' });
    db.listRagDocuments.mockResolvedValue([{ _id: 'doc1' }, { _id: 'doc2' }]);
    db.findRagChunksByDocumentId.mockImplementation(async (id: string) =>
      id === 'doc1' ? [{ content: 'chunk a' }] : [{ content: 'chunk b' }],
    );
    handleChatCompletion.mockResolvedValue(reply('[{"question":"q","answer":"a"}]'));

    const result = await generateDatasetItems({
      tenantDbName: 't',
      tenantId: 'tid',
      projectId: 'p',
      generationModelKey: 'gpt',
      source: { type: 'rag', ragModuleKey: 'kb' },
      count: 5,
    });

    expect(db.findRagChunksByDocumentId).toHaveBeenCalledTimes(2);
    expect(result.items.length).toBeGreaterThan(0);
  });

  it('throws when the module has no indexed content', async () => {
    db.findRagModuleByKey.mockResolvedValue({ key: 'kb' });
    db.listRagDocuments.mockResolvedValue([]);

    await expect(
      generateDatasetItems({
        tenantDbName: 't',
        tenantId: 'tid',
        generationModelKey: 'gpt',
        source: { type: 'rag', ragModuleKey: 'kb' },
        count: 5,
      }),
    ).rejects.toThrow(/no indexed content/i);
  });
});
