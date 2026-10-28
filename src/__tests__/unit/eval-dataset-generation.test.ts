/**
 * Unit tests — evaluation dataset generation (`generateDatasetItems`).
 * Covers text-source generation with JSON parsing (incl. code fences), the
 * RAG-source path (chunk gathering), the count cap, and a knowledge base with
 * access control (only what is open to everyone, whoever asks). DB + model mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const handleChatCompletion = vi.fn();
vi.mock('@/lib/services/models/inferenceService', () => ({
  handleChatCompletion: (...args: unknown[]) => handleChatCompletion(...args),
}));

const resolveRagAccess = vi.fn();
vi.mock('@/lib/services/rag/access', () => ({
  anonymousKbCaller: (reason: string) => ({ kind: 'anonymous', reason }),
  resolveRagAccess: (...args: unknown[]) => resolveRagAccess(...args),
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

describe('generateDatasetItems — rag source with access control', () => {
  const MODULE = { key: 'kb', access: { enabled: true } };
  const base = { tenantDbName: 't', tenantId: 'tid', projectId: 'p', generationModelKey: 'gpt', source: { type: 'rag', ragModuleKey: 'kb' } as const, count: 10 };

  /** A scope that reads the listed documents. */
  function scopeReading(readable: string[]) {
    return { enforced: true, canReadDocument: (doc: { _id?: unknown }) => readable.includes(String(doc._id)) };
  }

  /** Everything the model was shown across the calls. */
  const promptsSent = () => handleChatCompletion.mock.calls.map((call) => JSON.stringify(call[0].body.messages)).join('\n');

  beforeEach(() => {
    db.findRagModuleByKey.mockResolvedValue(MODULE);
    db.listRagDocuments.mockResolvedValue([{ _id: 'doc1' }, { _id: 'doc2' }, { _id: 'doc3' }]);
    db.findRagChunksByDocumentId.mockImplementation(async (id: string) => [{ content: `chunk of ${id}` }]);
    handleChatCompletion.mockResolvedValue(reply('[{"question":"q","answer":"a"}]'));
  });

  it('uses only the chunks of documents open to everyone', async () => {
    resolveRagAccess.mockResolvedValue(scopeReading(['doc1', 'doc3']));

    await generateDatasetItems({ ...base, createdBy: 'creator-1' });

    expect(resolveRagAccess).toHaveBeenCalledTimes(1);
    expect(resolveRagAccess).toHaveBeenCalledWith({
      tenantDbName: 't',
      tenantId: 'tid',
      module: MODULE,
      caller: { kind: 'anonymous', reason: 'public' },
    });
    // Chunks of a document not open to everyone are never loaded, let alone shown to the model.
    expect(db.findRagChunksByDocumentId.mock.calls.map((call) => call[0])).toEqual(['doc1', 'doc3']);
    expect(promptsSent()).toContain('chunk of doc1');
    expect(promptsSent()).toContain('chunk of doc3');
    expect(promptsSent()).not.toContain('chunk of doc2');
  });

  // A dataset is read by everyone who may read the project's evaluations: what its creator (even a manager)
  // may read does not widen it.
  it.each([
    ['a member', 'creator-1'],
    ['a manager', 'admin-1'],
    ['no creator', undefined],
    ['a system actor', 'system:scheduler'],
    ['an agent actor', 'agent:support-bot'],
    ['the evaluation placeholder', 'evaluation'],
  ])('reads as no one in particular for %s', async (_name, createdBy) => {
    resolveRagAccess.mockResolvedValue(scopeReading(['doc2']));

    await generateDatasetItems({ ...base, createdBy });

    expect(resolveRagAccess.mock.calls[0][0].caller).toEqual({ kind: 'anonymous', reason: 'public' });
    expect(db.findRagChunksByDocumentId.mock.calls.map((call) => call[0])).toEqual(['doc2']);
  });

  it('answers like an empty module when nothing is open to everyone', async () => {
    resolveRagAccess.mockResolvedValue(scopeReading([]));

    await expect(generateDatasetItems({ ...base, createdBy: 'creator-1' })).rejects.toThrow(/no indexed content/i);
    expect(db.findRagChunksByDocumentId).not.toHaveBeenCalled();
    expect(handleChatCompletion).not.toHaveBeenCalled();
  });

  it.each([
    ['no access setting', { key: 'kb' }],
    ['access control switched off', { key: 'kb', access: { enabled: false } }],
  ])('does not involve the access engine for a module with %s', async (_name, ragModule) => {
    db.findRagModuleByKey.mockResolvedValue(ragModule);

    await generateDatasetItems({ ...base, createdBy: 'creator-1' });

    expect(resolveRagAccess).not.toHaveBeenCalled();
    expect(db.findRagChunksByDocumentId.mock.calls.map((call) => call[0])).toEqual(['doc1', 'doc2', 'doc3']);
  });
});
